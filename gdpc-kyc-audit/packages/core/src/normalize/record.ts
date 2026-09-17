/**
 * Turn mapped raw rows into normalised records.
 *
 * Normalisation is separated from auditing on purpose: this stage only cleans
 * and canonicalises, recording exactly what it changed and what it could not
 * make sense of. The rules in `audit/` then decide what any of it means. That
 * split is what lets the audit report state, for every cell, both the value the
 * bank supplied and the value being submitted.
 */

import type {
  FieldSpec,
  MappingPlan,
  NormalizedRecord,
  NormalizedValue,
  RawCell,
  RawRow,
  TableSpec,
} from "../types.js";
import { cleanCell, isNullToken } from "./text.js";
import { parseGhanaCard } from "./ghana-card.js";
import { parseMsisdn } from "./msisdn.js";
import { parseDate, type DateParseOptions } from "./dates.js";
import { parseMoney } from "./money.js";
import { resolveBoolean, resolveEnum } from "./enums.js";
import { parseName } from "./names.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

export interface NormalizeOptions {
  dateOptions?: DateParseOptions;
  /** Prefix for synthetic record keys, usually the batch id. */
  keyPrefix?: string;
}

export function normalizeRows(
  rows: RawRow[],
  table: TableSpec,
  plan: MappingPlan,
  options: NormalizeOptions = {},
): NormalizedRecord[] {
  const bySource = new Map<string, string | null>();
  for (const mapping of plan.mappings) bySource.set(mapping.fieldId, mapping.sourceHeader);

  return rows.map((row) => normalizeRow(row, table, bySource, options));
}

function normalizeRow(
  row: RawRow,
  table: TableSpec,
  sourceByField: Map<string, string | null>,
  options: NormalizeOptions,
): NormalizedRecord {
  const fields: Record<string, NormalizedValue> = {};

  // A combined-name column feeds three fields, so resolve it once up front.
  const nameSplit = splitCombinedName(row, sourceByField);

  for (const field of table.fields) {
    const header = sourceByField.get(field.id) ?? null;
    const raw: RawCell = header === null ? null : (row.cells[header] ?? null);

    if (nameSplit && field.id in nameSplit) {
      fields[field.id] = nameSplit[field.id]!;
      continue;
    }

    fields[field.id] = normalizeField(field, raw, options);
  }

  const keyPrefix = options.keyPrefix ? `${options.keyPrefix}:` : "";
  const keyValue = fields[table.keyField]?.value;
  const recordKey =
    keyValue != null && String(keyValue).length > 0
      ? `${keyPrefix}${table.id}:${String(keyValue)}`
      : `${keyPrefix}${table.id}:row${row.rowNumber}`;

  return { rowNumber: row.rowNumber, recordKey, tableId: table.id, fields };
}

export function normalizeField(
  field: FieldSpec,
  raw: RawCell,
  options: NormalizeOptions = {},
): NormalizedValue {
  const notes: string[] = [];

  // Kinds whose own parser distinguishes "blank" from "filled with junk". Short-
  // circuiting these here would report `0000000000` as a missing phone number
  // rather than as the placeholder it is, losing the distinction the auditor
  // needs — a blank field is a capture gap, filler is a data-quality failure.
  const PARSER_OWNED = new Set(["msisdn", "ghana_card", "date", "money"]);

  if (raw === null || (isNullToken(raw) && !PARSER_OWNED.has(field.kind))) {
    return { value: null, raw, changed: false, notes };
  }

  switch (field.kind) {
    case "ghana_card": {
      const parse = parseGhanaCard(raw);
      if (parse.changed && parse.normalized) {
        notes.push(`Reformatted to ${parse.normalized}.`);
      }
      return { value: parse.normalized, raw, changed: parse.changed, notes, parse };
    }

    case "msisdn": {
      const parse = parseMsisdn(raw);
      if (parse.changed && parse.e164) notes.push(`Normalised to ${parse.e164}.`);
      if (parse.additional.length > 0) {
        notes.push(`Additional number(s) found in the same cell: ${parse.additional.join(", ")}.`);
      }
      return { value: parse.e164, raw, changed: parse.changed, notes, parse };
    }

    case "date": {
      const parse = parseDate(raw, options.dateOptions);
      if (parse.changed && parse.iso) notes.push(`Read as ${parse.iso}.`);
      if (parse.ambiguous && parse.transposedIso) {
        notes.push(
          `Ambiguous: could also be ${parse.transposedIso} if the source was month-first.`,
        );
      }
      return { value: parse.iso, raw, changed: parse.changed, notes, parse };
    }

    case "money": {
      const parse = parseMoney(raw);
      if (parse.detectedCurrency) {
        notes.push(`Currency symbol '${parse.detectedCurrency}' removed from the amount.`);
      }
      return { value: parse.value, raw, changed: parse.changed, notes, parse };
    }

    case "integer": {
      const cleaned = cleanCell(raw).replace(/[,\s]/g, "");
      const value = /^-?\d+$/.test(cleaned) ? Number(cleaned) : null;
      return { value, raw, changed: value !== null && String(value) !== cleanCell(raw), notes };
    }

    case "enum": {
      const resolution = resolveEnum(field.id, raw, field.enumValues);
      if (resolution.value && resolution.method !== "exact") {
        notes.push(`'${cleanCell(raw)}' mapped to '${resolution.value}'.`);
      }
      return {
        value: resolution.value,
        raw,
        changed: resolution.value !== null && resolution.method !== "exact",
        notes,
        parse: resolution,
      };
    }

    case "boolean": {
      const value = resolveBoolean(raw);
      return { value, raw, changed: value !== null, notes };
    }

    case "email": {
      const cleaned = cleanCell(raw).toLowerCase();
      const valid = EMAIL_PATTERN.test(cleaned);
      if (!valid) notes.push("Not a well-formed email address.");
      return { value: valid ? cleaned : null, raw, changed: cleaned !== cleanCell(raw), notes };
    }

    case "name": {
      const parsed = parseName(raw);
      if (parsed.titles.length > 0) {
        notes.push(`Honorific removed: ${parsed.titles.join(", ")}.`);
      }
      if (parsed.commaInverted) {
        notes.push("Re-ordered from 'SURNAME, Other names' form.");
      }
      return {
        value: parsed.normalized || null,
        raw,
        changed: parsed.changed,
        notes,
        parse: parsed,
      };
    }

    case "other_id":
    case "text":
    default: {
      let value: string | null = cleanCell(raw);
      if (value === "") value = null;
      let changed = value !== null && value !== String(raw ?? "");
      if (value && field.maxLength && value.length > field.maxLength) {
        notes.push(
          `Truncated from ${value.length} to ${field.maxLength} characters to fit the template.`,
        );
        value = value.slice(0, field.maxLength);
        changed = true;
      }
      return { value, raw, changed, notes };
    }
  }
}

/**
 * When the bank supplies one combined name column, split it into the discrete
 * fields the template needs.
 *
 * Which token is the surname cannot be known from the string alone, so the
 * split follows the dominant Ghanaian convention (surname last unless the cell
 * used `SURNAME, Other names`) and records that it is an assumption. The audit
 * stage then tests the assumption against the Ghana Card and corrects it — that
 * is the right place for the decision, because there the answer is knowable.
 */
function splitCombinedName(
  row: RawRow,
  sourceByField: Map<string, string | null>,
): Record<string, NormalizedValue> | null {
  const surnameHeader = sourceByField.get("depositor.surname");
  const firstHeader = sourceByField.get("depositor.first_name");
  const otherHeader = sourceByField.get("depositor.other_names");

  // Only a split when all the name fields point at the very same column.
  if (!surnameHeader || surnameHeader !== firstHeader) return null;

  const raw = row.cells[surnameHeader] ?? null;
  const parsed = parseName(raw);
  if (parsed.orderedTokens.length === 0) {
    const empty: NormalizedValue = { value: null, raw, changed: false, notes: [] };
    return {
      "depositor.surname": empty,
      "depositor.first_name": empty,
      "depositor.other_names": empty,
    };
  }

  const note = parsed.commaInverted
    ? "Split from a combined name column; the surname was given before the comma."
    : "Split from a combined name column, assuming the surname is last. Verified against the Ghana Card during the audit.";

  // Initials count as name components — `K. Owusu` must yield first `K`, not
  // drop it — so split on the ordered token list rather than the full-word one.
  const tokens = [...parsed.orderedTokens];
  // `SURNAME, Others` has already been reordered to `Others SURNAME` by parseName.
  const surname = tokens.pop() ?? null;
  const first = tokens.shift() ?? null;
  const others = tokens.join(" ") || null;

  const make = (value: string | null): NormalizedValue => ({
    value,
    raw,
    changed: true,
    notes: [note],
    parse: parsed,
  });

  const result: Record<string, NormalizedValue> = {
    "depositor.surname": make(surname),
    "depositor.first_name": make(first),
  };
  if (otherHeader === surnameHeader) {
    result["depositor.other_names"] = make(others);
  }
  return result;
}
