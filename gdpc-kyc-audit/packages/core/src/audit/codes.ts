/**
 * The exception taxonomy.
 *
 * Every finding the engine can raise is declared here with its category,
 * default severity and default disposition. Keeping the catalogue in one place
 * means the audit report, the review UI and the colour legend in the exported
 * workbook can never drift apart, and an auditor can be handed a single sheet
 * that explains every code they will encounter.
 */

import type { Disposition, FindingCategory, Severity } from "../types.js";

export interface CodeSpec {
  code: string;
  category: FindingCategory;
  severity: Severity;
  disposition: Disposition;
  title: string;
  /** What the auditor should do about it. */
  guidance: string;
}

function spec(
  code: string,
  category: FindingCategory,
  severity: Severity,
  disposition: Disposition,
  title: string,
  guidance: string,
): CodeSpec {
  return { code, category, severity, disposition, title, guidance };
}

export const CODE_SPECS: CodeSpec[] = [
  // --- Identity -----------------------------------------------------------
  spec("ID_MISSING", "identity", "critical", "rejected", "Ghana Card number absent",
    "Obtain the depositor's Ghana Card and capture the PIN. The record cannot be submitted without it."),
  spec("ID_FORMAT_INVALID", "identity", "critical", "rejected", "Ghana Card number malformed",
    "The value does not have the GHA-000000000-0 structure. Re-key it from the physical card."),
  spec("ID_PLACEHOLDER", "identity", "critical", "rejected", "Ghana Card number is filler",
    "The captured PIN is a placeholder such as all zeros. Capture the real card number."),
  spec("ID_NORMALISED", "identity", "info", "auto_corrected", "Ghana Card number reformatted",
    "Spacing or casing was corrected to the canonical form. No action needed."),
  spec("ID_NOT_FOUND", "identity", "critical", "conflict", "Ghana Card not found at the NIA",
    "The NIA has no record for this PIN. Verify the card is genuine and re-capture."),
  spec("ID_EXPIRED", "identity", "major", "needs_review", "Ghana Card has expired",
    "The card's expiry date has passed. Ask the depositor to renew before the next submission."),
  spec("ID_DUPLICATE", "identity", "critical", "conflict", "Ghana Card used by more than one depositor",
    "The same PIN appears on multiple customer records. Either they are duplicates to be merged, or one is wrong."),
  spec("ID_VERIFICATION_UNAVAILABLE", "identity", "minor", "needs_review", "NIA check could not be completed",
    "The verification service did not respond. The record is unverified, not incorrect; re-run the check."),

  // --- Name ---------------------------------------------------------------
  spec("NAME_MISSING", "name", "critical", "rejected", "No usable name captured",
    "The name field is empty or contains only filler. Capture the name from the Ghana Card."),
  spec("NAME_ORDER_DIFFERS", "name", "minor", "auto_corrected", "Name components in a different order",
    "The same names appear on both records in a different sequence. The engine re-sequences them to match the card."),
  spec("NAME_VARIANT", "name", "minor", "needs_review", "Accepted spelling or day-name variant",
    "The bank and the card use different renderings of the same name. Confirm, then adopt the card spelling."),
  spec("NAME_MISSING_COMPONENT", "name", "major", "needs_review", "Name component on the card is not held",
    "The Ghana Card carries a name the bank record omits, usually a middle name. Add it."),
  spec("NAME_EXTRA_COMPONENT", "name", "major", "needs_review", "Bank holds a name the card does not",
    "The bank record contains a name absent from the card. Establish which is correct."),
  spec("NAME_INITIAL_ONLY", "name", "major", "needs_review", "Name captured as an initial",
    "An initial stands where the card has a full name. Expand it to the full name."),
  spec("NAME_MISMATCH", "name", "critical", "conflict", "Name does not match the Ghana Card",
    "The names do not correspond. Treat as a different person until the branch proves otherwise."),
  spec("NAME_TITLE_STRIPPED", "name", "info", "auto_corrected", "Honorific removed",
    "A title such as Mr or Alhaji was removed from the name field. No action needed."),

  // --- Date of birth ------------------------------------------------------
  spec("DOB_MISSING", "dob", "critical", "rejected", "Date of birth absent",
    "Capture the date of birth from the Ghana Card."),
  spec("DOB_UNPARSEABLE", "dob", "critical", "rejected", "Date of birth not a valid date",
    "The value could not be read as a date. Re-key it as DD/MM/YYYY."),
  spec("DOB_IMPOSSIBLE", "dob", "critical", "rejected", "Date of birth is not a real date",
    "The value denotes a day that does not exist, such as 31 February."),
  spec("DOB_FUTURE", "dob", "critical", "rejected", "Date of birth is in the future",
    "Correct the year; this is normally a typing error."),
  spec("DOB_PLACEHOLDER", "dob", "major", "needs_review", "Date of birth is a placeholder",
    "Values such as 01/01/1900 mean the branch did not capture a real date."),
  spec("DOB_MISMATCH", "dob", "critical", "conflict", "Date of birth differs from the Ghana Card",
    "The bank and the NIA disagree on the date of birth. Adopt the card value once identity is confirmed."),
  spec("DOB_TRANSPOSED", "dob", "major", "auto_corrected", "Day and month transposed",
    "The bank value matches the card with day and month swapped — a locale error. The engine adopts the card reading."),
  spec("DOB_AMBIGUOUS", "dob", "minor", "needs_review", "Date could be read two ways",
    "Both day-first and month-first readings are valid dates and no card record was available to settle it."),
  spec("DOB_IMPLAUSIBLE_AGE", "dob", "major", "needs_review", "Implausible age",
    "The implied age is below the minimum account-holder age or improbably high."),

  // --- Contact ------------------------------------------------------------
  spec("PHONE_MISSING", "contact", "critical", "rejected", "Mobile number absent",
    "A reachable mobile number is required for payout notification."),
  spec("PHONE_FORMAT_INVALID", "contact", "major", "rejected", "Mobile number malformed",
    "The number is not nine national digits. Re-key it."),
  spec("PHONE_NORMALISED", "contact", "info", "auto_corrected", "Mobile number reformatted",
    "Converted to +233XXXXXXXXX, restoring a leading zero Excel had dropped where needed."),
  spec("PHONE_UNKNOWN_PREFIX", "contact", "minor", "needs_review", "Unrecognised network code",
    "The number is well formed but its network code is not one the NCA has allocated."),
  spec("PHONE_FILLER", "contact", "major", "rejected", "Mobile number is filler",
    "The number is a repeated digit such as 0000000000."),
  spec("PHONE_SHARED", "contact", "major", "needs_review", "Mobile number shared across depositors",
    "One number serves several unrelated customers. Common for family groups, but also a sign of a default value."),
  spec("PHONE_MULTIPLE_IN_CELL", "contact", "minor", "auto_corrected", "Two numbers in one cell",
    "The first number was taken as primary and the second moved to the alternate field."),
  spec("PHONE_HIGH_RISK", "contact", "minor", "needs_review", "Number flagged as high risk",
    "The phone intelligence provider rates this number as risky. Confirm it belongs to the depositor."),
  spec("EMAIL_INVALID", "contact", "minor", "needs_review", "Email address malformed",
    "Correct or clear the address; a malformed value will fail the upload."),

  // --- Account ------------------------------------------------------------
  spec("ACCOUNT_NUMBER_MISSING", "account", "critical", "rejected", "Account number absent",
    "Every account row must carry the account number."),
  spec("ACCOUNT_DUPLICATE", "account", "critical", "rejected", "Account number appears more than once",
    "Duplicate account rows inflate the insured amount. Remove or merge them."),
  spec("BALANCE_MISSING", "account", "critical", "rejected", "Balance absent",
    "Capture the account balance as at the reporting date."),
  spec("BALANCE_NOT_NUMERIC", "account", "critical", "rejected", "Balance is not a number",
    "Remove currency symbols, thousands separators or text from the balance column."),
  spec("BALANCE_NEGATIVE", "account", "major", "needs_review", "Balance is negative",
    "A negative deposit balance is an overdrawn account and is not an insurable deposit."),
  spec("CURRENCY_INVALID", "account", "major", "rejected", "Currency not recognised",
    "Use the ISO code: GHS, USD, GBP or EUR."),
  spec("ENUM_INVALID", "account", "major", "needs_review", "Value outside the permitted list",
    "The value is not one the template accepts. The engine proposes the closest permitted value."),
  spec("ENUM_NORMALISED", "account", "info", "auto_corrected", "Value mapped to the permitted list",
    "A recognised synonym was converted to the template's own code."),
  spec("LIEN_EXCEEDS_BALANCE", "account", "major", "needs_review", "Lien larger than the balance",
    "The encumbered amount exceeds the account balance, which cannot be right."),
  spec("DATE_OPENED_FUTURE", "account", "major", "needs_review", "Account opened in the future",
    "Correct the opening date."),

  // --- Structural ---------------------------------------------------------
  spec("REQUIRED_FIELD_EMPTY", "structural", "critical", "rejected", "Required field empty",
    "The template requires a value in this column."),
  spec("FIELD_UNMAPPED", "structural", "critical", "rejected", "Template field has no source column",
    "No column in the uploaded file supplies this field. Map it before running the alignment."),
  spec("VALUE_TRUNCATED", "structural", "minor", "auto_corrected", "Value longer than the column allows",
    "The value was truncated to the template's maximum length."),
  spec("CUSTOMER_ID_MISSING", "structural", "critical", "rejected", "Customer identifier absent",
    "Every row must carry the bank's customer identifier so the tables can be linked."),
  spec("CUSTOMER_ID_DUPLICATE", "structural", "critical", "rejected", "Customer identifier reused",
    "Two different depositors share one customer id. The link between tables is ambiguous."),
  spec("ORPHAN_RECORD", "structural", "major", "rejected", "Row has no matching depositor",
    "This account or address row refers to a customer id that is not in the depositor table."),

  // --- Cross-record -------------------------------------------------------
  spec("POSSIBLE_DUPLICATE_PERSON", "cross_record", "major", "needs_review", "Possible duplicate depositor",
    "Two records share a name and date of birth but different customer ids. They may be the same person."),
  spec("TOTAL_MISMATCH", "cross_record", "critical", "conflict", "Compensation total does not match the accounts",
    "The total balance reported for the depositor differs from the sum of their account balances."),
  spec("INSURED_EXCEEDS_LIMIT", "cross_record", "critical", "rejected", "Insured amount above the coverage limit",
    "The insured amount exceeds the statutory cap per depositor per institution."),
];

export const CODE_BY_ID = new Map(CODE_SPECS.map((s) => [s.code, s]));

export function codeSpec(code: string): CodeSpec {
  const found = CODE_BY_ID.get(code);
  if (!found) {
    throw new Error(`Unknown finding code '${code}' — add it to CODE_SPECS.`);
  }
  return found;
}

/** Ordering used everywhere findings are displayed. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

export const DISPOSITION_ORDER: Record<Disposition, number> = {
  rejected: 0,
  conflict: 1,
  needs_review: 2,
  auto_corrected: 3,
  clean: 4,
};

/** The most serious disposition in a set — drives the row colour. */
export function worstDisposition(dispositions: Disposition[]): Disposition {
  if (dispositions.length === 0) return "clean";
  return dispositions.reduce((worst, d) =>
    DISPOSITION_ORDER[d] < DISPOSITION_ORDER[worst] ? d : worst,
  );
}
