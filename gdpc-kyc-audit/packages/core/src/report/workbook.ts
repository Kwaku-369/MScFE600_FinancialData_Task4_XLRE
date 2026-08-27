/**
 * Builds the two deliverables of a run:
 *
 *  1. The GDPC-aligned submission workbook — the template's own columns, in the
 *     template's own order, with every cell colour-coded by what the engine did
 *     to it. This is the file the bank uploads, and the colours are what let a
 *     branch officer see at a glance which rows they must fix first.
 *
 *  2. The audit report workbook — findings, evidence and a summary, which is
 *     what goes to the auditor and, ultimately, to the regulator.
 *
 * A submission file is only ever exported with the corrected values; the
 * original value is preserved alongside in the audit report so the change is
 * always traceable.
 */

import type {
  BatchAudit,
  Disposition,
  Finding,
  RecordAudit,
  TableSpec,
  TemplateProfile,
} from "../types.js";
import { CODE_SPECS, codeSpec } from "../audit/codes.js";
import { formatMoney } from "../normalize/money.js";
import { FILL_COLOURS, writeXlsx, type FillKey, type SheetData, type StyledCell } from "./xlsx-write.js";

const DISPOSITION_FILL: Record<Disposition, FillKey> = {
  clean: "clean",
  auto_corrected: "autoCorrected",
  needs_review: "needsReview",
  conflict: "conflict",
  rejected: "rejected",
};

export interface WorkbookOptions {
  institutionName?: string;
  reportingDate?: string;
  generatedAt?: string;
  batchReference?: string;
  /**
   * When false the submission sheet omits colour, producing the plain file the
   * GDPC portal expects. Default true (the working copy for the bank).
   */
  colourCoded?: boolean;
}

/**
 * The submission workbook: one sheet per table, exactly the template's columns.
 */
export function buildAlignedWorkbook(
  profile: TemplateProfile,
  table: TableSpec,
  audit: BatchAudit,
  options: WorkbookOptions = {},
): Uint8Array {
  const colour = options.colourCoded !== false;

  const header: StyledCell[] = table.fields.map((f) => ({
    value: f.header,
    fill: "header",
    bold: true,
  }));

  const rows: StyledCell[][] = [header];

  for (const recordAudit of audit.records) {
    const findingsByField = groupByField(recordAudit.findings);

    const row: StyledCell[] = table.fields.map((field) => {
      const cell = recordAudit.record.fields[field.id];
      const fieldFindings = findingsByField.get(field.id) ?? [];

      const value = formatValue(cell?.value ?? null, field.kind);

      if (!colour) return { value, text: isTextual(field.kind) };

      let fill: FillKey | undefined;
      if (fieldFindings.length > 0) {
        const worst = fieldFindings.reduce((w, f) =>
          rank(f.disposition) < rank(w.disposition) ? f : w,
        );
        fill = DISPOSITION_FILL[worst.disposition];
      } else if (cell?.value === null && field.required) {
        fill = "missing";
      } else if (cell?.value !== null) {
        fill = "clean";
      }

      const styled: StyledCell = { value, text: isTextual(field.kind) };
      if (fill) styled.fill = fill;
      return styled;
    });

    rows.push(row);
  }

  const sheets: SheetData[] = [
    {
      name: table.sheetName,
      rows,
      freezeRow: 1,
      columnWidths: table.fields.map((f) => Math.min(38, Math.max(14, f.header.length + 4))),
    },
  ];

  if (colour) sheets.push(legendSheet(profile, options));

  return writeXlsx(sheets);
}

/**
 * The audit report: a findings register, a per-field before/after ledger, and a
 * summary an auditor can sign.
 */
export function buildAuditReport(
  profile: TemplateProfile,
  table: TableSpec,
  audit: BatchAudit,
  options: WorkbookOptions = {},
): Uint8Array {
  return writeXlsx([
    summarySheet(profile, table, audit, options),
    findingsSheet(audit),
    changeLedgerSheet(table, audit),
    exceptionsByCodeSheet(audit),
    legendSheet(profile, options),
  ]);
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

function summarySheet(
  profile: TemplateProfile,
  table: TableSpec,
  audit: BatchAudit,
  options: WorkbookOptions,
): SheetData {
  const s = audit.summary;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const rows: StyledCell[][] = [
    [{ value: "GDPC KYC Alignment and Audit Report", fill: "header", bold: true }, blank(), blank()],
    [],
    ...pairs([
      ["Institution", options.institutionName ?? "(not supplied)"],
      ["Batch reference", options.batchReference ?? "(not supplied)"],
      ["Reporting date", options.reportingDate ?? "(not supplied)"],
      ["Template profile", `${profile.label} (${profile.id} v${profile.version})`],
      ["Table", `${table.id} — ${table.name}`],
      ["Generated at", generatedAt],
    ]),
    [],
    [{ value: "Outcome", fill: "header", bold: true }, { value: "Records", fill: "header", bold: true }, { value: "Share", fill: "header", bold: true }],
    dispositionRow("Clean — no exception raised", s.cleanRecords, s.totalRecords, "clean"),
    dispositionRow("Auto-corrected — engine applied a deterministic fix", s.autoCorrectedRecords, s.totalRecords, "autoCorrected"),
    dispositionRow("Needs review — a human must decide", s.needsReviewRecords, s.totalRecords, "needsReview"),
    dispositionRow("Conflict — bank record disagrees with the Ghana Card", s.conflictRecords, s.totalRecords, "conflict"),
    dispositionRow("Rejected — cannot be submitted as-is", s.rejectedRecords, s.totalRecords, "rejected"),
    [{ value: "Total records", bold: true }, { value: s.totalRecords, bold: true }, blank()],
    [],
    [
      { value: "Submission readiness", bold: true },
      { value: `${(s.submissionReadiness * 100).toFixed(1)}%` },
      { value: "Share of records requiring no human intervention before upload." },
    ],
    [],
    [{ value: "Findings by severity", fill: "header", bold: true }, blank(), blank()],
    ...pairs([
      ["Critical", String(s.bySeverity.critical)],
      ["Major", String(s.bySeverity.major)],
      ["Minor", String(s.bySeverity.minor)],
      ["Informational", String(s.bySeverity.info)],
    ]),
    [],
    [{ value: "Findings by category", fill: "header", bold: true }, blank(), blank()],
    ...pairs(
      Object.entries(s.byCategory)
        .filter(([, count]) => count > 0)
        .map(([category, count]) => [prettyCategory(category), String(count)] as [string, string]),
    ),
  ];

  if (profile.provenance) {
    rows.push(
      [],
      [{ value: "Template provenance", fill: "needsReview", bold: true }, blank(), blank()],
      [{ value: profile.provenance }, blank(), blank()],
    );
  }

  return { name: "Summary", rows, columnWidths: [52, 18, 60], freezeRow: 1 };
}

function findingsSheet(audit: BatchAudit): SheetData {
  const header: StyledCell[] = [
    "Row", "Record key", "Severity", "Disposition", "Code", "Field",
    "What was found", "Bank value", "Authoritative value", "Proposed value", "Confidence",
  ].map((h) => ({ value: h, fill: "header" as FillKey, bold: true }));

  const rows: StyledCell[][] = [header];

  const sorted = [...audit.findings].sort(
    (a, b) => a.rowNumber - b.rowNumber || a.code.localeCompare(b.code),
  );

  for (const finding of sorted) {
    rows.push([
      { value: finding.rowNumber },
      { value: finding.recordKey, text: true },
      { value: finding.severity, fill: severityFill(finding.severity) },
      { value: prettyDisposition(finding.disposition), fill: DISPOSITION_FILL[finding.disposition] },
      { value: finding.code, text: true },
      { value: finding.fieldId ?? "", text: true },
      { value: finding.message },
      { value: stringify(finding.observed), text: true },
      { value: stringify(finding.expected), text: true },
      { value: stringify(finding.proposedValue), text: true },
      { value: finding.confidence !== undefined ? Number(finding.confidence.toFixed(3)) : "" },
    ]);
  }

  if (rows.length === 1) {
    rows.push([{ value: "No exceptions were raised for this batch.", fill: "clean" }]);
  }

  return {
    name: "Findings",
    rows,
    freezeRow: 1,
    columnWidths: [8, 22, 11, 18, 26, 26, 70, 26, 26, 26, 12],
  };
}

/**
 * Every cell the engine changed, with both values side by side. This is the
 * sheet an auditor works through to accept or reverse the alignment.
 */
function changeLedgerSheet(table: TableSpec, audit: BatchAudit): SheetData {
  const header: StyledCell[] = [
    "Row", "Field", "Original value", "Submitted value", "Why it changed", "Disposition",
  ].map((h) => ({ value: h, fill: "header" as FillKey, bold: true }));

  const rows: StyledCell[][] = [header];

  for (const recordAudit of audit.records) {
    const findingsByField = groupByField(recordAudit.findings);

    for (const field of table.fields) {
      const cell = recordAudit.record.fields[field.id];
      if (!cell || !cell.changed) continue;

      const original = stringify(cell.raw);
      const submitted = formatValue(cell.value, field.kind);
      if (original === submitted) continue;

      const fieldFindings = findingsByField.get(field.id) ?? [];
      const disposition: Disposition =
        fieldFindings.length > 0
          ? fieldFindings.reduce((w, f) => (rank(f.disposition) < rank(w.disposition) ? f : w))
              .disposition
          : "auto_corrected";

      const reason = cell.notes.length > 0
        ? cell.notes.join(" ")
        : fieldFindings.map((f) => f.message).join(" ");

      rows.push([
        { value: recordAudit.record.rowNumber },
        { value: field.header, text: true },
        { value: original, text: true },
        { value: submitted, text: true, fill: DISPOSITION_FILL[disposition] },
        { value: reason },
        { value: prettyDisposition(disposition), fill: DISPOSITION_FILL[disposition] },
      ]);
    }
  }

  if (rows.length === 1) {
    rows.push([{ value: "No values were altered during alignment.", fill: "clean" }]);
  }

  return {
    name: "Change ledger",
    rows,
    freezeRow: 1,
    columnWidths: [8, 26, 30, 30, 70, 18],
  };
}

function exceptionsByCodeSheet(audit: BatchAudit): SheetData {
  const header: StyledCell[] = [
    "Code", "Category", "Severity", "Occurrences", "What it means", "What to do",
  ].map((h) => ({ value: h, fill: "header" as FillKey, bold: true }));

  const rows: StyledCell[][] = [header];

  const counts = audit.summary.byCode;
  const present = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  for (const [code, count] of present) {
    const spec = codeSpec(code);
    rows.push([
      { value: code, text: true },
      { value: prettyCategory(spec.category) },
      { value: spec.severity, fill: severityFill(spec.severity) },
      { value: count },
      { value: spec.title },
      { value: spec.guidance },
    ]);
  }

  if (present.length === 0) {
    rows.push([{ value: "No exception codes were raised.", fill: "clean" }]);
  }

  return { name: "Exceptions by code", rows, freezeRow: 1, columnWidths: [28, 16, 11, 14, 44, 78] };
}

function legendSheet(profile: TemplateProfile, options: WorkbookOptions): SheetData {
  const rows: StyledCell[][] = [
    [{ value: "How to read this workbook", fill: "header", bold: true }, blank()],
    [],
    [{ value: "Colour", bold: true }, { value: "Meaning", bold: true }],
    [{ value: "Clean", fill: "clean" }, { value: "Verified and unchanged. Nothing to do." }],
    [{ value: "Auto-corrected", fill: "autoCorrected" }, { value: "The engine applied a deterministic correction — reformatting, re-ordering a name, or adopting the Ghana Card reading of a transposed date. The change is listed in the change ledger." }],
    [{ value: "Needs review", fill: "needsReview" }, { value: "A person must decide. Usually an accepted name variant, a missing middle name, or a value outside the permitted list." }],
    [{ value: "Conflict", fill: "conflict" }, { value: "The bank record and the Ghana Card disagree on something material — the name, or the date of birth. Resolve before submitting." }],
    [{ value: "Rejected", fill: "rejected" }, { value: "The record cannot be submitted as it stands. A required value is absent or unusable." }],
    [{ value: "Missing", fill: "missing" }, { value: "A required field with no value supplied." }],
    [],
    [{ value: "Every exception code", fill: "header", bold: true }, blank()],
    [{ value: "Code", bold: true }, { value: "Meaning and action", bold: true }],
    ...CODE_SPECS.map((spec): StyledCell[] => [
      { value: spec.code, text: true },
      { value: `${spec.title}. ${spec.guidance}` },
    ]),
    [],
    [{ value: "Template", fill: "header", bold: true }, blank()],
    [{ value: `${profile.label} (${profile.id} v${profile.version})` }, blank()],
    [{ value: profile.provenance }, blank()],
  ];

  if (options.institutionName) {
    rows.push([], [{ value: `Prepared for ${options.institutionName}.` }, blank()]);
  }

  return { name: "Legend", rows, columnWidths: [30, 110] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByField(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!finding.fieldId) continue;
    const existing = map.get(finding.fieldId);
    if (existing) existing.push(finding);
    else map.set(finding.fieldId, [finding]);
  }
  return map;
}

const DISPOSITION_RANK: Record<Disposition, number> = {
  rejected: 0, conflict: 1, needs_review: 2, auto_corrected: 3, clean: 4,
};
function rank(d: Disposition): number {
  return DISPOSITION_RANK[d];
}

function formatValue(value: unknown, kind: string): string | number {
  if (value === null || value === undefined) return "";
  if (kind === "money") return formatMoney(typeof value === "number" ? value : Number(value));
  if (typeof value === "boolean") return value ? "Y" : "N";
  if (typeof value === "number") return value;
  return String(value);
}

/** Long digit strings must not be reformatted into scientific notation. */
function isTextual(kind: string): boolean {
  return ["text", "ghana_card", "other_id", "msisdn", "name", "enum", "email", "date"].includes(kind);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function severityFill(severity: string): FillKey {
  switch (severity) {
    case "critical": return "rejected";
    case "major": return "conflict";
    case "minor": return "needsReview";
    default: return "missing";
  }
}

function prettyDisposition(d: Disposition): string {
  return {
    clean: "Clean",
    auto_corrected: "Auto-corrected",
    needs_review: "Needs review",
    conflict: "Conflict",
    rejected: "Rejected",
  }[d];
}

function prettyCategory(category: string): string {
  return {
    identity: "Identity",
    name: "Name",
    dob: "Date of birth",
    contact: "Contact",
    account: "Account",
    structural: "Structural",
    cross_record: "Cross-record",
  }[category] ?? category;
}

function blank(): StyledCell {
  return { value: "" };
}

function pairs(entries: Array<[string, string]>): StyledCell[][] {
  return entries.map(([label, value]) => [
    { value: label, bold: true },
    { value, text: true },
    blank(),
  ]);
}

function dispositionRow(
  label: string,
  count: number,
  total: number,
  fill: FillKey,
): StyledCell[] {
  const share = total === 0 ? 0 : count / total;
  return [
    { value: label, fill },
    { value: count },
    { value: `${(share * 100).toFixed(1)}%` },
  ];
}

export { FILL_COLOURS };
export type { RecordAudit };
