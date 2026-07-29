import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Sign-off "expected" denominator — countOrgMembers must count the ACTIVE
 * org only.
 *
 * The defect this pins against: migration 20260515170000_org_member_visibility
 * grants permissive (OR-combined) SELECT on memberships — the caller's own
 * rows in every org, plus ALL rows of orgs they belong to. A head-count with
 * no org predicate,
 *
 *   from("memberships").select("user_id", { count: "exact", head: true })
 *
 * therefore counts every membership row visible to the viewer ACROSS ALL
 * their orgs. For a multi-org viewer the acknowledgement "expected"
 * denominator inflates, understating completion: a fully-signed document in
 * a 3-member org renders as 3-of-8 with phantom "outstanding" operatives no
 * one can ever clear.
 *
 * #471 fixed caller-role derivation under the same migration and deliberately
 * left this count out of scope; this is that follow-up. The fix mirrors the
 * active-org pinning idiom (#456/#468): the helper takes the org id from its
 * caller (requireOrgContext → ctx.org.id) and applies .eq("org_id", orgId) —
 * exactly like listAssessors over the same table next door.
 *
 * Hermetic: a pure model of the policy's visible set + source pins, no
 * database. Every assertion here fails against the pre-fix source.
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
// 1. The failure mode, modelled — a viewer in two orgs
// ---------------------------------------------------------------------------

type MembershipRow = { org_id: string; user_id: string };

/**
 * The visible set under 20260515170000 (permissive OR): own rows in every
 * org + all rows of orgs the viewer belongs to. For an org member the second
 * arm subsumes the first; both are modelled so the shape matches the policy.
 */
function visibleMemberships(all: MembershipRow[], viewer: string): MembershipRow[] {
  const viewerOrgs = new Set(all.filter((r) => r.user_id === viewer).map((r) => r.org_id));
  return all.filter((r) => r.user_id === viewer || viewerOrgs.has(r.org_id));
}

/** PostgREST head-count semantics: count = size of the filtered visible set. */
const headCount = (rows: MembershipRow[]) => rows.length;

describe("multi-org viewer — the denominator must be the active org's size", () => {
  // Alice runs a 3-member org and also belongs to a 5-member org.
  const rows: MembershipRow[] = [
    { org_id: "org-a", user_id: "alice" },
    { org_id: "org-a", user_id: "bob" },
    { org_id: "org-a", user_id: "carol" },
    { org_id: "org-b", user_id: "alice" },
    { org_id: "org-b", user_id: "dan" },
    { org_id: "org-b", user_id: "erin" },
    { org_id: "org-b", user_id: "fay" },
    { org_id: "org-b", user_id: "gus" },
  ];
  const visible = visibleMemberships(rows, "alice");

  it("the pre-fix shape (no org predicate) counts memberships across BOTH orgs", () => {
    expect(headCount(visible)).toBe(8); // 3 + 5 — the member count of nothing
  });

  it("pinning to the active org yields that org's true head-count", () => {
    expect(headCount(visible.filter((r) => r.org_id === "org-a"))).toBe(3);
    expect(headCount(visible.filter((r) => r.org_id === "org-b"))).toBe(5);
  });

  it("the inflated denominator misreports a fully-acknowledged document", () => {
    const acked = 3; // every org-a member signed
    expect(acked).toBe(headCount(visible.filter((r) => r.org_id === "org-a"))); // truth: 3/3
    expect(acked).toBeLessThan(headCount(visible)); // rendered: 3/8 — 5 phantom outstanding
  });

  it("a single-org viewer is unaffected either way (why the bug hid)", () => {
    const bobVisible = visibleMemberships(rows, "bob");
    expect(headCount(bobVisible)).toBe(headCount(bobVisible.filter((r) => r.org_id === "org-a")));
  });
});

// ---------------------------------------------------------------------------
// 2. Source pins — the helper carries its own org predicate
// ---------------------------------------------------------------------------

describe("countOrgMembers — org-pinned, caller-supplied, tenant-client", () => {
  const DATA = src("app/(app)/health-safety/_signoff-data.ts");
  const F = fn(DATA, "countOrgMembers");

  it("takes the org id from its caller (RLS cannot supply the ACTIVE org)", () => {
    expect(F).toMatch(/countOrgMembers\(orgId: string\)/);
  });

  it("applies the org predicate to the head-count itself", () => {
    expect(F).toMatch(
      /\.from\("memberships"\)[\s\S]*?\.select\("user_id", \{ count: "exact", head: true \}\)[\s\S]*?\.eq\("org_id", orgId\)/,
    );
  });

  it("stays on the tenant client (RLS-scoped), never service-role", () => {
    expect(DATA).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(DATA).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|createServiceClient|createAdminClient/);
  });

  it("matches listAssessors — the same table is already pinned this way next door", () => {
    const assessors = fn(src("app/(app)/health-safety/_data.ts"), "listAssessors");
    expect(assessors).toMatch(/\.eq\("org_id", orgId\)/);
  });
});
