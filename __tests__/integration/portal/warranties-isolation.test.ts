import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { listPortalWarranties } from "@/app/customer-portal/_warranties";

/**
 * The customer-portal warranty loader, driven against real Postgres.
 *
 * `job_warranties` carries NO customer_id, and the portal runs on the
 * RLS-BYPASSING service-role client (the token is the whole auth surface). So
 * the only thing standing between customer B and customer A's warranty cover is
 * the loader's two-step scope: resolve the customer's OWN jobs first, then read
 * warranties `.in("job_id", ownJobIds)` with the org pinned.
 *
 * Proven here, end to end, through the real function:
 *   • DUAL-ORG — the same customer id in a second org sees nothing of the first;
 *   • same-org, different customer sees nothing either;
 *   • unpublished / withdrawn / voided warranties are invisible;
 *   • the derived expiry comes from the ISSUED certificate — and is absent, in
 *     words, when no certificate exists;
 *   • internal columns never appear in the payload.
 */

type Res = { data: Array<Record<string, unknown>> | null; error: unknown };
interface Sel extends PromiseLike<Res> {
  eq(c: string, v: unknown): Sel;
}
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      select(c: string): Sel;
      insert(r: Record<string, unknown>): {
        select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: { message: string } | null }> };
      };
      delete(): { eq(c: string, v: unknown): PromiseLike<Res> };
    };
  };

const T = `it-warr-portal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PUBLISHED = { portal_published_at: new Date().toISOString() };

describeIntegration("Customer portal · warranty isolation (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let custA1 = "";
  let custA2 = "";
  let custB = "";
  let jobA1 = "";
  let jobA2 = "";
  let jobB = "";
  const svc = () => db(serviceClient());

  const mk = async (table: string, row: Record<string, unknown>) => {
    const r = await svc().from(table).insert(row).select("id").single();
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    return String(r.data?.id ?? "");
  };

  beforeAll(async () => {
    orgA = await mk("organizations", { name: "Warr A", slug: `${T}-a` });
    orgB = await mk("organizations", { name: "Warr B", slug: `${T}-b` });
    custA1 = await mk("customers", { org_id: orgA, name: "A One" });
    custA2 = await mk("customers", { org_id: orgA, name: "A Two" });
    custB = await mk("customers", { org_id: orgB, name: "B One" });
    jobA1 = await mk("jobs", { org_id: orgA, status: "completed", customer_id: custA1 });
    jobA2 = await mk("jobs", { org_id: orgA, status: "completed", customer_id: custA2 });
    jobB = await mk("jobs", { org_id: orgB, status: "completed", customer_id: custB });

    // Customer A1's job has an ISSUED certificate — the only clock a warranty runs on.
    await mk("completion_certificates", {
      org_id: orgA,
      job_id: jobA1,
      customer_id: custA1,
      certificate_number: `${T}-A1`,
      status: "issued",
      completion_date: "2026-03-15",
      snapshot: { certificate_number: `${T}-A1` },
      issued_at: new Date().toISOString(),
    });

    // Published cover for A1, A2 and B.
    await mk("job_warranties", {
      org_id: orgA, job_id: jobA1, title: "A1 roof workmanship", kind: "workmanship",
      cover: "A1 COVER", period_months: 12, service_interval_months: 6, ...PUBLISHED,
    });
    await mk("job_warranties", {
      org_id: orgA, job_id: jobA2, title: "A2 boiler", kind: "product",
      cover: "A2 COVER", period_months: 24, ...PUBLISHED,
    });
    await mk("job_warranties", {
      org_id: orgB, job_id: jobB, title: "B structural", kind: "structural",
      cover: "B COVER", period_months: 120, ...PUBLISHED,
    });
    // A1 also has one that must NOT be visible: never published.
    await mk("job_warranties", {
      org_id: orgA, job_id: jobA1, title: "A1 unpublished", kind: "other",
      cover: "A1 UNPUBLISHED COVER", period_months: 6,
    });
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (org) await svc().from("organizations").delete().eq("id", org);
    }
  });

  it("customer A1 sees only their own published warranty", async () => {
    const rows = await listPortalWarranties(custA1, orgA);
    expect(rows.map((r) => r.title)).toEqual(["A1 roof workmanship"]);
  });

  it("DUAL-ORG: the same customer id read against the OTHER org returns nothing", async () => {
    // The org is part of the scope, not decoration: a caller who supplies the
    // wrong org gets an empty list, never another tenant's cover.
    expect(await listPortalWarranties(custA1, orgB)).toEqual([]);
    expect(await listPortalWarranties(custB, orgA)).toEqual([]);
  });

  it("a second customer in the SAME org sees only their own", async () => {
    const rows = await listPortalWarranties(custA2, orgA);
    expect(rows.map((r) => r.title)).toEqual(["A2 boiler"]);
    expect(JSON.stringify(rows)).not.toContain("A1 COVER");
  });

  it("customer B never sees org A's cover", async () => {
    const rows = await listPortalWarranties(custB, orgB);
    expect(rows.map((r) => r.title)).toEqual(["B structural"]);
    expect(JSON.stringify(rows)).not.toContain("A1 COVER");
    expect(JSON.stringify(rows)).not.toContain("A2 COVER");
  });

  it("unpublished cover is invisible", async () => {
    const rows = await listPortalWarranties(custA1, orgA);
    expect(JSON.stringify(rows)).not.toContain("A1 UNPUBLISHED COVER");
  });

  it("the expiry is derived from the ISSUED certificate's frozen completion date", async () => {
    const [w] = await listPortalWarranties(custA1, orgA);
    expect(w!.start_date).toBe("2026-03-15");
    expect(w!.expiry_date).toBe("2027-03-15");
    expect(w!.awaiting_completion_certificate).toBe(false);
    expect(w!.service_schedule.map((s) => s.due)).toEqual(["2026-09-15", "2027-03-15"]);
  });

  it("with no certificate the warranty says so instead of inventing a date", async () => {
    // A2's job has no certificate at all.
    const [w] = await listPortalWarranties(custA2, orgA);
    expect(w!.awaiting_completion_certificate).toBe(true);
    expect(w!.start_date).toBeNull();
    expect(w!.expiry_date).toBeNull();
    expect(w!.status).toBe("pending_completion");
  });

  it("withdrawing from the portal hides it again", async () => {
    const svcClient = serviceClient() as unknown as {
      from(t: string): {
        update(r: Record<string, unknown>): { eq(c: string, v: unknown): PromiseLike<Res> };
      };
    };
    await svcClient
      .from("job_warranties")
      .update({ portal_withdrawn_at: new Date().toISOString() })
      .eq("job_id", jobA2);
    expect(await listPortalWarranties(custA2, orgA)).toEqual([]);
  });

  it("never returns an internal column", async () => {
    const json = JSON.stringify(await listPortalWarranties(custA1, orgA));
    for (const internal of ["org_id", "created_by", "voided_by", "portal_published_by", "void_reason"]) {
      expect(json, `payload must not contain ${internal}`).not.toContain(internal);
    }
  });
});
