import type { ReactNode } from "react";

export function Pill({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

export function Notice({
  kind,
  children,
}: {
  kind: "error" | "warn" | "ok" | "info";
  children: ReactNode;
}) {
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  kind,
}: {
  label: string;
  value: string | number;
  kind?: string;
}) {
  return (
    <div className={`stat ${kind ?? ""}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function prettyDisposition(disposition: string): string {
  return (
    {
      clean: "Clean",
      auto_corrected: "Auto-corrected",
      needs_review: "Needs review",
      conflict: "Conflict",
      rejected: "Rejected",
    }[disposition] ?? disposition
  );
}

/**
 * The colour legend, shown wherever dispositions appear. It repeats the wording
 * used in the exported workbook so a bank reads one explanation, not two.
 */
export function Legend() {
  const entries: Array<[string, string]> = [
    ["clean", "Verified and unchanged. Nothing to do."],
    [
      "auto_corrected",
      "The engine applied a deterministic correction — reformatting, re-ordering a name, or adopting the card's reading of a transposed date.",
    ],
    ["needs_review", "A person must decide. Usually a name variant or a value outside the permitted list."],
    ["conflict", "The bank record and the Ghana Card disagree on something material."],
    ["rejected", "Cannot be submitted as it stands. A required value is absent or unusable."],
  ];

  return (
    <details>
      <summary>What the colours mean</summary>
      <table style={{ marginTop: "0.5rem" }}>
        <tbody>
          {entries.map(([kind, meaning]) => (
            <tr key={kind}>
              <td style={{ width: "10rem" }}>
                <Pill kind={kind}>{prettyDisposition(kind)}</Pill>
              </td>
              <td className="small">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
