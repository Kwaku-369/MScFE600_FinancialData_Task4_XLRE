import { useEffect, useState } from "react";
import { api, type Batch, type Stats } from "../api.js";
import { Card, Legend, Notice, Pill, Stat, prettyDisposition } from "../components.js";

export function Dashboard({ onOpenBatch }: { onOpenBatch: (id: string) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [statsResult, batchResult] = await Promise.all([api.stats(), api.batches()]);
        setStats(statsResult);
        setBatches(batchResult.batches);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the dashboard.");
      }
    })();
  }, []);

  return (
    <>
      <h1>Submissions</h1>
      {error ? <Notice kind="error">{error}</Notice> : null}

      {stats ? (
        <div className="grid cols-4" style={{ marginBottom: "1rem" }}>
          <Stat label="Submissions" value={stats.batches.total} />
          <Stat label="Audited" value={stats.batches.audited} />
          <Stat label="Depositor rows processed" value={stats.batches.rows ?? 0} />
          <Stat
            label="Open critical exceptions"
            value={stats.openFindingsBySeverity.critical ?? 0}
            kind={stats.openFindingsBySeverity.critical ? "rejected" : "clean"}
          />
        </div>
      ) : null}

      <Card title="Recent submissions">
        <Legend />
        {batches.length === 0 ? (
          <p className="muted">
            No submissions yet. Upload a customer extract to align it with the GDPC template.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>File</th>
                  <th>Rows</th>
                  <th>Status</th>
                  <th>Ready</th>
                  <th>Outstanding</th>
                  <th>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const s = batch.summary;
                  const outstanding = s
                    ? s.needsReviewRecords + s.conflictRecords + s.rejectedRecords
                    : null;
                  return (
                    <tr
                      key={batch.id}
                      onClick={() => onOpenBatch(batch.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <td><strong>{batch.reference}</strong></td>
                      <td className="small muted">{batch.source_filename}</td>
                      <td>{batch.row_count}</td>
                      <td>
                        <Pill kind={statusKind(batch.status)}>{batch.status}</Pill>
                      </td>
                      <td>{s ? `${(s.submissionReadiness * 100).toFixed(0)}%` : "—"}</td>
                      <td>
                        {outstanding === null ? (
                          "—"
                        ) : outstanding === 0 ? (
                          <Pill kind="clean">none</Pill>
                        ) : (
                          <Pill kind="needs_review">{outstanding} rows</Pill>
                        )}
                      </td>
                      <td className="small muted">
                        {new Date(batch.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {stats && stats.topExceptionCodes.length > 0 ? (
        <Card title="Most frequent exceptions">
          <p className="muted small">
            The codes driving the most work. A code dominating this list usually points at one
            fixable habit in the branch's capture process rather than at the depositors.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Code</th><th>Occurrences</th></tr>
              </thead>
              <tbody>
                {stats.topExceptionCodes.map((row) => (
                  <tr key={row.code}>
                    <td className="mono">{row.code}</td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

function statusKind(status: string): string {
  switch (status) {
    case "audited": return "clean";
    case "failed": return "rejected";
    case "verifying": return "auto_corrected";
    default: return "missing";
  }
}

export { prettyDisposition };
