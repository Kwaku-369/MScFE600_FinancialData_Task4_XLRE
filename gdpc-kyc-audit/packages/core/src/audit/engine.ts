/**
 * The audit engine: build the batch indexes, run every rule over every record,
 * and summarise the result.
 */

import type {
  AuditSummary,
  BatchAudit,
  BatchIndexes,
  Disposition,
  EngineConfig,
  Finding,
  FindingCategory,
  NormalizedRecord,
  PhoneIntelligence,
  RecordAudit,
  Rule,
  Severity,
  TableSpec,
  TemplateProfile,
  VerificationOutcome,
} from "../types.js";
import { ALL_RULES } from "./rules.js";
import { SEVERITY_ORDER, worstDisposition } from "./codes.js";

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  nameMismatchThreshold: 0.62,
  nameAutoAcceptThreshold: 0.95,
  sharedPhoneThreshold: 3,
  minBirthYear: 1900,
  minAccountHolderAge: 0, // minors hold passbook accounts; age 0 disables the floor
  placeholderDates: ["1900-01-01", "1901-01-01", "1970-01-01", "2000-01-01"],
  today: new Date().toISOString().slice(0, 10),
};

export interface RunAuditInput {
  profile: TemplateProfile;
  table: TableSpec;
  records: NormalizedRecord[];
  /** Verification results keyed by record key. */
  verifications?: Map<string, VerificationOutcome>;
  /** Phone intelligence keyed by E.164 number. */
  phoneIntel?: Map<string, PhoneIntelligence>;
  config?: Partial<EngineConfig>;
  rules?: Rule[];
}

export function buildIndexes(records: NormalizedRecord[]): BatchIndexes {
  const byGhanaCard = new Map<string, NormalizedRecord[]>();
  const byMsisdn = new Map<string, NormalizedRecord[]>();
  const byAccountNumber = new Map<string, NormalizedRecord[]>();
  const byNameDob = new Map<string, NormalizedRecord[]>();

  const push = (map: Map<string, NormalizedRecord[]>, key: string, record: NormalizedRecord) => {
    const existing = map.get(key);
    if (existing) existing.push(record);
    else map.set(key, [record]);
  };

  for (const record of records) {
    const pin = record.fields["depositor.ghana_card_pin"]?.value;
    if (typeof pin === "string" && pin.length > 0) push(byGhanaCard, pin, record);

    const phone = record.fields["depositor.mobile_number"]?.value;
    if (typeof phone === "string" && phone.length > 0) push(byMsisdn, phone, record);

    const account = record.fields["account.account_number"]?.value;
    if (typeof account === "string" && account.length > 0) push(byAccountNumber, account, record);

    const surname = record.fields["depositor.surname"]?.value;
    const first = record.fields["depositor.first_name"]?.value;
    const dob = record.fields["depositor.date_of_birth"]?.value;
    if (surname && first && dob) {
      push(byNameDob, `${String(surname)}|${String(first)}|${String(dob)}`, record);
    }
  }

  return { byGhanaCard, byMsisdn, byAccountNumber, byNameDob };
}

export function runAudit(input: RunAuditInput): BatchAudit {
  const config: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, ...input.config };
  const rules = input.rules ?? ALL_RULES;
  const indexes = buildIndexes(input.records);

  const recordAudits: RecordAudit[] = input.records.map((record) => {
    const verification = input.verifications?.get(record.recordKey) ?? null;

    const msisdn = record.fields["depositor.mobile_number"]?.value;
    const phone =
      typeof msisdn === "string" ? (input.phoneIntel?.get(msisdn) ?? null) : null;

    const ctx = {
      profile: input.profile,
      table: input.table,
      record,
      verification,
      phone,
      batch: input.records,
      indexes,
      config,
    };

    const findings: Finding[] = [];
    for (const rule of rules) {
      try {
        findings.push(...rule.evaluate(ctx));
      } catch (error) {
        // A rule that throws must not abort the whole batch — record it and move on.
        findings.push({
          code: "REQUIRED_FIELD_EMPTY",
          category: "structural",
          severity: "minor",
          disposition: "needs_review",
          rowNumber: record.rowNumber,
          recordKey: record.recordKey,
          fieldId: null,
          message: `Rule '${rule.code}' failed to evaluate: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    findings.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.code.localeCompare(b.code),
    );

    return {
      record,
      verification,
      findings,
      rowDisposition: worstDisposition(findings.map((f) => f.disposition)),
    };
  });

  const allFindings = recordAudits.flatMap((r) => r.findings);

  return {
    profileId: input.profile.id,
    tableId: input.table.id,
    records: recordAudits,
    findings: allFindings,
    summary: summarise(recordAudits, allFindings),
  };
}

function summarise(records: RecordAudit[], findings: Finding[]): AuditSummary {
  const bySeverity: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  const byCategory: Record<FindingCategory, number> = {
    identity: 0, name: 0, dob: 0, contact: 0, account: 0, structural: 0, cross_record: 0,
  };
  const byCode: Record<string, number> = {};

  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byCategory[finding.category] += 1;
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
  }

  const counts: Record<Disposition, number> = {
    clean: 0, auto_corrected: 0, needs_review: 0, rejected: 0, conflict: 0,
  };
  for (const record of records) counts[record.rowDisposition] += 1;

  const total = records.length;
  // A record is submission-ready when nothing blocks it: clean, or only changes
  // the engine already applied deterministically.
  const ready = counts.clean + counts.auto_corrected;

  return {
    totalRecords: total,
    cleanRecords: counts.clean,
    autoCorrectedRecords: counts.auto_corrected,
    needsReviewRecords: counts.needs_review,
    rejectedRecords: counts.rejected,
    conflictRecords: counts.conflict,
    bySeverity,
    byCategory,
    byCode,
    submissionReadiness: total === 0 ? 0 : Math.round((ready / total) * 1000) / 1000,
  };
}

/**
 * Apply every finding that carries a deterministic, high-confidence correction.
 * Returns a new record set; the originals are never mutated, so the audit report
 * can always show both sides.
 */
export function applyAutoCorrections(
  audit: BatchAudit,
  minConfidence = 0.95,
): { records: NormalizedRecord[]; applied: Finding[] } {
  const applied: Finding[] = [];

  const records = audit.records.map((recordAudit) => {
    const fields = { ...recordAudit.record.fields };
    let touched = false;

    for (const finding of recordAudit.findings) {
      if (finding.disposition !== "auto_corrected") continue;
      if (finding.proposedValue === undefined || finding.proposedValue === null) continue;
      if ((finding.confidence ?? 0) < minConfidence) continue;
      if (!finding.fieldId) continue;

      // A proposed value may be an object covering several name fields.
      if (typeof finding.proposedValue === "object") {
        for (const [suffix, value] of Object.entries(finding.proposedValue as Record<string, unknown>)) {
          const targetId = `${finding.fieldId.split(".")[0]}.${suffix}`;
          const cell = fields[targetId];
          if (!cell || value == null) continue;
          fields[targetId] = {
            ...cell,
            value: String(value).toUpperCase(),
            changed: true,
            notes: [...cell.notes, `Corrected by rule ${finding.code}.`],
          };
          touched = true;
        }
      } else {
        const cell = fields[finding.fieldId];
        if (!cell) continue;
        fields[finding.fieldId] = {
          ...cell,
          value: finding.proposedValue,
          changed: true,
          notes: [...cell.notes, `Corrected by rule ${finding.code}.`],
        };
        touched = true;
      }

      applied.push(finding);
    }

    return touched ? { ...recordAudit.record, fields } : recordAudit.record;
  });

  return { records, applied };
}
