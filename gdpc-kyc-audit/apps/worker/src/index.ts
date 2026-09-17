/**
 * GDPC KYC alignment and audit platform — Worker entry point.
 *
 * Serves the API, the web UI (as static assets), the MetaMap callback endpoint,
 * and the queue consumer that drives identity verification.
 */

import { Hono } from "hono";
import type { Env, AppContext, VerifyJobMessage } from "./env.js";
import { HttpError } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { batchRoutes } from "./routes/batches.js";
import { findingRoutes } from "./routes/findings.js";
import { adminRoutes } from "./routes/admin.js";
import { webhookRoutes } from "./routes/webhooks.js";
import {
  MetaMapError,
  credentialsFrom,
  startGhanaCardVerification,
} from "./services/metamap.js";
import { completeVerificationJob, upsertVerification } from "./db/repo.js";

const app = new Hono<AppContext>();

// Correlate every log line and error response with one request.
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
});

// Security headers. The UI is entirely self-hosted, so the policy can be tight.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (c.req.path.startsWith("/api/")) {
    // Depositor data must never be cached by an intermediary.
    c.header("Cache-Control", "no-store");
  }
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    environment: c.env.ENVIRONMENT,
    verificationConfigured: Boolean(c.env.METAMAP_CLIENT_ID && c.env.METAMAP_CLIENT_SECRET),
    agentsConfigured: Boolean(c.env.ANTHROPIC_API_KEY),
  }),
);

app.route("/api/auth", authRoutes);
app.route("/api/batches", batchRoutes);
app.route("/api/findings", findingRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/webhooks", webhookRoutes);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "not_found", message: "No such endpoint." }, 404);
  }
  // Everything else is the single-page app.
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  const requestId = c.get("requestId");

  if (error instanceof HttpError) {
    return c.json({ error: error.code, message: error.message, requestId }, error.status as 400);
  }

  if (error instanceof MetaMapError) {
    console.error("MetaMap error", { requestId, status: error.status, body: error.body });
    return c.json(
      {
        error: "verification_provider_error",
        message: "The identity verification service could not be reached.",
        requestId,
      },
      502,
    );
  }

  // Never leak an internal message to a caller; log it and hand back the id.
  console.error("Unhandled error", { requestId, error });
  return c.json(
    {
      error: "internal_error",
      message: "Something went wrong. Quote the request id when reporting it.",
      requestId,
    },
    500,
  );
});

export default {
  fetch: app.fetch,

  /**
   * Drive the Ghana Card lookups.
   *
   * Each message starts one verification; the result comes back later on the
   * callback endpoint. A message is retried on a transport failure, and a
   * permanent rejection is recorded against the card rather than retried
   * forever — a malformed PIN will never succeed no matter how often it is sent.
   */
  async queue(
    batch: MessageBatch<VerifyJobMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    let credentials;
    try {
      credentials = credentialsFrom(env);
    } catch (error) {
      console.error("Verification queue cannot run without MetaMap credentials", error);
      // Retry: the credentials may be configured before the retry window closes.
      for (const message of batch.messages) message.retry();
      return;
    }

    const callbackUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/metamap/ghana-card`;

    for (const message of batch.messages) {
      const job = message.body;
      try {
        await startGhanaCardVerification(credentials, {
          personalNumber: job.personalNumber,
          callbackUrl,
          correlationId: job.correlationId,
        });
        message.ack();
      } catch (error) {
        const status = error instanceof MetaMapError ? error.status : 0;

        // 4xx other than 429 means this request will never succeed. Record the
        // failure so the batch can finalise instead of waiting on a callback
        // that is never coming.
        if (status >= 400 && status < 500 && status !== 429) {
          console.warn("MetaMap rejected a verification permanently", {
            correlationId: job.correlationId,
            status,
          });

          await upsertVerification(env, {
            personalNumber: job.personalNumber,
            institutionId: job.institutionId,
            status: status === 422 ? "invalid_input" : "unavailable",
            errorCode: `http_${status}`,
            errorMessage:
              error instanceof MetaMapError ? (error.body ?? error.message) : String(error),
            ttlDays: 1,
          }).catch((e) => console.error("Failed to record verification failure", e));

          await completeVerificationJob(
            env,
            job.correlationId,
            "failed",
            `MetaMap returned ${status}`,
          ).catch((e) => console.error("Failed to close verification job", e));

          message.ack();
          continue;
        }

        console.error("Verification dispatch failed; retrying", {
          correlationId: job.correlationId,
          error,
        });
        message.retry();
      }
    }
  },
};
