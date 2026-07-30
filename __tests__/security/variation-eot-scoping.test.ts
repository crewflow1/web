import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Variation extension-of-time writers — active-org pinning + role gating.
 *
 * Style note: these are Server Actions coupled to createClient +
 * requireOrgContext + cookies(), which the repo pins on SOURCE (the documented
 * convention — see __tests__/security/active-org-scoping.test.ts). The runtime
 * proof against a real dual-org user's JWT is in the integration tier:
 * __tests__/integration/rls/variation-eot-cost-basis.test.ts.
 *
 * The invariant being defended: `current_org_ids()` returns EVERY org the
 * viewer belongs to, so RLS does not constrain a by-id write to the ACTIVE org.
 * Both new writers touch a CONTRACTUAL date, so an unpinned write would let a
 * dual-org user working in org A record an agreed extension of time against org
 * B's variation — a commercial fact, on the wrong company's contract.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const ACTIONS = src("app/(app)/quotes/actions.ts");

/** Isolate one exported function body so a sibling can't satisfy an assertion. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** The private loader both writers resolve their row through. */
function privateFn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("loadVariationForOrg — the scoped-read chokepoint for EoT writes", () => {
  const SRC = privateFn(ACTIONS, "loadVariationForOrg");

  it("pins the by-id read to the caller-supplied active org", () => {
    expect(SRC).toMatch(/\.eq\("id", quoteId\)[\s\S]*?\.eq\("org_id", orgId\)/);
  });

  it("throws on a failed read rather than reporting 'not a variation'", () => {
    // A loud read: an outage must not be indistinguishable from a foreign row.
    expect(SRC).toMatch(/if \(error\) throw readFailure\(/);
  });

  it("treats a plain quote as not-found so a quote id cannot be used as a variation id", () => {
    expect(SRC).toMatch(/variation_number == null\) return null/);
  });
});

const WRITERS: Array<[string, string]> = [
  ["recordVariationEotAgreement", "recording an agreed extension of time"],
  ["reclassifyVariationValidUntilAsEot", "reclassifying a misfiled completion date"],
];

for (const [name, label] of WRITERS) {
  describe(`${name} — ${label}`, () => {
    const SRC = fn(ACTIONS, name);

    it("resolves the row through the active-org chokepoint", () => {
      expect(SRC).toMatch(/loadVariationForOrg\(supabase, quoteId, ctx\.org\.id\)/);
    });

    it("ALSO pins the UPDATE to the active org (the read proves it, the predicate scopes it)", () => {
      expect(SRC).toMatch(
        /\.update\([\s\S]*?\.eq\("id", quoteId\)\s*\n?\s*\.eq\("org_id", ctx\.org\.id\)/,
      );
    });

    it("never issues an unpinned by-id write", () => {
      // An .eq("id", …) that is not followed by an org predicate.
      const unpinned = /\.eq\("id", quoteId\)(?![\s\S]{0,120}?\.eq\("org_id")/;
      expect(SRC).not.toMatch(unpinned);
    });

    it("validates the id is a uuid before touching the database", () => {
      expect(SRC).toMatch(/idSchema\.safeParse\(quoteId\)/);
    });

    it("is owner/admin only — recording a contractual date is not a member action", () => {
      expect(SRC).toMatch(/role !== "owner" && role !== "admin"/);
      expect(SRC).toMatch(/ctx\.membership\.role/);
    });

    it("bails to not-found when the row is absent or in another org", () => {
      expect(SRC).toMatch(/if \(!variation\) redirect\("\/quotes\?error=not_found"\)/);
    });

    it("NEVER writes to the jobs table — an agreed EoT does not move the programme", () => {
      expect(SRC).not.toMatch(/from\("jobs"\)/);
    });
  });
}

describe("createVariation — the completion date is not an expiry", () => {
  const SRC = fn(ACTIONS, "createVariation");

  it("writes valid_until as an explicit null, never from the requested date", () => {
    expect(SRC).toMatch(/valid_until: null/);
    // The exact defect: the EoT input reaching the expiry column.
    expect(SRC).not.toMatch(/valid_until:\s*parsed\.data\.\w*completion_date/);
    expect(SRC).not.toMatch(/valid_until:\s*parsed\.data\.target_completion_date/);
  });

  it("writes the requested date to its own column", () => {
    expect(SRC).toMatch(
      /eot_requested_completion_date:\s*\n?\s*parsed\.data\.eot_requested_completion_date/,
    );
  });

  it("persists the cost basis it prices the variation from", () => {
    for (const col of [
      "cost_labour",
      "cost_materials",
      "cost_subcontractors",
      "cost_misc",
    ]) {
      expect(SRC, `${col} must be persisted`).toMatch(new RegExp(`${col}: computed\\.cost_breakdown`));
    }
  });

  it("never writes the generated cost_total (no second source of truth)", () => {
    expect(SRC).not.toMatch(/cost_total:/);
  });

  it("never writes to the jobs table", () => {
    expect(SRC).not.toMatch(/from\("jobs"\)/);
  });
});

describe("the variation form's date field is named for what it is", () => {
  const FORM = src("app/(app)/jobs/[id]/variations/new/_form.tsx");

  it("submits eot_requested_completion_date, not a target/expiry name", () => {
    expect(FORM).toMatch(/name="eot_requested_completion_date"/);
    expect(FORM).not.toMatch(/name="target_completion_date"/);
    expect(FORM).not.toMatch(/name="valid_until"/);
  });

  it("tells the operator it is neither an expiry nor a programme change", () => {
    expect(FORM).toMatch(/not a quote expiry/i);
    expect(FORM).toMatch(/does not move this job/i);
  });
});
