import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Blueprint Centre — DB invariants against real Postgres (20261015). A drawing
 * revision is a record of what was ISSUED, so the guarantees are DB-enforced:
 *   - version rows immutable (blocks EVEN service_role);
 *   - org_id + version derived from the parent (client values ignored → anti-spoof);
 *   - current-version pointer tracks the latest revision;
 *   - one register entry per drawing number per job;
 *   - tenant isolation (a non-member reads nothing).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Upd extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): PromiseLike<Res<Row[]>> }
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  update(r: Row): Upd;
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-bp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("blueprints · DB invariants", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let bpA = "";
  let v1 = "";
  let outsiderId = "";
  let outsiderToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgA = String((await svc.from("organizations").insert({ name: "BP A", slug: `${TOKEN}-a` }).select("id").single()).data?.id ?? "");
    orgB = String((await svc.from("organizations").insert({ name: "BP B", slug: `${TOKEN}-b` }).select("id").single()).data?.id ?? "");
    jobA = String((await svc.from("jobs").insert({ org_id: orgA, status: "in-progress" }).select("id").single()).data?.id ?? "");
    bpA = String((await svc.from("blueprints").insert({ org_id: orgA, job_id: jobA, drawing_number: "A-201", title: "GA Plan", discipline: "architectural" }).select("id").single()).data?.id ?? "");
    // v1: pass a foreign org + version 99 → triggers must override both.
    v1 = String((await svc.from("blueprint_versions").insert({
      blueprint_id: bpA, org_id: orgB, version: 99, revision: "Rev A",
      storage_path: `${orgA}/j/b/f1.pdf`, file_name: "A-201.pdf", mime_type: "application/pdf", size_bytes: 100,
    }).select("id").single()).data?.id ?? "");
    if (!orgA || !orgB || !jobA || !bpA || !v1) throw new Error("fixture setup failed");

    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    outsiderId = created.data.user?.id ?? "";
    await db(serviceClient()).from("users").insert({ id: outsiderId, email, full_name: "Outsider" });
    await db(serviceClient()).from("memberships").insert({ org_id: orgB, user_id: outsiderId, role: "owner" });
    outsiderToken = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
    if (!outsiderToken) throw new Error("failed to mint outsider token");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (outsiderId) await serviceClient().auth.admin.deleteUser(outsiderId);
  });

  it("derives org_id + version from the parent, ignoring client-sent values", async () => {
    const r = await db(serviceClient()).from("blueprint_versions").select("org_id, version").eq("id", v1);
    expect(r.data?.[0]?.version).toBe(1); // not the client-sent 99
    expect(r.data?.[0]?.org_id).toBe(orgA); // not the client-sent orgB
  });

  it("moves the current-version pointer to the latest revision", async () => {
    await db(serviceClient()).from("blueprint_versions").insert({
      blueprint_id: bpA, org_id: orgA, version: 1, revision: "Rev B",
      storage_path: `${orgA}/j/b/f2.pdf`, file_name: "A-201.pdf", mime_type: "application/pdf", size_bytes: 200,
    });
    const r = await db(serviceClient()).from("blueprints").select("current_version").eq("id", bpA);
    expect(r.data?.[0]?.current_version).toBe(2);
  });

  it("makes a version row immutable — even for service_role", async () => {
    const r = await db(serviceClient()).from("blueprint_versions").update({ storage_path: "hacked" }).eq("id", v1);
    expect(r.error, "version rows must be immutable").not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/immutable/i);
  });

  it("allows one register entry per drawing number per job", async () => {
    const r = await db(serviceClient()).from("blueprints").insert({ org_id: orgA, job_id: jobA, drawing_number: "A-201", title: "dup" }).select("id").single();
    expect(r.error, "duplicate drawing number on a job must be rejected").not.toBeNull();
  });

  it("isolates tenants — an outside org's member reads nothing", async () => {
    const r1 = await db(userClient(outsiderToken)).from("blueprints").select("id").eq("id", bpA);
    expect(r1.data ?? []).toHaveLength(0);
    const r2 = await db(userClient(outsiderToken)).from("blueprint_versions").select("id").eq("id", v1);
    expect(r2.data ?? []).toHaveLength(0);
  });
});
