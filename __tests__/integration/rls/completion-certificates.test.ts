import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Completion certificates — DB contractual invariants against real Postgres
 * (20261014). A completion certificate is a legal-ish record, so the guarantees
 * below are enforced by the database, not the app:
 *   - snapshot + anchors immutable once issued (blocks EVEN service_role);
 *   - at most one live issued certificate per job;
 *   - tenant isolation (a non-member cannot read another org's cert).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): PromiseLike<Res<Row[]>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  update(r: Row): Upd;
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-cert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("completion certificates · DB invariants", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let certA = "";
  let outsiderId = "";
  let outsiderToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "Cert A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "Cert B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    const j = await svc.from("jobs").insert({ org_id: orgA, status: "completed" }).select("id").single();
    jobA = String(j.data?.id ?? "");
    // an issued cert on org A
    const c = await svc.from("completion_certificates").insert({
      org_id: orgA, job_id: jobA, certificate_number: "CERT-0001", status: "issued",
      completion_date: "2026-07-01", snapshot: { certificate_number: "CERT-0001", works_description: "x" }, issued_at: new Date().toISOString(),
    }).select("id").single();
    certA = String(c.data?.id ?? "");
    if (!orgA || !orgB || !jobA || !certA) throw new Error("fixture setup failed");

    // a member of org B (outsider to org A)
    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    outsiderId = created.data.user?.id ?? "";
    await db(serviceClient()).from("users").insert({ id: outsiderId, email, full_name: "Outsider" });
    await db(serviceClient()).from("memberships").insert({ org_id: orgB, user_id: outsiderId, role: "owner" });
    const signed = await anonClient().auth.signInWithPassword({ email, password });
    outsiderToken = signed.data.session?.access_token ?? "";
    if (!outsiderToken) throw new Error("failed to mint outsider token");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (outsiderId) await serviceClient().auth.admin.deleteUser(outsiderId);
  });

  it("freezes the snapshot once issued — even for service_role", async () => {
    const r = await db(serviceClient())
      .from("completion_certificates")
      .update({ snapshot: { tampered: true } })
      .eq("id", certA);
    expect(r.error, "snapshot must be immutable once set").not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/immutable/i);
  });

  it("freezes the completion_date + certificate_number once issued", async () => {
    const r1 = await db(serviceClient()).from("completion_certificates").update({ completion_date: "2026-09-01" }).eq("id", certA);
    expect(r1.error, "completion_date must be frozen").not.toBeNull();
    const r2 = await db(serviceClient()).from("completion_certificates").update({ certificate_number: "CERT-9999" }).eq("id", certA);
    expect(r2.error, "certificate_number must be frozen").not.toBeNull();
  });

  it("allows at most one LIVE issued certificate per job", async () => {
    const r = await db(serviceClient()).from("completion_certificates").insert({
      org_id: orgA, job_id: jobA, certificate_number: "CERT-0002", status: "issued",
      completion_date: "2026-07-05", snapshot: { certificate_number: "CERT-0002" }, issued_at: new Date().toISOString(),
    }).select("id").single();
    expect(r.error, "a second live cert on the same job must be rejected").not.toBeNull();
  });

  it("permits portal publish/withdraw on an issued cert (outside the freeze)", async () => {
    const pub = await db(serviceClient()).from("completion_certificates").update({ portal_published_at: new Date().toISOString() }).eq("id", certA);
    expect(pub.error, pub.error?.message).toBeNull();
    const wd = await db(serviceClient()).from("completion_certificates").update({ portal_withdrawn_at: new Date().toISOString() }).eq("id", certA);
    expect(wd.error, wd.error?.message).toBeNull();
  });

  it("isolates tenants — an outside org's member cannot read the cert (RLS)", async () => {
    const r = await db(userClient(outsiderToken)).from("completion_certificates").select("id").eq("id", certA);
    expect(r.error).toBeNull();
    expect(r.data ?? []).toHaveLength(0);
  });
});
