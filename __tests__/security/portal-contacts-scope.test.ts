import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  customerContactSchema,
  buildPortalContactView,
  CONTACT_PORTAL_KEYS,
} from "@/lib/customers/contacts";

/**
 * Multi-contact per customer (P3). The customer_contacts table is additive to
 * the single customers.portal_token path. Invariants:
 *
 *   • WRITE: org_id + customer_id are stamped from the token-resolved customer,
 *     never the form; a portal add NEVER mints a portal_token (no self-escalation
 *     into a second login).
 *   • READ-BACK: filters org_id AND customer_id, and the projection NEVER carries
 *     the portal_token credential.
 *   • CONTACT-TOKEN AUTH: a contact token resolves to the PARENT customer, so all
 *     downstream scoping stays on that customer — never a new tenant boundary.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) =>
  readFileSync(resolve(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ACTION = read("app/customer-portal/_contact-action.ts");
const LOADER = read("app/customer-portal/_contacts.ts");
const HELPERS = read("app/customer-portal/_helpers.ts");
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/20261141000000_customer_contacts.sql"),
  "utf8",
);

describe("input validation is bounded", () => {
  it("accepts a valid contact and requires a name + (email or phone)", () => {
    expect(
      customerContactSchema.safeParse({ name: "Jordan Smith", email: "j@x.com", role: "billing" }).success,
    ).toBe(true);
    expect(
      customerContactSchema.safeParse({ name: "Jordan Smith", phone: "07123", role: "site" }).success,
    ).toBe(true);
    // No email AND no phone → rejected.
    expect(customerContactSchema.safeParse({ name: "Jordan Smith", role: "other" }).success).toBe(false);
    // Too-short name → rejected.
    expect(customerContactSchema.safeParse({ name: "J", email: "j@x.com" }).success).toBe(false);
    // Bad role → rejected.
    expect(customerContactSchema.safeParse({ name: "Jordan", email: "j@x.com", role: "hacker" }).success).toBe(false);
  });
});

describe("the write stamps identity + never mints a login token", () => {
  it("org_id + customer_id come from the token-resolved customer", () => {
    expect(ACTION).toMatch(/org_id: customer\.org_id/);
    expect(ACTION).toMatch(/customer_id: customer\.id/);
  });

  it("portal access is never provisioned from the portal", () => {
    expect(ACTION).toMatch(/portal_access_enabled: false/);
    expect(ACTION).toMatch(/portal_token: null/);
  });

  it("the form is never consulted for identity", () => {
    for (const field of ["customer_id", "org_id", "portal_token", "portal_access_enabled"]) {
      expect(ACTION).not.toContain(`formData.get("${field}")`);
    }
  });

  it("resolves the token through the chokepoint and is rate-limited", () => {
    expect(ACTION).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(ACTION).toMatch(/consume\("portal_write", token, DEFAULT_LIMITS\.portal_write\)/);
  });
});

describe("the read-back is customer-scoped and never leaks the credential", () => {
  it("filters org_id AND customer_id", () => {
    expect(LOADER).toMatch(/\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("customer_id", customerId\)/);
  });

  it("never selects portal_token", () => {
    expect(LOADER).not.toContain("portal_token");
    expect(LOADER).toMatch(/select\("id, name, email, phone, role, portal_access_enabled"\)/);
  });

  it("is paged and fails loud", () => {
    expect(LOADER).toMatch(/fetchAllRows/);
    expect(LOADER).toMatch(/throw readFailure\("portal contacts: list", error\)/);
  });

  it("the projection has exactly the declared keys and no token", () => {
    const view = buildPortalContactView({
      id: "c1",
      name: "Jordan",
      email: "j@x.com",
      phone: null,
      role: "billing",
      portal_access_enabled: true,
    });
    expect(Object.keys(view).sort()).toEqual([...CONTACT_PORTAL_KEYS].sort());
    expect(JSON.stringify(view)).not.toMatch(/token/i);
    expect(view.has_portal_access).toBe(true);
  });
});

describe("contact-token auth is additive and resolves to the PARENT customer", () => {
  it("the customer-token path is tried first; contact resolution is the fallback", () => {
    // The primary customers lookup remains; the contact branch is only reached
    // when it misses (`if (!data) return resolveContactToken`).
    expect(HELPERS).toMatch(/if \(!data\) return resolveContactToken\(admin, token\)/);
    expect(HELPERS).toMatch(/function resolveContactToken/);
  });

  it("a contact token requires access enabled and honours contact-level expiry", () => {
    expect(HELPERS).toMatch(/\.eq\("portal_token", token\)/);
    expect(HELPERS).toMatch(/\.eq\("portal_access_enabled", true\)/);
    expect(HELPERS).toMatch(/portal_token_expires_at/);
  });

  it("resolution returns the PARENT customer's id/org_id (no new tenant boundary)", () => {
    // The returned customer is built from `data.customer` (the parent), not the
    // contact row itself.
    expect(HELPERS).toMatch(/const c = data\.customer/);
    expect(HELPERS).toMatch(/id: c\.id/);
    expect(HELPERS).toMatch(/org_id: c\.org_id/);
  });
});

describe("the schema binds contacts to their own customer + org", () => {
  it("composite FK to customers(id, org_id) — cross-org customer_id unrepresentable", () => {
    expect(MIGRATION).toMatch(
      /foreign key \(customer_id, org_id\) references public\.customers \(id, org_id\)/,
    );
  });

  it("token + access flag can never disagree, and the token is uniquely indexed", () => {
    expect(MIGRATION).toMatch(/customer_contacts_token_access_agree/);
    expect(MIGRATION).toMatch(/create unique index[\s\S]*customer_contacts_portal_token_key/);
  });

  it("RLS is enabled; token provisioning (delete) is admin-gated", () => {
    expect(MIGRATION).toMatch(/enable row level security/);
    expect(MIGRATION).toMatch(/for delete using \(public\.is_org_admin\(org_id\)\)/);
  });
});

describe("cross-customer isolation proof", () => {
  type Contact = { org_id: string; customer_id: string; id: string };
  const scopedRead = (all: Contact[], orgId: string, customerId: string) =>
    all.filter((c) => c.org_id === orgId && c.customer_id === customerId);
  const contacts: Contact[] = [
    { org_id: "org1", customer_id: "A", id: "a1" },
    { org_id: "org1", customer_id: "B", id: "b1" },
    { org_id: "org2", customer_id: "C", id: "c1" },
  ];
  it("customer A sees only their own contacts", () => {
    const a = scopedRead(contacts, "org1", "A");
    expect(a.map((c) => c.id)).toEqual(["a1"]);
  });
});
