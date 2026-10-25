import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Migration G1 — imported invoices link to their customer, against real Postgres.
 *
 * The commit path resolves an invoice's `customer_name` to a same-org customer
 * via resolveCustomerByName (app/(app)/imports/actions.ts): a case-insensitive,
 * org-scoped lookup (`.eq("org_id", orgId).ilike("name", name)`). This suite
 * replicates that EXACT query shape — the resolver is a private function in a
 * "use server" module and must not be exported (every export there becomes a
 * callable endpoint) — and then inserts invoices the way insertOne does, to
 * prove the three facts a unit test cannot:
 *
 *   (a) a matching name resolves and links customer_id;
 *   (b) a non-matching name resolves to null, and the invoice still imports
 *       with customer_id NULL (no throw, no skip);
 *   (c) a same-named customer in a DIFFERENT org is NOT linked — org scoping.
 *
 * Runs on the service-role client (the writer the importer uses, the most
 * privileged one), so the composite-FK backstop is exercised too: even this
 * writer cannot land a cross-org customer_id.
 */

type Row = Record<string, unknown>;
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{
          data: Row | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        ilike: (k: string, v: unknown) => {
          limit: (n: number) => {
            maybeSingle: () => Promise<{
              data: Row | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
    delete: () => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-invlink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// The resolver, byte-for-byte as resolveCustomerByName runs it in the commit
// path. Keep this identical to app/(app)/imports/actions.ts.
const resolveCustomerByName = async (
  orgId: string,
  name: string,
): Promise<string | null> => {
  const { data } = await db(serviceClient())
    .from("customers")
    .select("id")
    .eq("org_id", orgId)
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
};

describeIntegration("imports · invoice → customer linking (G1)", () => {
  let orgA = "";
  let orgB = "";
  let custA = "";
  let n = 0;

  // Insert an invoice the way insertOne's invoice case does: service-role,
  // generated `total` omitted, customer_id present only when resolved.
  const mkInvoice = async (org: string, customerId: string | null) => {
    n += 1;
    return db(serviceClient())
      .from("invoices")
      .insert({
        org_id: org,
        ...(customerId ? { customer_id: customerId } : {}),
        number: `${TOKEN}-INV-${n}`,
        amount: 100,
        vat_total: 0,
        status: "sent",
      })
      .select("id, customer_id, org_id")
      .single();
  };

  beforeAll(async () => {
    const svc = db(serviceClient());
    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const o = await svc
        .from("organizations")
        .insert({ name: `InvLink ${label}`, slug })
        .select("id")
        .single();
      expect(o.error, o.error?.message).toBeNull();
      if (label === "A") orgA = o.data?.id as string;
      else orgB = o.data?.id as string;
    }
    // Same display name "Acme Ltd" in BOTH orgs — the whole point of the org
    // scoping proof. Casing differs to also exercise the ilike.
    const ca = await svc
      .from("customers")
      .insert({ org_id: orgA, name: "Acme Ltd" })
      .select("id")
      .single();
    expect(ca.error, ca.error?.message).toBeNull();
    custA = ca.data?.id as string;
    const cb = await svc
      .from("customers")
      .insert({ org_id: orgB, name: "Acme Ltd" })
      .select("id")
      .single();
    expect(cb.error, cb.error?.message).toBeNull();
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      if (id) await db(serviceClient()).from("organizations").delete().eq("id", id);
    }
  });

  it("(a) links the invoice to a matching same-org customer (case-insensitive)", async () => {
    const resolved = await resolveCustomerByName(orgA, "acme ltd");
    expect(resolved).toBe(custA);

    const inv = await mkInvoice(orgA, resolved);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(inv.data?.customer_id).toBe(custA);
  });

  it("(b) a non-matching name resolves to null and the invoice imports unlinked", async () => {
    const resolved = await resolveCustomerByName(orgA, "No Such Customer");
    expect(resolved).toBeNull();

    const inv = await mkInvoice(orgA, resolved);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(inv.data?.customer_id).toBeNull();
  });

  it("(c) a same-named customer in a DIFFERENT org is NOT linked (org scoping)", async () => {
    // Resolving "Acme Ltd" under org A can only ever return org A's customer,
    // never org B's — even though both carry that exact name.
    const resolved = await resolveCustomerByName(orgA, "Acme Ltd");
    expect(resolved).toBe(custA);

    // And the database refuses a cross-org link outright: org A invoice +
    // org B's customer id → composite FK violation (23503). Defence in depth
    // behind the org-scoped resolver.
    const bCust = await resolveCustomerByName(orgB, "Acme Ltd");
    expect(bCust).not.toBeNull();
    expect(bCust).not.toBe(custA);
    const bad = await mkInvoice(orgA, bCust);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.code).toBe("23503");
    expect(bad.error?.message ?? "").toContain("invoices_customer_org_fkey");
  });
});
