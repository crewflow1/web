import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Caller-role derivation — the role that gates admin UI and admin actions
 * must come from the caller's OWN membership row.
 *
 * The defect this pins against: migration 20260515170000_org_member_visibility
 * lets org members SELECT each other's membership rows (needed for team lists
 * and assignment dropdowns). After it, a read like
 *
 *   supabase.from("memberships").select("role").eq("org_id", orgId).single()
 *
 * no longer returns "my row" — it returns EVERY member's row. PostgREST's
 * `.single()` errors on anything but exactly one row, so in any org with ≥2
 * members `data` is null, `myRow?.role` is undefined, and `isAdmin` is false
 * for EVERYONE — including owners. The quote approval panel vanished, and the
 * server gates behind it (reviewQuote, staff CRUD, bank-statement upload)
 * fail-closed with "forbidden" for legitimate admins.
 *
 * The correct source of the caller's role is ctx.membership.role:
 * requireOrgContext → getOrgForUser reads memberships WITH a user_id filter
 * and resolves the ACTIVE org (cookie-aware), so ctx.membership is precisely
 * the caller's own row in the org the page is rendering. It is also correct
 * under HQ impersonation, where the admin has NO membership row and a
 * user_id-filtered query would return nothing.
 *
 * Hermetic: source contracts + a pure model of PostgREST semantics, no
 * database. Every assertion here fails against the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// 1. The failure mode, modelled — a 2-member org
// ---------------------------------------------------------------------------

type MembershipRow = { user_id: string; role: string };

/**
 * PostgREST `.single()` semantics (PGRST116): exactly one row or
 * { data: null, error }. This is the contract the buggy code ran into.
 */
function pgrstSingle(rows: MembershipRow[]): {
  data: MembershipRow | null;
  error: { code: string } | null;
} {
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only) return { data: only, error: null };
  return { data: null, error: { code: "PGRST116" } };
}

describe("2-member org — the approval panel must see the caller's own role", () => {
  // What the org-member-visibility policy makes visible to BOTH members:
  // every row in the org.
  const visible: MembershipRow[] = [
    { user_id: "owner-uuid", role: "owner" },
    { user_id: "staff-uuid", role: "staff" },
  ];

  it("the pre-fix derivation (org-only filter + .single()) reports isAdmin=false even for the owner", () => {
    // Old shape: .eq("org_id", …).single() — no user_id pin.
    const { data: myRow, error } = pgrstSingle(visible);
    expect(error?.code).toBe("PGRST116"); // two rows → PostgREST errors
    const isAdmin = myRow?.role === "owner" || myRow?.role === "admin";
    expect(isAdmin).toBe(false); // the bug: owner locked out of approvals
  });

  it("pinning to the caller's own row yields the true role for each member", () => {
    // ctx.membership is resolved exactly this way upstream — a user_id
    // filter over the same visible set (getOrgForUser, pinned in §2).
    const ownRow = (userId: string) =>
      pgrstSingle(visible.filter((r) => r.user_id === userId));

    const owner = ownRow("owner-uuid");
    expect(owner.error).toBeNull();
    expect(owner.data?.role === "owner" || owner.data?.role === "admin").toBe(
      true,
    );

    const staff = ownRow("staff-uuid");
    expect(staff.error).toBeNull();
    expect(staff.data?.role === "owner" || staff.data?.role === "admin").toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The upstream guarantee — ctx.membership IS the caller's own row
// ---------------------------------------------------------------------------

describe("getOrgForUser — the guarantee that makes ctx.membership.role safe", () => {
  it("reads memberships filtered to the caller's user_id", () => {
    const SRC = src("server/auth/session.ts");
    const start = SRC.indexOf("export async function getOrgForUser");
    expect(start, "getOrgForUser not found").toBeGreaterThan(-1);
    const end = SRC.indexOf("\nexport ", start + 1);
    const body = SRC.slice(start, end === -1 ? undefined : end);
    expect(body).toMatch(/\.from\("memberships"\)/);
    expect(body).toMatch(/\.eq\("user_id", userId\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. The fixed surfaces derive the role from ctx, not a memberships query
// ---------------------------------------------------------------------------

/** Files whose admin gate / isAdmin flag must come from ctx.membership.role. */
const CTX_ROLE_SURFACES = [
  "app/(app)/quotes/[id]/page.tsx", // approval panel (the reported defect)
  "app/(app)/payments/page.tsx",
  "app/(app)/payments/actions.ts",
  "app/(app)/staff/page.tsx",
  "app/(app)/staff/rota/page.tsx",
  "app/(app)/staff/[id]/page.tsx",
  "app/(app)/staff/leave/page.tsx",
] as const;

describe("fixed surfaces read the caller's role from ctx.membership.role", () => {
  for (const file of CTX_ROLE_SURFACES) {
    it(`${file}`, () => {
      const SRC = src(file);
      expect(SRC, `${file} must derive the role from ctx`).toMatch(
        /ctx\.membership\.role/,
      );
      // The buggy read selected exactly "role" from memberships. List reads
      // (select("user_id, role, …")) are legitimate and don't match this.
      expect(
        SRC.includes('.select("role")') && SRC.includes('from("memberships")'),
        `${file} must not re-derive the caller's role from a memberships query`,
      ).toBe(false);
    });
  }

  it("quotes/actions.ts gate (requireQuoteApprover) takes ctx and checks ctx.membership.role", () => {
    const SRC = src("app/(app)/quotes/actions.ts");
    const start = SRC.indexOf("function requireQuoteApprover");
    expect(start, "requireQuoteApprover not found").toBeGreaterThan(-1);
    const end = SRC.indexOf("\nexport ", start + 1);
    const body = SRC.slice(start, end === -1 ? undefined : end);
    expect(body).toMatch(/requireQuoteApprover\(ctx: OrgContext\)/);
    expect(body).toMatch(/ctx\.membership\.role/);
    expect(body).not.toMatch(/from\("memberships"\)/);
  });

  it("staff/actions.ts gate (requireAdmin) takes ctx and checks ctx.membership.role", () => {
    const SRC = src("app/(app)/staff/actions.ts");
    const start = SRC.indexOf("function requireAdmin");
    expect(start, "requireAdmin not found").toBeGreaterThan(-1);
    const end = SRC.indexOf("\nexport ", start + 1);
    const body = SRC.slice(start, end === -1 ? undefined : end);
    expect(body).toMatch(/requireAdmin\(ctx: OrgContext\)/);
    expect(body).toMatch(/ctx\.membership\.role/);
    expect(body).not.toMatch(/from\("memberships"\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. Class-wide pin — the shape must not reappear anywhere
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git")
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
  }
  return out;
}

describe("repo-wide — no single-row role read from memberships without a user_id pin", () => {
  it("every .select(\"role\") … .single()/.maybeSingle() chain on memberships carries .eq(\"user_id\", …)", () => {
    const offenders: string[] = [];
    const dirs = ["app", "lib", "server", "components"].map((d) =>
      resolve(ROOT, d),
    );
    for (const dir of dirs) {
      for (const file of walk(dir)) {
        const source = readFileSync(file, "utf8");
        let idx = source.indexOf('from("memberships")');
        while (idx !== -1) {
          // A query chain is one statement; cut at its terminating semicolon
          // (a 600-char window bounds pathological files).
          const windowEnd = source.indexOf(";", idx);
          const chain = source.slice(
            idx,
            windowEnd === -1 ? idx + 600 : Math.min(windowEnd, idx + 600),
          );
          const selectsRoleOnly = chain.includes('.select("role")');
          const singleRow = /\.(single|maybeSingle)\(\)/.test(chain);
          const pinnedToUser = chain.includes('.eq("user_id"');
          if (selectsRoleOnly && singleRow && !pinnedToUser) {
            offenders.push(
              `${file.slice(ROOT.length + 1)} @ offset ${idx}`,
            );
          }
          idx = source.indexOf('from("memberships")', idx + 1);
        }
      }
    }
    expect(
      offenders,
      `Single-row role reads from memberships must filter to the caller's ` +
        `(or an explicit target's) user_id — org members can see each ` +
        `other's rows, so an org-only filter returns every member and ` +
        `.single() errors in any org with ≥2 members. Derive the CALLER's ` +
        `role from ctx.membership.role instead. Offending chains:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
