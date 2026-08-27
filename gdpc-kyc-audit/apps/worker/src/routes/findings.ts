import { Hono } from "hono";
import { CODE_SPECS } from "@gdpc/core";

import type { AppContext } from "../env.js";
import { HttpError, authenticate, requireAtLeast, scopedInstitution } from "../middleware/auth.js";
import { listFindings, resolveFinding, writeAuditLog } from "../db/repo.js";
import { adjudicate, saveAdjudication } from "../agents/adjudicator.js";

export const findingRoutes = new Hono<AppContext>();

findingRoutes.use("*", authenticate);

/** The exception catalogue, so the UI and any integrator share one vocabulary. */
findingRoutes.get("/codes", (c) => c.json({ codes: CODE_SPECS }));

findingRoutes.get("/", async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));

  const findings = await listFindings(c.env, institutionId, {
    ...(c.req.query("batchId") ? { batchId: c.req.query("batchId")! } : {}),
    ...(c.req.query("severity") ? { severity: c.req.query("severity")! } : {}),
    ...(c.req.query("category") ? { category: c.req.query("category")! } : {}),
    ...(c.req.query("code") ? { code: c.req.query("code")! } : {}),
    ...(c.req.query("resolution") ? { resolution: c.req.query("resolution")! } : {}),
    limit: Math.min(Number(c.req.query("limit") ?? 200), 500),
    offset: Number(c.req.query("offset") ?? 0),
  });

  return c.json({
    findings: findings.map((f) => ({
      ...f,
      evidence: f.evidence_json ? JSON.parse(f.evidence_json) : null,
      evidence_json: undefined,
    })),
  });
});

/**
 * Record a decision on a finding.
 *
 * Resolving a finding never rewrites the stored record. The decision is
 * recorded against the finding, and the corrected value is applied when the
 * batch is re-finalised — so the original submission and the decision that
 * changed it both remain visible.
 */
findingRoutes.post("/:id/resolve", requireAtLeast("bank_officer"), async (c) => {
  const principal = c.get("principal");
  const institutionId = scopedInstitution(principal, c.req.query("institutionId"));

  const { resolution, note } = await c.req.json<{
    resolution?: "accepted" | "rejected" | "corrected" | "escalated";
    note?: string;
  }>();

  const allowed = ["accepted", "rejected", "corrected", "escalated"] as const;
  if (!resolution || !allowed.includes(resolution)) {
    throw new HttpError(
      400,
      `Provide a resolution: ${allowed.join(", ")}.`,
      "invalid_request",
    );
  }

  const updated = await resolveFinding(
    c.env,
    institutionId,
    c.req.param("id"),
    resolution,
    principal.id,
    note,
  );

  if (!updated) throw new HttpError(404, "Not found.", "not_found");

  await writeAuditLog(c.env, {
    institutionId,
    actorId: principal.id,
    actorType: principal.kind,
    action: "finding.resolved",
    entityType: "finding",
    entityId: c.req.param("id"),
    detail: { resolution, note },
  });

  return c.json({ ok: true, resolution });
});

/**
 * Ask the adjudication agent to assess an identity finding.
 *
 * The recommendation is advisory and is stored separately from the finding. A
 * person still has to resolve the finding — the agent narrows the queue and
 * explains itself; it does not decide.
 */
findingRoutes.post("/:id/adjudicate", requireAtLeast("bank_officer"), async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));
  const findingId = c.req.param("id");

  const finding = await c.env.DB.prepare(
    `SELECT f.*, r.aligned_json
       FROM findings f
       LEFT JOIN records r ON r.id = f.record_id
      WHERE f.id = ? AND f.institution_id = ?`,
  )
    .bind(findingId, institutionId)
    .first<{
      id: string;
      batch_id: string;
      code: string;
      message: string;
      category: string;
      observed: string | null;
      expected: string | null;
      confidence: number | null;
      evidence_json: string | null;
      aligned_json: string | null;
    }>();

  if (!finding) throw new HttpError(404, "Not found.", "not_found");

  if (finding.category !== "name" && finding.category !== "identity" && finding.category !== "dob") {
    throw new HttpError(
      400,
      "Only identity, name and date-of-birth findings are adjudicated. Others are decided by rule.",
      "not_adjudicable",
    );
  }

  const evidence = finding.evidence_json
    ? (JSON.parse(finding.evidence_json) as Record<string, unknown>)
    : {};
  const aligned = finding.aligned_json
    ? (JSON.parse(finding.aligned_json) as Record<string, { value: unknown }>)
    : {};

  const input = {
    code: finding.code,
    message: finding.message,
    bankName: String(evidence.bankName ?? finding.observed ?? ""),
    cardName: String(evidence.cardName ?? finding.expected ?? ""),
    bankDateOfBirth: (aligned["depositor.date_of_birth"]?.value as string) ?? null,
    cardDateOfBirth: (evidence.cardDateOfBirth as string) ?? null,
    bankGender: (aligned["depositor.gender"]?.value as string) ?? null,
    cardGender: (evidence.cardGender as string) ?? null,
    ghanaCardPin: (aligned["depositor.ghana_card_pin"]?.value as string) ?? null,
    matchScore: typeof evidence.score === "number" ? evidence.score : null,
    alignment: evidence.alignment ?? [],
  };

  const result = await adjudicate(c.env, input);
  await saveAdjudication(c.env, finding.batch_id, findingId, input, result);

  if (!result.output) {
    throw new HttpError(
      502,
      result.failure ?? "The adjudication agent returned no recommendation.",
      "agent_unavailable",
    );
  }

  return c.json({
    findingId,
    adjudication: result.output,
    model: result.model,
    note: "Advisory only. A person must still resolve the finding.",
  });
});

/** Everything the agents have said about one batch. */
findingRoutes.get("/agent-reviews/:batchId", async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));

  const { results } = await c.env.DB.prepare(
    `SELECT a.* FROM agent_reviews a
       JOIN batches b ON b.id = a.batch_id
      WHERE a.batch_id = ? AND b.institution_id = ?
      ORDER BY a.created_at DESC`,
  )
    .bind(c.req.param("batchId"), institutionId)
    .all();

  return c.json({ reviews: results ?? [] });
});
