/**
 * Documentation truth pins (L8, 2026-08-29).
 *
 * The README was once "dangerous v0 fiction" — it described an ORM we don't
 * use, a background-job service we don't run, and a staging environment that
 * has never existed. These tests pin the reset so the fiction cannot creep
 * back in a doc-only PR that no code gate would ever catch.
 *
 * Deliberately dumb: read the files, assert on strings. No DB, no network.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const readme = read("README.md");
const status = read("docs/roadmap/STATUS.md");
const pkg = JSON.parse(read("package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
};

describe("README.md tells the truth about the stack", () => {
  it("never mentions Drizzle (there is no ORM — supabase-js + generated types)", () => {
    expect(readme).not.toMatch(/drizzle/i);
  });

  it("never mentions Inngest (dead dependency, removed; cron routes do scheduled work)", () => {
    expect(readme).not.toMatch(/inngest/i);
  });

  it("never mentions a staging environment (single production Supabase is the whole story)", () => {
    expect(readme).not.toMatch(/staging/i);
  });

  it("points at supabase/migrations as the migration home", () => {
    expect(readme).toContain("supabase/migrations");
  });

  it("never claims the next migration prefix — that lives only in the database", () => {
    expect(readme).toMatch(/supabase_migrations\.schema_migrations/);
  });
});

describe("README.md states dark channels as dark, not live", () => {
  // Each channel must appear (an honest README names what is NOT live) and
  // every capability-table row naming it must carry a DARK/not-live marker.
  const channels = ["SMS", "WhatsApp", "voice"] as const;

  for (const channel of channels) {
    it(`${channel} is present and marked dark/not live, never a live tick`, () => {
      const pattern = new RegExp(channel, "i");
      expect(readme).toMatch(pattern);

      const rows = readme
        .split("\n")
        .filter((line) => line.startsWith("|") && pattern.test(line));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatch(/dark|not live/i);
        expect(row).not.toMatch(/\bLIVE\b/);
      }
    });
  }

  it("has no pricing table selling SMS/WhatsApp/voice with feature ticks", () => {
    expect(readme).not.toMatch(/£\d+\s*\/\s*mo/i);
    expect(readme).not.toMatch(/Missed-call SMS\s*\|/);
  });
});

describe("README.md carries no other known fiction", () => {
  it("no 19-tables claim (production has 307)", () => {
    expect(readme).not.toMatch(/19 tables/i);
  });

  it("no 03_SUPABASE_SCHEMA.sql schema-source claim (migrations are the source of truth)", () => {
    expect(readme).not.toContain("03_SUPABASE_SCHEMA.sql");
  });

  it("no BetterStack-as-live claim", () => {
    expect(readme).not.toMatch(/betterstack/i);
  });

  it("no pnpm instructions (npm + package-lock.json is the truth)", () => {
    expect(readme).not.toMatch(/pnpm/i);
  });
});

describe("STATUS.md no longer volunteers a NEXT FREE migration prefix", () => {
  it("contains no 'NEXT FREE' claim (the next prefix is asked of the database, never a doc)", () => {
    expect(status).not.toMatch(/NEXT FREE/);
  });

  it("tells the reader to query supabase_migrations.schema_migrations instead", () => {
    expect(status).toMatch(/supabase_migrations\.schema_migrations/);
  });

  it("carries the 2026-08-29 reconciliation header", () => {
    expect(status).toContain("Reconciled 2026-08-29");
    expect(status).toContain("88cbe193");
    expect(status).toContain("20261220000000");
  });
});

describe("package.json hygiene matches reality", () => {
  it("has no inngest dependency anywhere", () => {
    expect(pkg.dependencies ?? {}).not.toHaveProperty("inngest");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("inngest");
  });

  it("does not pin pnpm as the package manager", () => {
    expect(pkg.packageManager ?? "").not.toMatch(/pnpm/);
  });
});
