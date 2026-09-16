import { describe, expect, it } from "vitest";
import { autoMap } from "../src/mapping/auto-map.js";
import { normalizeRows } from "../src/normalize/record.js";
import { runAudit } from "../src/audit/engine.js";
import { GDPC_SCV_V1 } from "../src/profiles/gdpc-scv-v1.js";
import { getTable } from "../src/profiles/registry.js";
import { readCsv } from "../src/ingest/csv.js";

/**
 * The GDPC template checked against itself.
 *
 * These headings, value conventions and defects are taken from a real member-bank
 * extract: 233-prefixed phone numbers, Ghana Card numbers both hyphenated and
 * bare, day-first dates, the 01/01/1900 migration default, whole names collapsed
 * into one column, and T24 section banners leaking into Product Name.
 *
 * The rows below are INVENTED. Every CIN, card number, phone number, account
 * number, name, address and balance here is made up; only the shapes, the value
 * conventions and the defect patterns are taken from the real file. Real
 * depositor data must never be committed to this repository.
 */

const TODAY = "2026-09-16";
const table = getTable(GDPC_SCV_V1, "A");

const HEADERS = table.fields.map((f) => f.header.trim());

/** The template's own headings, exactly as the portal expects them. */
const REAL_HEADERS = [
  "Bank Specific Cin", "Customer Type", "Title", "First Name", "Middle Name",
  "Surname", "Previous Name", "Company Name", "Gender", "Id Type", "Id Number",
  "Company Number (If Any)", "Dob", "Home Address", "Postal Address", "Country",
  "Email", "Main Phone Number", "Mobile Phone Number", "Mobile Money Number",
  "Politically Exposed Person (Yes/No)", "Account Type", "Account By Ownership",
  "Account Number", "Product Name", "Status Of Account", "Exclusion Type",
  "Account Branch", "Account Balance (% Share For Joint Accounts)",
  "Auth. Negative Balance", "Currency Of Account",
  "Account Balance In Original Currency", "Exchange Rate",
  "Account Balance In Cedis", "Overdue Loans",
];

function row(cells: Partial<Record<string, string>>): string {
  return REAL_HEADERS.map((h) => {
    const v = cells[h] ?? "";
    return v.includes(",") ? `"${v}"` : v;
  }).join(",");
}

const CSV = [
  REAL_HEADERS.join(","),
  // Healthy record, card written bare, phone in 233 form.
  row({
    "Bank Specific Cin": "KMH900001", "Customer Type": "I", Title: "Mr.",
    "First Name": "KWEKU", Surname: "BOATENG", Gender: "M", "Id Type": "G",
    "Id Number": "GHA4001002003", Dob: "01/04/1992",
    "Home Address": "AZ-0000-0001 - KONA", Country: "Ghana",
    "Main Phone Number": "233240000101", "Mobile Phone Number": "233240000101",
    "Mobile Money Number": "233240000101",
    "Politically Exposed Person (Yes/No)": "No", "Account Type": "C",
    "Account By Ownership": "I", "Account Number": "9990000000001",
    "Product Name": "Current Account", "Status Of Account": "A",
    "Account Branch": "KWAMANMAN KONA", "Currency Of Account": "GHS",
    "Account Balance In Original Currency": "1000.00", "Exchange Rate": "1",
    "Account Balance In Cedis": "1000.00", "Overdue Loans": "0",
  }),
  // Card hyphenated; whole name duplicated across First Name and Surname.
  row({
    "Bank Specific Cin": "KMH900002", "Customer Type": "I", Title: "Mr.",
    "First Name": "ANNAN KWABENA JOSEPH", Surname: "JOSEPH ANNAN KWABENA",
    Gender: "M", "Id Type": "G", "Id Number": "GHA-400200100-7",
    Dob: "07/03/1975", "Home Address": "KHM 00 SAMPLE KONA", Country: "Ghana",
    "Main Phone Number": "233240000102",
    "Politically Exposed Person (Yes/No)": "No", "Account Type": "C",
    "Account By Ownership": "I", "Account Number": "9990000000002",
    "Product Name": "Current Account", "Status Of Account": "A",
    "Account Branch": "KWAMANMAN KONA", "Currency Of Account": "GHS",
    "Account Balance In Original Currency": "3.00", "Exchange Rate": "1",
    "Account Balance In Cedis": "3.00", "Overdue Loans": "0",
  }),
  // The legacy migration cohort: 1900 default, no ID at all, no phone.
  row({
    "Bank Specific Cin": "KMH900003", "Customer Type": "I", Title: "Mr.",
    "First Name": "TETTEH NII ARYEE", Surname: "TETTEH NII ARYEE",
    Gender: "M", Dob: "01/01/1900", "Home Address": "EJ 00 SAMPLE EJISU",
    Country: "Ghana", "Politically Exposed Person (Yes/No)": "No",
    "Account Type": "C", "Account By Ownership": "C",
    "Account Number": "9990000000003", "Product Name": "Current Account",
    "Status Of Account": "A", "Account Branch": "KWAMANMAN KONA",
    "Currency Of Account": "GHS",
    "Account Balance In Original Currency": "10.00", "Exchange Rate": "1",
    "Account Balance In Cedis": "10.00", "Overdue Loans": "0",
  }),
  // Legacy voters ID rather than a Ghana Card.
  row({
    "Bank Specific Cin": "KMH900004", "Customer Type": "I", Title: "Mr.",
    "First Name": "SEIDU", Surname: "ALHASSAN", Gender: "M", "Id Type": "V",
    "Id Number": "8821450037", Dob: "29/04/1992",
    "Home Address": "SAMPLE ZONGO", Country: "Ghana",
    "Main Phone Number": "233550000103",
    "Politically Exposed Person (Yes/No)": "No", "Account Type": "S",
    "Account By Ownership": "I", "Account Number": "9990000000004",
    "Product Name": "Susu Savings Account", "Status Of Account": "A",
    "Account Branch": "KWAMANMAN KONA", "Currency Of Account": "GHS",
    "Account Balance In Original Currency": "1500.00", "Exchange Rate": "1",
    "Account Balance In Cedis": "1500.00", "Overdue Loans": "0",
  }),
].join("\n");

describe("the real GDPC template", () => {
  it("declares exactly the thirty-five observed columns, in order", () => {
    expect(HEADERS).toEqual(REAL_HEADERS);
  });

  const sheet = readCsv(CSV);
  const plan = autoMap(sheet.headers, GDPC_SCV_V1, "A");

  it("maps every column of the template onto itself", () => {
    const unmapped = table.fields.filter(
      (f) => !plan.mappings.some((m) => m.fieldId === f.id && m.sourceHeader),
    );
    expect(unmapped.map((f) => f.header)).toEqual([]);
  });

  it("keeps the three phone columns apart", () => {
    const by = (id: string) => plan.mappings.find((m) => m.fieldId === id)?.sourceHeader;
    expect(by("depositor.mobile_number")).toBe("Main Phone Number");
    expect(by("depositor.alternate_number")).toBe("Mobile Phone Number");
    expect(by("depositor.momo_number")).toBe("Mobile Money Number");
  });

  it("keeps Account Type and Product Name apart", () => {
    const by = (id: string) => plan.mappings.find((m) => m.fieldId === id)?.sourceHeader;
    expect(by("account.account_type")).toBe("Account Type");
    expect(by("account.product_name")).toBe("Product Name");
  });

  it("maps the cedi balance rather than the original-currency one", () => {
    const by = (id: string) => plan.mappings.find((m) => m.fieldId === id)?.sourceHeader;
    expect(by("account.balance")).toBe("Account Balance In Cedis");
    expect(by("account.balance_original")).toBe("Account Balance In Original Currency");
  });

  const records = normalizeRows(sheet.rows, table, plan, {
    dateOptions: { today: TODAY },
    keyPrefix: "kona",
  });

  it("normalises both Ghana Card spellings to the canonical form", () => {
    expect(records[0]!.fields["depositor.ghana_card_pin"]?.value).toBe("GHA-400100200-3");
    expect(records[1]!.fields["depositor.ghana_card_pin"]?.value).toBe("GHA-400200100-7");
  });

  it("reads 233-prefixed numbers without a plus as Ghanaian", () => {
    expect(records[0]!.fields["depositor.mobile_number"]?.value).toBe("+233240000101");
  });

  it("reads the day-first dates the extract uses", () => {
    expect(records[0]!.fields["depositor.date_of_birth"]?.value).toBe("1992-04-01");
    expect(records[1]!.fields["depositor.date_of_birth"]?.value).toBe("1975-03-07");
  });

  const audit = runAudit({
    profile: GDPC_SCV_V1,
    table,
    records,
    verifications: new Map(),
    config: { today: TODAY },
  });

  const codesFor = (rowNumber: number) =>
    audit.findings.filter((f) => f.rowNumber === rowNumber).map((f) => f.code);

  it("flags the 1900 migration default rather than accepting it as a birth date", () => {
    // Row 4 of the CSV: header is row 1, so the third data row is row 4.
    expect(codesFor(4)).toContain("DOB_PLACEHOLDER");
    expect(codesFor(4)).toContain("ID_MISSING");
  });

  it("carries the healthy record through on auto-corrections alone", () => {
    const codes = codesFor(2);
    // T24 codes, the bare card and the 233-prefixed phone are all deterministic
    // rewrites, so none of them should hold the record back.
    expect(codes).toContain("ENUM_NORMALISED");
    expect(codes).toContain("ID_NORMALISED");
    expect(codes).toContain("PHONE_NORMALISED");
    expect(codes).not.toContain("ENUM_INVALID");
    expect(codes).not.toContain("REQUIRED_FIELD_EMPTY");

    const blocking = audit.findings.filter(
      (f) => f.rowNumber === 2 && f.disposition === "rejected",
    );
    expect(blocking).toEqual([]);
  });

  it("still holds back a day/month-ambiguous date for checking", () => {
    // 01/04/1992 is 1 April or 4 January depending on the writer, and nothing in
    // the row settles it. With no NIA record to compare against it must stay in
    // the queue rather than be guessed — dates are checked, never assumed.
    expect(codesFor(2)).toContain("DOB_AMBIGUOUS");
  });
});
