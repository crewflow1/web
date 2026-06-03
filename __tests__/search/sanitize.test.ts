import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeSearchTerm } from "@/lib/search/sanitize";

/**
 * Search input sanitisation — shared by the customers list (customerSearchOr)
 * and the global Cmd/K search route (app/api/search/route.ts).
 *
 * A free-text term is interpolated into PostgREST `ilike` patterns and `.or()`
 * filter strings. Without neutralisation a crafted term can inject extra OR
 * branches, broaden the match, or break the grammar (400s). These pin the two
 * character classes we strip — control chars and PostgREST structural/wildcard
 * chars — plus the "nothing left" contract callers depend on.
 */

// Control chars are built via fromCharCode so the test source stays plain
// ASCII (literal control bytes don't survive editors/serialisation cleanly).
const NUL = String.fromCharCode(0); // C0 NUL
const BEL = String.fromCharCode(7); // C0 BEL
const US = String.fromCharCode(31); // C0 unit separator
const NEL = String.fromCharCode(0x85); // C1 next-line

describe("sanitizeSearchTerm", () => {
  it("passes ordinary terms through untouched (incl. non-ASCII letters)", () => {
    expect(sanitizeSearchTerm("acme")).toBe("acme");
    expect(sanitizeSearchTerm("José Müller")).toBe("José Müller");
  });

  it("strips PostgREST structural/wildcard chars (% _ , ( ) *)", () => {
    expect(sanitizeSearchTerm("a%,(b)_*")).toBe("a b");
    for (const dangerous of ["%", "_", ",", "(", ")", "*"]) {
      expect(sanitizeSearchTerm(`x${dangerous}y`)).toBe("x y");
    }
  });

  it("neutralises an .or()-injection payload", () => {
    // The classic attack: smuggle a second OR branch via a literal comma.
    expect(sanitizeSearchTerm("x,email.ilike.*")).toBe("x email.ilike.");
  });

  it("strips ASCII/C1 control characters", () => {
    expect(sanitizeSearchTerm(`ab${NUL}cd`)).toBe("ab cd");
    expect(sanitizeSearchTerm(`ab${BEL}cd`)).toBe("ab cd");
    expect(sanitizeSearchTerm(`ab${US}cd`)).toBe("ab cd");
    expect(sanitizeSearchTerm(`ab${NEL}cd`)).toBe("ab cd");
    expect(sanitizeSearchTerm("ab\tcd")).toBe("ab cd"); // tab → whitespace collapse
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeSearchTerm("  multiple   spaces  ")).toBe("multiple spaces");
  });

  it("returns '' for empty / whitespace / null / all-stripped input", () => {
    expect(sanitizeSearchTerm("")).toBe("");
    expect(sanitizeSearchTerm("   ")).toBe("");
    expect(sanitizeSearchTerm(undefined)).toBe("");
    expect(sanitizeSearchTerm(null)).toBe("");
    expect(sanitizeSearchTerm("%_()*")).toBe(""); // only structural chars
    expect(sanitizeSearchTerm(`${NUL}${BEL}`)).toBe(""); // only control chars
  });
});

describe("global search route wires the shared sanitizer", () => {
  // Source-guard: the route's term must flow through sanitizeSearchTerm, not a
  // bespoke (drift-prone) inline regex.
  const src = readFileSync(
    resolve(__dirname, "../../app/api/search/route.ts"),
    "utf8",
  );

  it("imports and applies sanitizeSearchTerm before building the filter", () => {
    expect(src).toContain('from "@/lib/search/sanitize"');
    expect(src).toMatch(/const safe = sanitizeSearchTerm\(q\)/);
  });

  it("still short-circuits a too-short or empty query (no unbounded scan)", () => {
    expect(src).toMatch(/q\.length < 2/);
    expect(src).toMatch(/safe\.length === 0/);
  });
});
