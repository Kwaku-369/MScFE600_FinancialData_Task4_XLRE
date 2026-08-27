import { describe, expect, it } from "vitest";
import { parseGhanaCard, sameGhanaCard } from "../src/normalize/ghana-card.js";
import { parseMsisdn } from "../src/normalize/msisdn.js";
import { ageInYears, isDayMonthTransposition, parseDate } from "../src/normalize/dates.js";
import { canonical, isNullToken } from "../src/normalize/text.js";

describe("text hygiene", () => {
  it("recognises the many ways a branch writes empty", () => {
    for (const token of ["", "  ", "N/A", "nil", "NONE", "xxxxx", "-----", "#N/A", "Unknown"]) {
      expect(isNullToken(token), token).toBe(true);
    }
  });

  it("does not treat a zero balance as empty", () => {
    expect(isNullToken("0")).toBe(false);
  });

  it("does not treat a real name as empty", () => {
    expect(isNullToken("Kwame Mensah")).toBe(false);
  });

  it("canonicalises punctuation and accents", () => {
    expect(canonical("  Kofi   Adjéi-Mensah ")).toBe("KOFI ADJEI MENSAH");
  });
});

describe("parseGhanaCard", () => {
  it("accepts the canonical form unchanged", () => {
    const parsed = parseGhanaCard("GHA-123456780-1");
    expect(parsed.normalized).toBe("GHA-123456780-1");
    expect(parsed.valid).toBe(true);
  });

  it("repairs the spacing and casing variants officers actually type", () => {
    for (const input of [
      "gha 123456780 1",
      "GHA1234567801",
      "  GHA-123456780-1  ",
      "'GHA-123456780-1",
    ]) {
      expect(parseGhanaCard(input).normalized, input).toBe("GHA-123456780-1");
    }
  });

  it("supplies the country code when the export dropped it", () => {
    const parsed = parseGhanaCard("123456780-1");
    expect(parsed.normalized).toBe("GHA-123456780-1");
    expect(parsed.problems).toContain("bad_country_code");
  });

  it("accepts the 8-digit serial form", () => {
    const parsed = parseGhanaCard("GHA-23456780-9");
    expect(parsed.valid).toBe(true);
    expect(parsed.serial).toBe("23456780");
  });

  it("rejects a too-short PIN", () => {
    expect(parseGhanaCard("GHA-1234-5").valid).toBe(false);
    expect(parseGhanaCard("GHA-1234-5").problems).toContain("bad_length");
  });

  it("flags obvious filler serials", () => {
    expect(parseGhanaCard("GHA-000000000-0").problems).toContain("placeholder");
    expect(parseGhanaCard("GHA-000000000-0").valid).toBe(false);
  });

  it("treats an empty cell as empty rather than invalid", () => {
    expect(parseGhanaCard("N/A").problems).toEqual(["empty"]);
  });

  it("matches a zero-padded 8-digit serial to its 9-digit form", () => {
    expect(sameGhanaCard("GHA-12345678-9", "GHA-012345678-9")).toBe(true);
    expect(sameGhanaCard("GHA-123456780-1", "GHA-123456781-1")).toBe(false);
  });
});

describe("parseMsisdn", () => {
  it("normalises the local form to E.164", () => {
    const parsed = parseMsisdn("0244123456");
    expect(parsed.e164).toBe("+233244123456");
    expect(parsed.national).toBe("0244123456");
    expect(parsed.operator).toBe("MTN");
    expect(parsed.valid).toBe(true);
  });

  it("recovers the leading zero Excel silently ate", () => {
    expect(parseMsisdn(244123456).e164).toBe("+233244123456");
  });

  it("handles the +233 (0) form officers type", () => {
    expect(parseMsisdn("+233 (0) 24 412 3456").e164).toBe("+233244123456");
  });

  it("handles the 00233 international prefix", () => {
    expect(parseMsisdn("00233244123456").e164).toBe("+233244123456");
  });

  it("attributes each network correctly", () => {
    expect(parseMsisdn("0201234567").operator).toBe("Telecel");
    expect(parseMsisdn("0271234567").operator).toBe("AT");
    expect(parseMsisdn("0591234567").operator).toBe("MTN");
  });

  it("rejects a number of the wrong length", () => {
    expect(parseMsisdn("024412345").valid).toBe(false);
    expect(parseMsisdn("024412345").problems).toContain("too_short");
    expect(parseMsisdn("02441234567").problems).toContain("too_long");
  });

  it("flags an unallocated network code without discarding the number", () => {
    const parsed = parseMsisdn("0991234567");
    expect(parsed.problems).toContain("unknown_prefix");
    expect(parsed.e164).toBe("+233991234567");
  });

  it("splits two numbers crammed into one cell", () => {
    const parsed = parseMsisdn("0244123456 / 0201234567");
    expect(parsed.e164).toBe("+233244123456");
    expect(parsed.additional).toEqual(["+233201234567"]);
    expect(parsed.problems).toContain("multiple_numbers");
  });

  it("flags a repeated-digit filler number", () => {
    expect(parseMsisdn("0000000000").problems).toContain("repeated_digits");
  });
});

describe("parseDate", () => {
  const today = "2026-08-27";

  it("reads the Ghanaian day-first convention by default", () => {
    expect(parseDate("03/04/1985", { today }).iso).toBe("1985-04-03");
  });

  it("reports the transposed reading when both are plausible", () => {
    const parsed = parseDate("03/04/1985", { today });
    expect(parsed.ambiguous).toBe(true);
    expect(parsed.transposedIso).toBe("1985-03-04");
  });

  it("is unambiguous when only one reading is a real date", () => {
    const parsed = parseDate("25/12/1990", { today });
    expect(parsed.iso).toBe("1990-12-25");
    expect(parsed.ambiguous).toBe(false);
  });

  it("parses ISO and compact forms", () => {
    expect(parseDate("1985-04-03", { today }).iso).toBe("1985-04-03");
    expect(parseDate("19850403", { today }).iso).toBe("1985-04-03");
  });

  it("parses textual months in both orders", () => {
    expect(parseDate("3-Apr-1985", { today }).iso).toBe("1985-04-03");
    expect(parseDate("April 3, 1985", { today }).iso).toBe("1985-04-03");
  });

  it("converts an Excel serial number", () => {
    expect(parseDate("31140", { today }).iso).toBe("1985-04-03");
  });

  it("expands two-digit years sensibly", () => {
    expect(parseDate("03/04/85", { today }).iso).toBe("1985-04-03");
    expect(parseDate("03/04/05", { today }).iso).toBe("2005-04-03");
  });

  it("rejects an impossible date", () => {
    expect(parseDate("31/02/1985", { today }).problems).toContain("impossible");
  });

  it("flags a future date of birth", () => {
    expect(parseDate("01/01/2030", { today }).problems).toContain("future");
  });

  it("flags the placeholder dates cores emit for unknown", () => {
    expect(parseDate("01/01/1900", { today }).problems).toContain("placeholder");
    expect(parseDate("1970-01-01", { today }).problems).toContain("placeholder");
  });

  it("detects a day/month transposition between two dates", () => {
    expect(isDayMonthTransposition("1985-04-03", "1985-03-04")).toBe(true);
    expect(isDayMonthTransposition("1985-04-03", "1985-04-03")).toBe(false);
    expect(isDayMonthTransposition("1985-04-03", "1986-03-04")).toBe(false);
  });

  it("computes age without an off-by-one at the birthday", () => {
    expect(ageInYears("1985-04-03", "2026-04-02")).toBe(40);
    expect(ageInYears("1985-04-03", "2026-04-03")).toBe(41);
  });
});
