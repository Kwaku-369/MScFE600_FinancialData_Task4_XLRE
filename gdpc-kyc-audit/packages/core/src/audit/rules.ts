/**
 * The audit rules.
 *
 * Each rule is a pure function from a record (plus its verification result and
 * the batch indexes) to zero or more findings. Purity matters here: it is what
 * lets the same rule run in the Worker, in a test, and in a re-run against a
 * stored batch and produce byte-identical findings, which is the basis of a
 * defensible audit trail.
 */

import type { Finding, Rule, RuleContext } from "../types.js";
import { codeSpec } from "./codes.js";
import { matchAgainstCard } from "../match/name-match.js";
import { ageInYears, isDayMonthTransposition, type DateParse } from "../normalize/dates.js";
import type { GhanaCardParse } from "../normalize/ghana-card.js";
import type { MsisdnParse } from "../normalize/msisdn.js";
import type { MoneyParse } from "../normalize/money.js";
import type { EnumResolution } from "../normalize/enums.js";
import { sameGhanaCard } from "../normalize/ghana-card.js";

/** Build a finding from the catalogue, allowing per-instance overrides. */
function finding(
  ctx: RuleContext,
  code: string,
  fieldId: string | null,
  message: string,
  extra: Partial<Finding> = {},
): Finding {
  const spec = codeSpec(code);
  return {
    code: spec.code,
    category: spec.category,
    severity: spec.severity,
    disposition: spec.disposition,
    rowNumber: ctx.record.rowNumber,
    recordKey: ctx.record.recordKey,
    fieldId,
    message,
    ...extra,
  };
}

function valueOf(ctx: RuleContext, fieldId: string): unknown {
  return ctx.record.fields[fieldId]?.value ?? null;
}

function parseOf<T>(ctx: RuleContext, fieldId: string): T | null {
  return (ctx.record.fields[fieldId]?.parse as T | undefined) ?? null;
}

function hasField(ctx: RuleContext, fieldId: string): boolean {
  return ctx.table.fields.some((f) => f.id === fieldId);
}

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

export const requiredFieldsRule: Rule = {
  code: "REQUIRED_FIELD_EMPTY",
  category: "structural",
  evaluate(ctx) {
    const findings: Finding[] = [];
    for (const field of ctx.table.fields) {
      if (!field.required) continue;
      const cell = ctx.record.fields[field.id];
      if (!cell) continue;

      // Fields with a dedicated rule report their own, more specific code.
      if (DEDICATED_REQUIRED.has(field.id)) continue;

      if (cell.value === null || cell.value === "") {
        findings.push(
          finding(ctx, "REQUIRED_FIELD_EMPTY", field.id, `'${field.header}' is required but empty.`, {
            observed: cell.raw,
          }),
        );
      }
    }
    return findings;
  },
};

const DEDICATED_REQUIRED = new Set([
  "depositor.ghana_card_pin",
  "depositor.date_of_birth",
  "depositor.mobile_number",
  "depositor.surname",
  "depositor.first_name",
  "account.account_number",
  "account.balance",
]);

export const truncationRule: Rule = {
  code: "VALUE_TRUNCATED",
  category: "structural",
  evaluate(ctx) {
    const findings: Finding[] = [];
    for (const field of ctx.table.fields) {
      const cell = ctx.record.fields[field.id];
      if (!cell) continue;
      if (cell.notes.some((n) => n.startsWith("Truncated from"))) {
        findings.push(
          finding(ctx, "VALUE_TRUNCATED", field.id, cell.notes.find((n) => n.startsWith("Truncated"))!, {
            observed: cell.raw,
            proposedValue: cell.value,
            confidence: 1,
          }),
        );
      }
    }
    return findings;
  },
};

export const customerIdRule: Rule = {
  code: "CUSTOMER_ID_MISSING",
  category: "structural",
  evaluate(ctx) {
    const idField = ctx.table.fields.find((f) => f.id.endsWith(".customer_id"));
    if (!idField) return [];
    const value = valueOf(ctx, idField.id);
    if (value === null || String(value).trim() === "") {
      return [
        finding(ctx, "CUSTOMER_ID_MISSING", idField.id,
          "The row carries no customer identifier, so it cannot be linked to the depositor record."),
      ];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const ghanaCardRule: Rule = {
  code: "ID_MISSING",
  category: "identity",
  evaluate(ctx) {
    const fieldId = "depositor.ghana_card_pin";
    if (!hasField(ctx, fieldId)) return [];

    const cell = ctx.record.fields[fieldId];
    if (!cell) return [];
    const parse = parseOf<GhanaCardParse>(ctx, fieldId);
    const findings: Finding[] = [];

    if (!parse || parse.problems.includes("empty")) {
      return [
        finding(ctx, "ID_MISSING", fieldId,
          "No Ghana Card number was captured for this depositor.", { observed: cell.raw }),
      ];
    }

    if (parse.problems.includes("placeholder")) {
      findings.push(
        finding(ctx, "ID_PLACEHOLDER", fieldId,
          `'${String(cell.raw)}' is filler rather than a real Ghana Card number.`,
          { observed: cell.raw }),
      );
      return findings;
    }

    if (!parse.normalized) {
      findings.push(
        finding(ctx, "ID_FORMAT_INVALID", fieldId,
          `'${String(cell.raw)}' is not a valid Ghana Card number (${parse.problems.join(", ")}).`,
          { observed: cell.raw }),
      );
      return findings;
    }

    if (parse.changed) {
      findings.push(
        finding(ctx, "ID_NORMALISED", fieldId,
          `Reformatted to the canonical ${parse.normalized}.`,
          { observed: cell.raw, proposedValue: parse.normalized, confidence: 1 }),
      );
    }

    return findings;
  },
};

export const verificationRule: Rule = {
  code: "ID_NOT_FOUND",
  category: "identity",
  evaluate(ctx) {
    const fieldId = "depositor.ghana_card_pin";
    if (!hasField(ctx, fieldId) || !ctx.verification) return [];

    const pin = valueOf(ctx, fieldId);
    const findings: Finding[] = [];

    switch (ctx.verification.status) {
      case "not_found":
        findings.push(
          finding(ctx, "ID_NOT_FOUND", fieldId,
            `The National Identification Authority has no record of ${String(pin)}.`,
            { observed: pin, evidence: { reason: ctx.verification.reason } }),
        );
        break;

      case "invalid_input":
        findings.push(
          finding(ctx, "ID_FORMAT_INVALID", fieldId,
            `The NIA rejected ${String(pin)} as malformed.`,
            { observed: pin, evidence: { reason: ctx.verification.reason } }),
        );
        break;

      case "unavailable":
        findings.push(
          finding(ctx, "ID_VERIFICATION_UNAVAILABLE", fieldId,
            "The identity verification service was unavailable, so this record is unverified.",
            { evidence: { reason: ctx.verification.reason } }),
        );
        break;

      case "verified": {
        const expiry = ctx.verification.identity.expiryDate;
        if (expiry && expiry < ctx.config.today) {
          findings.push(
            finding(ctx, "ID_EXPIRED", fieldId,
              `The Ghana Card expired on ${expiry}.`,
              { expected: expiry, evidence: { expiryDate: expiry } }),
          );
        }
        break;
      }

      case "skipped":
        break;
    }

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

export const nameRule: Rule = {
  code: "NAME_MISMATCH",
  category: "name",
  evaluate(ctx) {
    if (!hasField(ctx, "depositor.surname")) return [];

    const surname = valueOf(ctx, "depositor.surname");
    const first = valueOf(ctx, "depositor.first_name");
    const others = valueOf(ctx, "depositor.other_names");

    const bankName = [first, others, surname]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" ");

    const findings: Finding[] = [];

    if (bankName.trim() === "") {
      return [
        finding(ctx, "NAME_MISSING", "depositor.surname",
          "No usable depositor name was captured."),
      ];
    }

    // Report honorific removal so the auditor sees why the value changed.
    for (const fieldId of ["depositor.surname", "depositor.first_name", "depositor.other_names"]) {
      const cell = ctx.record.fields[fieldId];
      const note = cell?.notes.find((n) => n.startsWith("Honorific removed"));
      if (note) {
        findings.push(
          finding(ctx, "NAME_TITLE_STRIPPED", fieldId, note, {
            observed: cell!.raw,
            proposedValue: cell!.value,
            confidence: 1,
          }),
        );
      }
    }

    // Without an authoritative record there is nothing to compare against.
    if (!ctx.verification || ctx.verification.status !== "verified") return findings;

    const card = ctx.verification.identity;
    const result = matchAgainstCard(bankName, card, {
      mismatchThreshold: ctx.config.nameMismatchThreshold,
    });

    const cardName = [card.firstName, card.middleName, card.lastName]
      .filter((p): p is string => !!p)
      .join(" ");

    const evidence = {
      score: result.score,
      verdict: result.verdict,
      alignment: result.alignment,
      bankName,
      cardName,
    };

    switch (result.verdict) {
      case "exact":
        break;

      case "reordered":
        findings.push(
          finding(ctx, "NAME_ORDER_DIFFERS", "depositor.surname", result.explanation, {
            observed: bankName,
            expected: cardName,
            proposedValue: { surname: card.lastName, first_name: card.firstName, other_names: card.middleName },
            confidence: result.score,
            evidence,
          }),
        );
        break;

      case "variant":
        findings.push(
          finding(ctx, "NAME_VARIANT", "depositor.surname", result.explanation, {
            observed: bankName,
            expected: cardName,
            proposedValue: { surname: card.lastName, first_name: card.firstName, other_names: card.middleName },
            confidence: result.score,
            evidence,
          }),
        );
        break;

      case "subset":
        findings.push(
          finding(ctx, "NAME_MISSING_COMPONENT", "depositor.other_names", result.explanation, {
            observed: bankName,
            expected: cardName,
            proposedValue: card.middleName,
            confidence: result.score,
            evidence,
          }),
        );
        break;

      case "partial":
        findings.push(
          finding(ctx, "NAME_EXTRA_COMPONENT", "depositor.surname", result.explanation, {
            observed: bankName,
            expected: cardName,
            confidence: result.score,
            evidence,
          }),
        );
        break;

      case "mismatch":
        findings.push(
          finding(ctx, "NAME_MISMATCH", "depositor.surname", result.explanation, {
            observed: bankName,
            expected: cardName,
            confidence: 1 - result.score,
            evidence,
          }),
        );
        break;
    }

    if (result.alignment.some((a) => a.reason === "initial")) {
      findings.push(
        finding(ctx, "NAME_INITIAL_ONLY", "depositor.first_name",
          "The bank record holds an initial where the Ghana Card carries a full name.",
          { observed: bankName, expected: cardName, proposedValue: card.firstName, confidence: 0.9 }),
      );
    }

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Date of birth
// ---------------------------------------------------------------------------

export const dobRule: Rule = {
  code: "DOB_MISMATCH",
  category: "dob",
  evaluate(ctx) {
    const fieldId = "depositor.date_of_birth";
    if (!hasField(ctx, fieldId)) return [];

    const cell = ctx.record.fields[fieldId];
    if (!cell) return [];
    const parse = parseOf<DateParse>(ctx, fieldId);
    const findings: Finding[] = [];

    if (!parse || parse.problems.includes("empty")) {
      return [finding(ctx, "DOB_MISSING", fieldId, "No date of birth was captured.", { observed: cell.raw })];
    }
    if (parse.problems.includes("impossible")) {
      return [
        finding(ctx, "DOB_IMPOSSIBLE", fieldId,
          `'${String(cell.raw)}' denotes a day that does not exist.`, { observed: cell.raw }),
      ];
    }
    if (!parse.iso) {
      return [
        finding(ctx, "DOB_UNPARSEABLE", fieldId,
          `'${String(cell.raw)}' could not be read as a date.`, { observed: cell.raw }),
      ];
    }
    if (parse.problems.includes("future")) {
      findings.push(
        finding(ctx, "DOB_FUTURE", fieldId, `${parse.iso} is in the future.`, { observed: cell.raw }),
      );
    }
    if (parse.problems.includes("placeholder")) {
      findings.push(
        finding(ctx, "DOB_PLACEHOLDER", fieldId,
          `${parse.iso} is a placeholder, not a captured date of birth.`, { observed: cell.raw }),
      );
    }

    const age = ageInYears(parse.iso, ctx.config.today);
    if (age < ctx.config.minAccountHolderAge || age > 120) {
      findings.push(
        finding(ctx, "DOB_IMPLAUSIBLE_AGE", fieldId,
          `The date of birth implies an age of ${age}, which is outside the plausible range.`,
          { observed: parse.iso, evidence: { age } }),
      );
    }

    const verified = ctx.verification?.status === "verified" ? ctx.verification.identity : null;
    const cardDob = verified?.dateOfBirth ?? null;

    if (!cardDob) {
      // No authority to settle an ambiguous reading — flag it for a human.
      if (parse.ambiguous && parse.transposedIso) {
        findings.push(
          finding(ctx, "DOB_AMBIGUOUS", fieldId,
            `'${String(cell.raw)}' reads as ${parse.iso} day-first but ${parse.transposedIso} month-first, and no Ghana Card record was available to settle it.`,
            { observed: cell.raw, evidence: { dayFirst: parse.iso, monthFirst: parse.transposedIso } }),
        );
      }
      return findings;
    }

    if (cardDob === parse.iso) return findings;

    // The transposed reading matches the card: a locale error, safely correctable.
    if (parse.transposedIso === cardDob || isDayMonthTransposition(parse.iso, cardDob)) {
      findings.push(
        finding(ctx, "DOB_TRANSPOSED", fieldId,
          `The captured date has day and month transposed relative to the Ghana Card; ${parse.iso} should be ${cardDob}.`,
          { observed: parse.iso, expected: cardDob, proposedValue: cardDob, confidence: 0.97 }),
      );
      return findings;
    }

    findings.push(
      finding(ctx, "DOB_MISMATCH", fieldId,
        `The bank holds ${parse.iso}; the Ghana Card records ${cardDob}.`,
        { observed: parse.iso, expected: cardDob, proposedValue: cardDob, confidence: 0.9 }),
    );

    return findings;
  },
};

export const genderRule: Rule = {
  code: "ENUM_INVALID",
  category: "identity",
  evaluate(ctx) {
    const fieldId = "depositor.gender";
    if (!hasField(ctx, fieldId)) return [];
    const verified = ctx.verification?.status === "verified" ? ctx.verification.identity : null;
    if (!verified?.gender) return [];

    const bank = valueOf(ctx, fieldId);
    const cardGender = verified.gender.trim().toUpperCase().startsWith("F") ? "F" : "M";
    if (bank && bank !== cardGender) {
      return [
        finding(ctx, "ENUM_INVALID", fieldId,
          `The bank records gender '${String(bank)}'; the Ghana Card records '${cardGender}'.`,
          { observed: bank, expected: cardGender, proposedValue: cardGender, confidence: 0.95 }),
      ];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export const phoneRule: Rule = {
  code: "PHONE_MISSING",
  category: "contact",
  evaluate(ctx) {
    const fieldId = "depositor.mobile_number";
    if (!hasField(ctx, fieldId)) return [];

    const cell = ctx.record.fields[fieldId];
    if (!cell) return [];
    const parse = parseOf<MsisdnParse>(ctx, fieldId);
    const findings: Finding[] = [];

    if (!parse || parse.problems.includes("empty")) {
      return [
        finding(ctx, "PHONE_MISSING", fieldId,
          "No mobile number was captured. A reachable number is required for payout notification.",
          { observed: cell.raw }),
      ];
    }

    if (parse.problems.includes("repeated_digits")) {
      return [
        finding(ctx, "PHONE_FILLER", fieldId,
          `'${String(cell.raw)}' is a repeated-digit placeholder, not a real number.`,
          { observed: cell.raw }),
      ];
    }

    if (!parse.e164 || parse.problems.includes("too_short") || parse.problems.includes("too_long")) {
      return [
        finding(ctx, "PHONE_FORMAT_INVALID", fieldId,
          `'${String(cell.raw)}' is not a valid Ghanaian mobile number (${parse.problems.join(", ")}).`,
          { observed: cell.raw }),
      ];
    }

    if (parse.problems.includes("unknown_prefix")) {
      findings.push(
        finding(ctx, "PHONE_UNKNOWN_PREFIX", fieldId,
          `Network code '${parse.networkCode}' is not one allocated to a Ghanaian operator.`,
          { observed: parse.e164 }),
      );
    }

    if (parse.changed && parse.e164) {
      findings.push(
        finding(ctx, "PHONE_NORMALISED", fieldId,
          `Normalised to ${parse.e164}${parse.operator ? ` (${parse.operator})` : ""}.`,
          { observed: cell.raw, proposedValue: parse.e164, confidence: 1 }),
      );
    }

    if (parse.additional.length > 0) {
      findings.push(
        finding(ctx, "PHONE_MULTIPLE_IN_CELL", fieldId,
          `The cell held more than one number; ${parse.e164} was taken as primary and ${parse.additional.join(", ")} moved to the alternate field.`,
          { observed: cell.raw, proposedValue: parse.additional[0], confidence: 0.9 }),
      );
    }

    // Shared across unrelated depositors.
    if (parse.e164) {
      const sharers = ctx.indexes.byMsisdn.get(parse.e164) ?? [];
      if (sharers.length > ctx.config.sharedPhoneThreshold) {
        findings.push(
          finding(ctx, "PHONE_SHARED", fieldId,
            `${sharers.length} depositors in this submission share the number ${parse.e164}.`,
            {
              observed: parse.e164,
              evidence: { count: sharers.length, rows: sharers.map((r) => r.rowNumber).slice(0, 20) },
            }),
        );
      }
    }

    if (ctx.phone?.riskLevel && ["high", "very_high"].includes(ctx.phone.riskLevel.toLowerCase())) {
      findings.push(
        finding(ctx, "PHONE_HIGH_RISK", fieldId,
          `The phone intelligence provider rates ${parse.e164} as ${ctx.phone.riskLevel} risk.`,
          { observed: parse.e164, evidence: { riskScore: ctx.phone.riskScore, carrier: ctx.phone.carrier } }),
      );
    }

    return findings;
  },
};

export const emailRule: Rule = {
  code: "EMAIL_INVALID",
  category: "contact",
  evaluate(ctx) {
    const fieldId = "depositor.email";
    if (!hasField(ctx, fieldId)) return [];
    const cell = ctx.record.fields[fieldId];
    if (!cell || cell.raw === null) return [];
    if (cell.value === null && cell.notes.some((n) => n.includes("well-formed"))) {
      return [
        finding(ctx, "EMAIL_INVALID", fieldId,
          `'${String(cell.raw)}' is not a well-formed email address.`, { observed: cell.raw }),
      ];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export const accountRule: Rule = {
  code: "ACCOUNT_NUMBER_MISSING",
  category: "account",
  evaluate(ctx) {
    if (!hasField(ctx, "account.account_number")) return [];
    const findings: Finding[] = [];

    const accountNumber = valueOf(ctx, "account.account_number");
    if (!accountNumber) {
      findings.push(
        finding(ctx, "ACCOUNT_NUMBER_MISSING", "account.account_number",
          "The account row carries no account number."),
      );
    } else {
      const duplicates = ctx.indexes.byAccountNumber.get(String(accountNumber)) ?? [];
      if (duplicates.length > 1) {
        findings.push(
          finding(ctx, "ACCOUNT_DUPLICATE", "account.account_number",
            `Account number ${String(accountNumber)} appears on ${duplicates.length} rows.`,
            {
              observed: accountNumber,
              evidence: { rows: duplicates.map((r) => r.rowNumber) },
            }),
        );
      }
    }

    const balanceCell = ctx.record.fields["account.balance"];
    const balanceParse = parseOf<MoneyParse>(ctx, "account.balance");
    if (balanceCell) {
      if (!balanceParse || balanceParse.problems.includes("empty")) {
        findings.push(
          finding(ctx, "BALANCE_MISSING", "account.balance",
            "The account balance is missing.", { observed: balanceCell.raw }),
        );
      } else if (balanceParse.problems.includes("not_numeric")) {
        findings.push(
          finding(ctx, "BALANCE_NOT_NUMERIC", "account.balance",
            `'${String(balanceCell.raw)}' is not a number.`, { observed: balanceCell.raw }),
        );
      } else if (balanceParse.problems.includes("negative")) {
        findings.push(
          finding(ctx, "BALANCE_NEGATIVE", "account.balance",
            `The balance is ${balanceParse.value}. An overdrawn account is not an insurable deposit.`,
            { observed: balanceParse.value }),
        );
      }

      if (balanceParse?.detectedCurrency) {
        const declared = valueOf(ctx, "account.currency");
        if (declared && declared !== balanceParse.detectedCurrency) {
          findings.push(
            finding(ctx, "CURRENCY_INVALID", "account.currency",
              `The balance cell carries a ${balanceParse.detectedCurrency} symbol but the currency column says ${String(declared)}.`,
              { observed: declared, expected: balanceParse.detectedCurrency }),
          );
        }
      }
    }

    // Lien cannot exceed the balance.
    const lien = valueOf(ctx, "account.lien_amount");
    const balance = balanceParse?.value ?? null;
    if (typeof lien === "number" && typeof balance === "number" && lien > balance) {
      findings.push(
        finding(ctx, "LIEN_EXCEEDS_BALANCE", "account.lien_amount",
          `The lien of ${lien} exceeds the balance of ${balance}.`,
          { observed: lien, expected: balance }),
      );
    }

    // Opening date in the future.
    const opened = valueOf(ctx, "account.date_opened");
    if (typeof opened === "string" && opened > ctx.config.today) {
      findings.push(
        finding(ctx, "DATE_OPENED_FUTURE", "account.date_opened",
          `The account opening date ${opened} is in the future.`, { observed: opened }),
      );
    }

    return findings;
  },
};

export const enumRule: Rule = {
  code: "ENUM_INVALID",
  category: "account",
  evaluate(ctx) {
    const findings: Finding[] = [];
    for (const field of ctx.table.fields) {
      if (field.kind !== "enum") continue;
      if (field.id === "depositor.gender") continue; // handled against the card

      const cell = ctx.record.fields[field.id];
      if (!cell || cell.raw === null) continue;

      const resolution = cell.parse as EnumResolution | undefined;
      if (!resolution) continue;

      if (resolution.value === null) {
        if (field.required || String(cell.raw).trim() !== "") {
          findings.push(
            finding(ctx, "ENUM_INVALID", field.id,
              `'${String(cell.raw)}' is not one of the permitted values for '${field.header}' (${(field.enumValues ?? []).join(", ")}).`,
              { observed: cell.raw, evidence: { permitted: field.enumValues } }),
          );
        }
      } else if (resolution.method === "fuzzy") {
        findings.push(
          finding(ctx, "ENUM_INVALID", field.id,
            `'${String(cell.raw)}' is not a permitted value; '${resolution.value}' is the closest match.`,
            { observed: cell.raw, proposedValue: resolution.value, confidence: resolution.confidence }),
        );
      } else if (resolution.method === "synonym") {
        findings.push(
          finding(ctx, "ENUM_NORMALISED", field.id,
            `'${String(cell.raw)}' mapped to the template value '${resolution.value}'.`,
            { observed: cell.raw, proposedValue: resolution.value, confidence: resolution.confidence }),
        );
      }
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// Cross-record
// ---------------------------------------------------------------------------

export const duplicateIdentityRule: Rule = {
  code: "ID_DUPLICATE",
  category: "cross_record",
  evaluate(ctx) {
    const findings: Finding[] = [];
    const pin = valueOf(ctx, "depositor.ghana_card_pin");

    if (typeof pin === "string" && pin.length > 0) {
      const sharers = ctx.indexes.byGhanaCard.get(pin) ?? [];
      const distinctCustomers = new Set(
        sharers.map((r) => String(r.fields["depositor.customer_id"]?.value ?? r.recordKey)),
      );
      if (distinctCustomers.size > 1) {
        findings.push(
          finding(ctx, "ID_DUPLICATE", "depositor.ghana_card_pin",
            `Ghana Card ${pin} is recorded against ${distinctCustomers.size} different customer identifiers.`,
            {
              observed: pin,
              evidence: {
                customerIds: [...distinctCustomers].slice(0, 10),
                rows: sharers.map((r) => r.rowNumber).slice(0, 20),
              },
            }),
        );
      }
    }

    // Same name + DOB under different customer ids.
    const surname = valueOf(ctx, "depositor.surname");
    const first = valueOf(ctx, "depositor.first_name");
    const dob = valueOf(ctx, "depositor.date_of_birth");
    if (surname && first && dob) {
      const key = `${String(surname)}|${String(first)}|${String(dob)}`;
      const peers = ctx.indexes.byNameDob.get(key) ?? [];
      const distinct = new Set(
        peers.map((r) => String(r.fields["depositor.customer_id"]?.value ?? r.recordKey)),
      );
      if (distinct.size > 1) {
        findings.push(
          finding(ctx, "POSSIBLE_DUPLICATE_PERSON", "depositor.customer_id",
            `${distinct.size} customer records share the name and date of birth '${String(first)} ${String(surname)}, ${String(dob)}'.`,
            {
              observed: key,
              evidence: {
                customerIds: [...distinct].slice(0, 10),
                rows: peers.map((r) => r.rowNumber).slice(0, 20),
              },
            }),
        );
      }
    }

    return findings;
  },
};

export const customerIdUniquenessRule: Rule = {
  code: "CUSTOMER_ID_DUPLICATE",
  category: "structural",
  evaluate(ctx) {
    // Only meaningful on the depositor table, where the id must be unique.
    if (ctx.table.id !== "A") return [];
    const id = valueOf(ctx, "depositor.customer_id");
    if (!id) return [];

    const peers = ctx.batch.filter(
      (r) => r.tableId === "A" && String(r.fields["depositor.customer_id"]?.value ?? "") === String(id),
    );
    if (peers.length <= 1) return [];

    // Two rows with the same id but a different Ghana Card are different people.
    const pins = new Set(
      peers
        .map((r) => r.fields["depositor.ghana_card_pin"]?.value)
        .filter((v): v is string => typeof v === "string"),
    );
    const distinctPeople = pins.size > 1 || ![...pins].every((p) => sameGhanaCard(p, [...pins][0]));

    if (distinctPeople) {
      return [
        finding(ctx, "CUSTOMER_ID_DUPLICATE", "depositor.customer_id",
          `Customer identifier '${String(id)}' is used by ${peers.length} rows carrying different Ghana Card numbers.`,
          { observed: id, evidence: { rows: peers.map((r) => r.rowNumber) } }),
      ];
    }
    return [];
  },
};

/** The rules applied to every record, in the order their findings are reported. */
export const ALL_RULES: Rule[] = [
  customerIdRule,
  customerIdUniquenessRule,
  requiredFieldsRule,
  ghanaCardRule,
  verificationRule,
  nameRule,
  dobRule,
  genderRule,
  phoneRule,
  emailRule,
  accountRule,
  enumRule,
  duplicateIdentityRule,
  truncationRule,
];
