import { useCallback, useEffect, useState } from "react";
import { api, type Batch, type Finding } from "../api.js";
import { Card, Legend, Notice, Pill, Stat, prettyDisposition } from "../components.js";

export function BatchDetail({ batchId, onBack }: { batchId: string; onBack: () => void }) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState({ severity: "", category: "", resolution: "open" });
  const [adjudications, setAdjudications] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [{ batch: loaded }, { findings: loadedFindings }] = await Promise.all([
        api.batch(batchId),
        api.findings({
          batchId,
          ...(filter.severity ? { severity: filter.severity } : {}),
          ...(filter.category ? { category: filter.category } : {}),
          ...(filter.resolution ? { resolution: filter.resolution } : {}),
          limit: "300",
        }),
      ]);
      setBatch(loaded);
      setFindings(loadedFindings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the batch.");
    }
  }, [batchId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // While verification is in flight the batch finalises itself, so poll until
  // it settles rather than making the operator refresh.
  useEffect(() => {
    if (batch?.status !== "verifying") return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [batch?.status, load]);

  async function finalise() {
    setBusy(true);
    try {
      await api.finalise(batchId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Finalisation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(finding: Finding, resolution: string) {
    try {
      await api.resolveFinding(finding.id, resolution);
      setFindings((current) => current.filter((f) => f.id !== finding.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the decision.");
    }
  }

  async function adjudicate(finding: Finding) {
    setAdjudications((a) => ({ ...a, [finding.id]: "Thinking…" }));
    try {
      const result = await api.adjudicate(finding.id);
      const a = result.adjudication;
      setAdjudications((current) => ({
        ...current,
        [finding.id]: `${a.recommendation} (${(a.confidence * 100).toFixed(0)}% confident) — ${a.rationale}${
          a.what_to_check ? ` Check: ${a.what_to_check}` : ""
        }`,
      }));
    } catch (err) {
      setAdjudications((current) => ({
        ...current,
        [finding.id]: err instanceof Error ? err.message : "The agent is unavailable.",
      }));
    }
  }

  if (!batch) {
    return (
      <>
        <button className="ghost" onClick={onBack}>← Back</button>
        {error ? <Notice kind="error">{error}</Notice> : <p>Loading…</p>}
      </>
    );
  }

  const summary = batch.summary;

  return (
    <>
      <button className="ghost" onClick={onBack}>← All submissions</button>
      <h1>{batch.reference}</h1>
      <p className="muted small">
        {batch.source_filename} · {batch.row_count} rows · {batch.submission_mode} mode ·{" "}
        {new Date(batch.created_at).toLocaleString()}
      </p>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {batch.error ? <Notice kind="error">{batch.error}</Notice> : null}

      {batch.status === "verifying" ? (
        <Notice kind="info">
          Identity verification is running against the National Identification Authority. This page
          refreshes itself; the audit completes automatically when the last lookup returns. If a
          lookup is stuck you can finalise now — those records will be reported as unverified.
        </Notice>
      ) : null}

      {summary ? (
        <>
          <div className="grid cols-4" style={{ marginBottom: "1rem" }}>
            <Stat label="Clean" value={summary.cleanRecords} kind="clean" />
            <Stat label="Auto-corrected" value={summary.autoCorrectedRecords} kind="auto_corrected" />
            <Stat label="Needs review" value={summary.needsReviewRecords} kind="needs_review" />
            <Stat label="Conflict" value={summary.conflictRecords} kind="conflict" />
            <Stat label="Rejected" value={summary.rejectedRecords} kind="rejected" />
          </div>

          <Card title="Submission readiness">
            <div className="row">
              <strong style={{ fontSize: "1.5rem" }}>
                {(summary.submissionReadiness * 100).toFixed(1)}%
              </strong>
              <span className="muted small">
                of records need no human intervention before upload to the GDPC portal.
              </span>
            </div>
            <div className="readiness">
              <div style={{ width: `${summary.submissionReadiness * 100}%` }} />
            </div>
            <Legend />
          </Card>
        </>
      ) : null}

      <Card title="Files">
        <div className="row">
          <a className="secondary" href={api.downloadUrl(batchId, "aligned")} style={buttonLink}>
            Download the aligned submission
          </a>
          <a className="secondary" href={api.downloadUrl(batchId, "report")} style={buttonLink}>
            Download the audit report
          </a>
          <a className="ghost" href={api.downloadUrl(batchId, "source")} style={buttonLink}>
            Original upload
          </a>
          {batch.status !== "audited" ? (
            <button className="primary" onClick={finalise} disabled={busy}>
              {busy ? "Working…" : "Finalise now"}
            </button>
          ) : null}
        </div>
      </Card>

      <Card title={`Exceptions (${findings.length})`}>
        <div className="row" style={{ marginBottom: "0.75rem" }}>
          <select
            value={filter.severity}
            onChange={(e) => setFilter({ ...filter, severity: e.target.value })}
            style={{ width: "auto" }}
          >
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
            <option value="info">Informational</option>
          </select>

          <select
            value={filter.category}
            onChange={(e) => setFilter({ ...filter, category: e.target.value })}
            style={{ width: "auto" }}
          >
            <option value="">All categories</option>
            <option value="identity">Identity</option>
            <option value="name">Name</option>
            <option value="dob">Date of birth</option>
            <option value="contact">Contact</option>
            <option value="account">Account</option>
            <option value="structural">Structural</option>
            <option value="cross_record">Cross-record</option>
          </select>

          <select
            value={filter.resolution}
            onChange={(e) => setFilter({ ...filter, resolution: e.target.value })}
            style={{ width: "auto" }}
          >
            <option value="open">Open</option>
            <option value="">Any status</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="corrected">Corrected</option>
            <option value="escalated">Escalated</option>
          </select>
        </div>

        {findings.length === 0 ? (
          <p className="muted">Nothing matches these filters.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Severity</th>
                  <th>Disposition</th>
                  <th>Exception</th>
                  <th>Bank value</th>
                  <th>Ghana Card</th>
                  <th>Decide</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr key={finding.id}>
                    <td>{finding.row_number}</td>
                    <td><Pill kind={finding.severity}>{finding.severity}</Pill></td>
                    <td><Pill kind={finding.disposition}>{prettyDisposition(finding.disposition)}</Pill></td>
                    <td>
                      <div className="mono small">{finding.code}</div>
                      <div>{finding.message}</div>
                      {adjudications[finding.id] ? (
                        <div className="evidence">Agent: {adjudications[finding.id]}</div>
                      ) : null}
                    </td>
                    <td className="mono">{finding.observed ?? "—"}</td>
                    <td className="mono">{finding.expected ?? "—"}</td>
                    <td>
                      <div className="row" style={{ gap: "0.25rem" }}>
                        <button className="ghost" onClick={() => resolve(finding, "accepted")}>
                          Accept
                        </button>
                        <button className="ghost" onClick={() => resolve(finding, "rejected")}>
                          Reject
                        </button>
                        {["name", "identity", "dob"].includes(finding.category) ? (
                          <button className="ghost" onClick={() => adjudicate(finding)}>
                            Ask agent
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

const buttonLink: React.CSSProperties = {
  display: "inline-block",
  padding: "0.45rem 0.9rem",
  borderRadius: "8px",
  border: "1px solid var(--line)",
  background: "var(--surface)",
  color: "var(--ink)",
  textDecoration: "none",
  fontSize: "0.95rem",
};
