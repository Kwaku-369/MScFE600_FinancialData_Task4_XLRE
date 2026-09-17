/**
 * Header-row detection.
 *
 * Bank submissions rarely start at row 1. They carry a bank name, a report
 * title, a date, sometimes a blank row or a merged banner, and only then the
 * real column headings. Guessing wrong means every subsequent column mapping is
 * wrong, so this scans the first rows and scores each as a candidate header.
 */

const HEADER_HINTS = [
  "NAME", "ACCOUNT", "CUSTOMER", "BALANCE", "DATE", "PHONE", "MOBILE",
  "ID", "CARD", "GENDER", "BRANCH", "ADDRESS", "TYPE", "STATUS", "NO",
  "NUMBER", "SURNAME", "BIRTH", "CURRENCY", "AMOUNT", "PIN", "TIN",
];

/** How much a row looks like a set of column headings, 0..1. */
export function scoreAsHeader(row: string[]): number {
  const cells = row.map((c) => (c ?? "").trim()).filter((c) => c !== "");
  if (cells.length < 2) return 0;

  let score = 0;

  // Headers are text, not numbers.
  const numeric = cells.filter((c) => /^-?[\d,. ]+$/.test(c)).length;
  score += (1 - numeric / cells.length) * 0.35;

  // Headers are short.
  const shortEnough = cells.filter((c) => c.length <= 40).length;
  score += (shortEnough / cells.length) * 0.15;

  // Headers are mostly distinct.
  const distinct = new Set(cells.map((c) => c.toUpperCase())).size;
  score += (distinct / cells.length) * 0.2;

  // Headers use the vocabulary of a depositor file.
  const upper = cells.map((c) => c.toUpperCase());
  const hits = HEADER_HINTS.filter((hint) => upper.some((c) => c.includes(hint))).length;
  score += Math.min(hits / 5, 1) * 0.3;

  return Math.round(score * 1000) / 1000;
}

/**
 * Return the 1-based index of the most likely header row, searching the first
 * `limit` rows. Falls back to row 1 when nothing scores well.
 */
export function detectHeaderRow(matrix: string[][], limit = 20): number {
  let best = { index: 1, score: 0 };

  const upper = Math.min(limit, matrix.length);
  for (let i = 0; i < upper; i++) {
    const row = matrix[i] ?? [];
    const score = scoreAsHeader(row);

    // A row is only a header if the row beneath it has comparable width —
    // a title banner has one cell, its neighbour has many.
    const next = matrix[i + 1] ?? [];
    const width = row.filter((c) => (c ?? "").trim() !== "").length;
    const nextWidth = next.filter((c) => (c ?? "").trim() !== "").length;
    const widthPenalty = nextWidth === 0 ? 0.5 : Math.min(1, nextWidth / Math.max(width, 1));

    const adjusted = score * (0.5 + 0.5 * widthPenalty);
    if (adjusted > best.score) best = { index: i + 1, score: adjusted };
  }

  return best.score > 0.35 ? best.index : 1;
}
