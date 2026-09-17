import { describe, expect, it } from "vitest";
import { matchNames, scoreTokens } from "../src/match/name-match.js";
import { parseName } from "../src/normalize/names.js";
import { ghanaPhonetic } from "../src/match/phonetic.js";

describe("parseName", () => {
  it("strips honorifics that carry no identity information", () => {
    const parsed = parseName("Mr. Kwame Mensah");
    expect(parsed.tokens).toEqual(["KWAME", "MENSAH"]);
    expect(parsed.titles).toEqual(["MR"]);
  });

  it("handles the Alhaji and Nana honorifics used across Ghana", () => {
    expect(parseName("Alhaji Mohammed Fuseini").tokens).toEqual(["MOHAMMED", "FUSEINI"]);
    expect(parseName("Nana Akua Serwaa").tokens).toEqual(["AKUA", "SERWAA"]);
  });

  it("reorders the SURNAME, Othernames form", () => {
    const parsed = parseName("MENSAH, Kwame Kofi");
    expect(parsed.commaInverted).toBe(true);
    expect(parsed.tokens).toEqual(["KWAME", "KOFI", "MENSAH"]);
  });

  it("separates initials from full tokens", () => {
    const parsed = parseName("K. A. Mensah");
    expect(parsed.tokens).toEqual(["MENSAH"]);
    expect(parsed.initials).toEqual(["K", "A"]);
  });

  it("glues particles onto the following token", () => {
    expect(parseName("Kojo de Graft").tokens).toEqual(["KOJO", "DEGRAFT"]);
  });

  it("folds accents so the card and the bank agree", () => {
    expect(parseName("Kofi Adjéi").tokens).toEqual(["KOFI", "ADJEI"]);
  });
});

describe("ghanaPhonetic", () => {
  it("collapses the silent trailing H", () => {
    expect(ghanaPhonetic("MENSAH")).toBe(ghanaPhonetic("MENSA"));
    expect(ghanaPhonetic("YEBOAH")).toBe(ghanaPhonetic("YEBOA"));
  });

  it("treats doubled letters as single sounds", () => {
    expect(ghanaPhonetic("TETTEH")).toBe(ghanaPhonetic("TETEH"));
    expect(ghanaPhonetic("AKUAA")).toBe(ghanaPhonetic("AKUA"));
  });

  it("keeps genuinely different names apart", () => {
    expect(ghanaPhonetic("MENSAH")).not.toBe(ghanaPhonetic("OWUSU"));
    expect(ghanaPhonetic("ASANTE")).not.toBe(ghanaPhonetic("BOATENG"));
  });
});

describe("scoreTokens", () => {
  it("recognises Akan day-name equivalents as the same name", () => {
    expect(scoreTokens("KOJO", "KWADWO").reason).toBe("equivalent");
    expect(scoreTokens("KWEKU", "KWAKU").reason).toBe("equivalent");
    expect(scoreTokens("ESI", "AKOSUA").reason).toBe("equivalent");
  });

  it("recognises Arabic transliteration variants", () => {
    expect(scoreTokens("MOHAMMED", "MUHAMMAD").reason).toBe("equivalent");
    expect(scoreTokens("ABDULAI", "ABDUL").reason).toBe("equivalent");
  });

  it("matches an initial against the full name it stands for", () => {
    expect(scoreTokens("K", "KWAME").reason).toBe("initial");
  });

  it("does not equate different names that merely start alike", () => {
    expect(scoreTokens("KOFI", "KOJO").reason).toBe("unmatched");
    expect(scoreTokens("ABA", "ABU").reason).toBe("unmatched");
  });
});

describe("matchNames", () => {
  it("scores an identical name as exact", () => {
    const result = matchNames("Kwame Mensah", "Kwame Mensah");
    expect(result.verdict).toBe("exact");
    expect(result.score).toBe(1);
  });

  it("treats a reordered name as the same person, but reports the ordering", () => {
    const result = matchNames("KWAME MENSAH ADU", "ADU KWAME MENSAH");
    expect(result.verdict).toBe("reordered");
    expect(result.orderDiffers).toBe(true);
    expect(result.score).toBe(1);
    expect(result.missingFromLeft).toEqual([]);
  });

  it("accepts a missing middle name as a capture gap, not a mismatch", () => {
    const result = matchNames("Kwame Mensah", "Kwame Kofi Mensah");
    expect(result.verdict).toBe("subset");
    expect(result.missingFromLeft).toEqual(["KOFI"]);
    expect(result.score).toBeGreaterThan(0.62);
  });

  it("accepts a day-name variant across the two records", () => {
    const result = matchNames("Kojo Mensah", "Kwadwo Mensah");
    expect(result.verdict).toBe("variant");
    expect(result.score).toBeGreaterThan(0.9);
  });

  it("accepts a single-character typo in a long surname", () => {
    const result = matchNames("Kwame Acheampong", "Kwame Achiampong");
    expect(result.verdict).toBe("variant");
    expect(result.score).toBeGreaterThan(0.8);
  });

  it("flags a genuinely different person as a mismatch", () => {
    const result = matchNames("Kwame Mensah", "Yaw Boateng");
    expect(result.verdict).toBe("mismatch");
    expect(result.score).toBeLessThan(0.62);
  });

  it("does not accept a match on the surname alone", () => {
    const result = matchNames("Kwame Mensah", "Abena Mensah");
    expect(result.verdict).toBe("mismatch");
  });

  it("produces an alignment an auditor can read", () => {
    const result = matchNames("Kojo Mensa", "Kwadwo Mensah");
    const pairs = result.alignment.map((a) => [a.left, a.right, a.reason]);
    expect(pairs).toContainEqual(["KOJO", "KWADWO", "equivalent"]);
    expect(result.explanation).toContain("KOJO");
  });

  it("handles the bank holding an initial where the card holds the full name", () => {
    const result = matchNames("K. Mensah", "Kwame Mensah");
    expect(result.verdict).not.toBe("mismatch");
    expect(result.alignment.some((a) => a.reason === "initial")).toBe(true);
  });

  it("reports an empty bank name rather than throwing", () => {
    const result = matchNames("", "Kwame Mensah");
    expect(result.verdict).toBe("mismatch");
    expect(result.explanation).toContain("No usable name");
  });
});
