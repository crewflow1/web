import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient, anonClient } from "../_harness";
import { isPortalVisible } from "@/lib/site-reports/portal";
import { extractSnapshotPhotoIds } from "@/lib/site-reports/portal-photos";

/**
 * Train 4 (portal evolution) — dual-customer access proof against real Postgres.
 *
 * The portal has no customer JWT: the URL token resolves to a (customer_id,
 * org_id) pair on the service-role client and every read/write is scoped IN
 * CODE by that pair. These tests replicate the EXACT queries the new portal
 * surfaces run (service_role == the portal's admin client) and prove, on a
 * live database:
 *
 *   preferences — A1's read addresses only A1's row; a (customer, org) pair
 *                 that disagrees is UNREPRESENTABLE (composite FK); the upsert
 *                 is idempotent; anon gets nothing (RLS: select-only for org
 *                 members, no anon path).
 *   requests    — A1's read-back never returns A2's portal requests, org B's
 *                 leads, or staff-created leads that merely link A1.
 *   photos      — a photo id planted in A1's snapshot that belongs to another
 *                 customer's job (or another org) is dropped by the
 *                 verification chain even though the id is "known".
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Q extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Q;
  in(k: string, v: unknown[]): Q;
  not(k: string, op: string, v: unknown): Q;
  is(k: string, v: unknown): Q;
  order(k: string, o: { ascending: boolean }): Q;
  limit(n: number): Q;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Q;
  insert(r: Row | Row[]): Ins;
  upsert(r: Row, o: { onConflict: string }): PromiseLike<Res<null>>;
  delete(): { eq(k: string, v: unknown): PromiseLike<Res<null>> };
}
const db = (c: unknown) => c as unknown as { from(t: string): Table };

const STAMP = `it-pev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── replicated portal reads (must mirror the app loaders exactly) ───────────

/** app/customer-portal/_preferences.ts */
async function portalPrefs(customerId: string, orgId: string) {
  const { data } = await db(serviceClient())
    .from("customer_portal_preferences")
    .select("preferred_channel, contact_notes, updated_at")
    .eq("org_id", orgId)
    .eq("customer_id", customerId)
    .maybeSingle();
  return data ?? null;
}

/** app/customer-portal/_future-work.ts */
async function portalRequests(customerId: string, orgId: string) {
  const { data } = await db(serviceClient())
    .from("leads")
    .select("id, service, status, created_at")
    .eq("org_id", orgId)
    .eq("customer_id", customerId)
    .eq("source", "portal")
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
}

/** app/customer-portal/_photos.ts — steps 1-3 (everything before signing). */
async function portalPhotoAttachmentIds(customerId: string, orgId: string) {
  const { data: reports } = await db(serviceClient())
    .from("site_reports")
    .select("id, job_id, status, snapshot, portal_published_at, portal_withdrawn_at")
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .in("status", ["issued", "superseded"])
    .not("portal_published_at", "is", null)
    .is("portal_withdrawn_at", null)
    .order("portal_published_at", { ascending: false })
    .limit(50);
  const visible = (reports ?? []).filter((r) =>
    isPortalVisible({
      status: r.status as string,
      portal_published_at: (r.portal_published_at as string) ?? null,
      portal_withdrawn_at: (r.portal_withdrawn_at as string) ?? null,
    }),
  );
  const reportByPhotoId = new Map<string, Row>();
  for (const report of visible) {
    for (const id of extractSnapshotPhotoIds(report.snapshot)) {
      if (!reportByPhotoId.has(id)) reportByPhotoId.set(id, report);
    }
  }
  if (reportByPhotoId.size === 0) return [];
  const { data: atts } = await db(serviceClient())
    .from("tenant_attachments")
    .select("id, target_id, storage_path, mime_type")
    .in("id", [...reportByPhotoId.keys()])
    .eq("org_id", orgId)
    .eq("target_table", "jobs");
  return (atts ?? [])
    .filter((a) => {
      const report = reportByPhotoId.get(a.id as string);
      return (
        !!report &&
        report.job_id != null &&
        a.target_id === report.job_id &&
        ((a.mime_type as string) ?? "").startsWith("image/")
      );
    })
    .map((a) => a.id as string);
}

describeIntegration("portal evolution · dual-customer isolation", () => {
  let orgA = "";
  let orgB = "";
  let custA1 = "";
  let custA2 = "";
  let custB1 = "";
  let jobA1 = "";
  let jobA2 = "";
  let jobB1 = "";
  let attA1 = "";
  let attA2 = "";
  let attB1 = "";
  let leadA2 = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const mk = async (t: string, row: Row) => {
      const { data, error } = await svc.from(t).insert(row).select("id").single();
      expect(error, `${t}: ${error?.message}`).toBeNull();
      return String(data?.id ?? "");
    };
    orgA = await mk("organizations", { name: `PEV A ${STAMP}`, slug: `${STAMP}-a` });
    orgB = await mk("organizations", { name: `PEV B ${STAMP}`, slug: `${STAMP}-b` });
    custA1 = await mk("customers", { org_id: orgA, name: "PEV Customer A1" });
    custA2 = await mk("customers", { org_id: orgA, name: "PEV Customer A2" });
    custB1 = await mk("customers", { org_id: orgB, name: "PEV Customer B1" });
    jobA1 = await mk("jobs", { org_id: orgA, customer_id: custA1, status: "new" });
    jobA2 = await mk("jobs", { org_id: orgA, customer_id: custA2, status: "new" });
    jobB1 = await mk("jobs", { org_id: orgB, customer_id: custB1, status: "new" });

    // Job-image attachments, one per customer.
    const att = (org: string, job: string, n: string) => ({
      org_id: org,
      target_table: "jobs",
      target_id: job,
      filename: `pev-${n}.jpg`,
      storage_path: `${org}/${job}/pev-${n}.jpg`,
      mime_type: "image/jpeg",
    });
    attA1 = await mk("tenant_attachments", att(orgA, jobA1, "a1"));
    attA2 = await mk("tenant_attachments", att(orgA, jobA2, "a2"));
    attB1 = await mk("tenant_attachments", att(orgB, jobB1, "b1"));

    // A1's PUBLISHED report whose snapshot claims A1's photo — plus, as the
    // attack fixture, A2's and org B's attachment ids planted in the same
    // snapshot (a compromised/corrupted snapshot must still not cross scope).
    await mk("site_reports", {
      org_id: orgA,
      customer_id: custA1,
      job_id: jobA1,
      title: "PEV published report",
      period_start: "2026-07-01",
      period_end: "2026-07-07",
      status: "issued",
      portal_published_at: "2026-07-08T09:00:00.000Z",
      snapshot: {
        content: { sources: { photo_attachment_ids: [attA1, attA2, attB1] } },
      },
    });

    // Portal-sourced leads for both A-customers, a staff lead linking A1, and
    // an org-B portal lead.
    const now = new Date().toISOString();
    const lead = (org: string, cust: string, source: string, service: string) => ({
      org_id: org,
      customer_id: cust,
      contact_name: "PEV",
      contact_email: "pev@example.test",
      source,
      service,
      status: "new",
      first_contact_at: now,
      last_activity_at: now,
    });
    await mk("leads", lead(orgA, custA1, "portal", "A1 portal request"));
    leadA2 = await mk("leads", lead(orgA, custA2, "portal", "A2 portal request"));
    await mk("leads", lead(orgA, custA1, "phone", "A1 staff-created lead"));
    await mk("leads", lead(orgB, custB1, "portal", "B1 portal request"));

    // Preferences for both A-customers.
    const pref = (org: string, cust: string, channel: string, notes: string) =>
      svc.from("customer_portal_preferences").upsert(
        { org_id: org, customer_id: cust, preferred_channel: channel, contact_notes: notes },
        { onConflict: "org_id,customer_id" },
      );
    expect((await pref(orgA, custA1, "phone", "A1 private note")).error).toBeNull();
    expect((await pref(orgA, custA2, "whatsapp", "A2 private note")).error).toBeNull();
  });

  afterAll(async () => {
    // organizations cascade to customers, jobs, leads, attachments, reports,
    // and (new) customer_portal_preferences.
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  // ── preferences ────────────────────────────────────────────────────────────

  it("A1's preferences read returns A1's row and nothing of A2's", async () => {
    const p = await portalPrefs(custA1, orgA);
    expect(p?.preferred_channel).toBe("phone");
    expect(p?.contact_notes).toBe("A1 private note");
  });

  it("guessed ids cannot cross scope: (A2, orgA) via A1's identity is a different row; (A1, orgB) is nothing", async () => {
    // The portal can only ever call with the TOKEN-resolved pair; these are
    // the two guessed-pair shapes an attacker would need to work.
    const crossCustomer = await portalPrefs(custA2, orgA);
    expect(crossCustomer?.contact_notes).toBe("A2 private note"); // only reachable AS A2
    expect(await portalPrefs(custA1, orgB)).toBeNull();
    expect(await portalPrefs(custB1, orgA)).toBeNull();
  });

  it("a preference row whose (customer, org) pair disagrees is unrepresentable", async () => {
    const { error } = await db(serviceClient())
      .from("customer_portal_preferences")
      .upsert(
        { org_id: orgB, customer_id: custA1, preferred_channel: "email", contact_notes: null },
        { onConflict: "org_id,customer_id" },
      );
    expect(error, "composite FK must reject a cross-org preference").not.toBeNull();
  });

  it("the preferences upsert is idempotent — resubmits do not multiply rows", async () => {
    for (let i = 0; i < 2; i++) {
      const { error } = await db(serviceClient())
        .from("customer_portal_preferences")
        .upsert(
          { org_id: orgA, customer_id: custA1, preferred_channel: "phone", contact_notes: "A1 private note" },
          { onConflict: "org_id,customer_id" },
        );
      expect(error).toBeNull();
    }
    const { data } = await db(serviceClient())
      .from("customer_portal_preferences")
      .select("customer_id")
      .eq("org_id", orgA)
      .eq("customer_id", custA1);
    expect(data).toHaveLength(1);
  });

  it("anon (RLS) sees no preference rows at all", async () => {
    const { data } = await db(anonClient())
      .from("customer_portal_preferences")
      .select("contact_notes")
      .eq("org_id", orgA)
      .eq("customer_id", custA1);
    expect(data ?? []).toEqual([]);
  });

  // ── future-work requests ───────────────────────────────────────────────────

  it("A1's request read-back lists exactly A1's portal-sourced leads", async () => {
    const rows = await portalRequests(custA1, orgA);
    expect(rows.map((r) => r.service)).toEqual(["A1 portal request"]);
  });

  it("A2's portal request is invisible to A1 even by guessed id", async () => {
    const rows = await portalRequests(custA1, orgA);
    expect(rows.some((r) => r.id === leadA2)).toBe(false);
    // ...and legitimately visible to A2.
    const a2 = await portalRequests(custA2, orgA);
    expect(a2.map((r) => r.id)).toEqual([leadA2]);
  });

  it("tenant isolation: org B's portal leads never surface under org A scoping", async () => {
    expect(await portalRequests(custB1, orgA)).toEqual([]);
    expect(await portalRequests(custA1, orgB)).toEqual([]);
  });

  // ── photos ─────────────────────────────────────────────────────────────────

  it("A1 sees only the photo on A1's own job — planted A2/org-B ids are dropped", async () => {
    const ids = await portalPhotoAttachmentIds(custA1, orgA);
    expect(ids).toEqual([attA1]);
    expect(ids).not.toContain(attA2);
    expect(ids).not.toContain(attB1);
  });

  it("A2 has no published report, so A2 sees no photos at all", async () => {
    expect(await portalPhotoAttachmentIds(custA2, orgA)).toEqual([]);
  });
});
