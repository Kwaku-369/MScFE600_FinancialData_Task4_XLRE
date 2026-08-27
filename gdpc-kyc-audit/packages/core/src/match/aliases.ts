/**
 * Ghanaian name equivalence tables.
 *
 * These are the reason a generic string-similarity library is not good enough
 * for this problem. A depositor registered at the bank as `Kojo Mensah` and on
 * the Ghana Card as `Kwadwo Mensah` is the same person: Kojo is the spoken form
 * of the Akan Monday-born name Kwadwo. A naive matcher scores that pair near
 * zero and raises a false "different person" exception; an auditor then has to
 * clear thousands of them by hand.
 *
 * Two tables, deliberately separated:
 *
 *   EQUIVALENTS — different renderings of the *same* name (day names, Arabic
 *   transliterations, accepted spelling variants). Treated as a full match.
 *
 *   DIMINUTIVES — a short or familiar form used at the branch where the card
 *   carries the formal name. Strong evidence of the same person, but not proof,
 *   so these score below an exact match and stay reviewable.
 */

/** Akan day names — the largest single source of legitimate variation. */
const AKAN_DAY_NAMES: string[][] = [
  // Monday
  ["KWADWO", "KOJO", "KUDJOE", "KUDJO", "KOOJO", "KWADJO"],
  ["ADWOA", "ADJOA", "ADWOWA", "AJOA", "ADJUA"],
  // Tuesday
  ["KWABENA", "KOBINA", "KOBENA", "KWABINA", "EBO"],
  ["ABENA", "ARABA", "ABENAA"],
  // Wednesday
  ["KWAKU", "KWEKU", "KUUKU", "KWEKUU", "ABEIKU"],
  ["AKUA", "EKUA", "AKUAA", "KUUKUA"],
  // Thursday
  ["YAW", "YAO", "EKOW", "KOW", "YAWO"],
  ["YAA", "ABA", "AABA", "YAAWA"],
  // Friday
  ["KOFI", "FIIFI", "FIFI", "KOFFI", "YOOFI"],
  ["AFUA", "AFIA", "EFUA", "EFIA"],
  // Saturday
  ["KWAME", "KWAMENA", "KWAMI", "KWAMINA", "ATO"],
  ["AMA", "AMMA", "AMBA"],
  // Sunday
  ["KWASI", "KWESI", "KOSI", "KWASHIE", "AKWASI"],
  ["AKOSUA", "AKOSSUA", "ESI", "AKOSIWA"],
];

/**
 * Muslim given names, heavily represented in the northern regions and among
 * Zongo communities. Transliteration from Arabic is not standardised, so the
 * bank and the NIA routinely hold different spellings of the same name.
 */
const MUSLIM_NAMES: string[][] = [
  ["MOHAMMED", "MUHAMMAD", "MOHAMED", "MUHAMMED", "MAHAMA", "MAHAMADU", "MOHAMMAD", "MUHAMED"],
  ["ABDUL", "ABDULAI", "ABDULLAH", "ABDALLAH", "ABDULLAHI", "ABDULAHI"],
  ["ABDULRAHMAN", "ABDURRAHMAN", "ABDUL RAHMAN"],
  ["IBRAHIM", "IBRAHEEM", "BRAIMAH", "BRIMAH", "IBRAHIMA"],
  ["ISSAH", "ISAH", "ISA", "ISSA", "ISSAHAKU", "ISHAQ"],
  ["YUSSIF", "YUSUF", "YUSSUF", "YUSIF", "YOUSEF"],
  ["FUSEINI", "FUSHEINI", "HUSSEINI", "HUSSEIN", "HUSEIN"],
  ["ALHASSAN", "AL HASSAN", "HASSAN", "HASSANU"],
  ["AMINU", "AMIN", "AMINA", "AMINATA", "AMINAH"],
  ["SEIDU", "SAEED", "SAIDU", "SAID", "SAYEED"],
  ["ZAKARIA", "ZAKARIAH", "ZAKARIYA", "ZACHARIAH"],
  ["RASHID", "RASHEED", "RASHIDA", "RASHEEDA"],
  ["SULEMANA", "SULEIMAN", "SULEMAN", "SALIFU", "SALIF"],
  ["OSMAN", "USMAN", "UTHMAN"],
];

/** Ghanaian family and given names with more than one accepted spelling. */
const SPELLING_VARIANTS: string[][] = [
  ["MENSAH", "MENSA"],
  ["OWUSU", "OWUSUH"],
  ["ASANTE", "ASANTEH"],
  ["OSEI", "OSEY"],
  ["APPIAH", "APIAH"],
  ["AGYEMANG", "AGYEMAN", "AGYEIMANG"],
  ["ADJEI", "ADZEI", "ADJAI"],
  ["ANNAN", "ANAN"],
  ["QUARSHIE", "QUARSHI", "KWARSHIE"],
  ["TETTEH", "TETEH", "TETTE"],
  ["NKRUMAH", "NKRUMA"],
  ["FRIMPONG", "FREMPONG"],
  ["OPPONG", "OPONG"],
  ["BAAH", "BAH"],
  ["AMPONSAH", "AMPONSA"],
  ["ACHEAMPONG", "ACHIAMPONG"],
  ["DUFFOUR", "DUFOUR", "DUFFUOR"],
  ["NYARKO", "NYAKO"],
  ["ADDO", "ADO"],
  ["ANKRAH", "ANKRA"],
  ["LARYEA", "LARYEAH"],
  ["QUAYE", "QUAYEE"],
  ["ANSAH", "ANSA"],
  ["BADU", "BADOO"],
  ["DONKOR", "DONKO"],
  ["YEBOAH", "YEBOA"],
  ["ASIEDU", "ASIADU"],
  ["OFORI", "OFFORI"],
  ["SACKEY", "SAKI"],
  ["ODOI", "ODOY"],
  ["NARTEY", "NATEY"],
];

/**
 * Familiar/short forms. Same person in all likelihood, but the card should
 * carry the formal name, so a match here is reported as an alignment issue
 * rather than silently accepted.
 */
const DIMINUTIVES: string[][] = [
  ["EMMANUEL", "MANU"],
  ["ELIZABETH", "LIZZY", "BETTY"],
  ["FRANCIS", "FRANK"],
  ["MARGARET", "MAGGIE", "MAGGY"],
  ["THEOPHILUS", "THEO"],
  ["MICHAEL", "MIKE"],
  ["JOSEPH", "JOE"],
  ["SAMUEL", "SAM"],
  ["DANIEL", "DAN"],
  ["BENJAMIN", "BEN"],
  ["CHRISTOPHER", "CHRIS"],
  ["PATRICIA", "PAT", "PATTY"],
  ["VICTORIA", "VICKY"],
  ["REBECCA", "BECKY"],
  ["AUGUSTINE", "AUGUST", "GUSTAV"],
  ["GIFTY", "GIFT"],
  ["ERNESTINA", "TINA"],
  ["JOSEPHINE", "JOSIE"],
  ["FREDERICK", "FRED"],
  ["ALEXANDER", "ALEX"],
];

const EQUIVALENT_GROUPS: string[][] = [
  ...AKAN_DAY_NAMES,
  ...MUSLIM_NAMES,
  ...SPELLING_VARIANTS,
];

function indexGroups(groups: string[][]): Map<string, number> {
  const map = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const member of group) map.set(member.toUpperCase(), index);
  });
  return map;
}

const EQUIVALENT_BY_TOKEN = indexGroups(EQUIVALENT_GROUPS);
const DIMINUTIVE_BY_TOKEN = indexGroups(DIMINUTIVES);

/** Two renderings of the same name — treated as a full match. */
export function areEquivalent(a: string, b: string): boolean {
  if (a === b) return false; // exact equality is the caller's concern
  const ga = EQUIVALENT_BY_TOKEN.get(a.toUpperCase());
  const gb = EQUIVALENT_BY_TOKEN.get(b.toUpperCase());
  return ga !== undefined && ga === gb;
}

/** A familiar form of the same formal name — strong but not conclusive. */
export function areDiminutives(a: string, b: string): boolean {
  if (a === b) return false;
  const ga = DIMINUTIVE_BY_TOKEN.get(a.toUpperCase());
  const gb = DIMINUTIVE_BY_TOKEN.get(b.toUpperCase());
  return ga !== undefined && ga === gb;
}

/** All known equivalents of a token, for explaining a match to an auditor. */
export function equivalentsOf(token: string): string[] {
  const g = EQUIVALENT_BY_TOKEN.get(token.toUpperCase());
  if (g === undefined) return [];
  return (EQUIVALENT_GROUPS[g] ?? []).filter((t) => t !== token.toUpperCase());
}

export const ALIAS_STATS = {
  equivalentGroups: EQUIVALENT_GROUPS.length,
  equivalentTokens: EQUIVALENT_BY_TOKEN.size,
  diminutiveGroups: DIMINUTIVES.length,
};
