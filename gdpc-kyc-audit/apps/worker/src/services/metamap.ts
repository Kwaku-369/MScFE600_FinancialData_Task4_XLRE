/**
 * MetaMap client.
 *
 * Two things about this API drive the whole verification design:
 *
 *   1. The Ghana GovCheck is asynchronous. `POST /govchecks/v1/gh/verify-card`
 *      returns 202 with an empty body and delivers the NIA record later to a
 *      callback URL. There is no synchronous read-back, so a verification is a
 *      long-running job with a correlation token, not a function call.
 *
 *   2. MetaMap cannot resolve a phone number to a Ghana Card. Phone Risk
 *      returns carrier, line type and a risk score; Phone Ownership sends an
 *      OTP, which needs the depositor present. Neither yields an identity. The
 *      `PhoneIdentityProvider` interface below exists so a provider that *can*
 *      do that lookup — an MNO SIM-registration feed, which in Ghana is tied to
 *      the Ghana Card — can be added later without touching the audit engine.
 */

import type { Env } from "../env.js";

const TOKEN_SCOPE = "verification_flow";

export interface MetaMapCredentials {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export class MetaMapError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "MetaMapError";
  }
}

/** Cached access token. JWTs last an hour; refresh a minute early. */
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(credentials: MetaMapCredentials): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;

  const basic = btoa(`${credentials.clientId}:${credentials.clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: TOKEN_SCOPE,
  });

  const response = await fetch(`${credentials.baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new MetaMapError(
      `MetaMap token request failed with ${response.status}`,
      response.status,
      text,
    );
  }

  const json = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

/** Clear the cached token — used when a 401 says it was revoked early. */
export function invalidateToken(): void {
  cachedToken = null;
}

export interface VerifyCardRequest {
  /** Ghana Card PIN in `GHA-000000000-0` form. */
  personalNumber: string;
  callbackUrl: string;
  /** Echoed back on the callback so the result can be matched to its record. */
  correlationId: string;
}

/**
 * Start a Ghana Card verification against the NIA database.
 *
 * Returns once MetaMap has accepted the request (202). The result arrives on
 * the callback URL; see `routes/webhooks.ts`.
 */
export async function startGhanaCardVerification(
  credentials: MetaMapCredentials,
  request: VerifyCardRequest,
): Promise<void> {
  const token = await getAccessToken(credentials);

  const response = await fetch(`${credentials.baseUrl}/govchecks/v1/gh/verify-card`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      personalNumber: request.personalNumber,
      callbackUrl: request.callbackUrl,
      metadata: JSON.stringify({ correlationId: request.correlationId }),
    }),
  });

  if (response.status === 401) {
    invalidateToken();
    throw new MetaMapError("MetaMap rejected the access token", 401);
  }

  // 202 Accepted is the success path; 200 is tolerated in case that changes.
  if (response.status !== 202 && response.status !== 200) {
    const text = await response.text().catch(() => "");
    throw new MetaMapError(
      `MetaMap verify-card failed with ${response.status}`,
      response.status,
      text,
    );
  }
}

/** The shape MetaMap posts back to the callback URL. */
export interface GhanaCardCallback {
  data?: {
    firstName?: string | null;
    lastName?: string | null;
    middleName?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    placeOfBirth?: string | null;
    nationality?: string | null;
    personalNumber?: string | null;
    regDate?: string | null;
    expiryDate?: string | null;
  } | null;
  error?: {
    type?: string;
    code?: string;
    message?: string;
  } | null;
  metadata?: unknown;
}

/** Error codes the Ghana GovCheck can return in the callback. */
export const GHANA_ERROR_CODES = {
  NOT_FOUND: "ghanaianVerifyCard.notFound",
  INVALID_PARAMS: "ghanaianVerifyCard.notValidParams",
  SERVICE_UNAVAILABLE: "ghanaianVerifyCard.serviceUnavailable",
  INTERNAL: "system.internalError",
} as const;

/**
 * Verify the `x-signature` header MetaMap sends: HMAC-SHA256 of the raw request
 * body, keyed with the webhook secret.
 *
 * Compared in constant time — a timing-variable compare on a signature is a
 * genuine forgery vector, not a theoretical one.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, signature.trim().toLowerCase());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

// ---------------------------------------------------------------------------
// Phone intelligence
// ---------------------------------------------------------------------------

export interface PhoneRiskResult {
  msisdn: string;
  carrier: string | null;
  lineType: string | null;
  riskLevel: string | null;
  riskScore: number | null;
}

/**
 * Ask MetaMap to assess a phone number. Also asynchronous (callback-based), so
 * this only starts the check.
 *
 * Note what this does NOT return: the subscriber's name. No MetaMap endpoint
 * maps a Ghanaian number to the identity behind it.
 */
export async function startPhoneRiskCheck(
  credentials: MetaMapCredentials,
  msisdn: string,
  callbackUrl: string,
  correlationId: string,
): Promise<void> {
  const token = await getAccessToken(credentials);

  const response = await fetch(`${credentials.baseUrl}/safety/v1/checks/phone/risk`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: msisdn.replace(/\D/g, ""),
      callbackUrl,
      metadata: { correlationId },
    }),
  });

  if (!response.ok && response.status !== 202) {
    const text = await response.text().catch(() => "");
    throw new MetaMapError(`Phone risk check failed with ${response.status}`, response.status, text);
  }
}

/**
 * The seam for a future reverse phone -> identity lookup.
 *
 * Ghanaian SIM registration is tied to the Ghana Card, so an MNO or an
 * authorised aggregator can answer "who owns this number". MetaMap cannot.
 * Implement this interface against such a source and register it; the audit
 * engine already consumes `PhoneIntelligence.ownerName` when it is present, and
 * will start matching phone-derived names against the bank record with no
 * further change.
 */
export interface PhoneIdentityProvider {
  readonly name: string;
  lookup(msisdn: string): Promise<{
    ownerName: string | null;
    ghanaCardPin: string | null;
    confidence: number;
  } | null>;
}

export function credentialsFrom(env: Env): MetaMapCredentials {
  if (!env.METAMAP_CLIENT_ID || !env.METAMAP_CLIENT_SECRET) {
    throw new MetaMapError(
      "MetaMap credentials are not configured. Set METAMAP_CLIENT_ID and METAMAP_CLIENT_SECRET with `wrangler secret put`.",
      500,
    );
  }
  return {
    clientId: env.METAMAP_CLIENT_ID,
    clientSecret: env.METAMAP_CLIENT_SECRET,
    baseUrl: env.METAMAP_BASE_URL.replace(/\/$/, ""),
  };
}
