import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Duplicate-migration-prefix guard.
 *
 * Every file in supabase/migrations is named `<14-digit prefix>_<slug>.sql`,
 * and Supabase applies them in prefix order. Two files sharing a prefix is a
 * silent correctness hazard: the apply order between the pair is undefined, and
 * a `db push` can skip or double-apply depending on catalogue state (a class of
 * bug this programme has hit before during release-train merges). A collision
 * usually appears when two branches both grab the "next free" timestamp and are
 * later merged by content — the residue is two files, one prefix.
 *
 * Pure filesystem, no DB — so it runs in the fast unit tier (vitest.config.ts
 * globs every ".test.ts" under __tests__, so this needs no CI wiring) and
 * fails LOUDLY, naming the offending prefix and its files.
 *
 * Matches the repo's source-assertion convention (see
 * __tests__/db/perf-org-id-indexes.test.ts) rather than pulling in tooling.
 */

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const PREFIX = /^(\d{14})_.+\.sql$/;

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

describe("supabase migrations — prefix hygiene", () => {
  it("has migration files to check (guards against a broken glob)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every migration filename starts with a 14-digit numeric prefix", () => {
    const malformed = files.filter((f) => !PREFIX.test(f));
    expect(malformed, `malformed migration filenames: ${malformed.join(", ")}`).toEqual([]);
  });

  it("every 14-digit migration prefix is unique", () => {
    const byPrefix = new Map<string, string[]>();
    for (const f of files) {
      const m = f.match(PREFIX);
      if (!m) continue;
      const prefix = m[1];
      if (prefix === undefined) continue;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
    }

    const duplicates = [...byPrefix.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([prefix, names]) => `${prefix}: ${names.sort().join(" + ")}`);

    expect(
      duplicates,
      `duplicate migration prefixes (undefined apply order):\n${duplicates.join("\n")}`,
    ).toEqual([]);

    // Sanity: distinct prefixes == number of well-formed migration files.
    const wellFormed = files.filter((f) => PREFIX.test(f));
    expect(byPrefix.size).toBe(wellFormed.length);
  });
});
