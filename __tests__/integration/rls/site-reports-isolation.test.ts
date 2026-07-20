import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * Site Reports — real-Postgres security proof (20260922000000).
 *
 * Proves the load-bearing guarantees against a live database:
 *   1. tenant isolation — anon + an authenticated non-member cannot read a report;
 *   2. SNAPSHOT IMMUTABILITY — once `snapshot` is set it can never change, and
 *      once issued the `content` is frozen. Enforced by the trigger
 *      tg_site_reports_immutable, so even the service_role writer (the most
 *      privileged path, which BYPASSES RLS) is blocked — a frozen customer report
 *      can never silently change when its source records are later edited;
 *   3. the shared tenant_attachments CHECK now admits 'site_reports', still
 *      admits the earlier Site Management targets ('snags'), and still rejects a
 *      bogus target — the fourth stacked widening preserved everything.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("site_reports · isolation + immutability", () => {
  let orgId = "";
  let reportId = "";
  let authUserId = "";
  let authToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const org = await svc
      .from("organizations")
      .insert({ name: "Site Reports Probe Org", slug: TOKEN })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");
    if (!orgId) throw new Error("failed to create probe organisation");

    const report = await svc
      .from("site_reports")
      .insert({
        org_id: orgId,
        title: "Probe report",
        period_start: "2026-07-01",
        period_end: "2026-07-07",
      })
      .select("id")
      .single();
    expect(report.error, report.error?.message).toBeNull();
    reportId = String(report.data?.id ?? "");
    if (!reportId) throw new Error("failed to create probe report");

    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    authUserId = created.data.user?.id ?? "";
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    authToken = signedIn.data.session?.access_token ?? "";
    if (!authToken) throw new Error("failed to mint an authenticated token");
  });

  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    if (authUserId) await serviceClient().auth.admin.deleteUser(authUserId);
  });

  it("anon cannot read a report (RLS)", async () => {
    const { data, error } = await db(anonClient())
      .from("site_reports")
      .select("id")
      .eq("id", reportId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated non-member cannot read a report (membership-gated)", async () => {
    const { data, error } = await db(userClient(authToken))
      .from("site_reports")
      .select("id")
      .eq("id", reportId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("freezes the snapshot write-once and the content after issue (trigger)", async () => {
    const svc = db(serviceClient());

    // Issue: set the snapshot for the first time (allowed).
    const issue = await svc
      .from("site_reports")
      .update({
        status: "issued",
        snapshot: { title: "Probe report", frozen: true },
        issued_at: new Date("2026-07-08T09:00:00.000Z").toISOString(),
      })
      .eq("id", reportId);
    expect(issue.error, issue.error?.message).toBeNull();

    // Attempt to rewrite the snapshot — the trigger must reject it, even for
    // service_role.
    const rewrite = await svc
      .from("site_reports")
      .update({ snapshot: { title: "TAMPERED", frozen: false } })
      .eq("id", reportId);
    expect(rewrite.error).not.toBeNull();

    // Attempt to edit content after issue — also rejected.
    const editContent = await svc
      .from("site_reports")
      .update({ content: { summary: "changed after issue" } })
      .eq("id", reportId);
    expect(editContent.error).not.toBeNull();

    // The stored snapshot is unchanged.
    const { data } = await svc
      .from("site_reports")
      .select("snapshot")
      .eq("id", reportId);
    expect((data?.[0]?.snapshot as { frozen?: boolean })?.frozen).toBe(true);
  });

  it("tenant_attachments accepts 'site_reports', still accepts 'snags', rejects bogus", async () => {
    const svc = db(serviceClient());
    const okReport = await svc.from("tenant_attachments").insert({
      org_id: orgId,
      target_table: "site_reports",
      target_id: reportId,
      filename: "cover.jpg",
      storage_path: `${orgId}/site_reports/${reportId}/cover.jpg`,
    });
    expect(okReport.error, okReport.error?.message).toBeNull();

    // Prior Site Management target must remain valid (widening preserved it).
    const okSnag = await svc.from("tenant_attachments").insert({
      org_id: orgId,
      target_table: "snags",
      target_id: reportId, // any uuid; the CHECK is on target_table only
      filename: "s.jpg",
      storage_path: `${orgId}/snags/x.jpg`,
    });
    expect(okSnag.error, okSnag.error?.message).toBeNull();

    const bogus = await svc.from("tenant_attachments").insert({
      org_id: orgId,
      target_table: "not_a_real_table",
      target_id: reportId,
      filename: "x.jpg",
      storage_path: `${orgId}/x.jpg`,
    });
    expect(bogus.error).not.toBeNull();
  });
});
