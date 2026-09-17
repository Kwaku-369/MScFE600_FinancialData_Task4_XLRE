/**
 * Authentication and tenant isolation.
 *
 * The single most important invariant in this system: a rural bank must never
 * see another bank's depositor data. That is enforced here, by resolving a
 * principal with a fixed `institutionId`, and in the repository layer, which
 * refuses to build a query without one. Route handlers never choose the
 * institution themselves — they take it from the principal.
 */

import type { MiddlewareHandler } from "hono";
import type { AppContext, Env, Principal, Role } from "../env.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** SHA-256 hex, used for API key lookup. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Password hashing with PBKDF2-SHA256.
 *
 * Workers has no native bcrypt/argon2, and PBKDF2 through WebCrypto is the
 * strongest primitive available in the runtime. 210,000 iterations follows the
 * current OWASP guidance for PBKDF2-HMAC-SHA256.
 */
const PBKDF2_ITERATIONS = 210_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number(parts[1]);
  const salt = fromBase64(parts[2]!);
  const expected = parts[3]!;

  const bits = await deriveBits(password, salt, iterations);
  const actual = toBase64(new Uint8Array(bits));

  // Constant-time comparison.
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) {
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

interface SessionPayload {
  sub: string;
  exp: number;
}

export async function issueSession(env: Env, userId: string, ttlSeconds = 8 * 3600): Promise<string> {
  const secret = requireSessionSecret(env);
  const payload: SessionPayload = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = toBase64Url(JSON.stringify(payload));
  const signature = await hmac(secret, body);
  return `${body}.${signature}`;
}

export async function readSession(env: Env, token: string): Promise<string | null> {
  const secret = requireSessionSecret(env);
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = await hmac(secret, body);
  if (expected.length !== signature.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  if (difference !== 0) return null;

  try {
    const payload = JSON.parse(fromBase64Url(body)) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64Url(String.fromCharCode(...new Uint8Array(mac)));
}

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

function requireSessionSecret(env: Env): string {
  if (!env.SESSION_SECRET) {
    throw new HttpError(500, "SESSION_SECRET is not configured.", "misconfigured");
  }
  return env.SESSION_SECRET;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Resolve the caller from either a session cookie (the web UI) or an API key
 * (a bank's core system pushing a submission unattended).
 */
export const authenticate: MiddlewareHandler<AppContext> = async (c, next) => {
  const principal = await resolvePrincipal(c.env, c.req.raw);
  if (!principal) {
    throw new HttpError(401, "Authentication is required.", "unauthenticated");
  }
  c.set("principal", principal);
  await next();
};

async function resolvePrincipal(env: Env, request: Request): Promise<Principal | null> {
  const header = request.headers.get("authorization");

  if (header?.startsWith("Bearer gdpc_")) {
    return resolveApiKey(env, header.slice("Bearer ".length));
  }

  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)gdpc_session=([^;]+)/.exec(cookie);
  const token = match?.[1] ?? (header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!token) return null;

  const userId = await readSession(env, token);
  if (!userId) return null;

  const row = await env.DB.prepare(
    `SELECT id, institution_id, name, role, status FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ id: string; institution_id: string | null; name: string; role: Role; status: string }>();

  if (!row || row.status !== "active") return null;

  return {
    id: row.id,
    kind: "user",
    institutionId: row.institution_id,
    role: row.role,
    name: row.name,
  };
}

async function resolveApiKey(env: Env, key: string): Promise<Principal | null> {
  const hash = await sha256Hex(key);
  const row = await env.DB.prepare(
    `SELECT k.id, k.institution_id, k.name, k.revoked_at, i.status AS institution_status
       FROM api_keys k
       JOIN institutions i ON i.id = k.institution_id
      WHERE k.key_hash = ?`,
  )
    .bind(hash)
    .first<{
      id: string;
      institution_id: string;
      name: string;
      revoked_at: string | null;
      institution_status: string;
    }>();

  if (!row || row.revoked_at || row.institution_status !== "active") return null;

  // Best-effort; a failed timestamp update must not block the request.
  await env.DB.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`)
    .bind(row.id)
    .run()
    .catch(() => undefined);

  return {
    id: row.id,
    kind: "api_key",
    institutionId: row.institution_id,
    role: "bank_officer",
    name: row.name,
  };
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<Role, number> = {
  platform_admin: 100,
  auditor: 80,
  bank_admin: 60,
  bank_officer: 40,
  read_only: 20,
};

export function requireRole(...allowed: Role[]): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!allowed.includes(principal.role)) {
      throw new HttpError(
        403,
        `This action requires one of: ${allowed.join(", ")}.`,
        "forbidden",
      );
    }
    await next();
  };
}

export function requireAtLeast(minimum: Role): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (ROLE_RANK[principal.role] < ROLE_RANK[minimum]) {
      throw new HttpError(403, `This action requires at least the ${minimum} role.`, "forbidden");
    }
    await next();
  };
}

/**
 * The institution whose data this request may touch.
 *
 * A platform admin or auditor may name one explicitly; everyone else is pinned
 * to their own. Returning a value here is the only sanctioned way for a handler
 * to learn which tenant it is operating on.
 */
export function scopedInstitution(
  principal: Principal,
  requested?: string | null,
): string {
  const isPlatformWide = principal.role === "platform_admin" || principal.role === "auditor";

  if (isPlatformWide) {
    if (requested) return requested;
    if (principal.institutionId) return principal.institutionId;
    throw new HttpError(400, "Specify an institution for this request.", "institution_required");
  }

  if (!principal.institutionId) {
    throw new HttpError(403, "This account is not linked to an institution.", "forbidden");
  }

  if (requested && requested !== principal.institutionId) {
    // Do not reveal whether the other institution exists.
    throw new HttpError(404, "Not found.", "not_found");
  }

  return principal.institutionId;
}
