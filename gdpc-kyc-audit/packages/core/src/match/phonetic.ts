/**
 * A phonetic coder tuned for Ghanaian names.
 *
 * Soundex and Metaphone were built for Anglo-American surnames and mishandle
 * the patterns that matter here: the `KW`/`QU`/`GW` onsets of Akan names, the
 * doubled vowels that carry tone (`AKUAA`, `KUUKU`), the silent trailing `H`
 * in `MENSAH`, and the `DZ`/`DJ`/`J` alternation in Ewe and Ga names.
 *
 * The code produced is not meant to be compared with any other system's — it
 * exists purely so that two spellings of one spoken name collide.
 */

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

/** Digraph rewrites applied left-to-right before consonant coding. */
const DIGRAPHS: Array<[RegExp, string]> = [
  // Akan/Ga labial-velars: KW, QU, GW and TW all begin with a K-ish stop.
  [/^KW/, "KW"],
  [/QU/g, "KW"],
  [/^GW/, "KW"],
  [/^TW/, "TW"],
  // Ewe/Ga affricates that alternate freely in writing.
  [/DZ/g, "J"],
  [/DJ/g, "J"],
  [/TS/g, "C"],
  [/CH/g, "C"],
  [/SH/g, "C"],
  // NY and NG are single nasals, not N + consonant.
  [/NY/g, "N"],
  [/NG/g, "N"],
  [/GY/g, "J"],
  [/KY/g, "C"],
  [/HY/g, "C"],
  // PH is F; the Ghanaian PP/BB doubles are single stops.
  [/PH/g, "F"],
];

/** Consonants that sound alike often enough to share a code. */
const CONSONANT_CODES: Record<string, string> = {
  B: "B", P: "B", V: "B", F: "F",
  C: "C", J: "J",
  D: "D", T: "D",
  G: "G", K: "G", Q: "G",
  L: "L",
  M: "M", N: "M",
  R: "R",
  S: "S", Z: "S", X: "S",
  W: "W",
  Y: "Y",
  H: "H",
};

/**
 * Produce the phonetic key for a single name token.
 * Returns an empty string for tokens with no codeable content.
 */
export function ghanaPhonetic(token: string): string {
  let s = token.toUpperCase().replace(/[^A-Z]/g, "");
  if (s.length === 0) return "";

  // Collapse doubled letters first: AKUAA -> AKUA, TETTEH -> TETEH.
  s = s.replace(/(.)\1+/g, "$1");

  // A trailing H after a vowel is silent: MENSAH -> MENSA, YEBOAH -> YEBOA.
  s = s.replace(/([AEIOU])H$/, "$1");

  for (const [pattern, replacement] of DIGRAPHS) {
    s = s.replace(pattern, replacement);
  }

  // Keep the first sound (vowel or consonant) as the anchor, then code the rest
  // by consonant only — vowels in Akan vary too much to be discriminating.
  const first = s[0]!;
  const anchor = VOWELS.has(first) ? first : (CONSONANT_CODES[first] ?? first);

  let coded = "";
  let previous = anchor;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (VOWELS.has(ch)) {
      previous = "";
      continue;
    }
    const code = CONSONANT_CODES[ch] ?? ch;
    if (code !== previous) coded += code;
    previous = code;
  }

  // A trailing H adds nothing once vowels are dropped.
  const key = (anchor + coded).replace(/H+$/, "");
  return key.slice(0, 6);
}

/** True when two tokens share a phonetic key (and are not identical). */
export function soundsAlike(a: string, b: string): boolean {
  if (a === b) return false;
  const ka = ghanaPhonetic(a);
  const kb = ghanaPhonetic(b);
  return ka.length > 0 && ka === kb;
}
