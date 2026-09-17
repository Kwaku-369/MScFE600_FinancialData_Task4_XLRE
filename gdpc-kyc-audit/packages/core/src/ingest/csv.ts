/**
 * RFC 4180 CSV reader with the tolerances real bank exports need:
 * a UTF-8 BOM, CRLF or LF endings, quoted fields containing commas and
 * newlines, doubled quotes, and semicolon or tab delimiters.
 */

import type { RawRow, RawSheet } from "../types.js";
import { detectHeaderRow } from "./detect.js";

export interface CsvOptions {
  delimiter?: string;
  /** Force a header row (1-based). When omitted the reader detects it. */
  headerRow?: number;
  sheetName?: string;
}

/** Guess the delimiter from the first few lines. */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192).split(/\r?\n/).slice(0, 5);
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestScore = -1;

  for (const candidate of candidates) {
    const counts = sample.map((line) => line.split(candidate).length - 1);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    // Prefer the delimiter with the most consistent count across lines.
    const mean = total / counts.length;
    const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length;
    const score = mean - variance;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Split CSV text into a matrix of raw string cells. */
export function parseCsvMatrix(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM, which otherwise corrupts the first header.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // Consume CRLF as one terminator.
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Trailing field / row, unless the file ended with a clean newline.
  if (field !== "" || row.length > 0) pushRow();

  return rows;
}

export function readCsv(text: string, options: CsvOptions = {}): RawSheet {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const matrix = parseCsvMatrix(text, delimiter);

  const headerRowNumber = options.headerRow ?? detectHeaderRow(matrix);
  const headerCells = matrix[headerRowNumber - 1] ?? [];
  const headers = dedupeHeaders(headerCells.map((h) => h.trim()));

  const rows: RawRow[] = [];
  for (let r = headerRowNumber; r < matrix.length; r++) {
    const cells: Record<string, string | null> = {};
    const line = matrix[r]!;
    let hasContent = false;

    headers.forEach((header, c) => {
      const value = (line[c] ?? "").trim();
      cells[header] = value === "" ? null : value;
      if (value !== "") hasContent = true;
    });

    if (hasContent) rows.push({ rowNumber: r + 1, cells });
  }

  return {
    name: options.sheetName ?? "CSV",
    headers,
    rows,
    headerRowNumber,
  };
}

/**
 * Excel and hand-edited exports frequently repeat a header or leave one blank.
 * Names must be unique to key the row object, so blanks become positional
 * placeholders and repeats are suffixed.
 */
export function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    const base = header === "" ? `COLUMN_${index + 1}` : header;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}
