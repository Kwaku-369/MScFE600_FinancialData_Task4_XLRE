/** Thin API client. The session travels in an HttpOnly cookie. */

export interface Principal {
  id: string;
  kind: "user" | "api_key";
  institutionId: string | null;
  role: string;
  name: string;
}

export interface ColumnMapping {
  fieldId: string;
  sourceHeader: string | null;
  confidence: number;
  method: string;
  rationale?: string;
}

export interface MappingPlan {
  profileId: string;
  tableId: string;
  sheetName: string;
  mappings: ColumnMapping[];
  unusedHeaders: string[];
  requiresNameSplit: boolean;
  combinedNameHeader: string | null;
  missingRequired: string[];
  needsConfirmation: ColumnMapping[];
}

export interface AuditSummary {
  totalRecords: number;
  cleanRecords: number;
  autoCorrectedRecords: number;
  needsReviewRecords: number;
  rejectedRecords: number;
  conflictRecords: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byCode: Record<string, number>;
  submissionReadiness: number;
}

export interface Batch {
  id: string;
  reference: string;
  reporting_date: string | null;
  status: string;
  submission_mode: string;
  source_filename: string | null;
  row_count: number;
  created_at: string;
  error: string | null;
  summary: AuditSummary | null;
  mapping?: MappingPlan | null;
  aligned_key: string | null;
  report_key: string | null;
}

export interface Finding {
  id: string;
  batch_id: string;
  row_number: number;
  code: string;
  category: string;
  severity: string;
  disposition: string;
  field_id: string | null;
  message: string;
  observed: string | null;
  expected: string | null;
  proposed_value: string | null;
  confidence: number | null;
  resolution: string;
  resolution_note: string | null;
  evidence: Record<string, unknown> | null;
}

export interface CodeSpec {
  code: string;
  category: string;
  severity: string;
  disposition: string;
  title: string;
  guidance: string;
}

export interface Stats {
  batches: { total: number; audited: number; rows: number };
  openFindingsBySeverity: Record<string, number>;
  topExceptionCodes: Array<{ code: string; count: number }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      requestId?: string;
    };
    throw new ApiError(
      response.status,
      body.message ?? `Request failed with ${response.status}.`,
      body.error,
      body.requestId,
    );
  }

  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<{ principal: Principal }>("/auth/me"),

  login: (email: string, password: string) =>
    request<{ user: Principal }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  bootstrap: (name: string, email: string, password: string) =>
    request<{ id: string }>("/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    }),

  stats: () => request<Stats>("/admin/stats"),

  codes: () => request<{ codes: CodeSpec[] }>("/findings/codes"),

  batches: () => request<{ batches: Batch[] }>("/batches"),

  batch: (id: string) => request<{ batch: Batch }>(`/batches/${id}`),

  upload: (form: FormData) =>
    request<{
      batchId: string;
      reference: string;
      status: string;
      error: string | null;
      mapping: MappingPlan | null;
      nextStep: string;
    }>("/batches", { method: "POST", body: form }),

  run: (id: string, mapping?: MappingPlan) =>
    request<{
      status: string;
      summary?: AuditSummary;
      lookupsQueued?: number;
      cachedVerifications?: number;
      published?: number;
      quarantined?: number;
      note?: string;
      verification?: string;
    }>(`/batches/${id}/run`, {
      method: "POST",
      body: JSON.stringify(mapping ? { mapping } : {}),
    }),

  finalise: (id: string) =>
    request<{
      status: string;
      summary: AuditSummary;
      verified: number;
      unverified: number;
      published: number;
      quarantined: number;
    }>(`/batches/${id}/finalise`, { method: "POST" }),

  suggestMapping: (id: string) =>
    request<{
      mappings: Array<{ source_header: string; field_id: string; confidence: number; reason: string }>;
      unmappable: Array<{ source_header: string; reason: string }>;
      model?: string;
    }>(`/batches/${id}/mapping/suggest`, { method: "POST" }),

  findings: (params: Record<string, string>) => {
    const query = new URLSearchParams(params).toString();
    return request<{ findings: Finding[] }>(`/findings?${query}`);
  },

  resolveFinding: (id: string, resolution: string, note?: string) =>
    request<{ ok: boolean }>(`/findings/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution, note }),
    }),

  adjudicate: (id: string) =>
    request<{
      findingId: string;
      adjudication: {
        recommendation: string;
        confidence: number;
        rationale: string;
        proposed_surname?: string;
        proposed_first_name?: string;
        proposed_other_names?: string;
        what_to_check?: string;
      };
      model: string;
    }>(`/findings/${id}/adjudicate`, { method: "POST" }),

  downloadUrl: (batchId: string, kind: "aligned" | "report" | "source") =>
    `/api/batches/${batchId}/download/${kind}`,
};
