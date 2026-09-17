/**
 * Ghana Card PIN handling.
 *
 * Structure (National Identification Authority): a 3-letter ISO country code of
 * the nationality at first registration, a system-generated 8 or 9 digit serial,
 * and a single check character, joined by hyphens — e.g. `GHA-123456789-0`.
 *
 * The NIA does not publish the check-character algorithm, so this module
 * validates *structure* only and never claims a PIN is genuine. Authenticity is
 * established by the NIA lookup (MetaMap GovCheck), not by arithmetic here.
 */

import { cleanCell, isNullToken } from "./text.js";

export interface GhanaCardParse {
  /** Canonical `GHA-123456789-0` form, or null when unparseable. */
  normalized: string | null;
  countryCode: string | null;
  serial: string | null;
  checkChar: string | null;
  valid: boolean;
  /** Structural problems, in the order they were detected. */
  problems: GhanaCardProblem[];
  /** True when normalisation altered the input (spacing, case, missing hyphens). */
  changed: boolean;
}

export type GhanaCardProblem =
  | "empty"
  | "bad_length"
  | "bad_country_code"
  | "non_numeric_serial"
  | "missing_check_char"
  | "bad_check_char"
  | "placeholder";

/** Serials that are obviously filler rather than a real card. */
const PLACEHOLDER_SERIALS = new Set([
  "000000000",
  "111111111",
  "123456789",
  "999999999",
  "00000000",
  "12345678",
]);

/**
 * Accepts every shape seen in rural-bank exports:
 *   `GHA-123456789-0`, `gha 123456789 0`, `GHA1234567890`, `123456789-0`,
 *   `GHA-12345678-9`, and values wrapped in stray quotes or apostrophes.
 */
export function parseGhanaCard(input: unknown): GhanaCardParse {
  const raw = cleanCell(input).replace(/^['"`]+|['"`]+$/g, "");

  if (isNullToken(raw)) {
    return blank("empty");
  }

  const upper = raw.toUpperCase();
  // Keep only the characters a PIN can contain, then re-derive the parts.
  const compact = upper.replace(/[^A-Z0-9]/g, "");

  let countryCode: string | null = null;
  let body = compact;

  const codeMatch = /^([A-Z]{3})(.*)$/.exec(compact);
  if (codeMatch) {
    countryCode = codeMatch[1]!;
    body = codeMatch[2]!;
  }

  const problems: GhanaCardProblem[] = [];

  if (!countryCode) {
    // A PIN with no country code is still recoverable — Ghanaian records default
    // to GHA — but the omission is worth reporting.
    countryCode = "GHA";
    problems.push("bad_country_code");
  }

  if (body.length < 9) {
    problems.push("bad_length");
    return {
      normalized: null,
      countryCode,
      serial: null,
      checkChar: null,
      valid: false,
      problems,
      changed: true,
    };
  }

  // The check character is the last character; everything before it is the serial.
  const serial = body.slice(0, -1);
  const checkChar = body.slice(-1);

  if (serial.length !== 8 && serial.length !== 9) problems.push("bad_length");
  if (!/^\d+$/.test(serial)) problems.push("non_numeric_serial");
  if (!/^[0-9A-Z]$/.test(checkChar)) problems.push("bad_check_char");
  if (PLACEHOLDER_SERIALS.has(serial)) problems.push("placeholder");

  const structurallyValid =
    problems.filter((p) => p !== "bad_country_code" && p !== "placeholder").length === 0;

  const normalized = structurallyValid ? `${countryCode}-${serial}-${checkChar}` : null;

  return {
    normalized,
    countryCode,
    serial,
    checkChar,
    valid: structurallyValid && !problems.includes("placeholder"),
    problems,
    changed: normalized !== null && normalized !== raw,
  };
}

function blank(problem: GhanaCardProblem): GhanaCardParse {
  return {
    normalized: null,
    countryCode: null,
    serial: null,
    checkChar: null,
    valid: false,
    problems: [problem],
    changed: false,
  };
}

/** Convenience for indexes and equality checks. */
export function ghanaCardKey(input: unknown): string | null {
  return parseGhanaCard(input).normalized;
}

/**
 * True when two PINs refer to the same card even though they were typed
 * differently. Also treats an 8-digit serial as equal to the same serial
 * zero-padded to 9, which is a common core-banking truncation.
 */
export function sameGhanaCard(a: unknown, b: unknown): boolean {
  const pa = parseGhanaCard(a);
  const pb = parseGhanaCard(b);
  if (!pa.serial || !pb.serial) return false;
  if (pa.checkChar !== pb.checkChar) return false;
  return pa.serial.padStart(9, "0") === pb.serial.padStart(9, "0");
}
