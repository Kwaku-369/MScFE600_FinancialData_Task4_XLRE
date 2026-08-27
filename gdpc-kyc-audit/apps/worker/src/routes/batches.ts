import { Hono } from "hono";
import {
  autoMap,
  getProfile,
  getTable,
  type AutoMapResult,
  type VerificationOutcome,
} from "@gdpc/core";

import type { AppContext } from "../env.js";
import { HttpError, authenticate, requireAtLeast, scopedInstitution } from "../middleware/auth.js";
import {
  createBatch,
  getBatch,
  getCachedVerifications,
  getInstitution,
  listBatches,
  newId,
  updateBatch,
  writeAuditLog,
} from "../db/repo.js";
import {
  dispatchVerifications,
  finaliseBatch,
  loadRecords,
  prepareBatch,
  readUpload,
  toOutcome,
} from "../services/pipeline.js";
import { proposeMappings } from "../agents/mapper.js";

export const batchRoutes = new Hono<AppContext>();

batchRoutes.use("*", authenticate);

/** Maximum upload accepted, guarding both memory and the request limit. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

batchRoutes.get("/", async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Number(c.req.query("offset") ?? 0);

  const batches = await listBatches(c.env, institutionId, limit, offset);
  return c.json({
    batches: batches.map((b) => ({
      ...b,
      mapping_json: undefined,
      summary: b.summary_json ? JSON.parse(b.summary_json) : null,
    })),
  });
});

/**
 * Upload a submission.
 *
 * The file is stored first and processed second, so a mapping problem never
 * costs the bank the upload — an operator can correct the mapping and re-run
 * against the stored original rather than asking for the file again.
 */
batchRoutes.post("/", requireAtLeast("bank_officer"), async (c) => {
  const principal = c.get("principal");
  const institutionId = scopedInstitution(principal, c.req.query("institutionId"));

  const institution = await getInstitution(c.env, institutionId);
  if (!institution) throw new HttpError(404, "Not found.", "not_found");

  /** The subset of `File` this handler needs. */
  interface UploadedFile {
    name?: string;
    size: number;
    type: string;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  const form = await c.req.formData();
  // The Workers `FormData` types model every entry as a string, so the upload
  // is identified by shape rather than by `instanceof File`.
  const entry = form.get("file") as unknown as UploadedFile | string | null;

  if (entry === null || typeof entry === "string" || typeof entry.arrayBuffer !== "function") {
    throw new HttpError(400, "Attach the submission as the 'file' field.", "invalid_request");
  }

  const file = entry;
  const filename = file.name ?? "upload.xlsx";
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      `The file is ${(file.size / 1e6).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1e6} MB. Split it into several submissions.`,
      "file_too_large",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const reference =
    (form.get("reference") as string | null) ?? `SUB-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const tableId = (form.get("tableId") as string | null) ?? "A";
  const reportingDate = form.get("reportingDate") as string | null;

  const profile = getProfile((form.get("profileId") as string | null) ?? "gdpc-scv");

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const batchId = newId("bat");
  const sourceKey = `${institutionId}/${batchId}/source-${filename}`;

  await c.env.FILES.put(sourceKey, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  await createBatch(c.env, {
    id: batchId,
    institution_id: institutionId,
    reference,
    reporting_date: reportingDate,
    profile_id: profile.id,
    profile_version: profile.version,
    table_id: tableId,
    submission_mode: institution.submission_mode,
    status: "received",
    source_filename: filename,
    source_key: sourceKey,
    source_bytes: bytes.byteLength,
    source_sha256: sha256,
    row_count: 0,
    mapping_json: null,
    summary_json: null,
    aligned_key: null,
    report_key: null,
    error: null,
    created_by: principal.kind === "user" ? principal.id : null,
  });

  await writeAuditLog(c.env, {
    institutionId,
    actorId: principal.id,
    actorType: principal.kind,
    action: "batch.uploaded",
    entityType: "batch",
    entityId: batchId,
    detail: { filename, bytes: bytes.byteLength, sha256, reference },
  });

  // Preview the mapping so the caller learns immediately whether the file can
  // be aligned, without committing to a run.
  let preview: AutoMapResult | null = null;
  let previewError: string | null = null;
  try {
    const sheet = readUpload(filename, bytes);
    preview = autoMap(sheet.headers, profile, tableId);
  } catch (error) {
    previewError = error instanceof Error ? error.message : String(error);
    await updateBatch(c.env, batchId, { status: "failed", error: previewError });
  }

  return c.json(
    {
      batchId,
      reference,
      status: previewError ? "failed" : "received",
      error: previewError,
      mapping: preview,
      nextStep: previewError
        ? "The file could not be read. Correct it and upload again."
        : preview && (preview.missingRequired.length > 0 || preview.needsConfirmation.length > 0)
          ? "Confirm the column mapping, then start the run."
          : "The mapping resolved cleanly. Start the run.",
    },
    201,
  );
});

batchRoutes.get("/:id", async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));
  const batch = await getBatch(c.env, institutionId, c.req.param("id"));
  if (!batch) throw new HttpError(404, "Not found.", "not_found");

  return c.json({
    batch: {
      ...batch,
      mapping: batch.mapping_json ? JSON.parse(batch.mapping_json) : null,
      summary: batch.summary_json ? JSON.parse(batch.summary_json) : null,
      mapping_json: undefined,
      summary_json: undefined,
    },
  });
});

/** Ask the mapping agent about the columns the deterministic mapper could not place. */
batchRoutes.post("/:id/mapping/suggest", requireAtLeast("bank_officer"), async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));
  const batch = await getBatch(c.env, institutionId, c.req.param("id"));
  if (!batch || !batch.source_key) throw new HttpError(404, "Not found.", "not_found");

  const object = await c.env.FILES.get(batch.source_key);
  if (!object) throw new HttpError(410, "The uploaded file is no longer stored.", "gone");

  const bytes = new Uint8Array(await object.arrayBuffer());
  const sheet = readUpload(batch.source_filename ?? "upload.xlsx", bytes);
  const profile = getProfile(batch.profile_id, batch.profile_version);
  const table = getTable(profile, batch.table_id);
  const plan = autoMap(sheet.headers, profile, batch.table_id);

  if (plan.unusedHeaders.length === 0) {
    return c.json({ mappings: [], unmappable: [], note: "Every column was already mapped." });
  }

  const filled = new Set(
    plan.mappings.filter((m) => m.sourceHeader).map((m) => m.fieldId),
  );

  const result = await proposeMappings(c.env, {
    unmappedHeaders: plan.unusedHeaders.map((header) => ({
      header,
      samples: sheet.rows
        .slice(0, 8)
        .map((r) => r.cells[header])
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v)),
    })),
    unfilledFields: table.fields
      .filter((f) => !filled.has(f.id))
      .map((f) => ({
        id: f.id,
        header: f.header,
        description: f.description ?? "",
        required: f.required,
      })),
  });

  if (!result.output) {
    throw new HttpError(
      502,
      result.failure ?? "The mapping agent returned no suggestion.",
      "agent_unavailable",
    );
  }

  return c.json({ ...result.output, model: result.model });
});

/**
 * Start the run: normalise, dispatch NIA verification, and audit.
 *
 * Verification is asynchronous, so this returns as soon as the lookups are on
 * the queue. When they all land the batch finalises itself; a caller that does
 * not want to wait can force finalisation with `?wait=false`.
 */
batchRoutes.post("/:id/run", requireAtLeast("bank_officer"), async (c) => {
  const principal = c.get("principal");
  const institutionId = scopedInstitution(principal, c.req.query("institutionId"));
  const batch = await getBatch(c.env, institutionId, c.req.param("id"));
  if (!batch || !batch.source_key) throw new HttpError(404, "Not found.", "not_found");

  if (batch.status === "verifying") {
    throw new HttpError(409, "This batch is already running.", "already_running");
  }

  const body = await c.req.json<{ mapping?: AutoMapResult; skipVerification?: boolean }>().catch(
    () => ({}) as { mapping?: AutoMapResult; skipVerification?: boolean },
  );

  const object = await c.env.FILES.get(batch.source_key);
  if (!object) throw new HttpError(410, "The uploaded file is no longer stored.", "gone");
  const bytes = new Uint8Array(await object.arrayBuffer());

  let prepared;
  try {
    prepared = await prepareBatch(c.env, batch, bytes, {
      ...(body.mapping ? { mappingOverride: body.mapping } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateBatch(c.env, batch.id, { status: "failed", error: message });
    throw new HttpError(422, message, "processing_failed");
  }

  await writeAuditLog(c.env, {
    institutionId,
    actorId: principal.id,
    actorType: principal.kind,
    action: "batch.run_started",
    entityType: "batch",
    entityId: batch.id,
    detail: {
      rows: prepared.records.length,
      cachedVerifications: prepared.cached.size,
      lookupsQueued: prepared.toVerify.length,
    },
  });

  // Without credentials configured there is nothing to verify against; the run
  // still proceeds, and every record is reported as unverified rather than the
  // batch failing outright.
  const canVerify = Boolean(c.env.METAMAP_CLIENT_ID && c.env.METAMAP_CLIENT_SECRET);
  const queued =
    body.skipVerification || !canVerify
      ? 0
      : await dispatchVerifications(c.env, batch, prepared.toVerify);

  if (queued === 0) {
    const result = await finaliseBatch(c.env, batch, prepared.records, prepared.cached);
    return c.json({
      status: "audited",
      verification: canVerify ? "not required" : "skipped — MetaMap credentials are not configured",
      summary: result.audit.summary,
      published: result.published,
      quarantined: result.quarantined,
    });
  }

  return c.json({
    status: "verifying",
    rows: prepared.records.length,
    lookupsQueued: queued,
    cachedVerifications: prepared.cached.size,
    note: "Identity verification runs asynchronously. Poll this batch, or call /finalise once the lookups have landed.",
  });
});

/**
 * Finalise a batch whose verifications have landed — or force it, accepting
 * that outstanding lookups will be reported as unverified.
 */
batchRoutes.post("/:id/finalise", requireAtLeast("bank_officer"), async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));
  const batch = await getBatch(c.env, institutionId, c.req.param("id"));
  if (!batch) throw new HttpError(404, "Not found.", "not_found");

  const { records } = await loadRecords(c.env, batch.id);
  if (records.length === 0) {
    throw new HttpError(409, "This batch has no prepared records. Run it first.", "not_prepared");
  }

  const pins = [
    ...new Set(
      records
        .map((r) => r.fields["depositor.ghana_card_pin"]?.value)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];

  const cached = await getCachedVerifications(c.env, pins);
  const verifications = new Map<string, VerificationOutcome>();
  for (const record of records) {
    const pin = record.fields["depositor.ghana_card_pin"]?.value;
    if (typeof pin !== "string") continue;
    const row = cached.get(pin);
    if (row) verifications.set(record.recordKey, toOutcome(row));
  }

  // Clear any findings from a previous run so a re-run does not double up.
  await c.env.DB.prepare(`DELETE FROM findings WHERE batch_id = ?`).bind(batch.id).run();

  const result = await finaliseBatch(c.env, batch, records, verifications);

  return c.json({
    status: "audited",
    summary: result.audit.summary,
    verified: verifications.size,
    unverified: records.length - verifications.size,
    published: result.published,
    quarantined: result.quarantined,
  });
});

/** Download the aligned submission or the audit report. */
batchRoutes.get("/:id/download/:kind", async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));
  const batch = await getBatch(c.env, institutionId, c.req.param("id"));
  if (!batch) throw new HttpError(404, "Not found.", "not_found");

  const kind = c.req.param("kind");
  const key =
    kind === "aligned" ? batch.aligned_key : kind === "report" ? batch.report_key : kind === "source" ? batch.source_key : null;

  if (!key) {
    throw new HttpError(404, `No '${kind}' file exists for this batch.`, "not_found");
  }

  const object = await c.env.FILES.get(key);
  if (!object) throw new HttpError(410, "That file is no longer stored.", "gone");

  const filename = `${batch.reference}-${kind}.xlsx`;

  return new Response(object.body, {
    headers: {
      "Content-Type":
        object.httpMetadata?.contentType ??
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
