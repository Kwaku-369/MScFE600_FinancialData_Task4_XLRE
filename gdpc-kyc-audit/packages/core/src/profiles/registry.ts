import type { TableSpec, TemplateProfile } from "../types.js";
import { GDPC_SCV_V1 } from "./gdpc-scv-v1.js";

/**
 * Every template the platform knows how to produce.
 *
 * Adding a new regulator template — or a corrected GDPC one — means adding a
 * profile here. No engine code changes, because mapping, normalisation, audit
 * and export all read the profile.
 */
export const PROFILES: TemplateProfile[] = [GDPC_SCV_V1];

export function getProfile(id: string, version?: string): TemplateProfile {
  const matches = PROFILES.filter((p) => p.id === id);
  if (matches.length === 0) throw new Error(`Unknown template profile '${id}'.`);
  if (!version) return matches[matches.length - 1]!;
  const exact = matches.find((p) => p.version === version);
  if (!exact) throw new Error(`Profile '${id}' has no version '${version}'.`);
  return exact;
}

export function getTable(profile: TemplateProfile, tableId: string): TableSpec {
  const table = profile.tables.find((t) => t.id === tableId);
  if (!table) throw new Error(`Profile '${profile.id}' has no table '${tableId}'.`);
  return table;
}
