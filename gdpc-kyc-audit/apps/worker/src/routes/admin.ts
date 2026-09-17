import { Hono } from "hono";
import { PROFILES } from "@gdpc/core";

import type { AppContext } from "../env.js";
import { HttpError, authenticate, hashPassword, requireRole, requireAtLeast, scopedInstitution } from "../middleware/auth.js";
import { getInstitution, listInstitutions, newId, writeAuditLog } from "../db/repo.js";

export const adminRoutes = new Hono<AppContext>();

adminRoutes.use("*", authenticate);

/** The template profiles the platform can produce. */
adminRoutes.get("/profiles", (c) =>
  c.json({
    profiles: PROFILES.map((p) => ({
      id: p.id,
      version: p.version,
      label: p.label,
      provenance: p.provenance,
      tables: p.tables.map((t) => ({
        id: t.id,
        name: t.name,
        sheetName: t.sheetName,
        fields: t.fields,
      })),
    })),
  }),
);

adminRoutes.get("/institutions", requireAtLeast("bank_admin"), async (c) => {
  const principal = c.get("principal");

  if (principal.role === "platform_admin" || principal.role === "auditor") {
    return c.json({ institutions: await listInstitutions(c.env) });
  }

  const own = principal.institutionId
    ? await getInstitution(c.env, principal.institutionId)
    : null;
  return c.json({ institutions: own ? [own] : [] });
});

adminRoutes.post("/institutions", requireRole("platform_admin"), async (c) => {
  const principal = c.get("principal");
  const body = await c.req.json<{
    name?: string;
    memberCode?: string;
    category?: string;
    submissionMode?: "review" | "direct";
  }>();

  if (!body.name) throw new HttpError(400, "A name is required.", "invalid_request");

  const id = newId("ins");
  await c.env.DB.prepare(
    `INSERT INTO institutions (id, name, member_code, category, submission_mode)
     VALUES (?,?,?,?,?)`,
  )
    .bind(
      id,
      body.name,
      body.memberCode ?? null,
      body.category ?? "rcb",
      body.submissionMode ?? "review",
    )
    .run();

  await writeAuditLog(c.env, {
    institutionId: id,
    actorId: principal.id,
    action: "institution.created",
    entityType: "institution",
    entityId: id,
    detail: body,
  });

  return c.json({ id, ...body }, 201);
});

/**
 * Change how an institution submits.
 *
 * `review` holds every batch for an operator. `direct` publishes the records
 * that pass the gate and quarantines the rest — it never publishes an
 * exception, whatever raised it. Because the change alters what reaches the
 * live view without a human, it is restricted to a platform administrator and
 * always logged.
 */
adminRoutes.patch("/institutions/:id", requireRole("platform_admin"), async (c) => {
  const principal = c.get("principal");
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    submissionMode?: "review" | "direct";
    status?: string;
  }>();

  const existing = await getInstitution(c.env, id);
  if (!existing) throw new HttpError(404, "Not found.", "not_found");

  if (body.submissionMode && !["review", "direct"].includes(body.submissionMode)) {
    throw new HttpError(400, "submissionMode must be 'review' or 'direct'.", "invalid_request");
  }

  const patch: Array<[string, string]> = [];
  if (body.name) patch.push(["name", body.name]);
  if (body.submissionMode) patch.push(["submission_mode", body.submissionMode]);
  if (body.status) patch.push(["status", body.status]);

  if (patch.length === 0) return c.json({ ok: true, unchanged: true });

  await c.env.DB.prepare(
    `UPDATE institutions SET ${patch.map(([k]) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(...patch.map(([, v]) => v), id)
    .run();

  await writeAuditLog(c.env, {
    institutionId: id,
    actorId: principal.id,
    action: "institution.updated",
    entityType: "institution",
    entityId: id,
    detail: { before: { submission_mode: existing.submission_mode }, after: body },
  });

  return c.json({ ok: true });
});

adminRoutes.post("/users", requireRole("platform_admin", "bank_admin"), async (c) => {
  const principal = c.get("principal");
  const body = await c.req.json<{
    email?: string;
    name?: string;
    role?: string;
    password?: string;
    institutionId?: string;
  }>();

  if (!body.email || !body.name || !body.role || !body.password) {
    throw new HttpError(400, "Name, email, role and password are required.", "invalid_request");
  }
  if (body.password.length < 12) {
    throw new HttpError(400, "The password must be at least 12 characters.", "weak_password");
  }

  // A bank administrator may only create accounts inside their own institution,
  // and may not mint an account more privileged than their own.
  const institutionId = scopedInstitution(principal, body.institutionId);
  if (principal.role === "bank_admin" && !["bank_officer", "read_only"].includes(body.role)) {
    throw new HttpError(
      403,
      "A bank administrator may only create bank_officer or read_only accounts.",
      "forbidden",
    );
  }

  const id = newId("usr");
  await c.env.DB.prepare(
    `INSERT INTO users (id, institution_id, email, name, role, password_hash)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(
      id,
      institutionId,
      body.email.toLowerCase().trim(),
      body.name,
      body.role,
      await hashPassword(body.password),
    )
    .run();

  await writeAuditLog(c.env, {
    institutionId,
    actorId: principal.id,
    action: "user.created",
    entityType: "user",
    entityId: id,
    detail: { email: body.email, role: body.role },
  });

  return c.json({ id, email: body.email, role: body.role }, 201);
});

/** The audit trail. Read-only by construction — nothing writes to it from here. */
adminRoutes.get("/audit-log", requireAtLeast("bank_admin"), async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM audit_log WHERE institution_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(institutionId, limit)
    .all();

  return c.json({ entries: results ?? [] });
});

/** Headline numbers for the dashboard. */
adminRoutes.get("/stats", async (c) => {
  const institutionId = scopedInstitution(c.get("principal"), c.req.query("institutionId"));

  const batches = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'audited' THEN 1 ELSE 0 END) AS audited,
            SUM(row_count) AS rows
       FROM batches WHERE institution_id = ?`,
  )
    .bind(institutionId)
    .first<{ total: number; audited: number; rows: number }>();

  const findings = await c.env.DB.prepare(
    `SELECT severity, COUNT(*) AS count
       FROM findings WHERE institution_id = ? AND resolution = 'open'
      GROUP BY severity`,
  )
    .bind(institutionId)
    .all<{ severity: string; count: number }>();

  const topCodes = await c.env.DB.prepare(
    `SELECT code, COUNT(*) AS count
       FROM findings WHERE institution_id = ?
      GROUP BY code ORDER BY count DESC LIMIT 10`,
  )
    .bind(institutionId)
    .all<{ code: string; count: number }>();

  return c.json({
    batches: {
      total: batches?.total ?? 0,
      audited: batches?.audited ?? 0,
      rows: batches?.rows ?? 0,
    },
    openFindingsBySeverity: Object.fromEntries(
      (findings.results ?? []).map((r) => [r.severity, r.count]),
    ),
    topExceptionCodes: topCodes.results ?? [],
  });
});
