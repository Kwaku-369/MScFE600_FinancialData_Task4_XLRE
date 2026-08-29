/**
 * The submission pipeline.
 *
 *   receive -> map -> normalise -> verify (async) -> audit -> publish
 *
 * Verification is the only step that leaves the Worker and waits, so the
 * pipeline is split around it: `prepareBatch` runs everything up to dispatching
 * the NIA lookups, and `finaliseBatch` runs once the callbacks have landed.
 * A batch whose lookups never complete still finalises — on a timer or on
 * demand — with those records marked unverified rather than silently dropped.
 */

import {
  applyAutoCorrections,
  autoMap,
  buildAlignedWorkbook,
  buildAuditReport,
  getProfile,
  getTable,
  normalizeRows,
  readCsv,
  readXlsx,
  runAudit,
  type AutoMapResult,
  type BatchAudit,
  type Disposition,
  type NormalizedRecord,
  type RawSheet,
  type VerificationOutcome,
} from "@gdpc/core";

import type { Env, VerifyJobMessage } from "../env.js";
import { credentialsFrom, startGhanaCardVerification } from "./metamap.js";
import {
  completeVerificationJob,
  createVerificationJob,
  getCachedVerifications,
  getInstitution,
  insertFindings,
  insertRecords,
  newId,
  updateBatch,
  writeAuditLog,
  type BatchRow,
  type VerificationRow,
} from "../db/repo.js";

export const DEFAULT_PROFILE_ID = "gdpc-scv";

/** Read an uploaded file into a sheet, choosing the reader by extension. */
export function readUpload(
  filename: string,
  bytes: Uint8Array,
  options: { sheetName?: string; headerRow?: number } = {},
): RawSheet {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv")) {
    return readCsv(new TextDecoder().decode(bytes), {
      sheetName: filename,
      ...(options.headerRow !== undefined ? { headerRow: options.headerRow } : {}),
    });
  }

  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
    return readXlsx(bytes, options);
  }

  // .xls is the old binary format, which is not a zip and cannot be read here.
  if (lower.endsWith(".xls")) {
    throw new Error(
      "The legacy .xls format is not supported. Re-save the file as .xlsx or .csv and upload it again.",
    );
  }

  throw new Error(`Unsupported file type '${filename}'. Upload a .xlsx or .csv file.`);
}

export interface PrepareResult {
  batchId: string;
  sheet: RawSheet;
  plan: AutoMapResult;
  records: NormalizedRecord[];
  recordIds: Map<string, string>;
  /** Verifications already known from cache, keyed by record key. */
  cached: Map<string, VerificationOutcome>;
  /** Ghana Card numbers that must be looked up. */
  toVerify: Array<{ recordId: string; personalNumber: string }>;
}

/**
 * Map, normalise and persist a batch, then work out which Ghana Card numbers
 * still need an NIA lookup.
 */
export async function prepareBatch(
  env: Env,
  batch: BatchRow,
  bytes: Uint8Array,
  options: { sheetName?: string; headerRow?: number; mappingOverride?: AutoMapResult } = {},
): Promise<PrepareResult> {
  const profile = getProfile(batch.profile_id, batch.profile_version);
  const sheet = readUpload(batch.source_filename ?? "upload.xlsx", bytes, options);

  const plan =
    options.mappingOverride ?? autoMap(sheet.headers, profile, batch.table_id);

  const table = getTable(profile, plan.tableId);

  const records = normalizeRows(sheet.rows, table, plan, {
    dateOptions: { today: today() },
    keyPrefix: batch.id,
  });

  // Persist before verifying, so a failure mid-verification still leaves a
  // batch an operator can inspect and re-run.
  const recordIds = new Map<string, string>();
  const rows = records.map((record) => {
    const id = newId("rec");
    recordIds.set(record.recordKey, id);
    return {
      id,
      record,
      source: sheet.rows.find((r) => r.rowNumber === record.rowNumber)?.cells ?? {},
      disposition: "clean" as Disposition,
    };
  });

  await insertRecords(env, batch.institution_id, batch.id, rows);
  await updateBatch(env, batch.id, {
    status: "mapped",
    row_count: records.length,
    mapping_json: JSON.stringify(plan),
    table_id: plan.tableId,
  });

  // Resolve what is already known, and queue only the rest.
  const pins = [
    ...new Set(
      records
        .map((r) => r.fields["depositor.ghana_card_pin"]?.value)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];

  const cachedRows = await getCachedVerifications(env, pins);
  const cached = new Map<string, VerificationOutcome>();
  const toVerify: Array<{ recordId: string; personalNumber: string }> = [];
  const queued = new Set<string>();

  for (const record of records) {
    const pin = record.fields["depositor.ghana_card_pin"]?.value;
    const recordId = recordIds.get(record.recordKey);
    if (typeof pin !== "string" || pin.length === 0 || !recordId) continue;

    const hit = cachedRows.get(pin);
    if (hit) {
      cached.set(record.recordKey, toOutcome(hit));
      continue;
    }

    // One lookup per distinct card, however many records carry it.
    if (!queued.has(pin)) {
      queued.add(pin);
      toVerify.push({ recordId, personalNumber: pin });
    }
  }

  return { batchId: batch.id, sheet, plan, records, recordIds, cached, toVerify };
}

/** Dispatch the outstanding NIA lookups onto the queue. */
export async function dispatchVerifications(
  env: Env,
  batch: BatchRow,
  toVerify: Array<{ recordId: string; personalNumber: string }>,
): Promise<number> {
  if (toVerify.length === 0) return 0;

  const messages: Array<{ body: VerifyJobMessage }> = [];

  for (const item of toVerify) {
    const correlationId = newId("cor");
    await createVerificationJob(env, {
      batchId: batch.id,
      recordId: item.recordId,
      personalNumber: item.personalNumber,
      correlationId,
    });
    messages.push({
      body: {
        batchId: batch.id,
        recordId: item.recordId,
        institutionId: batch.institution_id,
        personalNumber: item.personalNumber,
        correlationId,
      },
    });
  }

  if (env.VERIFY_QUEUE) {
    // Queues cap a send batch at 100 messages.
    for (let i = 0; i < messages.length; i += 100) {
      await env.VERIFY_QUEUE.sendBatch(messages.slice(i, i + 100));
    }
  } else {
    // No queue binding (the free plan has none): start the lookups inline.
    await dispatchInline(env, messages.map((m) => m.body));
  }

  await updateBatch(env, batch.id, { status: "verifying" });
  return messages.length;
}

/**
 * Start the NIA lookups without a queue.
 *
 * Each lookup is one POST that returns 202 — the NIA record arrives later on
 * the callback endpoint — so the work here is IO-bound and short. Requests go
 * out in small concurrent waves rather than all at once, to stay inside the
 * Worker's subrequest limit and to avoid hammering the provider.
 *
 * What is genuinely lost without the queue is durability and retry: if the
 * Worker is evicted mid-wave, the outstanding jobs stay `pending` rather than
 * being redelivered. They are not silently dropped — the batch can still be
 * finalised, and those records are reported as unverified. Enable the queue for
 * large submissions.
 */
const INLINE_CONCURRENCY = 6;

async function dispatchInline(env: Env, jobs: VerifyJobMessage[]): Promise<void> {
  const credentials = credentialsFrom(env);
  const callbackUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/metamap/ghana-card`;

  for (let i = 0; i < jobs.length; i += INLINE_CONCURRENCY) {
    const wave = jobs.slice(i, i + INLINE_CONCURRENCY);

    await Promise.all(
      wave.map(async (job) => {
        try {
          await startGhanaCardVerification(credentials, {
            personalNumber: job.personalNumber,
            callbackUrl,
            correlationId: job.correlationId,
          });
        } catch (error) {
          // One card failing must not abandon the rest of the batch. Record it
          // against the job so finalisation reports the record as unverified
          // rather than waiting on a callback that will never arrive.
          const message = error instanceof Error ? error.message : String(error);
          console.error("Inline verification dispatch failed", {
            correlationId: job.correlationId,
            error: message,
          });
          await completeVerificationJob(env, job.correlationId, "failed", message).catch(
            () => undefined,
          );
        }
      }),
    );
  }
}

export interface FinaliseResult {
  audit: BatchAudit;
  alignedKey: string;
  reportKey: string;
  published: number;
  quarantined: number;
}

/**
 * Run the audit, write both workbooks to R2, and — in direct mode — publish the
 * records that are safe to publish.
 */
export async function finaliseBatch(
  env: Env,
  batch: BatchRow,
  records: NormalizedRecord[],
  verifications: Map<string, VerificationOutcome>,
): Promise<FinaliseResult> {
  const profile = getProfile(batch.profile_id, batch.profile_version);
  const table = getTable(profile, batch.table_id);

  const audit = runAudit({
    profile,
    table,
    records,
    verifications,
    config: { today: today() },
  });

  // Apply only the deterministic corrections, then re-audit so the exported
  // file and the findings describe the same data.
  const { records: corrected } = applyAutoCorrections(audit);
  const finalAudit = runAudit({
    profile,
    table,
    records: corrected,
    verifications,
    config: { today: today() },
  });

  const institution = await getInstitution(env, batch.institution_id);

  const workbookOptions = {
    institutionName: institution?.name ?? batch.institution_id,
    batchReference: batch.reference,
    reportingDate: batch.reporting_date ?? undefined,
    generatedAt: new Date().toISOString(),
  };

  const aligned = buildAlignedWorkbook(profile, table, finalAudit, workbookOptions);
  const report = buildAuditReport(profile, table, finalAudit, workbookOptions);

  const alignedKey = `${batch.institution_id}/${batch.id}/aligned.xlsx`;
  const reportKey = `${batch.institution_id}/${batch.id}/audit-report.xlsx`;

  await env.FILES.put(alignedKey, aligned, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
  await env.FILES.put(reportKey, report, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });

  // Persist findings against their records.
  const recordIdByKey = await loadRecordIds(env, batch.id);
  await insertFindings(
    env,
    batch.institution_id,
    batch.id,
    finalAudit.findings.map((f) => ({
      ...f,
      recordId: recordIdByKey.get(f.recordKey) ?? null,
    })),
  );

  // Update each record's disposition.
  await updateRecordDispositions(env, batch.id, finalAudit);

  const { published, quarantined } = await applyPublishPolicy(env, batch, finalAudit);

  await updateBatch(env, batch.id, {
    status: "audited",
    summary_json: JSON.stringify(finalAudit.summary),
    aligned_key: alignedKey,
    report_key: reportKey,
    completed_at: new Date().toISOString(),
  });

  await writeAuditLog(env, {
    institutionId: batch.institution_id,
    actorId: null,
    actorType: "system",
    action: "batch.audited",
    entityType: "batch",
    entityId: batch.id,
    detail: { summary: finalAudit.summary, published, quarantined },
  });

  return { audit: finalAudit, alignedKey, reportKey, published, quarantined };
}

/**
 * The direct-mode safety gate.
 *
 * In direct mode a bank pushes straight through with no operator in the loop.
 * That is only safe if the gate is closed by default: a record publishes only
 * when its disposition is at or below the configured ceiling — clean, or
 * changed in a way the engine could make deterministically. Everything else
 * quarantines and waits for a human, whatever raised it.
 *
 * The important property is that the gate keys on the *disposition*, not on a
 * list of known codes. A rule added later, or a finding nobody anticipated,
 * quarantines its record automatically instead of slipping through because it
 * was not on a list.
 */
async function applyPublishPolicy(
  env: Env,
  batch: BatchRow,
  audit: BatchAudit,
): Promise<{ published: number; quarantined: number }> {
  if (batch.submission_mode !== "direct") {
    return { published: 0, quarantined: audit.records.length };
  }

  const ceiling = env.DIRECT_PUBLISH_MAX_DISPOSITION ?? "auto_corrected";
  const allowed = publishableFor(ceiling);

  const publishable = audit.records.filter((r) => allowed.has(r.rowDisposition));

  for (let i = 0; i < publishable.length; i += 40) {
    const chunk = publishable.slice(i, i + 40);
    await env.DB.batch(
      chunk.map((r) =>
        env.DB.prepare(
          `UPDATE records SET published_at = datetime('now')
            WHERE batch_id = ? AND record_key = ?`,
        ).bind(batch.id, r.record.recordKey),
      ),
    );
  }

  return {
    published: publishable.length,
    quarantined: audit.records.length - publishable.length,
  };
}

/**
 * Which dispositions may publish at a given ceiling.
 *
 * An unrecognised ceiling falls back to the *stricter* setting, never a looser
 * one: a typo in configuration must not widen what reaches the live view.
 */
function publishableFor(ceiling: string): Set<Disposition> {
  switch (ceiling) {
    case "needs_review":
      return new Set<Disposition>(["clean", "auto_corrected", "needs_review"]);
    case "auto_corrected":
      return new Set<Disposition>(["clean", "auto_corrected"]);
    default:
      return new Set<Disposition>(["clean"]);
  }
}

async function updateRecordDispositions(
  env: Env,
  batchId: string,
  audit: BatchAudit,
): Promise<void> {
  const changed = audit.records.filter((r) => r.rowDisposition !== "clean");

  for (let i = 0; i < changed.length; i += 40) {
    const chunk = changed.slice(i, i + 40);
    await env.DB.batch(
      chunk.map((r) =>
        env.DB.prepare(
          `UPDATE records SET disposition = ? WHERE batch_id = ? AND record_key = ?`,
        ).bind(r.rowDisposition, batchId, r.record.recordKey),
      ),
    );
  }
}

async function loadRecordIds(env: Env, batchId: string): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT id, record_key FROM records WHERE batch_id = ?`,
  )
    .bind(batchId)
    .all<{ id: string; record_key: string }>();

  return new Map((results ?? []).map((r) => [r.record_key, r.id]));
}

/** Rebuild the normalised records for a stored batch, for re-audit or finalise. */
export async function loadRecords(
  env: Env,
  batchId: string,
): Promise<{ records: NormalizedRecord[]; idByKey: Map<string, string> }> {
  const { results } = await env.DB.prepare(
    `SELECT id, row_number, record_key, aligned_json FROM records
      WHERE batch_id = ? ORDER BY row_number`,
  )
    .bind(batchId)
    .all<{ id: string; row_number: number; record_key: string; aligned_json: string }>();

  const idByKey = new Map<string, string>();
  const records: NormalizedRecord[] = [];

  for (const row of results ?? []) {
    idByKey.set(row.record_key, row.id);
    const fields = JSON.parse(row.aligned_json) as NormalizedRecord["fields"];
    records.push({
      rowNumber: row.row_number,
      recordKey: row.record_key,
      tableId: "",
      fields,
    });
  }

  return { records, idByKey };
}

export function toOutcome(row: VerificationRow): VerificationOutcome {
  switch (row.status) {
    case "verified":
      return {
        status: "verified",
        identity: {
          source: "nia",
          personalNumber: row.personal_number,
          firstName: row.first_name,
          middleName: row.middle_name,
          lastName: row.last_name,
          gender: row.gender,
          dateOfBirth: row.date_of_birth,
          placeOfBirth: row.place_of_birth,
          nationality: row.nationality,
          regDate: row.reg_date,
          expiryDate: row.expiry_date,
          retrievedAt: row.retrieved_at,
        },
      };
    case "not_found":
      return { status: "not_found", reason: row.error_message ?? "No NIA record for this PIN." };
    case "invalid_input":
      return { status: "invalid_input", reason: row.error_message ?? "The NIA rejected the PIN." };
    default:
      return {
        status: "unavailable",
        reason: row.error_message ?? "The verification service did not return a result.",
      };
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
