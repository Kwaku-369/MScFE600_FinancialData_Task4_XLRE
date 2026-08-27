/**
 * Ghanaian mobile number (MSISDN) normalisation.
 *
 * Since the 2010 renumbering every Ghanaian mobile number is nine national
 * significant digits: a two-digit network code plus seven subscriber digits.
 * Written locally it carries a trunk `0` (ten digits); internationally it is
 * `+233` followed by the nine digits.
 *
 * Rural-bank exports mangle this in predictable ways: Excel eats the leading
 * zero and stores `244123456` as a number, officers type `+233 (0) 24 412 3456`,
 * and some cores store two numbers in one cell separated by `/` or `,`.
 */

import { cleanCell, isNullToken } from "./text.js";

export const GHANA_COUNTRY_CODE = "233";

export interface NetworkAllocation {
  /** Two-digit national network code, without the trunk zero. */
  code: string;
  operator: string;
}

/**
 * Network codes allocated by the National Communications Authority. Numbers on
 * a structurally valid but unlisted code are reported as `unknown_prefix`
 * (a minor finding) rather than invalid — the NCA does allocate new ranges.
 */
export const NETWORK_ALLOCATIONS: NetworkAllocation[] = [
  { code: "24", operator: "MTN" },
  { code: "25", operator: "MTN" },
  { code: "53", operator: "MTN" },
  { code: "54", operator: "MTN" },
  { code: "55", operator: "MTN" },
  { code: "59", operator: "MTN" },
  { code: "20", operator: "Telecel" },
  { code: "50", operator: "Telecel" },
  { code: "26", operator: "AT" },
  { code: "27", operator: "AT" },
  { code: "56", operator: "AT" },
  { code: "57", operator: "AT" },
  { code: "23", operator: "Glo" },
  { code: "28", operator: "Expresso" },
];

const OPERATOR_BY_CODE = new Map(NETWORK_ALLOCATIONS.map((a) => [a.code, a.operator]));

export type MsisdnProblem =
  | "empty"
  | "too_short"
  | "too_long"
  | "non_numeric"
  | "unknown_prefix"
  | "not_mobile"
  | "multiple_numbers"
  | "repeated_digits";

export interface MsisdnParse {
  /** Canonical E.164 form, e.g. `+233244123456`, or null when unusable. */
  e164: string | null;
  /** National form with trunk zero, e.g. `0244123456`. */
  national: string | null;
  networkCode: string | null;
  operator: string | null;
  valid: boolean;
  problems: MsisdnProblem[];
  changed: boolean;
  /** Extra numbers found in the same cell, already normalised where possible. */
  additional: string[];
}

const SPLITTERS = /[/,;|]| and | or /i;

export function parseMsisdn(input: unknown, defaultCountry = GHANA_COUNTRY_CODE): MsisdnParse {
  const raw = cleanCell(input);

  // A cell filled with one repeated digit is filler, not a blank cell. Test for
  // it before the generic emptiness check, which would otherwise swallow it and
  // report the field as simply missing.
  const allDigits = raw.replace(/\D+/g, "");
  if (allDigits.length >= 7 && /^(\d)\1+$/.test(allDigits)) {
    return { ...blank("repeated_digits"), changed: false };
  }

  if (isNullToken(raw)) return blank("empty");

  const parts = raw.split(SPLITTERS).map((p) => p.trim()).filter((p) => p.length > 0);
  const primary = parts[0] ?? raw;
  const problems: MsisdnProblem[] = [];
  if (parts.length > 1) problems.push("multiple_numbers");

  const result = parseSingle(primary, defaultCountry, problems);
  result.additional = parts
    .slice(1)
    .map((p) => parseSingle(p, defaultCountry, []).e164)
    .filter((v): v is string => v !== null);

  result.changed = result.e164 !== null && result.e164 !== raw;
  return result;
}

function parseSingle(
  input: string,
  defaultCountry: string,
  problems: MsisdnProblem[],
): MsisdnParse {
  // Strip everything but digits, remembering whether the caller wrote a `+`.
  const hadPlus = input.trimStart().startsWith("+");
  let digits = input.replace(/\D+/g, "");

  if (digits.length === 0) {
    problems.push("non_numeric");
    return { ...blank("non_numeric"), problems };
  }

  // `+233 (0) 24 ...` — drop the redundant trunk zero after the country code.
  if (digits.startsWith(GHANA_COUNTRY_CODE + "0")) {
    digits = GHANA_COUNTRY_CODE + digits.slice(GHANA_COUNTRY_CODE.length + 1);
  }

  // `00233...` international prefix.
  if (digits.startsWith("00")) digits = digits.slice(2);

  let national: string;
  if (digits.startsWith(GHANA_COUNTRY_CODE) && digits.length >= 12) {
    national = digits.slice(GHANA_COUNTRY_CODE.length);
  } else if (hadPlus && !digits.startsWith(GHANA_COUNTRY_CODE)) {
    // A genuinely foreign number — keep it, but it is not a Ghanaian MSISDN.
    problems.push("unknown_prefix");
    return {
      e164: "+" + digits,
      national: null,
      networkCode: null,
      operator: null,
      valid: false,
      problems,
      changed: true,
      additional: [],
    };
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    // Excel dropped the leading zero: nine digits with no trunk prefix.
    national = digits;
  }

  if (national.length < 9) problems.push("too_short");
  if (national.length > 9) problems.push("too_long");

  if (national.length !== 9) {
    return {
      e164: null,
      national: null,
      networkCode: null,
      operator: null,
      valid: false,
      problems,
      changed: true,
      additional: [],
    };
  }

  if (/^(\d)\1{8}$/.test(national)) problems.push("repeated_digits");

  const networkCode = national.slice(0, 2);
  const operator = OPERATOR_BY_CODE.get(networkCode) ?? null;
  if (!operator) problems.push("unknown_prefix");

  const valid =
    problems.filter((p) => p !== "multiple_numbers" && p !== "unknown_prefix").length === 0;

  return {
    e164: "+" + defaultCountry + national,
    national: "0" + national,
    networkCode,
    operator,
    valid,
    problems,
    changed: true,
    additional: [],
  };
}

function blank(problem: MsisdnProblem): MsisdnParse {
  return {
    e164: null,
    national: null,
    networkCode: null,
    operator: null,
    valid: false,
    problems: [problem],
    changed: false,
    additional: [],
  };
}

/** Key used for the shared-number index. */
export function msisdnKey(input: unknown): string | null {
  return parseMsisdn(input).e164;
}
