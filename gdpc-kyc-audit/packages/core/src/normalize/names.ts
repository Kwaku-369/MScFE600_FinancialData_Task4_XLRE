/**
 * Personal-name parsing for depositor records.
 *
 * Rural-bank cores store names in every conceivable arrangement: one `FULLNAME`
 * column, three columns, `SURNAME, Othernames`, or a full name with the surname
 * capitalised. The Ghana Card, by contrast, always exposes discrete first /
 * middle / last fields. This module reduces both sides to a comparable token
 * list without asserting which token is the surname — that assertion is exactly
 * what causes false mismatches, and the matcher below is order-insensitive so
 * it never needs to make it.
 */

import { canonical, cleanCell, isNullToken } from "./text.js";

/** Honorifics and salutations that carry no identity information. */
export const TITLES = new Set([
  "MR", "MRS", "MS", "MISS", "MSTR", "MASTER", "MADAM", "MAD",
  "DR", "PROF", "ENG", "ENGR", "ARC", "HON", "REV", "REVD", "PASTOR",
  "BISHOP", "APOSTLE", "EVANGELIST", "ELDER", "DEACON", "DEACONESS",
  "ALHAJI", "ALHAJ", "HAJIA", "HAJJ", "SHEIKH", "IMAM", "MALLAM",
  "NANA", "NII", "NAA", "TOGBE", "TOGBUI", "MAMA", "OSABARIMA",
  "OKYEAME", "OPANYIN", "OBAAPANYIN", "AWURA", "OWURA",
  "CAPT", "COL", "LT", "MAJ", "SGT", "GEN", "INSP", "SUPT",
  "SIR", "LADY", "CHIEF",
]);

/** Generational and qualification suffixes. */
export const SUFFIXES = new Set([
  "JR", "JNR", "SR", "SNR", "II", "III", "IV",
  "ESQ", "PHD", "MSC", "BSC", "MBA", "MD", "RN",
]);

/** Particles that belong to the following token rather than standing alone. */
const PARTICLES = new Set(["VAN", "VON", "DE", "DA", "DEL", "DER", "LA", "LE", "BIN", "BINT", "AL", "EL"]);

export interface ParsedName {
  /** Multi-letter identity tokens, in source order, upper case and unaccented. */
  tokens: string[];
  /** Tokens that were single letters, e.g. the `K` in `K. Mensah`. */
  initials: string[];
  /**
   * Every identity-bearing token including initials, in the order they appeared.
   * Splitting a combined-name column must use this rather than `tokens`, or the
   * `K` in `K. Owusu` is silently discarded and the depositor loses a name.
   */
  orderedTokens: string[];
  titles: string[];
  suffixes: string[];
  /** Canonical rendering of the identity tokens, space separated. */
  normalized: string;
  /** True when the source used `SURNAME, Other Names` form. */
  commaInverted: boolean;
  changed: boolean;
}

const EMPTY: ParsedName = {
  tokens: [],
  initials: [],
  orderedTokens: [],
  titles: [],
  suffixes: [],
  normalized: "",
  commaInverted: false,
  changed: false,
};

export function parseName(input: unknown): ParsedName {
  const raw = cleanCell(input);
  if (isNullToken(raw)) return EMPTY;

  // `MENSAH, Kwame Kofi` -> the part before the comma is the surname.
  const commaInverted = /^[^,]+,\s*\S/.test(raw);
  const reordered = commaInverted
    ? raw.split(",").slice(1).join(" ") + " " + raw.split(",")[0]
    : raw;

  const cleaned = canonical(reordered);
  if (cleaned === "") return { ...EMPTY, changed: true };

  const titles: string[] = [];
  const suffixes: string[] = [];
  const initials: string[] = [];
  const tokens: string[] = [];
  const orderedTokens: string[] = [];

  const parts = cleaned.split(" ").filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;

    if (TITLES.has(part)) {
      titles.push(part);
      continue;
    }
    if (SUFFIXES.has(part)) {
      suffixes.push(part);
      continue;
    }
    // Glue a particle onto the token that follows it: `DE GRAFT` -> `DEGRAFT`.
    if (PARTICLES.has(part) && i + 1 < parts.length) {
      const next = parts[i + 1]!;
      tokens.push(part + next);
      orderedTokens.push(part + next);
      i++;
      continue;
    }
    if (part.length === 1) {
      initials.push(part);
      orderedTokens.push(part);
      continue;
    }
    // A pure number in a name field is data corruption, not a name.
    if (/^\d+$/.test(part)) continue;

    tokens.push(part);
    orderedTokens.push(part);
  }

  const normalized = tokens.join(" ");

  return {
    tokens,
    initials,
    orderedTokens,
    titles,
    suffixes,
    normalized,
    commaInverted,
    changed: normalized !== raw.toUpperCase(),
  };
}

/** Join discrete first/middle/last fields into one parsed name. */
export function parseNameParts(
  first: unknown,
  middle: unknown,
  last: unknown,
): ParsedName {
  const joined = [first, middle, last]
    .map((p) => (isNullToken(p) ? "" : cleanCell(p)))
    .filter((p) => p.length > 0)
    .join(" ");
  return parseName(joined);
}

/**
 * Render a parsed name back into the `SURNAME FIRSTNAME OTHERNAMES` order most
 * GDPC-facing templates expect, given an authoritative surname to anchor on.
 * When the surname cannot be identified the tokens are returned unchanged.
 */
export function renderWithSurnameFirst(name: ParsedName, surname: string | null): string {
  if (!surname) return name.normalized;
  const key = canonical(surname);
  const rest = name.tokens.filter((t) => t !== key);
  if (rest.length === name.tokens.length) return name.normalized;
  return [key, ...rest].join(" ");
}
