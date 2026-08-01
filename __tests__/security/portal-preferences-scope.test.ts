import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPortalPreferencesView,
  buildProfileUpdateTicketBody,
  portalPreferencesSchema,
  PREFERENCES_PORTAL_KEYS,
  profileUpdateRequestSchema,
} from "@/lib/customers/portal-preferences";

/**
 * Customer-portal preferences + profile-change REQUESTS.
 *
 * Two write models, both pinned:
 *
 *   • preferences write DIRECTLY, but only to customer_portal_preferences —
 *     an idempotent natural-key upsert whose identity comes from the
 *     token-resolved customer, bounded by zod AND by DB CHECKs, on a table
 *     whose composite FK makes a cross-org row unrepresentable and whose RLS
 *     grants tenants SELECT only (service-role writes are the single path);
 *
 *   • name/email/phone NEVER write public.customers from the portal. A change
 *     is a support ticket staff apply manually — otherwise a leaked portal
 *     link is an account-takeover primitive (rewrite the delivery email, ask
 *     for a new link). The action file must not touch the customers table at
 *     all.
 */

const ROOT = resolve(__dirname, "..", "..");
const readRaw = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const read = (p: string) =>
  readRaw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ACTIONS = read("app/customer-portal/_preferences-action.ts");
const LOADER = read("app/customer-portal/_preferences.ts");
const PAGE = read("app/customer-portal/[token]/profile/page.tsx");
/** DDL only — strip SQL comments so prose can't satisfy (or fail) a pin. */
const MIGRATION = readRaw(
  "supabase/migrations/20261082000000_portal_evolution.sql",
).replace(/^\s*--.*$/gm, "");

describe("the migration — one table, org-bound, tenant-read-only", () => {
  it("binds the row to a (customer, org) pair that must actually exist together", () => {
    expect(MIGRATION).toMatch(/foreign key \(customer_id, org_id\)\s*\n?\s*references public\.customers \(id, org_id\)/);
    expect(MIGRATION).toMatch(/primary key \(org_id, customer_id\)/);
  });

  it("bounds both writable fields in the DATABASE, not just in zod", () => {
    expect(MIGRATION).toMatch(
      /check \(preferred_channel in \('email', 'phone', 'whatsapp', 'post'\)\)/,
    );
    expect(MIGRATION).toMatch(
      /check \(contact_notes is null or char_length\(contact_notes\) <= 500\)/,
    );
  });

  it("enables RLS and grants tenants exactly one policy: member SELECT", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.customer_portal_preferences enable row level security/,
    );
    expect(MIGRATION).toMatch(
      /for select using \(org_id in \(select public\.current_org_ids\(\)\)\)/,
    );
    // No tenant write path: the portal's service-role action is the only writer.
    expect(MIGRATION).not.toMatch(/for insert/);
    expect(MIGRATION).not.toMatch(/for update/);
    expect(MIGRATION).not.toMatch(/for delete/);
  });

  it("touches nothing else — no bucket, no policy on existing tables, no alter of customers", () => {
    expect(MIGRATION).not.toMatch(/storage\./);
    expect(MIGRATION).not.toMatch(/alter table public\.customers\b/);
    expect(MIGRATION.match(/create table/g) ?? []).toHaveLength(1);
  });
});

describe("preferences write — idempotent, bounded, token-identified", () => {
  it("upserts on the natural key so a resubmit is a no-op, not a duplicate", () => {
    expect(ACTIONS).toMatch(/\.upsert\(/);
    expect(ACTIONS).toMatch(/onConflict: "org_id,customer_id"/);
  });

  it("stamps identity from the token-resolved customer only", () => {
    expect(ACTIONS).toMatch(/org_id: customer\.org_id/);
    expect(ACTIONS).toMatch(/customer_id: customer\.id/);
    for (const field of ["customer_id", "org_id"]) {
      expect(ACTIONS).not.toContain(`formData.get("${field}")`);
    }
  });

  it("validates through the bounded schema and rate-limits on portal_write", () => {
    expect(ACTIONS).toMatch(/portalPreferencesSchema\.safeParse/);
    expect(
      ACTIONS.match(/consume\("portal_write", token, DEFAULT_LIMITS\.portal_write\)/g) ?? [],
    ).toHaveLength(2); // both actions in the file are throttled
  });

  it("zod bounds mirror the DB checks", () => {
    expect(
      portalPreferencesSchema.safeParse({ preferred_channel: "whatsapp" }).success,
    ).toBe(true);
    expect(
      portalPreferencesSchema.safeParse({ preferred_channel: "carrier_pigeon" }).success,
    ).toBe(false);
    expect(
      portalPreferencesSchema.safeParse({
        preferred_channel: "email",
        contact_notes: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      portalPreferencesSchema.safeParse({
        preferred_channel: "email",
        contact_notes: "x".repeat(500),
      }).success,
    ).toBe(true);
  });
});

describe("profile changes are REQUESTS — the portal never writes customers", () => {
  it("the action file never touches the customers table", () => {
    expect(ACTIONS).not.toContain('from("customers"');
    expect(ACTIONS).not.toContain("from('customers'");
  });

  it("creates a ticket in the EXISTING 'account' category, stamped to this customer", () => {
    expect(ACTIONS).toMatch(/category: "account"/);
    expect(ACTIONS).toMatch(/subject: "Contact details update request"/);
    // support_tickets insert carries the customer scope column the portal
    // messages list filters on (20260706000000).
    expect(ACTIONS.match(/customer_id: customer\.id/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("requires at least one requested field, each bounded", () => {
    expect(profileUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      profileUpdateRequestSchema.safeParse({ requested_email: "not-an-email" }).success,
    ).toBe(false);
    expect(
      profileUpdateRequestSchema.safeParse({ requested_name: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      profileUpdateRequestSchema.safeParse({ requested_phone: "07123 456789" }).success,
    ).toBe(true);
  });

  it("the ticket body lists only the fields the customer asked to change", () => {
    const body = buildProfileUpdateTicketBody({
      current: { name: "Old Name", email: "old@example.com", phone: null },
      requested: { requested_email: "new@example.com" },
    });
    expect(body).toContain("old@example.com → new@example.com");
    expect(body).not.toContain("Name:");
    expect(body).not.toContain("Phone:");
    expect(body).toContain("apply manually");
  });

  it("the page says plainly that changes are reviewed, not instant", () => {
    expect(PAGE).toMatch(/reviewed\s*\n?\s*and applied by/);
  });
});

describe("the preferences read", () => {
  it("addresses at most the caller's own row — both halves of the PK", () => {
    expect(LOADER).toMatch(
      /\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("customer_id", customerId\)\s*\n?\s*\.maybeSingle\(\)/,
    );
  });

  it("fails loud and projects through the builder", () => {
    expect(LOADER).toMatch(/throw readFailure\("portal preferences: load", error\)/);
    expect(LOADER).toMatch(/buildPortalPreferencesView\(data\)/);
  });

  it("the view has exactly the declared keys and coerces junk channels", () => {
    const view = buildPortalPreferencesView({
      preferred_channel: "SENTINEL-JUNK",
      contact_notes: null,
      updated_at: "2026-07-30T09:00:00.000Z",
      org_id: "SENTINEL-ORG-UUID",
      created_at: "SENTINEL-CREATED",
    } as Parameters<typeof buildPortalPreferencesView>[0]);
    expect(Object.keys(view).sort()).toEqual([...PREFERENCES_PORTAL_KEYS].sort());
    expect(view.preferred_channel).toBe("email");
    expect(view.updated_on).toBe("2026-07-30");
    const json = JSON.stringify(view);
    expect(json).not.toContain("SENTINEL");
  });
});
