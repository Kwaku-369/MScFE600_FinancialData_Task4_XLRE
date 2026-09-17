import { Hono } from "hono";
import type { AppContext } from "../env.js";
import {
  HttpError,
  authenticate,
  hashPassword,
  issueSession,
  requireRole,
  sha256Hex,
  verifyPassword,
} from "../middleware/auth.js";
import { newId, writeAuditLog } from "../db/repo.js";

export const authRoutes = new Hono<AppContext>();

authRoutes.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  if (!email || !password) {
    throw new HttpError(400, "Email and password are required.", "invalid_request");
  }

  const user = await c.env.DB.prepare(
    `SELECT id, institution_id, name, role, password_hash, status FROM users WHERE email = ?`,
  )
    .bind(email.toLowerCase().trim())
    .first<{
      id: string;
      institution_id: string | null;
      name: string;
      role: string;
      password_hash: string | null;
      status: string;
    }>();

  // Always run a verification so a missing account and a wrong password take
  // the same amount of time and cannot be told apart from the outside.
  const stored = user?.password_hash ?? "pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = await verifyPassword(password, stored);

  if (!user || !ok || user.status !== "active") {
    throw new HttpError(401, "Those credentials were not recognised.", "invalid_credentials");
  }

  const token = await issueSession(c.env, user.id);

  await c.env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(user.id)
    .run();

  await writeAuditLog(c.env, {
    institutionId: user.institution_id,
    actorId: user.id,
    action: "auth.login",
    entityType: "user",
    entityId: user.id,
    ip: c.req.header("cf-connecting-ip") ?? null,
  });

  // HttpOnly so the token is never reachable from page scripts.
  c.header(
    "Set-Cookie",
    `gdpc_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
  );

  return c.json({
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      institutionId: user.institution_id,
    },
  });
});

authRoutes.post("/logout", (c) => {
  c.header("Set-Cookie", "gdpc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  return c.json({ ok: true });
});

authRoutes.get("/me", authenticate, (c) => {
  const principal = c.get("principal");
  return c.json({ principal });
});

/** Issue an API key so a bank's core system can submit unattended. */
authRoutes.post(
  "/api-keys",
  authenticate,
  requireRole("platform_admin", "bank_admin"),
  async (c) => {
    const principal = c.get("principal");
    const { name } = await c.req.json<{ name?: string }>();
    if (!name) throw new HttpError(400, "A name for the key is required.", "invalid_request");

    if (!principal.institutionId) {
      throw new HttpError(400, "This account is not linked to an institution.", "invalid_request");
    }

    // 32 random bytes, rendered hex. Shown once and never stored in the clear.
    const secret =
      "gdpc_" +
      [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    await c.env.DB.prepare(
      `INSERT INTO api_keys (id, institution_id, name, key_hash, key_prefix, created_by)
       VALUES (?,?,?,?,?,?)`,
    )
      .bind(
        newId("key"),
        principal.institutionId,
        name,
        await sha256Hex(secret),
        secret.slice(0, 13),
        principal.id,
      )
      .run();

    await writeAuditLog(c.env, {
      institutionId: principal.institutionId,
      actorId: principal.id,
      action: "api_key.created",
      detail: { name },
    });

    return c.json(
      {
        key: secret,
        warning: "This is the only time the key will be shown. Store it securely.",
      },
      201,
    );
  },
);

/** Bootstrap the very first platform administrator. */
authRoutes.post("/bootstrap", async (c) => {
  const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users`).first<{
    count: number;
  }>();

  if ((existing?.count ?? 0) > 0) {
    throw new HttpError(409, "The platform has already been initialised.", "already_initialised");
  }

  const { email, password, name } = await c.req.json<{
    email?: string;
    password?: string;
    name?: string;
  }>();

  if (!email || !password || !name) {
    throw new HttpError(400, "Name, email and password are required.", "invalid_request");
  }
  if (password.length < 12) {
    throw new HttpError(400, "The password must be at least 12 characters.", "weak_password");
  }

  const id = newId("usr");
  await c.env.DB.prepare(
    `INSERT INTO users (id, institution_id, email, name, role, password_hash)
     VALUES (?, NULL, ?, ?, 'platform_admin', ?)`,
  )
    .bind(id, email.toLowerCase().trim(), name, await hashPassword(password))
    .run();

  await writeAuditLog(c.env, {
    institutionId: null,
    actorId: id,
    action: "platform.bootstrapped",
    entityType: "user",
    entityId: id,
  });

  return c.json({ id, email, role: "platform_admin" }, 201);
});
