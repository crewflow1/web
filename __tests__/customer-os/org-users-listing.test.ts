import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ per-org user listing — column allow-list pin (L11 item 5).
 *
 * The Customers OS detail page now lists every workspace member so an
 * operator never has to impersonate just to see who's in a workspace.
 * The roster is IDENTITY ONLY: memberships × users (name/email/role/
 * join date). Pay data lives in staff_compensation — RLS-locked by
 * migration 20261218000000 precisely because compensation leaking to
 * anyone beyond the org's admins was a live defect. An HQ page joining
 * it back in would reopen that hole with service-role privileges, so
 * this suite pins the boundary at the source level.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SNAPSHOT = read("server/services/hq-customer-snapshot.ts");
const PAGE = read("app/admin/customers/[id]/page.tsx");

describe("hq-customer-snapshot — member roster", () => {
  it("queries memberships org-pinned with the identity-only column list", () => {
    expect(SNAPSHOT).toMatch(
      /\.select\("user_id, role, created_at, user:users \( full_name, email \)"\)\s*\n?\s*\.eq\("org_id", orgId\)/,
    );
  });

  it("NEVER queries pay/compensation data — the staff_compensation boundary", () => {
    // Pin the QUERIES, not prose: comments may (and do) name the boundary.
    // Every table this service reads:
    const tables = [...SNAPSHOT.matchAll(/\.from\("([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(tables).not.toContain("staff_compensation");

    // Every column list this service selects:
    const selects = [...SNAPSHOT.matchAll(/\.select\(\s*"([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(selects.length).toBeGreaterThan(0);
    for (const forbidden of [
      "staff_compensation",
      "hourly_rate",
      "salary",
      "pay_rate",
      "day_rate",
      "pension",
      "ni_number",
    ]) {
      for (const sel of selects) {
        expect(sel, `select list leaks ${forbidden}: ${sel}`).not.toMatch(
          new RegExp(forbidden, "i"),
        );
      }
    }

    // And the page never queries anything itself — it renders the snapshot.
    expect(PAGE).not.toMatch(/staff_compensation/);
    expect(PAGE).not.toMatch(/\.from\(/);
  });

  it("exposes members on the snapshot with the typed identity shape", () => {
    expect(SNAPSHOT).toMatch(/export type CustomerMember = \{/);
    expect(SNAPSHOT).toMatch(/members: ReadonlyArray<CustomerMember>/);
    // The allow-list is documented as a security boundary at the type.
    expect(SNAPSHOT).toMatch(/COLUMN ALLOW-LIST IS A SECURITY BOUNDARY/);
  });

  it("fails loud on a members read error (no silent empty roster)", () => {
    expect(SNAPSHOT).toMatch(
      /if \(membersError\) throw readFailure\("hq customer: members", membersError\);/,
    );
  });
});

describe("customers OS page — Users section", () => {
  it("renders the roster with name/email/role/joined and the no-pay note", () => {
    expect(PAGE).toMatch(/Users \(\{members\.length\}\)/);
    expect(PAGE).toMatch(/pay data is never shown here/i);
    expect(PAGE).toMatch(/m\.full_name/);
    expect(PAGE).toMatch(/m\.email/);
    expect(PAGE).toMatch(/m\.role/);
    expect(PAGE).toMatch(/m\.joined_at/);
  });
});
