/**
 * Automatic column mapping from an arbitrary uploaded sheet onto a template.
 *
 * The mapper never guesses silently. Every mapping carries a confidence and the
 * method that produced it, so the review screen can present the uncertain ones
 * for confirmation and let the certain ones through. Anything it cannot resolve
 * is returned as `unmapped` rather than being force-fitted — a wrong mapping is
 * far more damaging than an absent one, because it produces a file that uploads
 * successfully with the wrong data in it.
 */

import type { ColumnMapping, MappingPlan, TableSpec, TemplateProfile } from "../types.js";
import { canonical } from "../normalize/text.js";
import { jaroWinkler } from "../match/similarity.js";
import { COMBINED_NAME_FIELD, HEADER_SYNONYMS } from "./synonyms.js";

/** Confidence at or above which a mapping is applied without asking a human. */
export const AUTO_ACCEPT_CONFIDENCE = 0.9;
/** Confidence below which no mapping is proposed at all. */
export const MIN_PROPOSAL_CONFIDENCE = 0.62;

export interface AutoMapResult extends MappingPlan {
  /** True when a single combined-name column must be split into parts. */
  requiresNameSplit: boolean;
  /** Header holding the combined name, when `requiresNameSplit` is true. */
  combinedNameHeader: string | null;
  /** Required fields with no mapping — the file cannot be submitted without these. */
  missingRequired: string[];
  /** Mappings a human should confirm before the run proceeds. */
  needsConfirmation: ColumnMapping[];
}

/**
 * Score how well a source header matches a target field.
 * Returns the best method and its confidence.
 */
function scoreHeader(
  sourceHeader: string,
  fieldId: string,
  fieldHeader: string,
): { confidence: number; method: ColumnMapping["method"] } {
  const source = canonical(sourceHeader);
  if (source === "") return { confidence: 0, method: "unmapped" };

  // 1. The template's own header, exactly.
  if (source === canonical(fieldHeader)) return { confidence: 1, method: "exact" };

  const synonyms = HEADER_SYNONYMS[fieldId] ?? [];

  // 2. A known synonym, exactly.
  if (synonyms.includes(source)) return { confidence: 0.97, method: "synonym" };

  // 3. A synonym after dropping filler words the bank added.
  const stripped = source
    .split(" ")
    .filter((w) => !FILLER_WORDS.has(w))
    .join(" ");
  if (stripped !== source && synonyms.includes(stripped)) {
    return { confidence: 0.93, method: "synonym" };
  }

  // 4. Fuzzy against the template header and every synonym.
  const candidates = [canonical(fieldHeader), ...synonyms];
  let best = 0;
  for (const candidate of candidates) {
    const similarity = jaroWinkler(source, candidate);
    if (similarity > best) best = similarity;

    // Containment is strong evidence: `CUSTOMER MOBILE NUMBER` contains
    // `MOBILE NUMBER`. Require the contained side to be substantial so that
    // short tokens like `ID` do not swallow unrelated columns.
    if (candidate.length >= 5 && source.includes(candidate)) {
      best = Math.max(best, 0.9);
    }
  }

  if (best >= MIN_PROPOSAL_CONFIDENCE) {
    return { confidence: round(best * 0.95), method: "fuzzy" };
  }

  return { confidence: 0, method: "unmapped" };
}

const FILLER_WORDS = new Set([
  "THE", "OF", "CUSTOMER", "CLIENT", "DEPOSITOR", "MEMBER", "ACCOUNT",
  "DETAILS", "DETAIL", "INFO", "INFORMATION", "PLEASE", "ENTER", "S",
]);

export function autoMap(
  headers: string[],
  profile: TemplateProfile,
  tableId: string,
): AutoMapResult {
  const table = profile.tables.find((t) => t.id === tableId);
  if (!table) throw new Error(`Unknown table '${tableId}' in profile '${profile.id}'`);

  interface Candidate {
    fieldId: string;
    header: string;
    confidence: number;
    method: ColumnMapping["method"];
  }

  const nameFieldIds = ["depositor.surname", "depositor.first_name", "depositor.other_names"];

  // Identify a combined-name column before anything else competes for it.
  //
  // This ordering matters: `CUSTOMER NAME` is a near-perfect match for the
  // virtual combined-name field, but it also scores a weak fuzzy match against
  // `OTHER_NAMES`. Assigning purely by score lets the weak match win the header
  // and silently drop the depositor's surname and first name, so the strong
  // signal is resolved first and its column withheld from the general pool.
  let combinedNameHeader: string | null = null;
  if (table.fields.some((f) => f.id === "depositor.surname")) {
    let bestCombined = 0;
    for (const header of headers) {
      const { confidence } = scoreHeader(header, COMBINED_NAME_FIELD, "FULL_NAME");
      if (confidence >= AUTO_ACCEPT_CONFIDENCE && confidence > bestCombined) {
        bestCombined = confidence;
        combinedNameHeader = header;
      }
    }

    // Unless a discrete name field claims that same header outright, in which
    // case the sheet really does have separate columns.
    if (combinedNameHeader) {
      const claimedOutright = nameFieldIds.some(
        (id) => scoreHeader(combinedNameHeader!, id, id).confidence >= AUTO_ACCEPT_CONFIDENCE,
      );
      if (claimedOutright) combinedNameHeader = null;
    }
  }

  const candidates: Candidate[] = [];
  for (const field of table.fields) {
    for (const header of headers) {
      if (header === combinedNameHeader) continue;
      const { confidence, method } = scoreHeader(header, field.id, field.header);
      if (confidence > 0) {
        candidates.push({ fieldId: field.id, header, confidence, method });
      }
    }
  }

  // Assign greedily by confidence; each header and each field used at most once.
  candidates.sort((a, b) => b.confidence - a.confidence);
  const takenHeaders = new Set<string>();
  const takenFields = new Set<string>();
  const assigned = new Map<string, Candidate>();

  for (const candidate of candidates) {
    if (takenHeaders.has(candidate.header) || takenFields.has(candidate.fieldId)) continue;
    takenHeaders.add(candidate.header);
    takenFields.add(candidate.fieldId);
    assigned.set(candidate.fieldId, candidate);
  }

  // The split supplies the discrete name fields unless the sheet already has
  // at least two of them from columns of their own.
  const discreteNamesMapped = nameFieldIds.filter(
    (id) => (assigned.get(id)?.confidence ?? 0) >= AUTO_ACCEPT_CONFIDENCE,
  ).length;
  const requiresNameSplit = combinedNameHeader !== null && discreteNamesMapped < 2;

  if (requiresNameSplit && combinedNameHeader) {
    takenHeaders.add(combinedNameHeader);
    // Drop any weak fuzzy claim on a name field; the split is authoritative.
    for (const id of nameFieldIds) {
      if ((assigned.get(id)?.confidence ?? 0) < AUTO_ACCEPT_CONFIDENCE) assigned.delete(id);
    }
  }

  const mappings: ColumnMapping[] = table.fields.map((field) => {
    const candidate = assigned.get(field.id);

    if (!candidate) {
      if (requiresNameSplit && nameFieldIds.includes(field.id)) {
        return {
          fieldId: field.id,
          sourceHeader: combinedNameHeader,
          confidence: 0.8,
          method: "fuzzy",
          rationale: `Derived by splitting the combined name column '${combinedNameHeader}'.`,
        };
      }
      return {
        fieldId: field.id,
        sourceHeader: null,
        confidence: 0,
        method: "unmapped",
        rationale: "No column in the uploaded file corresponds to this field.",
      };
    }

    return {
      fieldId: field.id,
      sourceHeader: candidate.header,
      confidence: candidate.confidence,
      method: candidate.method,
      rationale: describe(candidate.method, candidate.header, field.header),
    };
  });

  const missingRequired = table.fields
    .filter((f) => f.required)
    .filter((f) => {
      const m = mappings.find((x) => x.fieldId === f.id);
      return !m || m.sourceHeader === null;
    })
    .map((f) => f.id);

  const needsConfirmation = mappings.filter(
    (m) => m.sourceHeader !== null && m.confidence < AUTO_ACCEPT_CONFIDENCE,
  );

  return {
    profileId: profile.id,
    tableId: table.id,
    sheetName: table.sheetName,
    mappings,
    unusedHeaders: headers.filter((h) => !takenHeaders.has(h)),
    requiresNameSplit,
    combinedNameHeader: requiresNameSplit ? combinedNameHeader : null,
    missingRequired,
    needsConfirmation,
  };
}

function describe(method: ColumnMapping["method"], source: string, target: string): string {
  switch (method) {
    case "exact":
      return `'${source}' is the template column '${target}'.`;
    case "synonym":
      return `'${source}' is a recognised alternative heading for '${target}'.`;
    case "fuzzy":
      return `'${source}' closely resembles '${target}'; confirm before use.`;
    case "manual":
      return `Mapped to '${target}' by an operator.`;
    case "agent":
      return `Proposed by the mapping agent for '${target}'.`;
    default:
      return "";
  }
}

/**
 * Decide which table of the profile a sheet most likely represents, so a
 * multi-sheet workbook can be routed without asking the operator.
 */
export function detectTable(headers: string[], profile: TemplateProfile): TableSpec | null {
  let best: { table: TableSpec; score: number } | null = null;

  for (const table of profile.tables) {
    const plan = autoMap(headers, profile, table.id);
    const mapped = plan.mappings.filter((m) => m.sourceHeader !== null).length;
    const score = mapped / table.fields.length;
    if (!best || score > best.score) best = { table, score };
  }

  // Below a third of the columns matched, this sheet is probably not a table of
  // this profile at all (a cover sheet, a pivot, a notes tab).
  return best && best.score >= 0.33 ? best.table : null;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Apply an operator's correction to a plan, returning a new plan. */
export function applyManualMapping(
  plan: AutoMapResult,
  fieldId: string,
  sourceHeader: string | null,
): AutoMapResult {
  const mappings = plan.mappings.map((m) =>
    m.fieldId === fieldId
      ? {
          ...m,
          sourceHeader,
          confidence: sourceHeader ? 1 : 0,
          method: (sourceHeader ? "manual" : "unmapped") as ColumnMapping["method"],
          rationale: sourceHeader
            ? `Mapped to '${sourceHeader}' by an operator.`
            : "Cleared by an operator.",
        }
      : m,
  );

  const used = new Set(mappings.map((m) => m.sourceHeader).filter((h): h is string => h !== null));

  return {
    ...plan,
    mappings,
    unusedHeaders: plan.unusedHeaders.filter((h) => !used.has(h)),
    needsConfirmation: mappings.filter(
      (m) => m.sourceHeader !== null && m.confidence < AUTO_ACCEPT_CONFIDENCE,
    ),
  };
}
