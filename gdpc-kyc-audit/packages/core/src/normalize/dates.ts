/**
 * Date parsing for depositor records.
 *
 * Ghana writes dates day-first, but spreadsheets exported through a US locale,
 * or opened once in Excel on a machine set to en-US, silently reinterpret them.
 * That produces the single nastiest class of KYC defect: a date of birth that is
 * a *valid* date, just the wrong one — 03/04/1985 meaning 3 April read as 4 March.
 *
 * This module therefore never simply returns a date. It returns the date it
 * believes, plus whether the value was ambiguous, plus the day/month transposed
 * alternative, so the audit engine can test the alternative against the NIA
 * record and prove which reading is correct.
 */

import { cleanCell, isNullToken } from "./text.js";

export type DateProblem =
  | "empty"
  | "unparseable"
  | "impossible"
  | "future"
  | "placeholder"
  | "too_old";

export interface DateParse {
  /** Canonical `YYYY-MM-DD`, or null. */
  iso: string | null;
  /** The same value with day and month swapped, when that is also a real date. */
  transposedIso: string | null;
  /** True when the source could legitimately be read either way (both parts <= 12). */
  ambiguous: boolean;
  /** Which convention produced `iso`. */
  interpretation: "day_first" | "month_first" | "iso" | "excel_serial" | "text_month" | "none";
  problems: DateProblem[];
  changed: boolean;
}

/** Dates that are stand-ins for "unknown" rather than real birthdays. */
export const DEFAULT_PLACEHOLDER_DATES = [
  "1900-01-01",
  "1901-01-01",
  "1970-01-01",
  "1999-12-31",
  "2000-01-01",
];

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, JANUARY: 1,
  FEB: 2, FEBRUARY: 2,
  MAR: 3, MARCH: 3,
  APR: 4, APRIL: 4,
  MAY: 5,
  JUN: 6, JUNE: 6,
  JUL: 7, JULY: 7,
  AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OCT: 10, OCTOBER: 10,
  NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12,
};

export interface DateParseOptions {
  /** Prefer day-first (Ghanaian convention). Default true. */
  dayFirst?: boolean;
  /** Reference date for the "is this in the future" test, as `YYYY-MM-DD`. */
  today?: string;
  placeholders?: string[];
  /** Reject anything before this year outright. */
  minYear?: number;
}

export function parseDate(input: unknown, options: DateParseOptions = {}): DateParse {
  const {
    dayFirst = true,
    today = new Date().toISOString().slice(0, 10),
    placeholders = DEFAULT_PLACEHOLDER_DATES,
    minYear = 1900,
  } = options;

  const raw = input instanceof Date ? input.toISOString().slice(0, 10) : cleanCell(input);
  if (isNullToken(raw)) return blank("empty");

  const parsed = parseCore(raw, dayFirst);
  if (!parsed.iso) {
    // Keep the specific reason parseCore found (`impossible` for 31 February)
    // rather than flattening every failure to `unparseable`.
    return { ...parsed, changed: true };
  }

  const problems: DateProblem[] = [];
  const year = Number(parsed.iso.slice(0, 4));

  if (placeholders.includes(parsed.iso)) problems.push("placeholder");
  if (parsed.iso > today) problems.push("future");
  if (year < minYear) problems.push("too_old");

  return { ...parsed, problems, changed: parsed.iso !== raw };
}

function parseCore(raw: string, dayFirst: boolean): DateParse {
  // 1. Excel serial number (days since 1899-12-30).
  if (/^\d{1,6}(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    // Below ~1000 a bare number is far more likely a typo than a 1902 date.
    if (serial >= 1000 && serial <= 80000) {
      const iso = fromExcelSerial(serial);
      return {
        iso,
        transposedIso: null,
        ambiguous: false,
        interpretation: "excel_serial",
        problems: [],
        changed: true,
      };
    }
  }

  // 2. Unambiguous ISO / reverse forms: YYYY-MM-DD, YYYY/MM/DD, YYYYMMDD.
  const isoMatch = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})$/.exec(raw);
  if (isoMatch) {
    const iso = build(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    return {
      iso,
      transposedIso: null,
      ambiguous: false,
      interpretation: "iso",
      problems: iso ? [] : ["impossible"],
      changed: true,
    };
  }

  // 3. Textual month: 12-Mar-1985, 12 March 1985, March 12 1985.
  const textMatch =
    /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.]+(\d{2,4})$/.exec(raw) ??
    /^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2})[\s\-/.,]+(\d{2,4})$/.exec(raw);
  if (textMatch) {
    const monthToken = /^\d/.test(textMatch[1]!) ? textMatch[2]! : textMatch[1]!;
    const dayToken = /^\d/.test(textMatch[1]!) ? textMatch[1]! : textMatch[2]!;
    const month = MONTH_NAMES[monthToken.toUpperCase()];
    if (month) {
      const iso = build(expandYear(Number(textMatch[3])), month, Number(dayToken));
      return {
        iso,
        transposedIso: null,
        ambiguous: false,
        interpretation: "text_month",
        problems: iso ? [] : ["impossible"],
        changed: true,
      };
    }
  }

  // 4. The ambiguous numeric case: dd/mm/yyyy vs mm/dd/yyyy.
  const numMatch = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(raw);
  if (numMatch) {
    const a = Number(numMatch[1]);
    const b = Number(numMatch[2]);
    const year = expandYear(Number(numMatch[3]));

    const dayFirstIso = build(year, b, a);
    const monthFirstIso = build(year, a, b);

    // Only one reading is a real date — take it, no ambiguity.
    if (dayFirstIso && !monthFirstIso) {
      return {
        iso: dayFirstIso,
        transposedIso: null,
        ambiguous: false,
        interpretation: "day_first",
        problems: [],
        changed: true,
      };
    }
    if (monthFirstIso && !dayFirstIso) {
      return {
        iso: monthFirstIso,
        transposedIso: null,
        ambiguous: false,
        interpretation: "month_first",
        problems: [],
        changed: true,
      };
    }
    if (!dayFirstIso && !monthFirstIso) {
      return {
        iso: null,
        transposedIso: null,
        ambiguous: false,
        interpretation: "none",
        problems: ["impossible"],
        changed: true,
      };
    }

    // Both readings are real dates: genuinely ambiguous.
    const chosen = dayFirst ? dayFirstIso : monthFirstIso;
    const other = dayFirst ? monthFirstIso : dayFirstIso;
    return {
      iso: chosen,
      transposedIso: chosen === other ? null : other,
      ambiguous: chosen !== other,
      interpretation: dayFirst ? "day_first" : "month_first",
      problems: [],
      changed: true,
    };
  }

  return {
    iso: null,
    transposedIso: null,
    ambiguous: false,
    interpretation: "none",
    problems: ["unparseable"],
    changed: false,
  };
}

function blank(problem: DateProblem): DateParse {
  return {
    iso: null,
    transposedIso: null,
    ambiguous: false,
    interpretation: "none",
    problems: [problem],
    changed: false,
  };
}

/** Two-digit years: 00-30 are 2000s, everything else 1900s. */
function expandYear(year: number): number {
  if (year >= 1000) return year;
  if (year <= 30) return 2000 + year;
  if (year < 100) return 1900 + year;
  return year;
}

/** Build an ISO date, returning null when the components are not a real date. */
function build(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null; // e.g. 31 February
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export function fromExcelSerial(serial: number): string {
  // Excel's epoch is 1899-12-30 (accounting for its 1900 leap-year bug).
  const ms = Math.round(serial) * 86_400_000;
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  return d.toISOString().slice(0, 10);
}

/** Whole years between two ISO dates. */
export function ageInYears(birthIso: string, todayIso: string): number {
  const b = new Date(birthIso + "T00:00:00Z");
  const t = new Date(todayIso + "T00:00:00Z");
  let age = t.getUTCFullYear() - b.getUTCFullYear();
  const monthDelta = t.getUTCMonth() - b.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && t.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

/** True when two ISO dates are the same day with day/month transposed. */
export function isDayMonthTransposition(a: string, b: string): boolean {
  if (a === b) return false;
  const [ya, ma, da] = a.split("-");
  const [yb, mb, db] = b.split("-");
  return ya === yb && ma === db && da === mb;
}
