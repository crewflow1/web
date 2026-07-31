import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPortalVariationView,
  VARIATION_PORTAL_KEYS,
} from "@/lib/variations/portal";

/**
 * The variation approval surface must never carry the priced cost basis.
 *
 * 20261073 added `cost_labour`, `cost_materials`, `cost_subcontractors`,
 * `cost_misc` and the GENERATED `cost_total` to `public.quotes` — the same rows
 * the customer-facing /q/[token] page and the portal quotes list read. Those
 * five numbers are the margin the business priced the job at. A single
 * `{...quote}` on a customer route publishes the contractor's markup to the
 * client who is about to negotiate with them.
 *
 * Three independent proofs, in increasing strength:
 *   1. The DTO's key set is exactly the declared shape.
 *   2. Sentinel secrets planted on the SOURCE ROW are absent from the
 *      SERIALISED payload — not merely unrendered. A field that exists on the
 *      object but is never printed is one JSX edit from being printed.
 *   3. The cost columns are pinned out of the customer-facing `.select()`
 *      strings, so they never leave Postgres at all. The portal runs on the
 *      RLS-bypassing service-role client, so nothing else would stop them.
 */

const ROOT = resolve(__dirname, "..", "..");
/**
 * Source with comments stripped. These assertions are about what the CODE does,
 * so a docblock explaining why a cost column must never be read here (there are
 * several, deliberately) must not be mistaken for reading one.
 */
const read = (p: string) =>
  readFileSync(resolve(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const COST_COLUMNS = [
  "cost_labour",
  "cost_materials",
  "cost_subcontractors",
  "cost_misc",
  "cost_total",
] as const;

/** Values that must never appear in a payload sent to a customer. */
const SENTINELS = {
  cost_labour: 111_111.11,
  cost_materials: 222_222.22,
  cost_subcontractors: 333_333.33,
  cost_misc: 444_444.44,
  cost_total: 1_111_111.1,
  margin_pct: 999,
  internal_note: "SENTINEL-INTERNAL-MARGIN-NOTE",
  prepared_by: "SENTINEL-STAFF-UUID",
};

describe("buildPortalVariationView — shape is declared, not inherited", () => {
  const view = buildPortalVariationView({
    variationNumber: 2,
    status: "sent",
    subtotal: 1000,
    vatTotal: 200,
    total: 1200,
    eotRequestedCompletionDate: "2026-09-30",
    eotAgreedCompletionDate: null,
    acceptedAt: null,
    declinedAt: null,
    siblingQuotes: [{ status: "accepted", total: 50_000, variation_number: null }],
    priorAgreedCompletionDates: [],
  });

  it("has exactly the declared key set", () => {
    expect(Object.keys(view).sort()).toEqual([...VARIATION_PORTAL_KEYS].sort());
  });

  it("carries no cost key at any depth", () => {
    const json = JSON.stringify(view);
    for (const col of COST_COLUMNS) expect(json).not.toContain(col);
    expect(json).not.toContain("margin");
  });
});

describe("sentinel secrets on the source row never reach the payload", () => {
  /**
   * The realistic attack: somebody hands the builder the whole database row
   * (the shape a `select("*")` or a spread would produce). The builder must
   * pick, never absorb.
   */
  const wholeRow = {
    // legitimate, customer-safe
    variationNumber: 2,
    status: "sent",
    subtotal: 1000,
    vatTotal: 200,
    total: 1200,
    eotRequestedCompletionDate: "2026-09-30",
    eotAgreedCompletionDate: null,
    acceptedAt: null,
    declinedAt: null,
    siblingQuotes: [{ status: "accepted", total: 50_000, variation_number: null }],
    priorAgreedCompletionDates: [] as string[],
    // internal — planted
    ...SENTINELS,
  };

  const view = buildPortalVariationView(wholeRow);
  const json = JSON.stringify(view);

  it.each(Object.entries(SENTINELS))(
    "%s is absent from the serialised payload",
    (key, value) => {
      expect(json).not.toContain(key);
      expect(json).not.toContain(String(value));
    },
  );

  it("still produces the legitimate customer-facing figures", () => {
    expect(view.contract.before).toBe(50_000);
    expect(view.contract.after).toBe(51_200);
    expect(view.programme.requested_completion_date).toBe("2026-09-30");
  });
});

describe("cost columns are pinned OUT OF THE QUERY on every customer route", () => {
  const CUSTOMER_ROUTES = [
    "app/q/[token]/page.tsx",
    "app/q/[token]/pdf/route.ts",
    "app/customer-portal/[token]/quotes/page.tsx",
  ];

  it.each(CUSTOMER_ROUTES)("%s selects no cost_* column", (path) => {
    const src = read(path);
    for (const col of COST_COLUMNS) {
      expect(src, `${path} must not read ${col}`).not.toContain(col);
    }
  });

  it("the variation approval component renders no cost figure either", () => {
    const src = read("app/q/[token]/_variation-summary.tsx");
    for (const col of COST_COLUMNS) expect(src).not.toMatch(new RegExp(`view\\.${col}`));
    expect(src).not.toMatch(/margin/i);
  });

  it("the operator-only variation panel still shows cost — the fix must not reach the tenant side", () => {
    const src = read("app/(app)/quotes/[id]/_variation-panel.tsx");
    expect(src).toContain("cost_total");
  });
});
