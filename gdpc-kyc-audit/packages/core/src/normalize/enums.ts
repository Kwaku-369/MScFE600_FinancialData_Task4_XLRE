/**
 * Canonicalisation of the small controlled vocabularies in the template.
 *
 * Rural-bank cores encode these differently from one another and from the GDPC
 * template — `SAV`, `Savings A/C`, `SB` and `01` all mean the same product.
 * Mapping them here is what turns a file the portal rejects into one it accepts.
 */

import { canonical } from "./text.js";
import { jaroWinkler } from "../match/similarity.js";

export interface EnumResolution {
  value: string | null;
  /** How the value was resolved. */
  method: "exact" | "synonym" | "fuzzy" | "unresolved";
  confidence: number;
}

const GENDER: Record<string, string> = {
  M: "M", MALE: "M", MAN: "M", "1": "M", B: "M", BOY: "M",
  F: "F", FEMALE: "F", WOMAN: "F", "2": "F", G: "F", GIRL: "F",
};

const CUSTOMER_TYPE: Record<string, string> = {
  INDIVIDUAL: "INDIVIDUAL", IND: "INDIVIDUAL", PERSONAL: "INDIVIDUAL",
  PERSON: "INDIVIDUAL", SINGLE: "INDIVIDUAL", RETAIL: "INDIVIDUAL",
  JOINT: "JOINT", "JOINT ACCOUNT": "JOINT", JT: "JOINT",
  "SOLE PROPRIETOR": "SOLE_PROPRIETOR", SOLE: "SOLE_PROPRIETOR",
  "SOLE PROPRIETORSHIP": "SOLE_PROPRIETOR", BUSINESS: "SOLE_PROPRIETOR",
  CORPORATE: "CORPORATE", COMPANY: "CORPORATE", LTD: "CORPORATE",
  LIMITED: "CORPORATE", INSTITUTION: "CORPORATE", ORGANISATION: "CORPORATE",
  GROUP: "GROUP", SUSU: "GROUP", ASSOCIATION: "GROUP", CLUB: "GROUP",
  COOPERATIVE: "GROUP", SOCIETY: "GROUP",
  TRUST: "TRUST", ESTATE: "TRUST",
};

const ACCOUNT_TYPE: Record<string, string> = {
  SAVINGS: "SAVINGS", SAV: "SAVINGS", SB: "SAVINGS", "SAVINGS ACCOUNT": "SAVINGS",
  "SAVINGS AC": "SAVINGS", "SAVING": "SAVINGS", ORDINARY: "SAVINGS",
  CURRENT: "CURRENT", CUR: "CURRENT", CA: "CURRENT", "CURRENT ACCOUNT": "CURRENT",
  CHEQUING: "CURRENT", CHECKING: "CURRENT", DEMAND: "CURRENT",
  "FIXED DEPOSIT": "FIXED_DEPOSIT", FIXED: "FIXED_DEPOSIT", FD: "FIXED_DEPOSIT",
  "TIME DEPOSIT": "FIXED_DEPOSIT", TERM: "FIXED_DEPOSIT",
  "TERM DEPOSIT": "FIXED_DEPOSIT", INVESTMENT: "FIXED_DEPOSIT",
  SUSU: "SUSU", "SUSU ACCOUNT": "SUSU", DAILY: "SUSU", "DAILY SAVINGS": "SUSU",
  CALL: "CALL", "CALL ACCOUNT": "CALL", "CALL DEPOSIT": "CALL",
  SPECIAL: "SPECIAL", OTHER: "SPECIAL", MISC: "SPECIAL",
};

const ACCOUNT_STATUS: Record<string, string> = {
  ACTIVE: "ACTIVE", A: "ACTIVE", OPEN: "ACTIVE", OPERATIVE: "ACTIVE",
  NORMAL: "ACTIVE", LIVE: "ACTIVE", "1": "ACTIVE",
  DORMANT: "DORMANT", D: "DORMANT", DORMANCY: "DORMANT", "2": "DORMANT",
  INACTIVE: "INACTIVE", "NOT ACTIVE": "INACTIVE",
  CLOSED: "CLOSED", C: "CLOSED", TERMINATED: "CLOSED", "0": "CLOSED",
  BLOCKED: "BLOCKED", B: "BLOCKED", FROZEN: "BLOCKED", RESTRICTED: "BLOCKED",
  LIEN: "BLOCKED",
};

const CURRENCY: Record<string, string> = {
  GHS: "GHS", GHC: "GHS", CEDI: "GHS", CEDIS: "GHS", "GH": "GHS",
  "GHANA CEDI": "GHS", "GH CEDI": "GHS", "GHS GHC": "GHS",
  USD: "USD", DOLLAR: "USD", DOLLARS: "USD", "US DOLLAR": "USD", USDOLLAR: "USD",
  GBP: "GBP", POUND: "GBP", POUNDS: "GBP", STERLING: "GBP",
  EUR: "EUR", EURO: "EUR", EUROS: "EUR",
};

const ID_TYPE: Record<string, string> = {
  PASSPORT: "PASSPORT", "PASSPORT ID": "PASSPORT",
  "VOTER ID": "VOTER_ID", VOTERS: "VOTER_ID", "VOTERS ID": "VOTER_ID",
  VOTER: "VOTER_ID", "VOTER CARD": "VOTER_ID",
  "DRIVERS LICENCE": "DRIVERS_LICENCE", "DRIVERS LICENSE": "DRIVERS_LICENCE",
  "DRIVING LICENCE": "DRIVERS_LICENCE", DL: "DRIVERS_LICENCE",
  SSNIT: "SSNIT", "SSNIT CARD": "SSNIT",
  NHIS: "NHIS", "HEALTH INSURANCE": "NHIS",
  NONE: "NONE", NIL: "NONE",
};

const REGION_ALIASES: Record<string, string> = {
  "GREATER ACCRA": "GREATER ACCRA", ACCRA: "GREATER ACCRA", GA: "GREATER ACCRA",
  ASHANTI: "ASHANTI", KUMASI: "ASHANTI", AR: "ASHANTI",
  "BRONG AHAFO": "BONO", BA: "BONO", BONO: "BONO",
  "BONO EAST": "BONO EAST", AHAFO: "AHAFO",
  CENTRAL: "CENTRAL", EASTERN: "EASTERN", WESTERN: "WESTERN",
  "WESTERN NORTH": "WESTERN NORTH", VOLTA: "VOLTA", OTI: "OTI",
  NORTHERN: "NORTHERN", "NORTH EAST": "NORTH EAST", SAVANNAH: "SAVANNAH",
  "UPPER EAST": "UPPER EAST", "UPPER WEST": "UPPER WEST",
  UE: "UPPER EAST", UW: "UPPER WEST",
};

const TABLES: Record<string, Record<string, string>> = {
  "depositor.gender": GENDER,
  "depositor.customer_type": CUSTOMER_TYPE,
  "depositor.other_id_type": ID_TYPE,
  "account.account_type": ACCOUNT_TYPE,
  "account.status": ACCOUNT_STATUS,
  "account.currency": CURRENCY,
  "address.region": REGION_ALIASES,
};

/**
 * Resolve a raw cell to one of the template's permitted values.
 * Falls back to a fuzzy match against the permitted list so that a near-miss is
 * proposed rather than rejected outright — but at a confidence that keeps it in
 * the review queue.
 */
export function resolveEnum(
  fieldId: string,
  raw: unknown,
  permitted: string[] | undefined,
): EnumResolution {
  const key = canonical(raw);
  if (key === "") return { value: null, method: "unresolved", confidence: 0 };

  const allowed = permitted ?? [];

  if (allowed.includes(key)) return { value: key, method: "exact", confidence: 1 };

  const table = TABLES[fieldId];
  if (table) {
    const mapped = table[key];
    if (mapped) {
      return {
        value: mapped,
        method: mapped === key ? "exact" : "synonym",
        confidence: mapped === key ? 1 : 0.95,
      };
    }
  }

  // Underscored template codes compared against a spaced source value.
  const spacedMatch = allowed.find((a) => a.replace(/_/g, " ") === key);
  if (spacedMatch) return { value: spacedMatch, method: "synonym", confidence: 0.95 };

  let best: { value: string; score: number } | null = null;
  for (const candidate of allowed) {
    const score = jaroWinkler(key, candidate.replace(/_/g, " "));
    if (!best || score > best.score) best = { value: candidate, score };
  }

  if (best && best.score >= 0.85) {
    return { value: best.value, method: "fuzzy", confidence: Math.round(best.score * 100) / 100 };
  }

  return { value: null, method: "unresolved", confidence: 0 };
}

/** Booleans as written by branch staff. */
export function resolveBoolean(raw: unknown): boolean | null {
  const key = canonical(raw);
  if (["Y", "YES", "TRUE", "T", "1", "JOINT"].includes(key)) return true;
  if (["N", "NO", "FALSE", "F", "0", "SINGLE", "SOLE"].includes(key)) return false;
  return null;
}
