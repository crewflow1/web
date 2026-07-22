import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Blueprint Pins (Programme B) — DB invariants against real Postgres (20261016).
 * A pin is operational annotation on an IMMUTABLE drawing revision, so the
 * guarantees are DB-enforced for every role:
 *   - org_id/job_id derived from the parent version (client values ignored);
 *   - (u,v) constrained to [0,1], page_number >= 1;
 *   - kind <-> payload consistency (snag pin links a snag; note pin carries text);
 *   - composite-FK tenant integrity: a pin CANNOT link a cross-ORG entity;
 *   - a before-write trigger rejects linking a cross-JOB snag;
 *   - deleting the snag (or the version) cascades the pin away — no dangling;
 *   - RLS: members read/create/move; only admins hard-delete; tenants isolated;
 *   - the atomic create-snag+pin RPC creates both or neither.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Upd extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): PromiseLike<Res<Row[]>> }
interface Del { eq(c: string, v: unknown): PromiseLike<Res<null>> }
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  update(r: Row): Upd;
  delete(): Del;
}
type Rpc = (fn: string, args: Row) => { single(): PromiseLike<Res<Row>> };
const db = (client: unknown) => client as unknown as { from(t: string): Table; rpc: Rpc };
const TOKEN = `it-pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const insId = async (svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> =>
  String((await svc.from(table).insert(row).select("id").single()).data?.id ?? "");

async function mkUser(email: string, role: string, orgId: string): Promise<{ id: string; token: string }> {
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role });
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${email}`);
  return { id, token };
}

describeIntegration("blueprint_pins · DB invariants", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "";
  let jobA = "", jobA2 = "", jobB = "";
  let versionA = "";
  let snagA = "", snagA2 = "", snagBnoJob = "";
  let member = { id: "", token: "" };
  let admin = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Pin A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Pin B", slug: `${TOKEN}-b` });
    jobA = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    jobA2 = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    jobB = await insId(svc, "jobs", { org_id: orgB, status: "in-progress" });
    const bpA = await insId(svc, "blueprints", { org_id: orgA, job_id: jobA, drawing_number: "A-201", title: "GA Plan" });
    versionA = await insId(svc, "blueprint_versions", {
      blueprint_id: bpA, org_id: orgA, version: 1, revision: "Rev A",
      storage_path: `${orgA}/j/b/f1.pdf`, file_name: "A-201.pdf", mime_type: "application/pdf", size_bytes: 100,
    });
    snagA = await insId(svc, "snags", { org_id: orgA, job_id: jobA, title: "Snag on job A" });
    snagA2 = await insId(svc, "snags", { org_id: orgA, job_id: jobA2, title: "Snag on job A2" });
    snagBnoJob = await insId(svc, "snags", { org_id: orgB, job_id: null, title: "Snag in org B, no job" });
    if (!orgA || !orgB || !jobA || !versionA || !snagA || !snagA2 || !snagBnoJob) throw new Error("fixture setup failed");

    member = await mkUser(`${TOKEN}-m@example.test`, "staff", orgA);
    admin = await mkUser(`${TOKEN}-adm@example.test`, "owner", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);
  });

  afterAll(async () => {
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    for (const u of [member.id, admin.id, outsider.id]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const notePin = (over: Row = {}): Row => ({
    blueprint_version_id: versionA, page_number: 1, u: 0.5, v: 0.5, kind: "note", note: "check level", ...over,
  });

  it("derives org_id + job_id from the parent version, ignoring client-sent values", async () => {
    const r = await svc.from("blueprint_pins")
      .insert(notePin({ org_id: orgB, job_id: jobB })) // bogus tenancy
      .select("id, org_id, job_id").single();
    expect(r.error).toBeNull();
    expect(r.data?.org_id).toBe(orgA); // not the client-sent orgB
    expect(r.data?.job_id).toBe(jobA); // not the client-sent jobB
    await svc.from("blueprint_pins").delete().eq("id", String(r.data?.id));
  });

  it("rejects coordinates outside [0,1] and page_number < 1", async () => {
    expect((await svc.from("blueprint_pins").insert(notePin({ u: 1.5 })).select("id").single()).error).not.toBeNull();
    expect((await svc.from("blueprint_pins").insert(notePin({ v: -0.1 })).select("id").single()).error).not.toBeNull();
    expect((await svc.from("blueprint_pins").insert(notePin({ page_number: 0 })).select("id").single()).error).not.toBeNull();
  });

  it("enforces kind<->payload: a note needs text; a snag pin carries no free note", async () => {
    expect((await svc.from("blueprint_pins").insert(notePin({ note: null })).select("id").single()).error).not.toBeNull();
    expect((await svc.from("blueprint_pins").insert(notePin({ kind: "snag", note: "x", snag_id: snagA })).select("id").single()).error).not.toBeNull();
  });

  it("rejects linking a snag from ANOTHER ORG (composite FK, every role)", async () => {
    // snagBnoJob has no job → the cross-job trigger is skipped, isolating the FK.
    const r = await svc.from("blueprint_pins")
      .insert(notePin({ kind: "snag", note: null, snag_id: snagBnoJob })).select("id").single();
    expect(r.error, "cross-org snag link must be rejected by the composite FK").not.toBeNull();
  });

  it("rejects linking a snag from a DIFFERENT JOB in the same org (trigger)", async () => {
    const r = await svc.from("blueprint_pins")
      .insert(notePin({ kind: "snag", note: null, snag_id: snagA2 })).select("id").single();
    expect(r.error?.message ?? "").toMatch(/different job/i);
  });

  it("accepts a valid snag-link pin and cascades it away when the snag is deleted", async () => {
    const snagTmp = await insId(svc, "snags", { org_id: orgA, job_id: jobA, title: "temp snag" });
    const pinId = await insId(svc, "blueprint_pins", notePin({ kind: "snag", note: null, snag_id: snagTmp }));
    expect(pinId).not.toBe("");
    await svc.from("snags").delete().eq("id", snagTmp);
    const after = await svc.from("blueprint_pins").select("id").eq("id", pinId);
    expect(after.data ?? [], "deleting the snag must cascade the pin").toHaveLength(0);
  });

  it("RLS: a member can place + move a pin but CANNOT delete it; an admin can", async () => {
    const m = db(userClient(member.token));
    const created = await m.from("blueprint_pins").insert(notePin()).select("id").single();
    expect(created.error, "a member can place a pin").toBeNull();
    const pinId = String(created.data?.id);

    const moved = await m.from("blueprint_pins").update({ u: 0.1, v: 0.2 }).eq("id", pinId);
    expect(moved.error, "a member can move a pin").toBeNull();

    await m.from("blueprint_pins").delete().eq("id", pinId); // RLS filters it out → 0 rows, no throw
    expect((await svc.from("blueprint_pins").select("id").eq("id", pinId)).data ?? [], "member delete must not remove the pin").toHaveLength(1);

    await db(userClient(admin.token)).from("blueprint_pins").delete().eq("id", pinId);
    expect((await svc.from("blueprint_pins").select("id").eq("id", pinId)).data ?? [], "admin delete removes the pin").toHaveLength(0);
  });

  it("RLS: an outside org's member reads none of org A's pins", async () => {
    const pinId = await insId(svc, "blueprint_pins", notePin());
    const seen = await db(userClient(outsider.token)).from("blueprint_pins").select("id").eq("id", pinId);
    expect(seen.data ?? []).toHaveLength(0);
    await svc.from("blueprint_pins").delete().eq("id", pinId);
  });

  it("RPC create_blueprint_pin_with_snag creates the snag AND its pin atomically", async () => {
    const r = await db(userClient(member.token)).rpc("create_blueprint_pin_with_snag", {
      p_blueprint_version_id: versionA, p_page_number: 1, p_u: 0.3, p_v: 0.7,
      p_pin_title: "at the RC junction", p_snag_title: "Cracked render",
      p_snag_description: "spalling", p_snag_priority: "high", p_snag_location: "north elevation",
    }).single();
    expect(r.error).toBeNull();
    const pin = r.data as { id: string; snag_id: string; kind: string; job_id: string } | null;
    expect(pin?.kind).toBe("snag");
    expect(pin?.job_id).toBe(jobA);
    const snag = await svc.from("snags").select("id, title, job_id, status").eq("id", String(pin?.snag_id));
    expect(snag.data?.[0]?.title).toBe("Cracked render");
    expect(snag.data?.[0]?.job_id).toBe(jobA);
    expect(snag.data?.[0]?.status).toBe("open");
    await svc.from("blueprint_pins").delete().eq("id", String(pin?.id));
  });
});
