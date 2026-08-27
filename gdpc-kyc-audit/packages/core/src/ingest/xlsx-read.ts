/**
 * A self-contained XLSX reader.
 *
 * Deliberately not SheetJS or ExcelJS: this has to run inside a Cloudflare
 * Worker, where a Node-targeted spreadsheet library either does not run or
 * drags in a large polyfill surface. An xlsx file is a zip of XML parts, and
 * the subset needed to read a flat depositor sheet is small enough to implement
 * directly — which also means no surprise behaviour around dates or numbers.
 *
 * Supports: shared strings, inline strings, numbers, booleans, formula results
 * (the cached value), and date-formatted cells (converted to ISO).
 */

import { unzipSync, strFromU8 } from "fflate";
import type { RawCell, RawRow, RawSheet } from "../types.js";
import { dedupeHeaders } from "./csv.js";
import { detectHeaderRow } from "./detect.js";
import { fromExcelSerial } from "../normalize/dates.js";

interface Zip {
  [path: string]: Uint8Array;
}

export interface XlsxOptions {
  /** Sheet name to read; defaults to the first sheet with data. */
  sheetName?: string;
  /** Force a header row (1-based). */
  headerRow?: number;
}

/** List the worksheet names in workbook order. */
export function listSheetNames(data: Uint8Array): string[] {
  const zip = unzipSync(data) as Zip;
  return readWorkbookSheets(zip).map((s) => s.name);
}

export function readXlsx(data: Uint8Array, options: XlsxOptions = {}): RawSheet {
  const zip = unzipSync(data) as Zip;

  const sheets = readWorkbookSheets(zip);
  if (sheets.length === 0) throw new Error("The workbook contains no worksheets.");

  const target = options.sheetName
    ? sheets.find((s) => s.name === options.sheetName)
    : sheets[0];
  if (!target) {
    throw new Error(
      `The workbook has no sheet named '${options.sheetName}'. Available: ${sheets.map((s) => s.name).join(", ")}.`,
    );
  }

  const sharedStrings = readSharedStrings(zip);
  const dateStyles = readDateStyles(zip);

  const partPath = target.path.replace(/^\//, "");
  const part = zip[partPath] ?? zip[`xl/${partPath}`];
  if (!part) throw new Error(`Worksheet part '${partPath}' is missing from the workbook.`);

  const matrix = readSheetMatrix(strFromU8(part), sharedStrings, dateStyles);

  const headerRowNumber =
    options.headerRow ?? detectHeaderRow(matrix.map((row) => row.map(cellToText)));

  const headerCells = matrix[headerRowNumber - 1] ?? [];
  const headers = dedupeHeaders(headerCells.map((c) => cellToText(c).trim()));

  const rows: RawRow[] = [];
  for (let r = headerRowNumber; r < matrix.length; r++) {
    const line = matrix[r] ?? [];
    const cells: Record<string, RawCell> = {};
    let hasContent = false;

    headers.forEach((header, c) => {
      const value = line[c] ?? null;
      cells[header] = value;
      if (value !== null && String(value).trim() !== "") hasContent = true;
    });

    if (hasContent) rows.push({ rowNumber: r + 1, cells });
  }

  return { name: target.name, headers, rows, headerRowNumber };
}

// ---------------------------------------------------------------------------
// Workbook parts
// ---------------------------------------------------------------------------

interface SheetRef {
  name: string;
  path: string;
}

function readWorkbookSheets(zip: Zip): SheetRef[] {
  const workbook = zip["xl/workbook.xml"];
  if (!workbook) throw new Error("Not a valid xlsx file: xl/workbook.xml is missing.");

  const relsPart = zip["xl/_rels/workbook.xml.rels"];
  const rels = new Map<string, string>();
  if (relsPart) {
    for (const match of strFromU8(relsPart).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attr(match[0], "Id");
      const targetPath = attr(match[0], "Target");
      if (id && targetPath) rels.set(id, targetPath.replace(/^\/?xl\//, ""));
    }
  }

  const sheets: SheetRef[] = [];
  for (const match of strFromU8(workbook).matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = decodeXml(attr(match[0], "name") ?? "");
    const rid = attr(match[0], "r:id") ?? attr(match[0], "id");
    const relTarget = rid ? rels.get(rid) : undefined;
    const path = relTarget ? `xl/${relTarget}` : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    if (name) sheets.push({ name, path });
  }

  return sheets;
}

function readSharedStrings(zip: Zip): string[] {
  const part = zip["xl/sharedStrings.xml"];
  if (!part) return [];

  const xml = strFromU8(part);
  const strings: string[] = [];

  // Each <si> is one string, possibly split across several <t> runs.
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const body = si[1] ?? "";
    let text = "";
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      text += t[1] ?? "";
    }
    strings.push(decodeXml(text));
  }

  return strings;
}

/**
 * Style indices whose number format is a date, so serial numbers can be turned
 * back into dates. Covers the built-in date formats and any custom format whose
 * code contains a date token.
 */
function readDateStyles(zip: Zip): Set<number> {
  const part = zip["xl/styles.xml"];
  const dateStyles = new Set<number>();
  if (!part) return dateStyles;

  const xml = strFromU8(part);

  // Built-in numeric formats 14-22 and 45-47 are dates/times.
  const builtInDate = (id: number) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47);

  const customDateFormats = new Set<number>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/>/g)) {
    const id = Number(attr(match[0], "numFmtId"));
    const code = attr(match[0], "formatCode") ?? "";
    // A format containing y/d or mmm is a date; guard against `#,##0` etc.
    if (/[yd]/i.test(code.replace(/\[[^\]]*\]/g, "")) || /mmm/i.test(code)) {
      customDateFormats.add(id);
    }
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfs) return dateStyles;

  let index = 0;
  for (const xf of (cellXfs[1] ?? "").matchAll(/<xf\b[^>]*\/?>/g)) {
    const numFmtId = Number(attr(xf[0], "numFmtId") ?? "0");
    if (builtInDate(numFmtId) || customDateFormats.has(numFmtId)) dateStyles.add(index);
    index++;
  }

  return dateStyles;
}

function readSheetMatrix(
  xml: string,
  sharedStrings: string[],
  dateStyles: Set<number>,
): RawCell[][] {
  const matrix: RawCell[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = rowMatch[1] ?? "";
    const body = rowMatch[2] ?? "";
    const rowIndex = Number(attr(`<row ${rowAttrs}>`, "r") ?? matrix.length + 1) - 1;

    const cells: RawCell[] = [];

    for (const cellMatch of body.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = `<c ${cellMatch[1] ?? ""}>`;
      const inner = cellMatch[2] ?? "";

      const ref = attr(attrs, "r");
      const columnIndex = ref ? columnToIndex(ref) : cells.length;
      const type = attr(attrs, "t") ?? "n";
      const styleIndex = Number(attr(attrs, "s") ?? "-1");

      const value = decodeCell(inner, type, sharedStrings, dateStyles.has(styleIndex));

      // Pad any columns the file skipped (xlsx omits empty cells).
      while (cells.length < columnIndex) cells.push(null);
      cells[columnIndex] = value;
    }

    while (matrix.length < rowIndex) matrix.push([]);
    matrix[rowIndex] = cells;
  }

  return matrix;
}

function decodeCell(
  inner: string,
  type: string,
  sharedStrings: string[],
  isDate: boolean,
): RawCell {
  if (type === "inlineStr") {
    let text = "";
    for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += t[1] ?? "";
    return decodeXml(text) || null;
  }

  const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
  if (!vMatch) return null;
  const raw = decodeXml(vMatch[1] ?? "");
  if (raw === "") return null;

  switch (type) {
    case "s": {
      const index = Number(raw);
      return sharedStrings[index] ?? null;
    }
    case "b":
      return raw === "1";
    case "e":
      // An error value such as #N/A — surface the text so the audit can flag it.
      return raw;
    case "str":
      return raw;
    default: {
      const number = Number(raw);
      if (!Number.isFinite(number)) return raw;
      if (isDate && number > 0) return fromExcelSerial(number);
      return number;
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match?.[1];
}

/** `BC12` -> zero-based column 54. */
export function columnToIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase())?.[1] ?? "A";
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function cellToText(cell: RawCell): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell);
}
