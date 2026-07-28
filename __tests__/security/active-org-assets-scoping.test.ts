import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the ASSETS/QR domain must pin by-id access to ctx.org.id.
 *
 * Why this tier and this style: these are RSC pages coupled to createClient +
 * requireOrgContext + cookies(), and the repo has no Supabase mock harness for
 * them — so the invariants are pinned on SOURCE, the documented convention
 * already used by __tests__/security/active-org-scoping.test.ts (see its
 * header). The RUNTIME proof, against a real multi-org user driving the real
 * resolver, lives in the integration tier:
 * __tests__/integration/rls/asset-qr-active-org.test.ts.
 *
 * The invariant: RLS's `current_org_ids()` returns EVERY org the viewer belongs
 * to. It is the OUTER boundary, not scoping. So a by-id (or by-token) read MUST
 * carry its own org predicate, or a user working in org A can read org B's
 * asset — and the asset detail page is where custody, QR rotation and
 * maintenance actions live.
 *
 * Every assertion here fails against the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("lib/assets/scan — the QR scan chokepoint", () => {
  const SRC = src("lib/assets/scan.ts");

  it("pins the IDENTITY lookup to the caller-supplied active org", () => {
    expect(SRC).toMatch(
      /\.eq\("token", token\)[\s\S]*?\.eq\("active", true\)[\s\S]*?\.eq\("org_id", orgId\)/,
    );
  });

  it("pins the ASSET dereference to the same active org", () => {
    expect(SRC).toMatch(/\.eq\("id", assetId\)[\s\S]*?\.eq\("org_id", orgId\)/);
  });

  it("takes the Supabase client as an argument so integration can drive it", () => {
    expect(SRC).toMatch(/supabase: SupabaseClient<Database>/);
    expect(SRC, "must not build its own cookie-bound client").not.toMatch(
      /from "@\/lib\/supabase\/server"/,
    );
  });

  it("refuses an empty org rather than matching every row", () => {
    expect(SRC).toMatch(/if \(!orgId\) return null;/);
  });

  it("returns null (not a throw) so callers render an identical not-found", () => {
    expect(SRC).toMatch(/Promise<ScannedAsset \| null>/);
  });
});

describe("QR scan route — resolution is active-org scoped", () => {
  it("the /a/[token] page passes its active org to the resolver", () => {
    const SRC = src("app/(app)/a/[token]/page.tsx");
    expect(
      SRC,
      "requireOrgContext()'s ctx must be USED, not discarded",
    ).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(SRC).toMatch(/resolveScannedAsset\(token, ctx\.org\.id\)/);
    expect(SRC).toMatch(/if \(!asset\) notFound\(\)/);
  });

  it("the _scan wrapper cannot be called without an org", () => {
    const SRC = src("app/(app)/assets/_scan.ts");
    expect(SRC).toMatch(/token: string,\s*orgId: string,/);
    expect(SRC).toMatch(/resolveScannedAssetForOrg\(supabase, token, orgId\)/);
    expect(
      SRC,
      "the wrapper must delegate, not carry its own copy of the query",
    ).not.toMatch(/asset_qr_identities/);
  });
});

describe("asset detail pages — by-id reads are active-org scoped", () => {
  const cases: Array<{
    path: string;
    label: string;
    /** The by-id predicate that must be followed by an org predicate. */
    idPredicate: RegExp;
  }> = [
    {
      path: "app/(app)/assets/[id]/page.tsx",
      label: "the asset detail page (custody + QR + maintenance actions)",
      idPredicate: /\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    },
    {
      path: "app/(app)/assets/[id]/inspections/[inspectionId]/page.tsx",
      label: "the inspection detail page",
      idPredicate:
        /\.eq\("id", inspectionId\)\s*\.eq\("asset_id", assetId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    },
    {
      path: "app/(app)/assets/templates/[id]/page.tsx",
      label: "the inspection-template editor",
      idPredicate: /\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    },
    {
      path: "app/(app)/diary/[id]/edit/page.tsx",
      label: "the site-diary edit form",
      idPredicate: /\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    },
  ];

  for (const { path, label, idPredicate } of cases) {
    it(`${label} constrains its by-id read to the active org`, () => {
      expect(src(path)).toMatch(idPredicate);
    });

    it(`${label} uses requireOrgContext's ctx rather than discarding it`, () => {
      const SRC = src(path);
      expect(SRC).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
      expect(
        SRC,
        "a bare `await requireOrgContext();` means the org was never used for scoping",
      ).not.toMatch(/^\s*await requireOrgContext\(\);\s*$/m);
    });

    it(`${label} still treats a missing/foreign row as notFound()`, () => {
      expect(src(path)).toMatch(/notFound\(\)/);
    });
  }

  it("the template version list is org-scoped too (family_id is not a PK)", () => {
    expect(src("app/(app)/assets/templates/[id]/page.tsx")).toMatch(
      /\.eq\("family_id", t\.family_id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });
});

describe("QR label PDF route — printed labels carry the ACTIVE org", () => {
  const SRC = src("app/api/assets/[id]/label/pdf/route.ts");

  it("scopes the asset read to the active org", () => {
    expect(SRC).toMatch(/\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("scopes the QR identity read to the active org", () => {
    expect(SRC).toMatch(
      /\.eq\("asset_id", id\)\s*\.eq\("active", true\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("takes the letterhead from the request context, not an unscoped query", () => {
    expect(SRC).toMatch(/org_name: ctx\.org\.name/);
    expect(
      SRC,
      'an unscoped `from("organizations").select("name")` is ambiguous for a ' +
        "multi-org user and can stamp the wrong org on a printed label",
    ).not.toMatch(/from\("organizations"\)/);
  });
});

describe("the QR scan proof cannot drift from the implementation again", () => {
  const SRC = src("__tests__/integration/rls/asset-qr-scan.test.ts");

  it("drives the real resolver instead of replicating the query inline", () => {
    expect(SRC).toMatch(
      /import \{ resolveScannedAssetForOrg \} from "@\/lib\/assets\/scan"/,
    );
    expect(
      SRC,
      "a local copy of the identity query is what let the old proof go green " +
        "against a resolver shape that did not exist",
    ).not.toMatch(/\.from\("asset_qr_identities"\)\s*\.select\("asset_id"\)/);
  });
});
