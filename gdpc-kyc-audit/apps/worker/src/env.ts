export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;

  /**
   * Optional. Cloudflare Queues requires the Workers Paid plan, so the binding
   * is commented out in wrangler.toml by default and the pipeline falls back to
   * dispatching NIA lookups inline. The queue adds retry, backpressure and
   * durability — valuable at volume, not required for correctness.
   */
  VERIFY_QUEUE?: Queue<VerifyJobMessage>;

  ENVIRONMENT: string;
  METAMAP_BASE_URL: string;
  PUBLIC_BASE_URL: string;
  DIRECT_PUBLISH_MAX_DISPOSITION: string;
  ANTHROPIC_MODEL: string;

  // Secrets
  METAMAP_CLIENT_ID?: string;
  METAMAP_CLIENT_SECRET?: string;
  METAMAP_WEBHOOK_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  SESSION_SECRET?: string;
}

export interface VerifyJobMessage {
  batchId: string;
  recordId: string;
  institutionId: string;
  personalNumber: string;
  correlationId: string;
}

export type Role =
  | "platform_admin"
  | "auditor"
  | "bank_admin"
  | "bank_officer"
  | "read_only";

export interface Principal {
  id: string;
  kind: "user" | "api_key";
  institutionId: string | null;
  role: Role;
  name: string;
}

export interface AppContext {
  Bindings: Env;
  Variables: {
    principal: Principal;
    requestId: string;
  };
}
