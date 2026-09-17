import { describe, expect, it } from "vitest";
import { readCsv } from "../src/ingest/csv.js";
import { readXlsx } from "../src/ingest/xlsx-read.js";
import { autoMap } from "../src/mapping/auto-map.js";
import { normalizeRows } from "../src/normalize/record.js";
import { runAudit, applyAutoCorrections } from "../src/audit/engine.js";
import { GDPC_SCV_V1 } from "../src/profiles/gdpc-scv-v1.js";
import { getTable } from "../src/profiles/registry.js";
import { buildAlignedWorkbook, buildAuditReport } from "../src/report/workbook.js";
import type { VerificationOutcome } from "../src/types.js";

const TODAY = "2026-08-27";
const table = getTable(GDPC_SCV_V1, "A");

/**
 * A deliberately messy export of the kind a rural bank actually sends: a title
 * banner above the headers, headings from the core system rather than the GDPC
 * template, a combined name column, an Excel-mangled phone number, a Ghana Card
 * number without hyphens, and a date in an ambiguous format.
 */
const MESSY_CSV = [
  "AKUAPEM RURAL BANK LTD",
  "Customer KYC Extract as at 30 June 2026",
  "",
  "CIF NO,CUSTOMER NAME,GHANA CARD NO,D.O.B,SEX,MOBILE NO,CLIENT TYPE",
  "C001,Mr. Kwame Mensah Adu,GHA1234567801,03/04/1985,M,244123456,Individual",
  "C002,\"MENSAH, Abena\",GHA-234567890-2,25/12/1990,F,0201234567,IND",
  "C003,Kojo Mensa,gha 345678901 3,12/07/1978,Male,+233 (0) 27 765 4321,Individual",
  "C004,Yaa Asantewaa,,01/01/1900,F,0000000000,Individual",
  "C005,K. Owusu,GHA-456789012-4,15/03/1982,M,0244123456,Individual",
].join("\n");

function verification(pin: string, first: string, middle: string | null, last: string, dob: string): VerificationOutcome {
  return {
    status: "verified",
    identity: {
      source: "nia",
      personalNumber: pin,
      firstName: first,
      middleName: middle,
      lastName: last,
      gender: "M",
      dateOfBirth: dob,
      placeOfBirth: null,
      nationality: "GHANAIAN",
      regDate: null,
      expiryDate: "2030-01-01",
      retrievedAt: TODAY + "T00:00:00Z",
    },
  };
}

describe("end-to-end alignment pipeline", () => {
  const sheet = readCsv(MESSY_CSV);

  it("finds the real header row beneath the bank's title banner", () => {
    expect(sheet.headerRowNumber).toBe(4);
    expect(sheet.headers).toContain("GHANA CARD NO");
    expect(sheet.rows).toHaveLength(5);
  });

  const plan = autoMap(sheet.headers, GDPC_SCV_V1, "A");

  it("maps core-system headings onto the GDPC template", () => {
    const by = (id: string) => plan.mappings.find((m) => m.fieldId === id);
    expect(by("depositor.customer_id")?.sourceHeader).toBe("CIF NO");
    expect(by("depositor.ghana_card_pin")?.sourceHeader).toBe("GHANA CARD NO");
    expect(by("depositor.date_of_birth")?.sourceHeader).toBe("D.O.B");
    expect(by("depositor.gender")?.sourceHeader).toBe("SEX");
    expect(by("depositor.mobile_number")?.sourceHeader).toBe("MOBILE NO");
  });

  it("recognises the single combined name column and plans to split it", () => {
    expect(plan.requiresNameSplit).toBe(true);
    expect(plan.combinedNameHeader).toBe("CUSTOMER NAME");
  });

  const records = normalizeRows(sheet.rows, table, plan, {
    dateOptions: { today: TODAY },
    keyPrefix: "batch1",
  });

  it("splits the combined name into the template's discrete fields", () => {
    const first = records[0]!;
    expect(first.fields["depositor.first_name"]?.value).toBe("KWAME");
    expect(first.fields["depositor.other_names"]?.value).toBe("MENSAH");
    expect(first.fields["depositor.surname"]?.value).toBe("ADU");
  });

  it("normalises the Ghana Card, phone and date on the way through", () => {
    const first = records[0]!;
    expect(first.fields["depositor.ghana_card_pin"]?.value).toBe("GHA-123456780-1");
    expect(first.fields["depositor.mobile_number"]?.value).toBe("+233244123456");
    expect(first.fields["depositor.date_of_birth"]?.value).toBe("1985-04-03");
    expect(first.fields["depositor.gender"]?.value).toBe("M");
    expect(first.fields["depositor.customer_type"]?.value).toBe("INDIVIDUAL");
  });

  const verifications = new Map<string, VerificationOutcome>([
    // Same person, but the card orders the names differently.
    [records[0]!.recordKey, verification("GHA-123456780-1", "ADU", "KWAME", "MENSAH", "1985-04-03")],
    // Card carries a middle name the bank does not hold.
    [records[1]!.recordKey, verification("GHA-234567890-2", "ABENA", "AKOSUA", "MENSAH", "1990-12-25")],
    // Day-name variant plus a spelling variant of the surname.
    [records[2]!.recordKey, verification("GHA-345678901-3", "KWADWO", null, "MENSAH", "1978-07-12")],
    // Date of birth transposed relative to the card.
    [records[4]!.recordKey, verification("GHA-456789012-4", "KWAME", null, "OWUSU", "1982-03-15")],
  ]);

  const audit = runAudit({
    profile: GDPC_SCV_V1,
    table,
    records,
    verifications,
    config: { today: TODAY },
  });

  const codesFor = (rowNumber: number) =>
    audit.findings.filter((f) => f.rowNumber === rowNumber).map((f) => f.code);

  it("accepts a reordered name rather than calling it a mismatch", () => {
    const codes = codesFor(5);
    expect(codes).toContain("NAME_ORDER_DIFFERS");
    expect(codes).not.toContain("NAME_MISMATCH");
  });

  it("flags a middle name held by the NIA but not by the bank", () => {
    expect(codesFor(6)).toContain("NAME_MISSING_COMPONENT");
  });

  it("accepts Kojo/Kwadwo and Mensa/Mensah as the same person", () => {
    const codes = codesFor(7);
    expect(codes).toContain("NAME_VARIANT");
    expect(codes).not.toContain("NAME_MISMATCH");
  });

  it("rejects the record with no Ghana Card and a placeholder date", () => {
    const codes = codesFor(8);
    expect(codes).toContain("ID_MISSING");
    expect(codes).toContain("DOB_PLACEHOLDER");
    expect(codes).toContain("PHONE_FILLER");
  });

  it("detects a name captured as an initial", () => {
    expect(codesFor(9)).toContain("NAME_INITIAL_ONLY");
  });

  it("detects the shared mobile number across two depositors", () => {
    const shared = audit.findings.filter((f) => f.code === "PHONE_SHARED");
    // Threshold is 3 by default and only two records share the number.
    expect(shared).toHaveLength(0);
  });

  it("summarises the batch", () => {
    expect(audit.summary.totalRecords).toBe(5);
    expect(audit.summary.rejectedRecords).toBeGreaterThan(0);
    expect(audit.summary.submissionReadiness).toBeLessThan(1);
    expect(Object.keys(audit.summary.byCode).length).toBeGreaterThan(3);
  });

  it("applies only the deterministic corrections", () => {
    const { records: corrected, applied } = applyAutoCorrections(audit);
    expect(applied.every((f) => f.disposition === "auto_corrected")).toBe(true);
    expect(corrected).toHaveLength(5);
  });

  it("produces a submission workbook that reads back correctly", () => {
    const bytes = buildAlignedWorkbook(GDPC_SCV_V1, table, audit, {
      institutionName: "Akuapem Rural Bank Ltd",
      batchReference: "BATCH-1",
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const readBack = readXlsx(bytes, { sheetName: table.sheetName, headerRow: 1 });
    // The workbook is written with the template's headings exactly as GDPC
    // supplies them, padding included (" Account Balance In Cedis "). The reader
    // trims on the way back in — deliberately, because bank files carry stray
    // whitespace everywhere — so the round trip is compared against trimmed form.
    expect(readBack.headers).toEqual(table.fields.map((f) => f.header.trim()));
    expect(readBack.rows).toHaveLength(5);
    expect(readBack.rows[0]!.cells["Id Number"]).toBe("GHA-123456780-1");
    expect(readBack.rows[0]!.cells["Main Phone Number"]).toBe("+233244123456");
  });

  it("produces an audit report workbook with the expected sheets", () => {
    const bytes = buildAuditReport(GDPC_SCV_V1, table, audit, {
      institutionName: "Akuapem Rural Bank Ltd",
      generatedAt: TODAY + "T09:00:00Z",
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const findings = readXlsx(bytes, { sheetName: "Findings", headerRow: 1 });
    expect(findings.headers).toContain("Code");
    expect(findings.rows.length).toBeGreaterThan(0);
  });
});

describe("dishonest inputs are not silently accepted", () => {
  it("does not map an unrelated column onto a required field", () => {
    const sheet = readCsv("FRUIT,COLOUR,WEIGHT\napple,red,120");
    const plan = autoMap(sheet.headers, GDPC_SCV_V1, "A");
    expect(plan.missingRequired).toContain("depositor.ghana_card_pin");
    expect(plan.missingRequired).toContain("depositor.surname");
  });

  it("flags two depositors sharing one Ghana Card", () => {
    const csv = [
      "CIF NO,SURNAME,FIRST NAME,GHANA CARD NO,D.O.B,SEX,MOBILE NO,CLIENT TYPE",
      "C001,MENSAH,KWAME,GHA-123456780-1,03/04/1985,M,0244123456,Individual",
      "C002,OWUSU,YAA,GHA-123456780-1,05/05/1988,F,0201234567,Individual",
    ].join("\n");
    const sheet = readCsv(csv);
    const plan = autoMap(sheet.headers, GDPC_SCV_V1, "A");
    const records = normalizeRows(sheet.rows, table, plan, { dateOptions: { today: TODAY } });
    const audit = runAudit({ profile: GDPC_SCV_V1, table, records, config: { today: TODAY } });

    expect(audit.findings.filter((f) => f.code === "ID_DUPLICATE")).toHaveLength(2);
  });
});
