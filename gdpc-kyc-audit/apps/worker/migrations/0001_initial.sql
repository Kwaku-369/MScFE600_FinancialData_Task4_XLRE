-- Schema for the GDPC KYC alignment and audit platform.
--
-- Two things shape this design:
--
--   1. Everything is per-institution. A rural bank must never be able to read
--      another bank's depositor data, so `institution_id` is on every table
--      that holds customer information and every query filters on it.
--
--   2. Nothing is destroyed. A submission, its mapping, its findings and every
--      resolution decision are all retained, because the whole point of the
--      platform is to be able to show a regulator how a submitted value was
--      arrived at months later.

CREATE TABLE institutions (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- Bank of Ghana / GDPC member institution code.
  member_code     TEXT,
  -- 'rcb' (rural & community bank), 'sdi', 'bank'
  category        TEXT NOT NULL DEFAULT 'rcb',
  -- 'review'  : submissions are held for the operator to work from the back end
  -- 'direct'  : clean records publish automatically, exceptions still quarantine
  submission_mode TEXT NOT NULL DEFAULT 'review',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  institution_id  TEXT REFERENCES institutions(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  -- 'platform_admin' sees every institution; the rest are scoped to their own.
  role            TEXT NOT NULL CHECK (role IN ('platform_admin','auditor','bank_admin','bank_officer','read_only')),
  password_hash   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_institution ON users(institution_id);

-- Machine credentials, so a bank's core system can push a submission without a
-- human. Only the hash is stored; the key itself is shown once at creation.
CREATE TABLE api_keys (
  id              TEXT PRIMARY KEY,
  institution_id  TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  key_prefix      TEXT NOT NULL,
  scopes          TEXT NOT NULL DEFAULT 'submit',
  created_by      TEXT REFERENCES users(id),
  last_used_at    TEXT,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_keys_institution ON api_keys(institution_id);

-- One uploaded file and everything that happened to it.
CREATE TABLE batches (
  id                TEXT PRIMARY KEY,
  institution_id    TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  reference         TEXT NOT NULL,
  reporting_date    TEXT,
  profile_id        TEXT NOT NULL,
  profile_version   TEXT NOT NULL,
  table_id          TEXT NOT NULL,
  submission_mode   TEXT NOT NULL,
  -- received -> mapping -> mapped -> verifying -> audited -> published | failed
  status            TEXT NOT NULL DEFAULT 'received',
  source_filename   TEXT,
  source_key        TEXT,
  source_bytes      INTEGER,
  source_sha256     TEXT,
  row_count         INTEGER DEFAULT 0,
  -- JSON snapshot of the mapping actually used, so a re-run is reproducible.
  mapping_json      TEXT,
  summary_json      TEXT,
  aligned_key       TEXT,
  report_key        TEXT,
  error             TEXT,
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT
);

CREATE INDEX idx_batches_institution ON batches(institution_id, created_at DESC);
CREATE INDEX idx_batches_status ON batches(status);
CREATE UNIQUE INDEX idx_batches_reference ON batches(institution_id, reference);

-- One depositor (or account) row, both as submitted and as aligned.
CREATE TABLE records (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  institution_id    TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  row_number        INTEGER NOT NULL,
  record_key        TEXT NOT NULL,
  customer_id       TEXT,
  ghana_card_pin    TEXT,
  msisdn            TEXT,
  -- The values as received, keyed by source header.
  source_json       TEXT NOT NULL,
  -- The normalised values, keyed by canonical field id.
  aligned_json      TEXT NOT NULL,
  disposition       TEXT NOT NULL DEFAULT 'clean',
  -- Set once the record has been accepted into the institution's live view.
  published_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_records_batch ON records(batch_id);
CREATE INDEX idx_records_pin ON records(institution_id, ghana_card_pin);
CREATE INDEX idx_records_msisdn ON records(institution_id, msisdn);
CREATE INDEX idx_records_disposition ON records(batch_id, disposition);

CREATE TABLE findings (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  record_id       TEXT REFERENCES records(id) ON DELETE CASCADE,
  institution_id  TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  row_number      INTEGER NOT NULL,
  code            TEXT NOT NULL,
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL,
  disposition     TEXT NOT NULL,
  field_id        TEXT,
  message         TEXT NOT NULL,
  observed        TEXT,
  expected        TEXT,
  proposed_value  TEXT,
  confidence      REAL,
  evidence_json   TEXT,
  -- open -> accepted | rejected | corrected | escalated
  resolution      TEXT NOT NULL DEFAULT 'open',
  resolved_by     TEXT REFERENCES users(id),
  resolved_at     TEXT,
  resolution_note TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_findings_batch ON findings(batch_id, severity);
CREATE INDEX idx_findings_open ON findings(institution_id, resolution) WHERE resolution = 'open';
CREATE INDEX idx_findings_code ON findings(batch_id, code);

-- NIA lookups, cached across batches. A Ghana Card record does not change often
-- and each lookup is billable, so re-verifying the same PIN on next month's
-- submission would be pure waste.
CREATE TABLE verifications (
  id                TEXT PRIMARY KEY,
  institution_id    TEXT REFERENCES institutions(id) ON DELETE SET NULL,
  personal_number   TEXT NOT NULL,
  status            TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'metamap',
  first_name        TEXT,
  middle_name       TEXT,
  last_name         TEXT,
  gender            TEXT,
  date_of_birth     TEXT,
  place_of_birth    TEXT,
  nationality       TEXT,
  reg_date          TEXT,
  expiry_date       TEXT,
  raw_json          TEXT,
  error_code        TEXT,
  error_message     TEXT,
  retrieved_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT
);

CREATE UNIQUE INDEX idx_verifications_pin ON verifications(personal_number);

-- In-flight verification requests, correlating the callback back to its record.
CREATE TABLE verification_jobs (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  record_id         TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  personal_number   TEXT NOT NULL,
  -- The opaque token echoed back in the provider's callback metadata.
  correlation_id    TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  requested_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT,
  error             TEXT
);

CREATE INDEX idx_verification_jobs_batch ON verification_jobs(batch_id, status);

-- What each agent proposed, kept separate from the deterministic findings so an
-- auditor can always tell a model's judgement from a rule's.
CREATE TABLE agent_reviews (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  finding_id      TEXT REFERENCES findings(id) ON DELETE CASCADE,
  agent           TEXT NOT NULL,
  model           TEXT NOT NULL,
  recommendation  TEXT NOT NULL,
  confidence      REAL,
  rationale       TEXT,
  input_json      TEXT,
  output_json     TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_reviews_batch ON agent_reviews(batch_id);

-- Append-only. Every state change a regulator might ask about lands here.
CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,
  institution_id  TEXT,
  actor_id        TEXT,
  actor_type      TEXT NOT NULL DEFAULT 'user',
  action          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  detail_json     TEXT,
  ip              TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_log_institution ON audit_log(institution_id, created_at DESC);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
