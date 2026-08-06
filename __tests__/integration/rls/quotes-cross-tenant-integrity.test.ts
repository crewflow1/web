import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient, anonClient } from "../_harness";

/**
 * Tenant integrity — a QUOTE may reference only a customer / property / lead /
 * job in the SAME org. Proved against real Postgres.
 *
 * The defect (hostile-audit 🔴): quotes.{customer,property,lead,job}_id were BARE
 * FKs to the global parent tables. The only write guard was `.eq("org_id", …)` on
 * the ROW, which constrains the org_id the caller supplies, never the reference the
 * row POINTS AT. So a caller in org A could attach org B's customer — and quotes
 * are WORSE than jobs/leads because /q/[token] renders customer name+email on a
 * PUBLIC, unauthenticated, service-role route: a cross-tenant PII leak. Migration
 * 20261113000000 closes it with COMPOSITE FKs (col, org_id) -> parent(id, org_id).
 *
 * The suite runs on the SERVICE-ROLE client deliberately (the invoice-payments /
 * jobs-leads idiom): that client BYPASSES RLS and is the most privileged writer
 * the app has (the public portal + every admin path use it). If the constraint
 * holds against it, no application writer can bypass the invariant.
 *
 * Fixtures are created and torn down per-run; org deletion cascades.
 */

type InsertResult = { data: Record<string, unknown> | null; error: { message: string; code?: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => { single: () => Promise<InsertResult> };
    } & Promise<{ error: { message: string; code?: string } | null }>;
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<InsertResult>;
      };
    };
    update: (v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string; code?: string } | null }>;
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-qxt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function mkOrg(label: string): Promise<string> {
  const res = await db(serviceClient())
    .from("organizations")
    .insert({ name: `QXT Org ${label}`, slug: `${TOKEN}-${label.toLowerCase()}` })
    .select("id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  const id = res.data?.id as string;
  if (!id) throw new Error(`failed to create org ${label}`);
  return id;
}

describeIntegration("quotes · cross-tenant reference integrity (composite FKs)", () => {
  let orgA = "";
  let orgB = "";
  let customerA = "";
  let customerB = "";
  let propertyA = "";
  let propertyB = "";
  let leadA = "";
  let leadB = "";
  let jobA = "";
  let jobB = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgA = await mkOrg("A");
    orgB = await mkOrg("B");

    for (const [org, ref] of [
      [orgA, "A"],
      [orgB, "B"],
    ] as const) {
      const c = await svc
        .from("customers")
        .insert({ org_id: org, name: `${TOKEN} Customer ${ref}` })
        .select("id")
        .single();
      expect(c.error, c.error?.message).toBeNull();
      const customerId = c.data?.id as string;
      if (ref === "A") customerA = customerId;
      else customerB = customerId;

      // property belongs to that org + customer (properties.customer_id NOT NULL).
      const p = await svc
        .from("properties")
        .insert({ org_id: org, customer_id: customerId, address: { line1: `${ref} St` } })
        .select("id")
        .single();
      expect(p.error, p.error?.message).toBeNull();
      if (ref === "A") propertyA = p.data?.id as string;
      else propertyB = p.data?.id as string;

      const l = await svc
        .from("leads")
        .insert({ org_id: org, source: "phone", status: "new" })
        .select("id")
        .single();
      expect(l.error, l.error?.message).toBeNull();
      if (ref === "A") leadA = l.data?.id as string;
      else leadB = l.data?.id as string;

      const j = await svc
        .from("jobs")
        .insert({ org_id: org, customer_id: customerId, status: "new" })
        .select("id")
        .single();
      expect(j.error, j.error?.message).toBeNull();
      if (ref === "A") jobA = j.data?.id as string;
      else jobB = j.data?.id as string;
    }
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    for (const id of [orgA, orgB]) {
      if (!id) continue;
      const del = await svc.from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
  });

  // A minimal valid quote row for org A; caller overrides one reference field.
  function quoteRow(over: Record<string, unknown>): Record<string, unknown> {
    return {
      org_id: orgA,
      customer_id: customerA,
      number: `${TOKEN}-${Math.random().toString(36).slice(2, 8)}`,
      status: "draft",
      currency: "GBP",
      subtotal: 0,
      vat_total: 0,
      total: 0,
      public_token: `${TOKEN}-${Math.random().toString(36).slice(2, 10)}`,
      ...over,
    };
  }

  // ── DB layer: composite FK refuses each foreign reference (service role) ─────

  it("REJECTS an org-A quote pointing at org B's customer (quotes_customer_org_fkey)", async () => {
    const res = await db(serviceClient()).from("quotes").insert(quoteRow({ customer_id: customerB }));
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("23503");
    expect(res.error?.message ?? "").toContain("quotes_customer_org_fkey");
  });

  it("REJECTS an org-A quote pointing at org B's property (quotes_property_org_fkey)", async () => {
    const res = await db(serviceClient()).from("quotes").insert(quoteRow({ property_id: propertyB }));
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("23503");
    expect(res.error?.message ?? "").toContain("quotes_property_org_fkey");
  });

  it("REJECTS an org-A quote pointing at org B's lead (quotes_lead_org_fkey)", async () => {
    const res = await db(serviceClient()).from("quotes").insert(quoteRow({ lead_id: leadB }));
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("23503");
    expect(res.error?.message ?? "").toContain("quotes_lead_org_fkey");
  });

  it("REJECTS an org-A quote pointing at org B's job (quotes_job_org_fkey)", async () => {
    const res = await db(serviceClient()).from("quotes").insert(quoteRow({ job_id: jobB }));
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("23503");
    expect(res.error?.message ?? "").toContain("quotes_job_org_fkey");
  });

  it("REJECTS re-pointing an org-A quote at org B's customer via UPDATE (the updateQuote path)", async () => {
    const svc = db(serviceClient());
    const created = await svc.from("quotes").insert(quoteRow({})).select("id").single();
    expect(created.error, created.error?.message).toBeNull();
    const quoteId = created.data?.id as string;

    const upd = await svc.from("quotes").update({ customer_id: customerB }).eq("id", quoteId);
    expect(upd.error).not.toBeNull();
    expect(upd.error?.code).toBe("23503");
    expect(upd.error?.message ?? "").toContain("quotes_customer_org_fkey");
  });

  // ── positive paths — same-org references succeed unchanged ──────────────────

  it("ACCEPTS an org-A quote with same-org customer + property + lead + job", async () => {
    const res = await db(serviceClient())
      .from("quotes")
      .insert(
        quoteRow({ customer_id: customerA, property_id: propertyA, lead_id: leadA, job_id: jobA }),
      )
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.id).toBeTruthy();
  });

  it("ACCEPTS an org-A quote with only the (NOT NULL) customer set — nullable refs stay unchecked", async () => {
    const res = await db(serviceClient()).from("quotes").insert(quoteRow({})).select("id").single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.id).toBeTruthy();
  });

  // ── ON DELETE semantics preserved on the nullable refs ─────────────────────

  it("deleting a property NULLs the quote's property_id but keeps the row + NOT NULL org_id", async () => {
    const svc = db(serviceClient());
    // A throwaway property in org B + a quote in org B that references it.
    const p = await svc
      .from("properties")
      .insert({ org_id: orgB, customer_id: customerB, address: { line1: "Throwaway" } })
      .select("id")
      .single();
    expect(p.error, p.error?.message).toBeNull();
    const throwawayProperty = p.data?.id as string;

    const q = await svc
      .from("quotes")
      .insert(
        quoteRow({
          org_id: orgB,
          customer_id: customerB,
          property_id: throwawayProperty,
        }),
      )
      .select("id")
      .single();
    expect(q.error, q.error?.message).toBeNull();
    const quoteId = q.data?.id as string;

    const del = await svc.from("properties").delete().eq("id", throwawayProperty);
    expect(del.error, del.error?.message).toBeNull();

    const after = await svc.from("quotes").select("property_id, org_id").eq("id", quoteId).maybeSingle();
    expect(after.error, after.error?.message).toBeNull();
    expect(after.data).not.toBeNull();
    expect(after.data?.property_id).toBeNull();
    expect(after.data?.org_id).toBe(orgB);
  });

  it("a customer with quotes cannot be deleted — customer_id keeps NO ACTION (NOT NULL, no SET NULL)", async () => {
    const svc = db(serviceClient());
    const c = await svc
      .from("customers")
      .insert({ org_id: orgB, name: `${TOKEN} Undeletable` })
      .select("id")
      .single();
    expect(c.error, c.error?.message).toBeNull();
    const custId = c.data?.id as string;

    const q = await svc
      .from("quotes")
      .insert(quoteRow({ org_id: orgB, customer_id: custId }))
      .select("id")
      .single();
    expect(q.error, q.error?.message).toBeNull();

    // NO ACTION: the delete is refused while a quote references the customer.
    const del = await svc.from("customers").delete().eq("id", custId);
    expect(del.error).not.toBeNull();
    expect(del.error?.message ?? "").toContain("quotes_customer_org_fkey");
  });

  it("the anon (RLS) client is still denied a cross-org read — the outer boundary is intact", async () => {
    const res = await (anonClient() as unknown as Db).from("quotes").select("id").eq("org_id", orgA).maybeSingle();
    expect(res.data ?? null).toBeNull();
  });
});
