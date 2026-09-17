/**
 * Core domain types for the GDPC KYC alignment and audit engine.
 *
 * The engine is deliberately free of any Cloudflare / Node runtime dependency so
 * that it can run inside a Worker, in a test harness, or in a batch job.
 */

/** A single cell value as read from a spreadsheet, before any coercion. */
export type RawCell = string | number | boolean | Date | null;

/** One row of an uploaded submission, keyed by the *original* column header. */
export interface RawRow {
  /** 1-based row number in the source sheet, used for every diagnostic. */
  rowNumber: number;
  cells: Record<string, RawCell>;
}

export interface RawSheet {
  name: string;
  headers: string[];
  rows: RawRow[];
  /** Row index (1-based) where the header was detected. */
  headerRowNumber: number;
}

// ---------------------------------------------------------------------------
// Target template (GDPC profile)
// ---------------------------------------------------------------------------

export type FieldKind =
  | "text"
  | "name"
  | "ghana_card"
  | "other_id"
  | "msisdn"
  | "email"
  | "date"
  | "money"
  | "integer"
  | "enum"
  | "boolean";

export interface FieldSpec {
  /** Canonical field id used throughout the engine, e.g. `depositor.ghana_card_pin`. */
  id: string;
  /** Column heading required by the GDPC upload template. */
  header: string;
  kind: FieldKind;
  required: boolean;
  /** Allowed values for `enum` fields (canonical form). */
  enumValues?: string[];
  /** Max length enforced by the receiving system, if any. */
  maxLength?: number;
  /** Human description shown in the mapping UI. */
  description?: string;
  /**
   * Whether a change to this field between the bank record and the authoritative
   * NIA record is materially significant. Name / DOB / ID are; a town name is not.
   */
  materiality: "critical" | "high" | "medium" | "low";
  /**
   * Canonical value -> the code the receiving template expects on output.
   *
   * The engine canonicalises controlled vocabularies on the way in, because a
   * rule that has to know every core system's spelling of "savings account" is
   * unmaintainable. The portal, though, wants its own codes back — `I`, not
   * `INDIVIDUAL`. This is that inverse, and it belongs to the template rather
   * than the engine, so a template revision is still a single-file change.
   *
   * Omitted means the canonical value is itself what the template expects.
   */
  submissionCodes?: Record<string, string>;
}

export interface TableSpec {
  /** e.g. `A`, `B`, `C`, `D` in the standard SCV layout. */
  id: string;
  name: string;
  sheetName: string;
  /** Field id that links this table back to the depositor table. */
  parentKeyField?: string;
  keyField: string;
  fields: FieldSpec[];
}

export interface TemplateProfile {
  id: string;
  version: string;
  label: string;
  /** Where the column list came from, so an auditor can see how authoritative it is. */
  provenance: string;
  tables: TableSpec[];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  /** Canonical target field id. */
  fieldId: string;
  /** Source header as it appeared in the uploaded file, or null when unmapped. */
  sourceHeader: string | null;
  /** 0..1 — how confident the auto-mapper is. 1 for a human-confirmed mapping. */
  confidence: number;
  /** How the mapping was arrived at. */
  method: "exact" | "synonym" | "fuzzy" | "agent" | "manual" | "unmapped";
  /** Free-text rationale, surfaced in the mapping review UI. */
  rationale?: string;
}

export interface MappingPlan {
  profileId: string;
  tableId: string;
  sheetName: string;
  mappings: ColumnMapping[];
  /** Source headers that were not consumed by any mapping. */
  unusedHeaders: string[];
}

// ---------------------------------------------------------------------------
// Normalised records
// ---------------------------------------------------------------------------

export interface NormalizedValue<T = unknown> {
  /** The cleaned, canonical value, or null when absent/unusable. */
  value: T | null;
  /** Exactly what was in the source cell, for the audit trail. */
  raw: RawCell;
  /** True when normalisation changed the value in a way a human should confirm. */
  changed: boolean;
  /** Notes explaining any transformation applied. */
  notes: string[];
  /**
   * The parser's own result object (a `GhanaCardParse`, `MsisdnParse`, ...).
   * Retained so rules can inspect the detailed problems the parser found
   * without re-parsing the cell.
   */
  parse?: unknown;
}

/** A depositor row after mapping + normalisation, keyed by canonical field id. */
export interface NormalizedRecord {
  rowNumber: number;
  /** Stable synthetic key for correlating across tables and verification calls. */
  recordKey: string;
  tableId: string;
  fields: Record<string, NormalizedValue>;
}

// ---------------------------------------------------------------------------
// Identity verification (MetaMap / NIA)
// ---------------------------------------------------------------------------

export interface AuthoritativeIdentity {
  source: "nia" | "manual" | "cache";
  personalNumber: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  placeOfBirth: string | null;
  nationality: string | null;
  regDate: string | null;
  expiryDate: string | null;
  /** ISO timestamp of when this record was retrieved. */
  retrievedAt: string;
}

export type VerificationOutcome =
  | { status: "verified"; identity: AuthoritativeIdentity }
  | { status: "not_found"; reason: string }
  | { status: "invalid_input"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "skipped"; reason: string };

export interface PhoneIntelligence {
  msisdn: string;
  valid: boolean;
  carrier: string | null;
  lineType: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  /**
   * Owner name, when a provider that supports reverse lookup is configured.
   * MetaMap does NOT provide this — see `PhoneIdentityProvider` in the worker.
   */
  ownerName: string | null;
}

// ---------------------------------------------------------------------------
// Audit findings
// ---------------------------------------------------------------------------

export type Severity = "critical" | "major" | "minor" | "info";

export type FindingCategory =
  | "identity"
  | "name"
  | "dob"
  | "contact"
  | "account"
  | "structural"
  | "cross_record";

/**
 * Disposition drives the colour of the cell in the exported workbook and what an
 * auditor is expected to do about it.
 */
export type Disposition =
  | "clean" // nothing wrong
  | "auto_corrected" // engine changed it deterministically and safely
  | "needs_review" // a human (or the adjudication agent) must decide
  | "rejected" // cannot be submitted to GDPC as-is
  | "conflict"; // bank record and authoritative record disagree materially

export interface Finding {
  /** Stable machine code, e.g. `NAME_ORDER_SWAPPED`. */
  code: string;
  category: FindingCategory;
  severity: Severity;
  disposition: Disposition;
  rowNumber: number;
  recordKey: string;
  /** Canonical field the finding attaches to; null for whole-row findings. */
  fieldId: string | null;
  message: string;
  /** Value found in the bank's submission. */
  observed?: unknown;
  /** Value from the authoritative source, when one exists. */
  expected?: unknown;
  /** A deterministic correction the engine can apply if accepted. */
  proposedValue?: unknown;
  /** 0..1 confidence in `proposedValue`. */
  confidence?: number;
  /** Machine-readable extras used by the report and the agents. */
  evidence?: Record<string, unknown>;
}

export interface RecordAudit {
  record: NormalizedRecord;
  verification: VerificationOutcome | null;
  findings: Finding[];
  /** Worst disposition across all findings — drives the row colour. */
  rowDisposition: Disposition;
}

export interface BatchAudit {
  profileId: string;
  tableId: string;
  records: RecordAudit[];
  findings: Finding[];
  summary: AuditSummary;
}

export interface AuditSummary {
  totalRecords: number;
  cleanRecords: number;
  autoCorrectedRecords: number;
  needsReviewRecords: number;
  rejectedRecords: number;
  conflictRecords: number;
  bySeverity: Record<Severity, number>;
  byCode: Record<string, number>;
  byCategory: Record<FindingCategory, number>;
  /** Fraction of records that could be submitted to GDPC without intervention. */
  submissionReadiness: number;
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

export interface RuleContext {
  profile: TemplateProfile;
  table: TableSpec;
  record: NormalizedRecord;
  verification: VerificationOutcome | null;
  phone: PhoneIntelligence | null;
  /** All records in the batch, for duplicate / cross-record rules. */
  batch: NormalizedRecord[];
  /** Indexes built once per batch, keyed by normalised value. */
  indexes: BatchIndexes;
  config: EngineConfig;
}

export interface BatchIndexes {
  byGhanaCard: Map<string, NormalizedRecord[]>;
  byMsisdn: Map<string, NormalizedRecord[]>;
  byAccountNumber: Map<string, NormalizedRecord[]>;
  byNameDob: Map<string, NormalizedRecord[]>;
}

export interface EngineConfig {
  /** Below this name-similarity score a mismatch is treated as a different person. */
  nameMismatchThreshold: number;
  /** At or above this score, a name variant is auto-accepted. */
  nameAutoAcceptThreshold: number;
  /** How many distinct depositors may share one phone number before flagging. */
  sharedPhoneThreshold: number;
  /** Earliest plausible date of birth. */
  minBirthYear: number;
  /** Minimum age for an account holder, in years. */
  minAccountHolderAge: number;
  /** Treat these DOB values as placeholders rather than real dates. */
  placeholderDates: string[];
  /** Reference date used for age calculations; injected so tests are deterministic. */
  today: string;
}

export interface Rule {
  code: string;
  category: FindingCategory;
  /** Runs once per record. Return zero or more findings. */
  evaluate(ctx: RuleContext): Finding[];
}
