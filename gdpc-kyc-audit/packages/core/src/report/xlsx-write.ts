/**
 * A minimal styled XLSX writer.
 *
 * Written directly against the OOXML format for the same reason as the reader:
 * it must run in a Worker with no Node dependency. Writing it by hand also
 * gives exact control over cell fills, which the audit output depends on — the
 * colour of a cell is the finding, as far as the branch officer reading the
 * returned file is concerned.
 */

import { zipSync, strToU8 } from "fflate";

/** The palette. Deliberately distinguishable when printed in greyscale too. */
export const FILL_COLOURS = {
  /** Verified against the Ghana Card and unchanged. */
  clean: "FFC6EFCE",
  /** Corrected automatically; the value being submitted differs from the source. */
  autoCorrected: "FFD9E1F2",
  /** A human must decide. */
  needsReview: "FFFFEB9C",
  /** Bank record and Ghana Card disagree materially. */
  conflict: "FFF8CBAD",
  /** Cannot be submitted. */
  rejected: "FFFFC7CE",
  /** Missing / not supplied. */
  missing: "FFE7E6E6",
  header: "FF1F3864",
} as const;

export type FillKey = keyof typeof FILL_COLOURS;

export interface StyledCell {
  value: string | number | boolean | null;
  fill?: FillKey;
  bold?: boolean;
  /** Cell note rendered as a comment-style extra column by the report builder. */
  note?: string;
  /** Force text formatting so long digit strings are not mangled into floats. */
  text?: boolean;
}

export interface SheetData {
  name: string;
  rows: StyledCell[][];
  /** Column widths in characters. */
  columnWidths?: number[];
  /** Freeze everything above and including this 1-based row. */
  freezeRow?: number;
}

/** Style table: index into cellXfs, built once and shared by every sheet. */
const FILL_ORDER: FillKey[] = [
  "clean", "autoCorrected", "needsReview", "conflict", "rejected", "missing", "header",
];

/**
 * cellXfs layout:
 *   0            default
 *   1            default bold
 *   2            default text-format
 *   3 + 3*i      fill i
 *   4 + 3*i      fill i, bold
 *   5 + 3*i      fill i, text-format
 */
function styleIndex(cell: StyledCell): number {
  if (!cell.fill) {
    if (cell.bold) return 1;
    if (cell.text) return 2;
    return 0;
  }
  const fillIndex = FILL_ORDER.indexOf(cell.fill);
  const base = 3 + fillIndex * 3;
  if (cell.bold) return base + 1;
  if (cell.text) return base + 2;
  return base;
}

export function writeXlsx(sheets: SheetData[]): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");

  const files: Record<string, Uint8Array> = {};

  files["[Content_Types].xml"] = strToU8(contentTypes(sheets.length));
  files["_rels/.rels"] = strToU8(rootRels());
  files["xl/workbook.xml"] = strToU8(workbook(sheets));
  files["xl/_rels/workbook.xml.rels"] = strToU8(workbookRels(sheets.length));
  files["xl/styles.xml"] = strToU8(styles());

  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheet(sheet));
  });

  return zipSync(files, { level: 6 });
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function contentTypes(sheetCount: number): string {
  const overrides = Array.from({ length: sheetCount }, (_v, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;
}

function rootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function workbook(sheets: SheetData[]): string {
  const entries = sheets
    .map(
      (sheet, i) =>
        `<sheet name="${escapeXml(sheetName(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${entries}</sheets>
</workbook>`;
}

function workbookRels(sheetCount: number): string {
  const entries = Array.from({ length: sheetCount }, (_v, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

function styles(): string {
  // Fill 0 and 1 are reserved by the format (none / gray125).
  const fills = FILL_ORDER.map(
    (key) =>
      `<fill><patternFill patternType="solid"><fgColor rgb="${FILL_COLOURS[key]}"/><bgColor indexed="64"/></patternFill></fill>`,
  ).join("");

  const xfs: string[] = [
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`,
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`,
    `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
  ];

  FILL_ORDER.forEach((key, i) => {
    const fillId = i + 2;
    // The header fill is dark, so it pairs with the white font (fontId 2).
    const fontId = key === "header" ? 2 : 0;
    const boldFontId = key === "header" ? 2 : 1;
    xfs.push(
      `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>`,
      `<xf numFmtId="0" fontId="${boldFontId}" fillId="${fillId}" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"/>`,
      `<xf numFmtId="49" fontId="${fontId}" fillId="${fillId}" borderId="1" xfId="0" applyFill="1" applyNumberFormat="1" applyBorder="1"/>`,
    );
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="${FILL_ORDER.length + 2}">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
${fills}
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
</styleSheet>`;
}

function worksheet(sheet: SheetData): string {
  const cols = sheet.columnWidths
    ? `<cols>${sheet.columnWidths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("")}</cols>`
    : "";

  const pane = sheet.freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";

  const rows = sheet.rows
    .map((cells, r) => {
      const rowNumber = r + 1;
      const body = cells
        .map((cell, c) => renderCell(cell, columnLetter(c) + rowNumber))
        .filter((s) => s !== "")
        .join("");
      return `<row r="${rowNumber}">${body}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${pane}${cols}
<sheetData>${rows}</sheetData>
</worksheet>`;
}

function renderCell(cell: StyledCell, ref: string): string {
  const style = styleIndex(cell);
  const styleAttr = style === 0 ? "" : ` s="${style}"`;

  if (cell.value === null || cell.value === undefined || cell.value === "") {
    // An empty but filled cell still needs to exist so the colour shows.
    return cell.fill ? `<c r="${ref}"${styleAttr}/>` : "";
  }

  if (typeof cell.value === "number" && Number.isFinite(cell.value) && !cell.text) {
    return `<c r="${ref}"${styleAttr}><v>${cell.value}</v></c>`;
  }

  if (typeof cell.value === "boolean") {
    return `<c r="${ref}"${styleAttr} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
  }

  // Inline strings avoid a shared-string table entirely.
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
    String(cell.value),
  )}</t></is></c>`;
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Excel rejects these characters in a sheet name, and caps it at 31 chars. */
function sheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet";
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Strip characters XML 1.0 cannot represent at all.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
