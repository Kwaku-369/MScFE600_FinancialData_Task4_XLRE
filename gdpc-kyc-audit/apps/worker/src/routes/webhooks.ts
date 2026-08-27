/**
 * Inbound callbacks from MetaMap.
 *
 * This endpoint is unauthenticated in the ordinary sense — MetaMap has no
 * session with us — so the HMAC signature is the only thing standing between a
 * stranger and the ability to write an identity record into the database. It is
 * verified before the body is parsed, and a request that fails verification is
 * refused without revealing why.
 */

import { Hono } from "hono";
import type { AppContext } from "../env.js";
import {
  GHANA_ERROR_CODES,
  verifyWebhookSignature,
  type GhanaCardCallback,
} from "../services/metamap.js";
import {
  completeVerificationJob,
  countPendingVerifications,
  getBatch,
  getCachedVerifications,
  upsertVerification,
  writeAuditLog,
} from "../db/repo.js";
import { finaliseBatch, loadRecords, toOutcome } from "../services/pipeline.js";
import type { VerificationOutcome } from "@gdpc/core";

export const webhookRoutes = new Hono<AppContext>();

webhookRoutes.post("/metamap/ghana-card", async (c) => {
  const secret = c.env.METAMAP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("METAMAP_WEBHOOK_SECRET is not configured; rejecting callback.");
    return c.json({ error: "not_configured" }, 500);
  }

  // Read the body as text: the signature covers the exact bytes sent, so it
  // must be verified before any parsing normalises them.
  const rawBody = await c.req.text();
  const signature = c.req.header("x-signature") ?? null;

  if (!(await verifyWebhookSignature(rawBody, signature, secret))) {
    console.warn("Rejected a MetaMap callback with an invalid signature.");
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: GhanaCardCallback;
  try {
    payload = JSON.parse(rawBody) as GhanaCardCallback;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const correlationId = extractCorrelationId(payload.metadata);
  if (!correlationId) {
    console.warn("MetaMap callback carried no correlation id; cannot match it to a record.");
    return c.json({ error: "missing_correlation" }, 400);
  }

  const errorCode = payload.error?.code ?? payload.error?.type ?? null;
  const status = mapStatus(errorCode, payload.data);

  const personalNumber =
    payload.data?.personalNumber ?? (await personalNumberFor(c.env, correlationId));

  if (personalNumber) {
    await upsertVerification(c.env, {
      personalNumber,
      institutionId: null,
      status,
      firstName: payload.data?.firstName ?? null,
      middleName: payload.data?.middleName ?? null,
      lastName: payload.data?.lastName ?? null,
      gender: payload.data?.gender ?? null,
      dateOfBirth: normaliseDate(payload.data?.dateOfBirth ?? null),
      placeOfBirth: payload.data?.placeOfBirth ?? null,
      nationality: payload.data?.nationality ?? null,
      regDate: normaliseDate(payload.data?.regDate ?? null),
      expiryDate: normaliseDate(payload.data?.expiryDate ?? null),
      raw: payload,
      errorCode,
      errorMessage: payload.error?.message ?? null,
      // A negative result is cached only briefly: a card that is not on file
      // today may well be tomorrow, and caching that for six months would keep
      // a depositor rejected long after they had fixed the problem.
      ttlDays: status === "verified" ? 180 : 1,
    });
  }

  const job = await completeVerificationJob(
    c.env,
    correlationId,
    status === "unavailable" ? "failed" : "completed",
    payload.error?.message ?? undefined,
  );

  if (!job) {
    // An unknown correlation id is not an error worth retrying — acknowledge it
    // so MetaMap stops redelivering.
    return c.json({ ok: true, note: "No matching job." });
  }

  // Once the last lookup for a batch lands, finalise it without being asked.
  const pending = await countPendingVerifications(c.env, job.batch_id);
  if (pending === 0) {
    c.executionCtx.waitUntil(finaliseWhenReady(c.env, job.batch_id));
  }

  return c.json({ ok: true });
});

/** Health probe MetaMap (or a monitor) can call. */
webhookRoutes.get("/metamap/ghana-card", (c) =>
  c.json({ ok: true, configured: Boolean(c.env.METAMAP_WEBHOOK_SECRET) }),
);

async function finaliseWhenReady(env: AppContext["Bindings"], batchId: string): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT institution_id, status FROM batches WHERE id = ?`,
    )
      .bind(batchId)
      .first<{ institution_id: string; status: string }>();

    if (!row || row.status === "audited") return;

    const batch = await getBatch(env, row.institution_id, batchId);
    if (!batch) return;

    const { records } = await loadRecords(env, batchId);
    if (records.length === 0) return;

    const pins = [
      ...new Set(
        records
          .map((r) => r.fields["depositor.ghana_card_pin"]?.value)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    ];

    const cached = await getCachedVerifications(env, pins);
    const verifications = new Map<string, VerificationOutcome>();
    for (const record of records) {
      const pin = record.fields["depositor.ghana_card_pin"]?.value;
      if (typeof pin !== "string") continue;
      const hit = cached.get(pin);
      if (hit) verifications.set(record.recordKey, toOutcome(hit));
    }

    await env.DB.prepare(`DELETE FROM findings WHERE batch_id = ?`).bind(batchId).run();
    await finaliseBatch(env, batch, records, verifications);
  } catch (error) {
    console.error("Automatic finalisation failed", { batchId, error });
    await writeAuditLog(env, {
      institutionId: null,
      actorId: null,
      actorType: "system",
      action: "batch.finalise_failed",
      entityType: "batch",
      entityId: batchId,
      detail: { error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
  }
}

/**
 * The correlation token is echoed back inside `metadata`, which MetaMap returns
 * either as an object or as the JSON string it was sent as.
 */
function extractCorrelationId(metadata: unknown): string | null {
  if (!metadata) return null;

  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as { correlationId?: string };
      return parsed.correlationId ?? null;
    } catch {
      return null;
    }
  }

  if (typeof metadata === "object" && "correlationId" in metadata) {
    const value = (metadata as { correlationId?: unknown }).correlationId;
    return typeof value === "string" ? value : null;
  }

  return null;
}

function mapStatus(errorCode: string | null, data: GhanaCardCallback["data"]): string {
  if (!errorCode && data) return "verified";

  switch (errorCode) {
    case GHANA_ERROR_CODES.NOT_FOUND:
      return "not_found";
    case GHANA_ERROR_CODES.INVALID_PARAMS:
      return "invalid_input";
    case GHANA_ERROR_CODES.SERVICE_UNAVAILABLE:
    case GHANA_ERROR_CODES.INTERNAL:
      return "unavailable";
    default:
      return errorCode ? "unavailable" : "not_found";
  }
}

async function personalNumberFor(
  env: AppContext["Bindings"],
  correlationId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT personal_number FROM verification_jobs WHERE correlation_id = ?`,
  )
    .bind(correlationId)
    .first<{ personal_number: string }>();
  return row?.personal_number ?? null;
}

/** The NIA returns dates in several forms; store ISO or nothing. */
function normaliseDate(value: string | null): string | null {
  if (!value) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value.trim());
  if (dmy) {
    const day = dmy[1]!.padStart(2, "0");
    const month = dmy[2]!.padStart(2, "0");
    return `${dmy[3]}-${month}-${day}`;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}
