/**
 * Order-insensitive personal-name matching with an explainable alignment.
 *
 * The design constraint that drives everything here: an auditor must be able to
 * see *why* a pair was accepted or rejected. A bare similarity score is not
 * defensible to a regulator, so the matcher returns the token-by-token pairing
 * it used, each with its own reason code.
 *
 * Matching is order-insensitive by construction, because the most common defect
 * in rural-bank data is exactly a reordering: the branch captured
 * `KWAME MENSAH ADU` where the Ghana Card reads `ADU KWAME MENSAH`. Those are
 * the same person and must not be flagged as a mismatch — but the *ordering*
 * difference still matters for the GDPC upload, so it is reported separately
 * from the identity verdict.
 */

import { parseName, type ParsedName } from "../normalize/names.js";
import { areDiminutives, areEquivalent, equivalentsOf } from "./aliases.js";
import { soundsAlike } from "./phonetic.js";
import { jaroWinkler, levenshtein } from "./similarity.js";

export type TokenMatchReason =
  | "exact"
  | "equivalent" // known alias, e.g. KOJO / KWADWO
  | "diminutive" // familiar form, e.g. FRED / FREDERICK
  | "phonetic" // same phonetic key
  | "typo" // small edit distance
  | "initial" // K matched against KWAME
  | "prefix" // one token is a truncation of the other
  | "unmatched";

export interface TokenAlignment {
  left: string | null;
  right: string | null;
  score: number;
  reason: TokenMatchReason;
  /** Populated for `equivalent` matches so the report can cite the rule. */
  note?: string;
}

export type NameVerdict =
  | "exact" // identical token sets, identical order
  | "reordered" // identical token sets, different order
  | "variant" // every token matched, some via alias/phonetic/typo
  | "subset" // one side is missing tokens the other has (e.g. no middle name)
  | "partial" // core tokens match but there is unexplained content
  | "mismatch"; // likely a different person

export interface NameMatchResult {
  score: number;
  verdict: NameVerdict;
  alignment: TokenAlignment[];
  left: ParsedName;
  right: ParsedName;
  /** Tokens present on the right (authoritative) side but absent on the left. */
  missingFromLeft: string[];
  /** Tokens present on the left (bank) side but absent on the right. */
  extraOnLeft: string[];
  /** True when the same tokens appear in a different sequence. */
  orderDiffers: boolean;
  /** Plain-language explanation for the audit report. */
  explanation: string;
}

const SCORES: Record<Exclude<TokenMatchReason, "unmatched">, number> = {
  exact: 1.0,
  equivalent: 0.97,
  diminutive: 0.88,
  phonetic: 0.86,
  typo: 0.84,
  prefix: 0.8,
  initial: 0.75,
};

/** Score a single pair of tokens, returning the best applicable reason. */
export function scoreTokens(a: string, b: string): { score: number; reason: TokenMatchReason; note?: string } {
  if (a === b) return { score: SCORES.exact, reason: "exact" };

  if (areEquivalent(a, b)) {
    return {
      score: SCORES.equivalent,
      reason: "equivalent",
      note: `${a} and ${b} are accepted renderings of the same name`,
    };
  }

  if (areDiminutives(a, b)) {
    return {
      score: SCORES.diminutive,
      reason: "diminutive",
      note: `${a} is a familiar form of ${b}`,
    };
  }

  // An initial standing in for a full name: `K` vs `KWAME`.
  if ((a.length === 1 || b.length === 1) && a[0] === b[0]) {
    return { score: SCORES.initial, reason: "initial" };
  }

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  // A truncated capture: `KWAB` vs `KWABENA`. Require a meaningful stem.
  if (shorter.length >= 3 && longer.startsWith(shorter)) {
    return { score: SCORES.prefix, reason: "prefix" };
  }

  // Phonetic keys are only discriminating on tokens with enough consonants to
  // code. On three-letter Akan names (`ABA` / `ABU`) every key collides, so the
  // phonetic route is restricted to longer tokens.
  if (shorter.length >= 4 && soundsAlike(a, b)) {
    return { score: SCORES.phonetic, reason: "phonetic" };
  }

  // A one-character slip in a long token is a typo; in a short one it is a
  // different name (`ABA` vs `ABU`), so scale the tolerance with length.
  const distance = levenshtein(a, b);
  const tolerance = longer.length >= 7 ? 2 : 1;
  if (distance <= tolerance && shorter.length >= 4) {
    const jw = jaroWinkler(a, b);
    if (jw >= 0.9) return { score: Math.min(SCORES.typo, jw), reason: "typo" };
  }

  const jw = jaroWinkler(a, b);
  if (jw >= 0.93 && shorter.length >= 5) {
    return { score: Math.min(SCORES.typo, jw), reason: "typo" };
  }

  return { score: 0, reason: "unmatched" };
}

export interface NameMatchOptions {
  /** Score at or above which the pair is treated as the same person. */
  acceptThreshold?: number;
  /** Score below which the pair is treated as a different person. */
  mismatchThreshold?: number;
}

/**
 * Compare a bank-held name against an authoritative (Ghana Card) name.
 *
 * `left` is the bank record, `right` is the authoritative record. The asymmetry
 * matters: a middle name present on the card but missing at the bank is a
 * routine capture gap, whereas an extra token at the bank that the card does not
 * know about is a stronger signal.
 */
export function matchNames(
  leftInput: unknown,
  rightInput: unknown,
  options: NameMatchOptions = {},
): NameMatchResult {
  const { mismatchThreshold = 0.62 } = options;

  const left = parseName(leftInput);
  const right = parseName(rightInput);

  // Initials participate in matching, appended after the full tokens.
  const leftTokens = [...left.tokens, ...left.initials];
  const rightTokens = [...right.tokens, ...right.initials];

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return {
      score: 0,
      verdict: "mismatch",
      alignment: [],
      left,
      right,
      missingFromLeft: rightTokens,
      extraOnLeft: leftTokens,
      orderDiffers: false,
      explanation:
        leftTokens.length === 0
          ? "No usable name was captured in the bank record."
          : "No authoritative name was available to compare against.",
    };
  }

  const { alignment, usedLeft, usedRight } = alignTokens(leftTokens, rightTokens);

  const missingFromLeft = rightTokens.filter((_t, i) => !usedRight.has(i));
  const extraOnLeft = leftTokens.filter((_t, i) => !usedLeft.has(i));

  for (const token of missingFromLeft) {
    alignment.push({ left: null, right: token, score: 0, reason: "unmatched" });
  }
  for (const token of extraOnLeft) {
    alignment.push({ left: token, right: null, score: 0, reason: "unmatched" });
  }

  const score = computeScore(alignment, leftTokens.length, rightTokens.length);
  const orderDiffers = detectOrderDifference(leftTokens, rightTokens, alignment);
  const verdict = decideVerdict({
    alignment,
    score,
    orderDiffers,
    missingFromLeft,
    extraOnLeft,
    mismatchThreshold,
  });

  return {
    score,
    verdict,
    alignment,
    left,
    right,
    missingFromLeft,
    extraOnLeft,
    orderDiffers,
    explanation: explain(verdict, alignment, missingFromLeft, extraOnLeft, orderDiffers),
  };
}

/**
 * Greedy best-first assignment between the two token lists.
 *
 * A full Hungarian assignment would be optimal, but personal names have at most
 * a handful of tokens and greedy-by-descending-score is identical to optimal in
 * every realistic case while staying trivial to explain in an audit.
 */
function alignTokens(
  leftTokens: string[],
  rightTokens: string[],
): { alignment: TokenAlignment[]; usedLeft: Set<number>; usedRight: Set<number> } {
  interface Candidate {
    li: number;
    ri: number;
    score: number;
    reason: TokenMatchReason;
    note?: string;
  }

  const candidates: Candidate[] = [];
  for (let li = 0; li < leftTokens.length; li++) {
    for (let ri = 0; ri < rightTokens.length; ri++) {
      const scored = scoreTokens(leftTokens[li]!, rightTokens[ri]!);
      if (scored.score > 0) {
        candidates.push({ li, ri, score: scored.score, reason: scored.reason, note: scored.note });
      }
    }
  }

  // Highest score first; ties broken by keeping positions close together so the
  // alignment reads naturally.
  candidates.sort(
    (a, b) => b.score - a.score || Math.abs(a.li - a.ri) - Math.abs(b.li - b.ri),
  );

  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();
  const alignment: TokenAlignment[] = [];

  for (const candidate of candidates) {
    if (usedLeft.has(candidate.li) || usedRight.has(candidate.ri)) continue;
    usedLeft.add(candidate.li);
    usedRight.add(candidate.ri);
    const entry: TokenAlignment = {
      left: leftTokens[candidate.li]!,
      right: rightTokens[candidate.ri]!,
      score: candidate.score,
      reason: candidate.reason,
    };
    if (candidate.note) entry.note = candidate.note;
    alignment.push(entry);
  }

  return { alignment, usedLeft, usedRight };
}

/**
 * Aggregate the pairwise scores.
 *
 * Unmatched tokens on the authoritative side are penalised more heavily than
 * unmatched tokens on the bank side, because the card is the source of truth:
 * failing to hold a name the card carries is worse than holding an extra one.
 */
function computeScore(
  alignment: TokenAlignment[],
  leftCount: number,
  rightCount: number,
): number {
  const matched = alignment.filter((a) => a.reason !== "unmatched");
  if (matched.length === 0) return 0;

  const matchedScore = matched.reduce((sum, a) => sum + a.score, 0);
  const denominator = Math.max(leftCount, rightCount);
  const base = matchedScore / denominator;

  // A single shared token out of three is not a match, however exact it is.
  const coverage = matched.length / Math.min(leftCount, rightCount);
  return round(base * (0.6 + 0.4 * coverage));
}

function detectOrderDifference(
  leftTokens: string[],
  rightTokens: string[],
  alignment: TokenAlignment[],
): boolean {
  const pairs = alignment
    .filter((a) => a.reason !== "unmatched" && a.left && a.right)
    .map((a) => ({
      li: leftTokens.indexOf(a.left!),
      ri: rightTokens.indexOf(a.right!),
    }));

  if (pairs.length < 2) return false;

  // Order differs when the aligned positions are not monotonically increasing.
  const byLeft = [...pairs].sort((a, b) => a.li - b.li);
  for (let i = 1; i < byLeft.length; i++) {
    if (byLeft[i]!.ri < byLeft[i - 1]!.ri) return true;
  }
  return false;
}

function decideVerdict(input: {
  alignment: TokenAlignment[];
  score: number;
  orderDiffers: boolean;
  missingFromLeft: string[];
  extraOnLeft: string[];
  mismatchThreshold: number;
}): NameVerdict {
  const { alignment, score, orderDiffers, missingFromLeft, extraOnLeft, mismatchThreshold } = input;
  const matched = alignment.filter((a) => a.reason !== "unmatched");
  const allExact = matched.length > 0 && matched.every((a) => a.reason === "exact");
  const complete = missingFromLeft.length === 0 && extraOnLeft.length === 0;

  if (score < mismatchThreshold) return "mismatch";

  if (complete && allExact) return orderDiffers ? "reordered" : "exact";
  if (complete) return "variant";

  // Missing a middle name is the classic capture gap — still the same person.
  if (extraOnLeft.length === 0 && missingFromLeft.length > 0) return "subset";

  return "partial";
}

function explain(
  verdict: NameVerdict,
  alignment: TokenAlignment[],
  missingFromLeft: string[],
  extraOnLeft: string[],
  orderDiffers: boolean,
): string {
  const reasons = alignment
    .filter((a) => a.reason !== "unmatched" && a.reason !== "exact")
    .map((a) => `${a.left} matched ${a.right} (${a.reason})`);

  const parts: string[] = [];

  switch (verdict) {
    case "exact":
      return "The bank record and the Ghana Card carry exactly the same name.";
    case "reordered":
      parts.push(
        "The same name tokens appear on both records but in a different order; the bank record must be re-sequenced to match the card.",
      );
      break;
    case "variant":
      parts.push("Every name token is accounted for, with accepted variations.");
      break;
    case "subset":
      parts.push(
        `The Ghana Card carries ${missingFromLeft.length} name token(s) the bank record does not hold: ${missingFromLeft.join(", ")}.`,
      );
      break;
    case "partial":
      parts.push(
        `Partial agreement. Missing from the bank record: ${missingFromLeft.join(", ") || "none"}. Not on the card: ${extraOnLeft.join(", ") || "none"}.`,
      );
      break;
    case "mismatch":
      parts.push(
        "The two names do not correspond; this should be treated as a different person until proven otherwise.",
      );
      break;
  }

  if (reasons.length > 0) parts.push(reasons.join("; ") + ".");
  if (orderDiffers && verdict !== "reordered") parts.push("Token order also differs.");

  const aliasNotes = alignment
    .filter((a) => a.note)
    .map((a) => a.note!)
    .slice(0, 3);
  if (aliasNotes.length > 0) parts.push(aliasNotes.join("; ") + ".");

  return parts.join(" ");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Convenience wrapper for comparing against discrete card name fields. */
export function matchAgainstCard(
  bankName: unknown,
  card: { firstName: string | null; middleName: string | null; lastName: string | null },
  options?: NameMatchOptions,
): NameMatchResult {
  const cardName = [card.firstName, card.middleName, card.lastName]
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join(" ");
  return matchNames(bankName, cardName, options);
}

export { equivalentsOf };
