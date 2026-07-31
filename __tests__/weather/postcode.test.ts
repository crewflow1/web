import { describe, it, expect } from "vitest";
import {
  toPostcodeDistrict,
  isPostcodeDistrict,
  districtForAddress,
  distinctDistricts,
} from "@/lib/weather/postcode";
import type { Address } from "@/lib/address";

/**
 * The cache key — derivation, PII containment, and the economic claim.
 *
 * Three things are proven here:
 *
 *   1. DERIVATION is correct across all six UK outward-code shapes, including
 *      the unspaced forms a human types.
 *   2. PII CONTAINMENT: nothing this function returns can carry the inward code,
 *      so a full postcode can never reach the cross-tenant cache through it. (The
 *      CHECK on both weather tables enforces the same rule in SQL — this is the
 *      TypeScript half of a two-sided guarantee.)
 *   3. THE ECONOMIC CLAIM — that district keying collapses a builder's jobs into
 *      a handful of provider calls — is asserted with real numbers rather than
 *      argued in a comment.
 */

describe("toPostcodeDistrict — the six UK outward-code shapes", () => {
  it("handles every shape, spaced and unspaced", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // A9 / A99 — one letter.
      ["M1 1AE", "M1"],
      ["M60 1NW", "M60"],
      ["m11ae", "M1"],
      // A9A — one letter, digit, letter.
      ["W1A 0AX", "W1A"],
      ["w1a0ax", "W1A"],
      // AA9 / AA99 — two letters.
      ["CR2 6XH", "CR2"],
      ["DN55 1PT", "DN55"],
      ["dn551pt", "DN55"],
      // AA9A.
      ["EC1A 1BB", "EC1A"],
      ["ec1a1bb", "EC1A"],
      // Northern Ireland needs no special case.
      ["BT1 5GS", "BT1"],
      ["BT49 9AA", "BT49"],
      // Leeds, the running example in the migration header.
      ["LS1 4AP", "LS1"],
    ];
    for (const [input, expected] of cases) {
      expect(toPostcodeDistrict(input), input).toBe(expected);
    }
  });

  it("splits an unspaced postcode on the fixed 3-character inward code", () => {
    // "DN551PT" is DN55 + 1PT, not DN5 + 51PT. The inward code is always
    // digit-letter-letter, which is what makes this unambiguous.
    expect(toPostcodeDistrict("DN551PT")).toBe("DN55");
    expect(toPostcodeDistrict("LS14AP")).toBe("LS1");
  });

  it("passes an outward code through unchanged, normalising case and stray spaces", () => {
    expect(toPostcodeDistrict("LS1")).toBe("LS1");
    expect(toPostcodeDistrict(" ls1 ")).toBe("LS1");
    expect(toPostcodeDistrict("ec1a")).toBe("EC1A");
  });

  it("reads a bare 'LS14' as the DISTRICT LS14, which is the documented interpretation", () => {
    // Genuinely ambiguous with the sector "LS1 4"; nothing in the string
    // distinguishes them, and LS14 is a real Leeds district.
    expect(toPostcodeDistrict("LS14")).toBe("LS14");
  });

  it("handles the GIR 0AA special case", () => {
    expect(toPostcodeDistrict("GIR 0AA")).toBe("GIR");
    expect(toPostcodeDistrict("gir0aa")).toBe("GIR");
    expect(toPostcodeDistrict("GIR")).toBe("GIR");
  });

  it("strips punctuation a human might type", () => {
    expect(toPostcodeDistrict("LS1-4AP")).toBe("LS1");
    expect(toPostcodeDistrict("LS1.4AP")).toBe("LS1");
  });
});

describe("toPostcodeDistrict — refuses rather than guesses", () => {
  it("returns null for junk, free text and foreign codes", () => {
    // A WRONG district is a forecast for the wrong place, which is worse than no
    // forecast, so anything unrecognised is refused outright.
    const junk = [
      "",
      "   ",
      "not a postcode",
      "Unit 4, Trading Estate",
      "12345", // US ZIP
      "75008", // French
      "1234 AB", // Dutch
      "ABC",
      "9LS",
      "L",
      "LS",
    ];
    for (const j of junk) {
      expect(toPostcodeDistrict(j), JSON.stringify(j)).toBeNull();
    }
  });

  it("returns null for null, undefined and non-strings", () => {
    expect(toPostcodeDistrict(null)).toBeNull();
    expect(toPostcodeDistrict(undefined)).toBeNull();
    // A defensive cast: callers get these from database columns typed as
    // `string | null`, and a bad migration could deliver something else.
    expect(toPostcodeDistrict(42 as unknown as string)).toBeNull();
  });
});

describe("PII containment — the whole reason the key is a district", () => {
  it("NEVER returns anything containing the inward code", () => {
    // The inward code is what narrows a postcode to ~15 addresses. A district
    // covers thousands, which is why a global, cross-tenant-readable cache keyed
    // on it leaks nothing about where any customer lives.
    const fullPostcodes = [
      "LS1 4AP",
      "EC1A 1BB",
      "DN55 1PT",
      "BT49 9AA",
      "M60 1NW",
      "W1A 0AX",
      "GIR 0AA",
    ];
    for (const full of fullPostcodes) {
      const district = toPostcodeDistrict(full)!;
      const inward = full.replace(/\s+/g, "").toUpperCase().slice(-3);
      expect(district, full).not.toContain(inward);
      // A district is at most 4 characters. A full postcode is at least 5.
      expect(district.length, full).toBeLessThanOrEqual(4);
    }
  });

  it("every derived district satisfies the same predicate the SQL CHECK enforces", () => {
    for (const p of ["LS1 4AP", "M1 1AE", "EC1A 1BB", "DN55 1PT", "GIR 0AA", "BT1 5GS"]) {
      expect(isPostcodeDistrict(toPostcodeDistrict(p))).toBe(true);
    }
  });
});

describe("isPostcodeDistrict", () => {
  it("accepts normalised districts only", () => {
    for (const d of ["M1", "M60", "W1A", "CR2", "DN55", "EC1A", "GIR", "BT49"]) {
      expect(isPostcodeDistrict(d), d).toBe(true);
    }
  });

  it("rejects full postcodes, lowercase, spaced and non-strings", () => {
    // This is the narrowing guard for untrusted input (a URL segment, a form
    // field) before it reaches a query, so it must not be lenient.
    for (const bad of ["LS1 4AP", "LS14AP", "ls1", "LS1 ", " LS1", "", 1, null, undefined, {}]) {
      expect(isPostcodeDistrict(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("districtForAddress", () => {
  const addr = (postcode: string | null): Address => ({ line1: "1 Test St", postcode });

  it("reads the postcode from the shared Address shape", () => {
    expect(districtForAddress(addr("LS1 4AP"))).toBe("LS1");
  });

  it("returns null for an address with no postcode — a legitimate state, not an error", () => {
    // Plenty of CrewFlow jobs carry a street address and no postcode. Those
    // simply have no weather; they must not borrow a neighbour's district.
    expect(districtForAddress(addr(null))).toBeNull();
    expect(districtForAddress({ line1: "1 Test St" })).toBeNull();
    expect(districtForAddress(null)).toBeNull();
    expect(districtForAddress(undefined)).toBeNull();
  });
});

describe("distinctDistricts — the API-call economics, as a number", () => {
  it("collapses a realistic jobs list into a handful of districts", () => {
    // Twelve live jobs clustered around Leeds and Wakefield, as a real regional
    // builder's board looks. Keying on the FULL postcode would cost 12 provider
    // calls per refresh; keying on the district costs 4.
    const jobs: Address[] = [
      { postcode: "LS1 4AP" },
      { postcode: "LS1 5RR" },
      { postcode: "LS1 2TW" },
      { postcode: "LS11 5BD" },
      { postcode: "LS11 9AA" },
      { postcode: "WF1 1AA" },
      { postcode: "WF1 2BB" },
      { postcode: "WF1 3CC" },
      { postcode: "WF2 8DD" },
      { postcode: "LS1 9ZZ" },
      { postcode: "LS11 1QQ" },
      { postcode: "WF1 4EE" },
    ];
    const districts = distinctDistricts(jobs);
    expect(districts).toEqual(["LS1", "LS11", "WF1", "WF2"]);
    expect(districts.length).toBe(4);
    expect(jobs.length).toBe(12);
    // A 3x reduction on this board. The saving grows with clustering, and grows
    // again across tenants because the cache is global.
    expect(jobs.length / districts.length).toBeGreaterThanOrEqual(3);
  });

  it("drops addresses with no derivable postcode instead of inventing a district", () => {
    const districts = distinctDistricts([
      { postcode: "LS1 4AP" },
      { postcode: null },
      { line1: "Behind the church" },
      null,
      undefined,
      { postcode: "not a postcode" },
    ]);
    expect(districts).toEqual(["LS1"]);
  });

  it("is sorted and deduplicated, so a refresh plan is stable across runs", () => {
    const a = distinctDistricts([{ postcode: "WF1 1AA" }, { postcode: "LS1 4AP" }]);
    const b = distinctDistricts([{ postcode: "LS1 4AP" }, { postcode: "WF1 1AA" }]);
    expect(a).toEqual(["LS1", "WF1"]);
    expect(a).toEqual(b);
  });

  it("returns an empty list for an empty input", () => {
    expect(distinctDistricts([])).toEqual([]);
  });
});
