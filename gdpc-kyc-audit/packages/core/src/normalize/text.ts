/** Text hygiene shared by every normaliser. */

const cp = String.fromCodePoint;
const range = (lo: number, hi: number) => `${cp(lo)}-${cp(hi)}`;

/**
 * Control characters and zero-width / BOM characters that rural-bank exports
 * routinely carry (usually from copy-pasting out of a terminal report) and that
 * must never reach the GDPC upload.
 *
 * Built from code points rather than written as literals so the source stays
 * readable and no invisible character can be lost in transit.
 */
const CONTROL_AND_ZERO_WIDTH = new RegExp(
  `[${range(0x00, 0x08)}${cp(0x0b)}${cp(0x0c)}${range(0x0e, 0x1f)}${cp(0x7f)}${range(0x200b, 0x200d)}${cp(0xfeff)}]`,
  "g",
);

/** Whitespace, including the non-breaking, en/em and ideographic variants. */
const ANY_SPACE = new RegExp(
  `[\\s${cp(0x00a0)}${range(0x2000, 0x200a)}${cp(0x202f)}${cp(0x205f)}${cp(0x3000)}]+`,
  "g",
);

/** Combining marks, stripped after NFD so an accented vowel folds to plain ASCII. */
const COMBINING_MARKS = new RegExp(`[${range(0x0300, 0x036f)}]`, "g");

/** Strip accents so `KOFI ADJEI` and `KOFI ADJÉI` compare equal. */
export function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(COMBINING_MARKS, "");
}

/**
 * Collapse the whitespace zoo (non-breaking spaces, tabs, repeated spaces) that
 * comes out of copy-pasted core-banking reports into single ASCII spaces.
 */
export function collapseWhitespace(input: string): string {
  return input.replace(ANY_SPACE, " ").trim();
}

export function cleanCell(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = typeof input === "string" ? input : String(input);
  return collapseWhitespace(s.replace(CONTROL_AND_ZERO_WIDTH, ""));
}

/**
 * The canonical comparison form: upper case, unaccented, punctuation reduced to
 * spaces. Used for headers, names and enum matching alike.
 */
export function canonical(input: unknown): string {
  const cleaned = stripDiacritics(cleanCell(input)).toUpperCase();
  return collapseWhitespace(cleaned.replace(/[^A-Z0-9]+/g, " "));
}

/** Like `canonical` but keeps digits glued together — for account numbers. */
export function digitsOnly(input: unknown): string {
  return cleanCell(input).replace(/\D+/g, "");
}

/** Values that mean "the operator left this blank" rather than a real value. */
const NULL_TOKENS = new Set([
  "",
  "N A",
  "NA",
  "N/A",
  "NIL",
  "NILL",
  "NONE",
  "NULL",
  "NOT AVAILABLE",
  "NOT APPLICABLE",
  "NOT PROVIDED",
  "NO DATA",
  "UNKNOWN",
  "UNKOWN",
  "XXX",
  "XXXX",
  "-",
  "--",
  "...",
  "#N/A",
  "#VALUE!",
  "#REF!",
  "TBD",
  "PENDING",
]);

/**
 * True when a cell is one of the many ways a branch officer writes "empty".
 * Treating these as real text is the single largest cause of junk reaching GDPC.
 *
 * Note that a bare `0` is deliberately NOT a null token here: it is a legitimate
 * account balance. Numeric fields decide emptiness for themselves.
 */
export function isNullToken(input: unknown): boolean {
  const raw = cleanCell(input);
  if (raw === "") return true;
  if (NULL_TOKENS.has(raw.toUpperCase())) return true;

  const c = canonical(input);
  if (c === "") return true;
  if (NULL_TOKENS.has(c)) return true;

  // Repeated single characters: "XXXXXXX", "-------", "//////"
  const squashed = c.replace(/\s/g, "");
  if (squashed.length >= 3 && /^(.)\1+$/.test(squashed)) return true;

  return false;
}

export function titleCase(input: string): string {
  return cleanCell(input)
    .toLowerCase()
    .replace(/(^|[\s\-'])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}
