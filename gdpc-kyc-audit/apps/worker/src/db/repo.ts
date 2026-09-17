/**
 * Data access.
 *
 * Every function that reads customer data takes an `institutionId` as its first
 * argument and puts it in the WHERE clause. That is not decoration: it is the
 * second half of the tenant isolation enforced in `middleware/auth.ts`, and it
 * means a handler cannot accidentally widen a query by forgetting a filter.
 */

import type { Disposition, Finding, NormalizedRecord } from "@gdpc/core";
import type { Env } from "../env.js";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Institutions
// ---------------------------------------------------------------------------

export interface InstitutionRow {
  id: string;
  name: string;
  member_code: string | null;
  category: string;
  submission_mode: "review" | "direct";
  status: string;
  created_at: string;
}

export async function getInstitution(env: Env, id: string): Promise<InstitutionRow | null> {
  return env.DB.prepare(`SELECT * FROM institutions WHERE id = ?`)
    .bind(id)
    .first<InstitutionRow>();
}

export async function listInstitutions(env: Env): Promise<InstitutionRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM institutions ORDER BY name`,
  ).all<InstitutionRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export interface BatchRow {
  id: string;
  institution_id: string;
  reference: string;
  reporting_date: string | null;
  profile_id: string;
  profile_version: string;
  table_id: string;
  submission_mode: string;
  status: string;
  source_filename: string | null;
  source_key: string | null;
  source_bytes: number | null;
  source_sha256: string | null;
  row_count: number;
  mapping_json: string | null;
  summary_json: string | null;
  aligned_key: string | null;
  report_key: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function createBatch(
  env: Env,
  batch: Omit<BatchRow, "created_at" | "updated_at" | "completed_at">,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO batches (
       id, institution_id, reference, reporting_date, profile_id, profile_version,
       table_id, submission_mode, status, source_filename, source_key, source_bytes,
       source_sha256, row_count, mapping_json, summary_json, aligned_key, report_key,
       error, created_by
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      batch.id, batch.institution_id, batch.reference, batch.reporting_date,
      batch.profile_id, batch.profile_version, batch.table_id, batch.submission_mode,
      batch.status, batch.source_filename, batch.source_key, batch.source_bytes,
      batch.source_sha256, batch.row_count, batch.mapping_json, batch.summary_json,
      batch.aligned_key, batch.report_key, batch.error, batch.created_by,
    )
    .run();
}

export async function getBatch(
  env: Env,
  institutionId: string,
  batchId: string,
): Promise<BatchRow | null> {
  return env.DB.prepare(`SELECT * FROM batches WHERE id = ? AND institution_id = ?`)
    .bind(batchId, institutionId)
    .first<BatchRow>();
}

export async function listBatches(
  env: Env,
  institutionId: string,
  limit = 50,
  offset = 0,
): Promise<BatchRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM batches WHERE institution_id = ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(institutionId, limit, offset)
    .all<BatchRow>();
  return results ?? [];
}

export async function updateBatch(
  env: Env,
  batchId: string,
  patch: Partial<Pick<
    BatchRow,
    "status" | "row_count" | "mapping_json" | "summary_json" | "aligned_key"
    | "report_key" | "error" | "completed_at" | "table_id"
  >>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  const assignments = entries.map(([k]) => `${k} = ?`).join(", ");
  await env.DB.prepare(
    `UPDATE batches SET ${assignments}, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(...entries.map(([, v]) => v as string | number | null), batchId)
    .run();
}

// ---------------------------------------------------------------------------
// Records and findings
// ---------------------------------------------------------------------------

export interface RecordRow {
  id: string;
  batch_id: string;
  institution_id: string;
  row_number: number;
  record_key: string;
  customer_id: string | null;
  ghana_card_pin: string | null;
  msisdn: string | null;
  source_json: string;
  aligned_json: string;
  disposition: Disposition;
  published_at: string | null;
}

/** D1 caps how many statements a batch may carry, so writes are chunked. */
const WRITE_CHUNK = 40;

export async function insertRecords(
  env: Env,
  institutionId: string,
  batchId: string,
  records: Array<{
    id: string;
    record: NormalizedRecord;
    source: Record<string, unknown>;
    disposition: Disposition;
  }>,
): Promise<void> {
  const statement = env.DB.prepare(
    `INSERT INTO records (
       id, batch_id, institution_id, row_number, record_key, customer_id,
       ghana_card_pin, msisdn, source_json, aligned_json, disposition
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );

  for (let i = 0; i < records.length; i += WRITE_CHUNK) {
    const chunk = records.slice(i, i + WRITE_CHUNK);
    await env.DB.batch(
      chunk.map((entry) =>
        statement.bind(
          entry.id,
          batchId,
          institutionId,
          entry.record.rowNumber,
          entry.record.recordKey,
          asText(entry.record.fields["depositor.customer_id"]?.value),
          asText(entry.record.fields["depositor.ghana_card_pin"]?.value),
          asText(entry.record.fields["depositor.mobile_number"]?.value),
          JSON.stringify(entry.source),
          JSON.stringify(serialiseFields(entry.record)),
          entry.disposition,
        ),
      ),
    );
  }
}

export async function insertFindings(
  env: Env,
  institutionId: string,
  batchId: string,
  findings: Array<Finding & { recordId: string | null }>,
): Promise<void> {
  if (findings.length === 0) return;

  const statement = env.DB.prepare(
    `INSERT INTO findings (
       id, batch_id, record_id, institution_id, row_number, code, category,
       severity, disposition, field_id, message, observed, expected,
       proposed_value, confidence, evidence_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  for (let i = 0; i < findings.length; i += WRITE_CHUNK) {
    const chunk = findings.slice(i, i + WRITE_CHUNK);
    await env.DB.batch(
      chunk.map((finding) =>
        statement.bind(
          newId("fnd"),
          batchId,
          finding.recordId,
          institutionId,
          finding.rowNumber,
          finding.code,
          finding.category,
          finding.severity,
          finding.disposition,
          finding.fieldId,
          finding.message,
          asText(finding.observed),
          asText(finding.expected),
          asText(finding.proposedValue),
          finding.confidence ?? null,
          finding.evidence ? JSON.stringify(finding.evidence) : null,
        ),
      ),
    );
  }
}

export interface FindingRow {
  id: string;
  batch_id: string;
  record_id: string | null;
  row_number: number;
  code: string;
  category: string;
  severity: string;
  disposition: string;
  field_id: string | null;
  message: string;
  observed: string | null;
  expected: string | null;
  proposed_value: string | null;
  confidence: number | null;
  evidence_json: string | null;
  resolution: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface FindingFilter {
  batchId?: string;
  severity?: string;
  category?: string;
  code?: string;
  resolution?: string;
  limit?: number;
  offset?: number;
}

export async function listFindings(
  env: Env,
  institutionId: string,
  filter: FindingFilter = {},
): Promise<FindingRow[]> {
  const clauses = ["institution_id = ?"];
  const bindings: Array<string | number> = [institutionId];

  if (filter.batchId) { clauses.push("batch_id = ?"); bindings.push(filter.batchId); }
  if (filter.severity) { clauses.push("severity = ?"); bindings.push(filter.severity); }
  if (filter.category) { clauses.push("category = ?"); bindings.push(filter.category); }
  if (filter.code) { clauses.push("code = ?"); bindings.push(filter.code); }
  if (filter.resolution) { clauses.push("resolution = ?"); bindings.push(filter.resolution); }

  bindings.push(filter.limit ?? 200, filter.offset ?? 0);

  const { results } = await env.DB.prepare(
    `SELECT * FROM findings WHERE ${clauses.join(" AND ")}
      ORDER BY CASE severity
                 WHEN 'critical' THEN 0 WHEN 'major' THEN 1
                 WHEN 'minor' THEN 2 ELSE 3 END,
               row_number
      LIMIT ? OFFSET ?`,
  )
    .bind(...bindings)
    .all<FindingRow>();

  return results ?? [];
}

export async function resolveFinding(
  env: Env,
  institutionId: string,
  findingId: string,
  resolution: "accepted" | "rejected" | "corrected" | "escalated",
  userId: string,
  note?: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE findings
        SET resolution = ?, resolved_by = ?, resolved_at = datetime('now'), resolution_note = ?
      WHERE id = ? AND institution_id = ?`,
  )
    .bind(resolution, userId, note ?? null, findingId, institutionId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function countFindingsByDisposition(
  env: Env,
  batchId: string,
): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT disposition, COUNT(*) AS count FROM findings WHERE batch_id = ? GROUP BY disposition`,
  )
    .bind(batchId)
    .all<{ disposition: string; count: number }>();

  const counts: Record<string, number> = {};
  for (const row of results ?? []) counts[row.disposition] = row.count;
  return counts;
}

// ---------------------------------------------------------------------------
// Verification cache
// ---------------------------------------------------------------------------

export interface VerificationRow {
  id: string;
  personal_number: string;
  status: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  gender: string | null;
  date_of_birth: string | null;
  place_of_birth: string | null;
  nationality: string | null;
  reg_date: string | null;
  expiry_date: string | null;
  error_code: string | null;
  error_message: string | null;
  retrieved_at: string;
  expires_at: string | null;
}

export async function getCachedVerification(
  env: Env,
  personalNumber: string,
): Promise<VerificationRow | null> {
  return env.DB.prepare(
    `SELECT * FROM verifications
      WHERE personal_number = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))`,
  )
    .bind(personalNumber)
    .first<VerificationRow>();
}

export async function getCachedVerifications(
  env: Env,
  personalNumbers: string[],
): Promise<Map<string, VerificationRow>> {
  const found = new Map<string, VerificationRow>();
  if (personalNumbers.length === 0) return found;

  // SQLite has a bound-parameter limit, so query in pages.
  const PAGE = 80;
  for (let i = 0; i < personalNumbers.length; i += PAGE) {
    const page = personalNumbers.slice(i, i + PAGE);
    const placeholders = page.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT * FROM verifications
        WHERE personal_number IN (${placeholders})
          AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
      .bind(...page)
      .all<VerificationRow>();

    for (const row of results ?? []) found.set(row.personal_number, row);
  }

  return found;
}

export async function upsertVerification(
  env: Env,
  row: {
    personalNumber: string;
    institutionId: string | null;
    status: string;
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    placeOfBirth?: string | null;
    nationality?: string | null;
    regDate?: string | null;
    expiryDate?: string | null;
    raw?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    /** Cache lifetime in days; NIA records are stable so this can be long. */
    ttlDays?: number;
  },
): Promise<void> {
  const ttl = row.ttlDays ?? 180;

  await env.DB.prepare(
    `INSERT INTO verifications (
       id, institution_id, personal_number, status, provider, first_name, middle_name,
       last_name, gender, date_of_birth, place_of_birth, nationality, reg_date,
       expiry_date, raw_json, error_code, error_message, retrieved_at, expires_at
     ) VALUES (?,?,?,?,'metamap',?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'), datetime('now', ?))
     ON CONFLICT(personal_number) DO UPDATE SET
       status = excluded.status,
       first_name = excluded.first_name,
       middle_name = excluded.middle_name,
       last_name = excluded.last_name,
       gender = excluded.gender,
       date_of_birth = excluded.date_of_birth,
       place_of_birth = excluded.place_of_birth,
       nationality = excluded.nationality,
       reg_date = excluded.reg_date,
       expiry_date = excluded.expiry_date,
       raw_json = excluded.raw_json,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       retrieved_at = excluded.retrieved_at,
       expires_at = excluded.expires_at`,
  )
    .bind(
      newId("ver"), row.institutionId, row.personalNumber, row.status,
      row.firstName ?? null, row.middleName ?? null, row.lastName ?? null,
      row.gender ?? null, row.dateOfBirth ?? null, row.placeOfBirth ?? null,
      row.nationality ?? null, row.regDate ?? null, row.expiryDate ?? null,
      row.raw ? JSON.stringify(row.raw) : null,
      row.errorCode ?? null, row.errorMessage ?? null,
      `+${ttl} days`,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Verification jobs
// ---------------------------------------------------------------------------

export async function createVerificationJob(
  env: Env,
  job: { batchId: string; recordId: string; personalNumber: string; correlationId: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO verification_jobs (id, batch_id, record_id, personal_number, correlation_id)
     VALUES (?,?,?,?,?)`,
  )
    .bind(newId("vjb"), job.batchId, job.recordId, job.personalNumber, job.correlationId)
    .run();
}

export async function completeVerificationJob(
  env: Env,
  correlationId: string,
  status: "completed" | "failed",
  error?: string,
): Promise<{ batch_id: string; record_id: string; personal_number: string } | null> {
  const job = await env.DB.prepare(
    `SELECT batch_id, record_id, personal_number FROM verification_jobs WHERE correlation_id = ?`,
  )
    .bind(correlationId)
    .first<{ batch_id: string; record_id: string; personal_number: string }>();

  if (!job) return null;

  await env.DB.prepare(
    `UPDATE verification_jobs
        SET status = ?, completed_at = datetime('now'), error = ?
      WHERE correlation_id = ?`,
  )
    .bind(status, error ?? null, correlationId)
    .run();

  return job;
}

export async function countPendingVerifications(env: Env, batchId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM verification_jobs WHERE batch_id = ? AND status = 'pending'`,
  )
    .bind(batchId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function writeAuditLog(
  env: Env,
  entry: {
    institutionId: string | null;
    actorId: string | null;
    actorType?: string;
    action: string;
    entityType?: string;
    entityId?: string;
    detail?: unknown;
    ip?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (
       id, institution_id, actor_id, actor_type, action, entity_type, entity_id, detail_json, ip
     ) VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      newId("log"),
      entry.institutionId,
      entry.actorId,
      entry.actorType ?? "user",
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.ip ?? null,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Store the normalised value and the raw source value for every field. */
function serialiseFields(record: NormalizedRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [fieldId, cell] of Object.entries(record.fields)) {
    out[fieldId] = {
      value: cell.value,
      raw: cell.raw,
      changed: cell.changed,
      notes: cell.notes,
    };
  }
  return out;
}
