/**
 * Monetary amount parsing.
 *
 * Balances arrive as `GH¢ 1,234.56`, `1 234,56`, `(500.00)` for a negative, or
 * as text where a formula failed. Getting this wrong misstates the insured
 * amount, so the parser is deliberately strict about what it will accept and
 * explicit about what it rejected.
 */

import { cleanCell, isNullToken } from "./text.js";

export type MoneyProblem = "empty" | "not_numeric" | "negative" | "excessive_precision";

export interface MoneyParse {
  /** Amount in major units, rounded to 2 decimal places. */
  value: number | null;
  problems: MoneyProblem[];
  changed: boolean;
  /** Currency symbol found in the cell, if any — a hint the column is mixed. */
  detectedCurrency: string | null;
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/GH[¢C₵]|₵/i, "GHS"],
  [/\bGHS\b/i, "GHS"],
  [/US\$|\$|\bUSD\b/i, "USD"],
  [/£|\bGBP\b/i, "GBP"],
  [/€|\bEUR\b/i, "EUR"],
];

export function parseMoney(input: unknown): MoneyParse {
  if (typeof input === "number" && Number.isFinite(input)) {
    return finish(input, [], false, null);
  }

  const raw = cleanCell(input);
  if (raw === "" || isNullToken(raw)) {
    // A literal zero is a real balance, not an empty cell.
    if (raw === "0") return finish(0, [], false, null);
    return { value: null, problems: ["empty"], changed: false, detectedCurrency: null };
  }

  let detectedCurrency: string | null = null;
  for (const [pattern, code] of CURRENCY_SYMBOLS) {
    if (pattern.test(raw)) {
      detectedCurrency = code;
      break;
    }
  }

  // Accounting negatives: (1,234.56)
  const parenthesised = /^\((.*)\)$/.exec(raw);
  const body = parenthesised ? parenthesised[1]! : raw;

  // Strip currency words/symbols and spaces, keep digits, separators and sign.
  let cleaned = body
    .replace(/[A-Za-z¢₵$£€]/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (cleaned === "") {
    return { value: null, problems: ["not_numeric"], changed: true, detectedCurrency };
  }

  cleaned = normaliseSeparators(cleaned);

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return { value: null, problems: ["not_numeric"], changed: true, detectedCurrency };
  }

  const signed = parenthesised ? -Math.abs(parsed) : parsed;
  return finish(signed, [], true, detectedCurrency);
}

/**
 * Decide whether `.` or `,` is the decimal mark.
 *
 * `1,234.56` is Anglo, `1.234,56` is continental, `1,234` is ambiguous but far
 * more likely a thousands group than a two-place decimal in a balance column.
 */
function normaliseSeparators(input: string): string {
  const lastComma = input.lastIndexOf(",");
  const lastDot = input.lastIndexOf(".");

  if (lastComma === -1 && lastDot === -1) return input;

  if (lastComma > lastDot) {
    // Comma is the decimal mark: strip dots, swap the comma.
    const decimals = input.length - lastComma - 1;
    if (decimals <= 2) {
      return input.replace(/\./g, "").replace(",", ".");
    }
    // More than two digits after the last comma — it was a thousands separator.
    return input.replace(/,/g, "");
  }

  // Dot is the decimal mark (or there is no comma): strip commas.
  return input.replace(/,/g, "");
}

function finish(
  value: number,
  problems: MoneyProblem[],
  changed: boolean,
  detectedCurrency: string | null,
): MoneyParse {
  const rounded = Math.round(value * 100) / 100;
  const all = [...problems];
  if (Math.abs(value - rounded) > 1e-9) all.push("excessive_precision");
  if (rounded < 0) all.push("negative");
  return { value: rounded, problems: all, changed: changed || rounded !== value, detectedCurrency };
}

/** Format for the exported workbook — plain, no separators, two decimals. */
export function formatMoney(value: number | null): string {
  if (value === null) return "";
  return value.toFixed(2);
}
