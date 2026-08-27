import { useState } from "react";
import { api, type MappingPlan } from "../api.js";
import { Card, Notice } from "../components.js";

/**
 * Upload, then confirm the mapping, then run.
 *
 * The mapping step is deliberately not skippable when anything is uncertain. A
 * wrongly mapped column produces a file that uploads to the GDPC portal
 * successfully with the wrong data in it — the one failure mode nobody catches.
 */
export function Upload({ onOpenBatch }: { onOpenBatch: (batchId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState("");
  const [reportingDate, setReportingDate] = useState("");
  const [tableId, setTableId] = useState("A");

  const [batchId, setBatchId] = useState<string | null>(null);
  const [plan, setPlan] = useState<MappingPlan | null>(null);
  const [nextStep, setNextStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);
    setSuggestion(null);

    const form = new FormData();
    form.append("file", file);
    if (reference) form.append("reference", reference);
    if (reportingDate) form.append("reportingDate", reportingDate);
    form.append("tableId", tableId);

    try {
      const result = await api.upload(form);
      setBatchId(result.batchId);
      setPlan(result.mapping);
      setNextStep(result.nextStep);
      if (result.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function remap(fieldId: string, sourceHeader: string) {
    if (!plan) return;
    setPlan({
      ...plan,
      mappings: plan.mappings.map((m) =>
        m.fieldId === fieldId
          ? {
              ...m,
              sourceHeader: sourceHeader || null,
              confidence: sourceHeader ? 1 : 0,
              method: sourceHeader ? "manual" : "unmapped",
              rationale: sourceHeader ? "Chosen by an operator." : undefined,
            }
          : m,
      ),
    });
  }

  async function askAgent() {
    if (!batchId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.suggestMapping(batchId);
      if (result.mappings.length === 0) {
        setSuggestion("The agent could not place any of the remaining columns.");
      } else {
        setPlan((current) =>
          current
            ? {
                ...current,
                mappings: current.mappings.map((m) => {
                  const proposed = result.mappings.find((p) => p.field_id === m.fieldId);
                  return proposed && !m.sourceHeader
                    ? {
                        ...m,
                        sourceHeader: proposed.source_header,
                        confidence: proposed.confidence,
                        method: "agent",
                        rationale: proposed.reason,
                      }
                    : m;
                }),
              }
            : current,
        );
        setSuggestion(
          `The agent proposed ${result.mappings.length} mapping(s). Each is marked "agent" below — confirm them before running.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The mapping agent is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!batchId || !plan) return;
    setBusy(true);
    setError(null);
    try {
      await api.run(batchId, plan);
      onOpenBatch(batchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The run failed to start.");
    } finally {
      setBusy(false);
    }
  }

  const stillMissing = plan
    ? plan.mappings.filter(
        (m) => !m.sourceHeader && plan.missingRequired.includes(m.fieldId),
      )
    : [];

  return (
    <>
      <h1>New submission</h1>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {!plan ? (
        <Card title="Upload the extract">
          <p className="muted small">
            A .xlsx or .csv export from your core banking system. Column headings do not need to
            match the GDPC template — the platform maps them. A title banner above the headings is
            fine; it is detected and skipped.
          </p>
          <form onSubmit={upload}>
            <div className="grid cols-2">
              <label>
                <span>File</span>
                <input
                  type="file"
                  accept=".xlsx,.xlsm,.csv,.tsv,.txt"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  required
                />
              </label>
              <label>
                <span>Submission reference (optional)</span>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Generated if left blank"
                />
              </label>
              <label>
                <span>Reporting date</span>
                <input
                  type="date"
                  value={reportingDate}
                  onChange={(e) => setReportingDate(e.target.value)}
                />
              </label>
              <label>
                <span>Table</span>
                <select value={tableId} onChange={(e) => setTableId(e.target.value)}>
                  <option value="A">A — Depositor details</option>
                  <option value="B">B — Address details</option>
                  <option value="C">C — Account details</option>
                  <option value="D">D — Compensation details</option>
                </select>
              </label>
            </div>
            <button className="primary" type="submit" disabled={busy || !file}>
              {busy ? "Uploading…" : "Upload and check the mapping"}
            </button>
          </form>
        </Card>
      ) : (
        <>
          {nextStep ? <Notice kind="info">{nextStep}</Notice> : null}
          {suggestion ? <Notice kind="warn">{suggestion}</Notice> : null}

          {plan.requiresNameSplit ? (
            <Notice kind="info">
              The file holds one combined name column ({plan.combinedNameHeader}). It will be split
              into surname, first name and other names, assuming the surname is last. The audit
              checks that assumption against each Ghana Card and corrects it where it is wrong.
            </Notice>
          ) : null}

          {stillMissing.length > 0 ? (
            <Notice kind="error">
              {stillMissing.length} required field(s) have no source column. The submission cannot
              be run until they are mapped.
            </Notice>
          ) : null}

          <Card title="Confirm the column mapping">
            <div className="row" style={{ marginBottom: "0.75rem" }}>
              <button className="secondary" onClick={askAgent} disabled={busy || plan.unusedHeaders.length === 0}>
                Ask the mapping agent about unmapped columns
              </button>
              <span className="muted small">
                {plan.unusedHeaders.length} column(s) in the file are unused.
              </span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>GDPC template field</th>
                    <th>Source column</th>
                    <th>How</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.mappings.map((m) => {
                    const required = plan.missingRequired.includes(m.fieldId);
                    const uncertain = m.sourceHeader && m.confidence < 0.9;
                    return (
                      <tr key={m.fieldId}>
                        <td className="mono">{m.fieldId}</td>
                        <td>
                          <select
                            value={m.sourceHeader ?? ""}
                            onChange={(e) => remap(m.fieldId, e.target.value)}
                            style={
                              required
                                ? { borderColor: "var(--rejected-ink)" }
                                : uncertain
                                  ? { borderColor: "var(--review-ink)" }
                                  : undefined
                            }
                          >
                            <option value="">— not mapped —</option>
                            {[
                              ...new Set(
                                [
                                  ...plan.mappings.map((x) => x.sourceHeader),
                                  ...plan.unusedHeaders,
                                  plan.combinedNameHeader,
                                ].filter((h): h is string => Boolean(h)),
                              ),
                            ].map((header) => (
                              <option key={header} value={header}>
                                {header}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="small">
                          {m.sourceHeader ? `${m.method} ${(m.confidence * 100).toFixed(0)}%` : "—"}
                        </td>
                        <td className="small muted">{m.rationale ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="row">
            <button className="primary" onClick={run} disabled={busy || stillMissing.length > 0}>
              {busy ? "Starting…" : "Run alignment and audit"}
            </button>
            <button className="secondary" onClick={() => { setPlan(null); setBatchId(null); }} disabled={busy}>
              Start over
            </button>
          </div>
        </>
      )}
    </>
  );
}
