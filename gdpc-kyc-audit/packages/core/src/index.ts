/** Public surface of the GDPC KYC alignment and audit engine. */

export * from "./types.js";

// Template profiles
export { GDPC_SCV_V1, COVERAGE_LIMITS } from "./profiles/gdpc-scv-v1.js";
export { PROFILES, getProfile, getTable } from "./profiles/registry.js";

// Ingestion
export { readCsv } from "./ingest/csv.js";
export { readXlsx, listSheetNames } from "./ingest/xlsx-read.js";
export { detectHeaderRow } from "./ingest/detect.js";

// Mapping
export {
  autoMap,
  applyManualMapping,
  detectTable,
  AUTO_ACCEPT_CONFIDENCE,
  MIN_PROPOSAL_CONFIDENCE,
  type AutoMapResult,
} from "./mapping/auto-map.js";
export { HEADER_SYNONYMS, COMBINED_NAME_FIELD } from "./mapping/synonyms.js";

// Normalisation
export { canonical, cleanCell, isNullToken, titleCase } from "./normalize/text.js";
export { parseGhanaCard, sameGhanaCard, ghanaCardKey, type GhanaCardParse } from "./normalize/ghana-card.js";
export { parseMsisdn, msisdnKey, NETWORK_ALLOCATIONS, type MsisdnParse } from "./normalize/msisdn.js";
export { parseDate, ageInYears, isDayMonthTransposition, type DateParse } from "./normalize/dates.js";
export { parseMoney, formatMoney, type MoneyParse } from "./normalize/money.js";
export { resolveEnum, resolveBoolean } from "./normalize/enums.js";
export { parseName, parseNameParts, TITLES, type ParsedName } from "./normalize/names.js";
export { normalizeRows, normalizeField } from "./normalize/record.js";

// Matching
export {
  matchNames,
  matchAgainstCard,
  scoreTokens,
  type NameMatchResult,
  type NameVerdict,
  type TokenAlignment,
} from "./match/name-match.js";
export { jaroWinkler, levenshtein, levenshteinSimilarity } from "./match/similarity.js";
export { ghanaPhonetic, soundsAlike } from "./match/phonetic.js";
export { areEquivalent, areDiminutives, equivalentsOf, ALIAS_STATS } from "./match/aliases.js";

// Audit
export { CODE_SPECS, codeSpec, worstDisposition, SEVERITY_ORDER, DISPOSITION_ORDER } from "./audit/codes.js";
export { ALL_RULES } from "./audit/rules.js";
export {
  runAudit,
  buildIndexes,
  applyAutoCorrections,
  DEFAULT_ENGINE_CONFIG,
  type RunAuditInput,
} from "./audit/engine.js";

// Reporting
export { buildAlignedWorkbook, buildAuditReport } from "./report/workbook.js";
export { writeXlsx, FILL_COLOURS, type SheetData, type StyledCell } from "./report/xlsx-write.js";
