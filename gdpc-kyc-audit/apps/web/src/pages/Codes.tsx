import { useEffect, useState } from "react";
import { api, type CodeSpec } from "../api.js";
import { Card, Notice, Pill, prettyDisposition } from "../components.js";

/**
 * The exception catalogue.
 *
 * Served from the same source the engine and the exported workbook use, so a
 * bank, an auditor and the regulator are all reading one definition of each
 * code rather than three copies that drift.
 */
export function Codes() {
  const [codes, setCodes] = useState<CodeSpec[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setCodes((await api.codes()).codes);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the catalogue.");
      }
    })();
  }, []);

  const filtered = codes.filter((c) =>
    query
      ? `${c.code} ${c.title} ${c.guidance} ${c.category}`.toLowerCase().includes(query.toLowerCase())
      : true,
  );

  const byCategory = new Map<string, CodeSpec[]>();
  for (const code of filtered) {
    const list = byCategory.get(code.category) ?? [];
    list.push(code);
    byCategory.set(code.category, list);
  }

  return (
    <>
      <h1>Exception catalogue</h1>
      <p className="muted small">
        Every exception the platform can raise, what it means, and what to do about it.
      </p>

      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="card">
        <input
          placeholder="Search codes, meanings and guidance…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {[...byCategory.entries()].map(([category, list]) => (
        <Card key={category} title={prettyCategory(category)}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Severity</th>
                  <th>Disposition</th>
                  <th>Meaning</th>
                  <th>What to do</th>
                </tr>
              </thead>
              <tbody>
                {list.map((code) => (
                  <tr key={code.code}>
                    <td className="mono">{code.code}</td>
                    <td><Pill kind={code.severity}>{code.severity}</Pill></td>
                    <td><Pill kind={code.disposition}>{prettyDisposition(code.disposition)}</Pill></td>
                    <td>{code.title}</td>
                    <td className="small muted">{code.guidance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </>
  );
}

function prettyCategory(category: string): string {
  return (
    {
      identity: "Identity",
      name: "Name",
      dob: "Date of birth",
      contact: "Contact",
      account: "Account",
      structural: "Structural",
      cross_record: "Cross-record",
    }[category] ?? category
  );
}
