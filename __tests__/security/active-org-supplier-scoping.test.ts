import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the SUPPLIERS slice must pin by-id access to ctx.org.id.
 *
 * The last deferred slice of the defect class. Companion to
 * __tests__/security/active-org-scoping.test.ts (jobs, #456) and
 * __tests__/security/active-org-finance-scoping.test.ts (finance/commercial,
 * #459). #459 deliberately EXCLUDED `app/(app)/suppliers/actions.ts` to avoid
 * colliding with the concurrent CIS M4 lane and left a placeholder test saying
 * so; that lane has shipped and this file replaces the placeholder with real
 * coverage.
 *
 * Why this tier and this style: these are Server Actions / RSC pages coupled to
 * createClient + requireOrgContext + cookies(), and the repo has no Supabase
 * mock harness for them — so the invariants are pinned on SOURCE, the
 * documented convention already used by
 * __tests__/security/bank-match-invoice-org-scope.test.ts. The runtime proof
 * against a real multi-org user lives in the integration tier:
 * __tests__/integration/rls/supplier-active-org.test.ts.
 *
 * The invariant: `suppliers_select` / `suppliers_update` are
 * `org_id in current_org_ids()` and `suppliers_delete` is
 * `is_org_admin(org_id)`. All three admit EVERY org the viewer belongs to, so
 * none of them constrains a query to the ACTIVE org (the `active_org_id`
 * cookie). A by-id supplier read or write MUST therefore carry its own org
 * predicate.
 *
 * Every assertion here fails against the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Extract a single exported function body so a sibling can't satisfy an assertion. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

// ---------------------------------------------------------------------------
// 1. The shared read seam
// ---------------------------------------------------------------------------

describe("server/services/suppliers — the shared scoped-read chokepoint", () => {
  const SRC = src("server/services/suppliers.ts");

  it("constrains the by-id load to the caller-supplied active org", () => {
    expect(fn(SRC, "loadSupplierForOrg")).toMatch(
      /\.eq\("id", supplierId\)\s*\.eq\("org_id", orgId\)/,
    );
  });

  it("returns null (not a throw) so callers can treat it as not-found", () => {
    expect(fn(SRC, "loadSupplierForOrg")).toMatch(/Promise<T \| null>/);
  });

  it("constrains the list read to the active org too", () => {
    expect(fn(SRC, "listSuppliersForOrg")).toMatch(/\.eq\("org_id", orgId\)/);
  });

  it("takes the client as an argument so page, action and test share one implementation", () => {
    // If this became `await createClient()` internally, the integration tier
    // could no longer drive it with a real multi-org user's JWT.
    expect(SRC).not.toMatch(/createClient\(\)/);
    expect(fn(SRC, "loadSupplierForOrg")).toMatch(/db: SuppliersClient/);
    expect(fn(SRC, "listSuppliersForOrg")).toMatch(/db: SuppliersClient/);
  });

  it("does NOT switch the viewer's active org to match the URL", () => {
    // Auto-switching would turn a scoping fix into a silent context change —
    // a product decision this slice must not assume. Same stance as #456.
    expect(SRC).not.toMatch(/cookies\(/);
    expect(SRC).not.toMatch(/active_org_id/);
    expect(SRC).not.toMatch(/setActiveOrg/);
  });
});

// ---------------------------------------------------------------------------
// 2. Supplier pages — by-id and list reads are active-org scoped
// ---------------------------------------------------------------------------

describe("supplier pages — reads go through the scoped seam", () => {
  const detailPages: Array<[string, string]> = [
    ["app/(app)/suppliers/[id]/page.tsx", "the supplier detail/edit page"],
    ["app/(app)/suppliers/[id]/cis/page.tsx", "the CIS subcontractor page"],
    ["app/(app)/suppliers/[id]/payments/page.tsx", "the supplier payments page"],
  ];

  for (const [path, label] of detailPages) {
    it(`${label} loads the supplier through loadSupplierForOrg with ctx.org.id`, () => {
      const SRC = src(path);
      expect(SRC, `${path} should import the chokepoint`).toMatch(
        /import \{ loadSupplierForOrg, type SuppliersClient \} from "@\/server\/services\/suppliers"/,
      );
      expect(SRC, `${path} should pass the active org`).toMatch(
        /loadSupplierForOrg[\s\S]{0,300}?ctx\.org\.id/,
      );
    });

    it(`${label} no longer performs a bare unscoped suppliers read`, () => {
      expect(src(path)).not.toMatch(/from\("suppliers"/);
    });

    it(`${label} still treats a missing/foreign supplier as notFound()`, () => {
      expect(src(path)).toMatch(/if \(!supplier\) notFound\(\)/);
    });
  }

  it("the address book lists only the active org's suppliers", () => {
    const SRC = src("app/(app)/suppliers/page.tsx");
    expect(SRC).toMatch(/listSuppliersForOrg[\s\S]{0,300}?ctx\.org\.id/);
    expect(SRC, "the list must not fall back to an RLS-only read").not.toMatch(
      /from\("suppliers"/,
    );
    expect(SRC).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
  });

  it("the new-supplier page reads nothing (nothing to scope)", () => {
    // Pinned so a future 'duplicate check' or picker added here cannot be an
    // unscoped read without this test noticing.
    expect(src("app/(app)/suppliers/new/page.tsx")).not.toMatch(/from\("suppliers"/);
  });
});

// ---------------------------------------------------------------------------
// 3. Supplier writes — mutations are pinned to the active org
// ---------------------------------------------------------------------------

describe("supplier writes — mutations are pinned to the active org", () => {
  const ACTIONS = src("app/(app)/suppliers/actions.ts");

  it("createSupplier stamps the active org on the new row (was already safe)", () => {
    // Pinned so a refactor cannot drop it and leave creation org-less.
    const F = fn(ACTIONS, "createSupplier");
    expect(F).toMatch(/const \{ ctx, user \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/org_id: ctx\.org\.id/);
  });

  it("updateSupplier captures ctx and scopes the UPDATE by org_id", () => {
    const F = fn(ACTIONS, "updateSupplier");
    expect(F).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("updateSupplier counts rows so a foreign/missing supplier is reported, not faked", () => {
    // Without `count`, a scoped UPDATE that matches nothing returns no error and
    // the action would cheerfully answer "Supplier updated."
    const F = fn(ACTIONS, "updateSupplier");
    expect(F).toMatch(/\{ count: "exact" \}/);
    expect(F).toMatch(/if \(count === 0\)/);
  });

  it("deleteSupplier captures ctx and scopes the DELETE by org_id", () => {
    const F = fn(ACTIONS, "deleteSupplier");
    expect(F).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/\.delete\(\{ count: "exact" \}\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(count === 0\)/);
  });

  it("deleteSupplier KEEPS the paid-supplier refusal message (regression)", () => {
    // supplier_payments holds a NO ACTION FK to suppliers (20261047000000): a
    // supplier you have paid must not be deletable, and the operator gets a
    // sentence explaining why. The org predicate must not swallow that path.
    const F = fn(ACTIONS, "deleteSupplier");
    expect(F).toMatch(/error=delete_failed/);
    const detail = src("app/(app)/suppliers/[id]/page.tsx");
    expect(detail).toMatch(/delete_failed:/);
    expect(detail, "the FK explanation must survive").toMatch(/recorded payments to them/i);
    expect(detail, "the new zero-row path needs a message too").toMatch(/delete_denied:/);
  });
});

// ---------------------------------------------------------------------------
// 4. Supplier pickers embedded in other domains
// ---------------------------------------------------------------------------

describe("supplier pickers in other domains — scoped to the active org", () => {
  it("the expense-draft supplier picker is active-org scoped", () => {
    const SRC = src("app/(app)/expenses/[id]/page.tsx");
    expect(SRC).toMatch(/listSuppliersForOrg[\s\S]{0,200}?ctx\.org\.id/);
    expect(SRC).not.toMatch(/from\("suppliers"/);
  });

  it("the purchase-order builder takes an explicit orgId and scopes BOTH lists", () => {
    const SRC = src("app/(app)/purchase-orders/_data.ts");
    const F = fn(SRC, "listPoFormOptions");
    expect(F, "the loader must demand the active org rather than trusting RLS").toMatch(
      /orgId: string/,
    );
    expect(F).toMatch(/listSuppliersForOrg\([\s\S]{0,120}?orgId\)/);
    // The jobs half of the same picker leaked customer names the same way.
    expect(F).toMatch(/\.eq\("org_id", orgId\)/);
  });

  it("both purchase-order pages pass the active org through", () => {
    for (const p of [
      "app/(app)/purchase-orders/new/page.tsx",
      "app/(app)/purchase-orders/[id]/page.tsx",
    ]) {
      expect(src(p), `${p} must pass ctx.org.id`).toMatch(
        /listPoFormOptions\(supabase, ctx\.org\.id\)/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. CIS M1 posture is preserved, not weakened
// ---------------------------------------------------------------------------

describe("CIS (M1) — the org boundary holds and the admin/masking posture is intact", () => {
  it("every CIS action passes the ACTIVE org into the service (was already safe)", () => {
    const ACTIONS = src("app/(app)/suppliers/[id]/cis/actions.ts");
    for (const name of ["saveCisProfile", "saveCisVerification", "requestCisReverification"]) {
      const F = fn(ACTIONS, name);
      expect(F, `${name} must capture ctx`).toMatch(
        /const \{ ctx, user \} = await requireOrgContext\(\)/,
      );
      expect(F, `${name} must pass the active org, never a client-supplied one`).toMatch(
        /\(\s*ctx\.org\.id,\s*supplierId/,
      );
      expect(F, `${name} must keep the owner/admin re-check`).toMatch(
        /if \(!isManager\(ctx\.membership\.role\)\) return formError/,
      );
    }
  });

  it("the CIS service scopes by BOTH org_id and supplier_id (was already safe)", () => {
    const SVC = src("server/services/cis.ts");
    expect(fn(SVC, "getCisProfile")).toMatch(
      /\.eq\("org_id", orgId\)\s*\.eq\("supplier_id", supplierId\)/,
    );
    const upsert = fn(SVC, "upsertCisProfile");
    expect(upsert).toMatch(/org_id: orgId, supplier_id: supplierId/);
    expect(upsert).toMatch(/\.eq\("org_id", orgId\)\s*\.eq\("supplier_id", supplierId\)/);
  });

  it("the supplier ledger read is org-scoped (was already safe)", () => {
    const F = fn(src("server/services/supplier-payments.ts"), "getSupplierLedger");
    expect(F).toMatch(/\.eq\("org_id", orgId\)\s*\.eq\("supplier_id", supplierId\)/);
  });

  it("the scoping fix did not weaken UTR masking or the admin gates", () => {
    // Restates the CIS M1 invariants that this slice's edits sit next to, so a
    // scoping refactor cannot quietly regress them.
    const detail = src("app/(app)/suppliers/[id]/page.tsx");
    expect(detail, "the supplier detail page must still never touch the UTR").not.toMatch(
      /\butr\b/i,
    );
    expect(detail).toMatch(/const isAdmin = ctx\.membership\.role === "owner"/);

    const cis = src("app/(app)/suppliers/[id]/cis/page.tsx");
    expect(cis, "only the masked identifier crosses into the client component").toMatch(
      /maskedUtr=\{maskUtr\(/,
    );
    expect(cis).toMatch(/ctx\.membership\.role === "owner"/);

    const payments = src("app/(app)/suppliers/[id]/payments/page.tsx");
    expect(payments).toMatch(/if \(!isAdmin\)/);
  });

  it("no supplier surface reads cis_subcontractors directly", () => {
    // The admin gate and the masking both live in server/services/cis.ts; a
    // direct read from a page would bypass them.
    for (const p of [
      "app/(app)/suppliers/page.tsx",
      "app/(app)/suppliers/[id]/page.tsx",
      "app/(app)/suppliers/[id]/cis/page.tsx",
      "app/(app)/suppliers/[id]/payments/page.tsx",
      "app/(app)/suppliers/actions.ts",
      "server/services/suppliers.ts",
    ]) {
      expect(src(p), `${p} must not touch cis_subcontractors directly`).not.toMatch(
        /from\(\s*["']cis_subcontractors["']/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 6. What this slice deliberately does not claim
// ---------------------------------------------------------------------------

describe("scope note — supplier reads still outstanding", () => {
  it("the ASSET REGISTER's two supplier reads remain unscoped (next slice)", () => {
    // Deliberate: `app/(app)/assets/**` is the asset-register domain and a
    // concurrent lane owns the fleet surfaces it is adjacent to, so this slice
    // leaves it alone rather than risk a collision. Both are READ-only leaks
    // (a picker and a name lookup) — no write crosses the boundary there.
    // This test documents the gap so it cannot be mistaken for coverage, and
    // goes RED the moment either file is fixed, forcing it to be retired.
    for (const p of ["app/(app)/assets/new/page.tsx", "app/(app)/assets/[id]/page.tsx"]) {
      expect(
        src(p),
        `${p}: if this is now scoped, delete this test — the gap is closed`,
      ).toMatch(/from\("suppliers"/);
    }
  });
});
