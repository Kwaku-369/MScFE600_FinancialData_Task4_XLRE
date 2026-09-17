import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readXlsx } from "../src/ingest/xlsx-read.js";

/**
 * Regression cover for sparse rows.
 *
 * Core banking exports write a styled-but-empty `<c r="J2" s="17"/>` wherever a
 * column is blank, and omit skipped columns entirely. A cell parser that treats
 * the self-closing form as an opening tag runs its body match on to the next
 * cell's `</c>` and consumes it — so the empty cell AND the populated cell after
 * it both read back as null. That silently dropped Ghana Card numbers and phone
 * numbers out of the middle of otherwise healthy rows, which is precisely the
 * data this platform exists to protect.
 */

/** Minimal single-sheet workbook whose row 2 is deliberately sparse. */
function workbookWithRow(cells: string): Uint8Array {
  const sheet =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1">` +
    ["A", "B", "C", "D", "E", "F"]
      .map(
        (c, i) =>
          `<c r="${c}1" t="inlineStr"><is><t>H${i + 1}</t></is></c>`,
      )
      .join("") +
    `</row>` +
    `<row r="2">${cells}</row>` +
    `</sheetData></worksheet>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;

describe("xlsx reader — sparse and self-closing cells", () => {
  it("keeps the value that follows a styled empty cell", () => {
    const bytes = workbookWithRow(
      text("A2", "first") + `<c r="B2" s="17"/>` + text("C2", "GHA-123456780-1"),
    );
    const sheet = readXlsx(bytes, { sheetName: "Sheet1", headerRow: 1 });

    expect(sheet.rows[0]!.cells["H1"]).toBe("first");
    expect(sheet.rows[0]!.cells["H2"]).toBeNull();
    // The cell immediately after the self-closing one must survive.
    expect(sheet.rows[0]!.cells["H3"]).toBe("GHA-123456780-1");
  });

  it("keeps values after a run of consecutive empty cells", () => {
    const bytes = workbookWithRow(
      text("A2", "first") +
        `<c r="B2" s="17"/>` +
        `<c r="C2" s="17"/>` +
        `<c r="D2" s="17"/>` +
        text("E2", "+233244123456"),
    );
    const sheet = readXlsx(bytes, { sheetName: "Sheet1", headerRow: 1 });

    expect(sheet.rows[0]!.cells["H2"]).toBeNull();
    expect(sheet.rows[0]!.cells["H3"]).toBeNull();
    expect(sheet.rows[0]!.cells["H4"]).toBeNull();
    expect(sheet.rows[0]!.cells["H5"]).toBe("+233244123456");
  });

  it("places values by column reference when columns are omitted entirely", () => {
    // No B or C element at all — the classic xlsx sparse row.
    const bytes = workbookWithRow(text("A2", "first") + text("D2", "fourth"));
    const sheet = readXlsx(bytes, { sheetName: "Sheet1", headerRow: 1 });

    expect(sheet.rows[0]!.cells["H1"]).toBe("first");
    expect(sheet.rows[0]!.cells["H2"]).toBeNull();
    expect(sheet.rows[0]!.cells["H3"]).toBeNull();
    expect(sheet.rows[0]!.cells["H4"]).toBe("fourth");
  });
});
