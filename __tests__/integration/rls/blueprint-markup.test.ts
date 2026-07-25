import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Blueprint Markup (Programme C) — DB invariants against real Postgres (20261017).
 * A redline is annotation on an IMMUTABLE drawing revision, so:
 *   - org_id/job_id + bbox derived server-side (client values ignored);
 *   - geom validated: point-count per shape, every point in [0,1];
 *   - anchor (version/page) immutable after insert;
 *   - shape<->text payload + soft-delete consistency CHECKs;
 *   - RLS: members select/insert/update(soft-remove); only admins hard-delete;
 *   - tenant isolation + version cascade.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Upd extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): PromiseLike<Res<Row[]>> }
interface Del { eq(c: string, v: unknown): PromiseLike<Res<null>> }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; update(r: Row): Upd; delete(): Del }
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-mk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

describeIntegration("blueprint_markup · DB invariants", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "", jobA = "", versionA = "";
  let member = { id: "", token: "" };
  let admin = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Mk A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Mk B", slug: `${TOKEN}-b` });
    jobA = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    const bpA = await insId(svc, "blueprints", { org_id: orgA, job_id: jobA, drawing_number: "A-201", title: "GA" });
    versionA = await insId(svc, "blueprint_versions", {
      blueprint_id: bpA, org_id: orgA, version: 1, revision: "Rev A",
      storage_path: `${orgA}/j/b/f1.pdf`, file_name: "A-201.pdf", mime_type: "application/pdf", size_bytes: 100,
    });
    if (!orgA || !orgB || !jobA || !versionA) throw new Error("fixture setup failed");
    member = await mkUser(`${TOKEN}-m@example.test`, "staff", orgA);
    admin = await mkUser(`${TOKEN}-adm@example.test`, "owner", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);
  });

  afterAll(async () => {
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    for (const u of [member.id, admin.id, outsider.id]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const shape = (over: Row = {}): Row => ({
    blueprint_version_id: versionA, page_number: 1, shape: "line",
    geom: { points: [{ u: 0.2, v: 0.3 }, { u: 0.6, v: 0.7 }] }, ...over,
  });

  it("derives org_id/job_id + bbox from the parent version, ignoring client values", async () => {
    const r = await svc.from("blueprint_markup")
      .insert(shape({ org_id: orgB, job_id: "00000000-0000-0000-0000-000000000000", bbox_u: 0.9, bbox_v: 0.9, bbox_w: 0.05, bbox_h: 0.05 }))
      .select("id, org_id, job_id, bbox_u, bbox_v, bbox_w, bbox_h").single();
    expect(r.error).toBeNull();
    expect(r.data?.org_id).toBe(orgA);
    expect(r.data?.job_id).toBe(jobA);
    expect(r.data?.bbox_u).toBeCloseTo(0.2, 6); // server-derived from geom, not client 0.9
    expect(r.data?.bbox_w).toBeCloseTo(0.4, 6);
    await svc.from("blueprint_markup").delete().eq("id", String(r.data?.id));
  });

  it("validates geom: point count per shape + points in [0,1]", async () => {
    expect((await svc.from("blueprint_markup").insert(shape({ shape: "line", geom: { points: [{ u: 0.1, v: 0.1 }] } })).select("id").single()).error).not.toBeNull();
    expect((await svc.from("blueprint_markup").insert(shape({ shape: "text", geom: { points: [{ u: 0.1, v: 0.1 }, { u: 0.2, v: 0.2 }] }, text_content: "x" })).select("id").single()).error).not.toBeNull();
    expect((await svc.from("blueprint_markup").insert(shape({ geom: { points: [{ u: 1.5, v: 0.1 }, { u: 0.2, v: 0.2 }] } })).select("id").single()).error).not.toBeNull();
    expect((await svc.from("blueprint_markup").insert(shape({ shape: "freehand", geom: { points: Array.from({ length: 2001 }, () => ({ u: 0.5, v: 0.5 })) } })).select("id").single()).error).not.toBeNull();
  });

  it("enforces shape<->text payload + colour/stroke CHECKs", async () => {
    expect((await svc.from("blueprint_markup").insert(shape({ shape: "text", geom: { points: [{ u: 0.5, v: 0.5 }] } })).select("id").single()).error, "text needs text_content").not.toBeNull();
    expect((await svc.from("blueprint_markup").insert(shape({ text_content: "x" })).select("id").single()).error, "non-text carries no text").not.toBeNull();
    expect((await svc.from("blueprint_markup").insert(shape({ color: "red" })).select("id").single()).error).not.toBeNull();
    expect((await svc.from("blueprint_markup").insert(shape({ stroke_width: 99 })).select("id").single()).error).not.toBeNull();
  });

  it("freezes the anchor (version/page) after insert", async () => {
    const id = await insId(svc, "blueprint_markup", shape());
    const r = await svc.from("blueprint_markup").update({ page_number: 2 }).eq("id", id);
    expect(r.error?.message ?? "").toMatch(/immutable/i);
    await svc.from("blueprint_markup").delete().eq("id", id);
  });

  it("enforces soft-delete consistency (removed <=> deleted_at)", async () => {
    const id = await insId(svc, "blueprint_markup", shape());
    const bad = await svc.from("blueprint_markup").update({ status: "removed" }).eq("id", id); // deleted_at still null
    expect(bad.error).not.toBeNull();
    await svc.from("blueprint_markup").delete().eq("id", id);
  });

  it("RLS: a member can draw + soft-remove but NOT hard-delete; an admin can", async () => {
    const m = db(userClient(member.token));
    const created = await m.from("blueprint_markup").insert(shape()).select("id").single();
    expect(created.error, "member can draw").toBeNull();
    const id = String(created.data?.id);

    const soft = await m.from("blueprint_markup").update({ status: "removed", deleted_at: new Date().toISOString() }).eq("id", id);
    expect(soft.error, "member can soft-remove").toBeNull();
    expect((await svc.from("blueprint_markup").select("status").eq("id", id)).data?.[0]?.status).toBe("removed");

    await m.from("blueprint_markup").delete().eq("id", id); // RLS filters to 0 rows
    expect((await svc.from("blueprint_markup").select("id").eq("id", id)).data ?? [], "member hard-delete removes nothing").toHaveLength(1);

    await db(userClient(admin.token)).from("blueprint_markup").delete().eq("id", id);
    expect((await svc.from("blueprint_markup").select("id").eq("id", id)).data ?? [], "admin hard-delete purges").toHaveLength(0);
  });

  it("RLS: an outside org reads none of org A's markup + cannot insert onto its version", async () => {
    const id = await insId(svc, "blueprint_markup", shape());
    const o = db(userClient(outsider.token));
    expect((await o.from("blueprint_markup").select("id").eq("id", id)).data ?? []).toHaveLength(0);
    // trigger derives org_id=orgA, which fails the outsider's insert WITH CHECK
    const ins = await o.from("blueprint_markup").insert(shape()).select("id").single();
    expect(ins.error, "cross-org insert must be rejected").not.toBeNull();
    await svc.from("blueprint_markup").delete().eq("id", id);
  });

  it("cascades markup when its blueprint_version is deleted", async () => {
    const bpTmp = await insId(svc, "blueprints", { org_id: orgA, job_id: jobA, drawing_number: "A-999", title: "tmp" });
    const vTmp = await insId(svc, "blueprint_versions", {
      blueprint_id: bpTmp, org_id: orgA, version: 1, revision: "Rev A",
      storage_path: `${orgA}/j/b/tmp.pdf`, file_name: "t.pdf", mime_type: "application/pdf", size_bytes: 10,
    });
    const id = await insId(svc, "blueprint_markup", shape({ blueprint_version_id: vTmp }));
    expect(id).not.toBe("");
    await svc.from("blueprints").delete().eq("id", bpTmp); // cascades version → markup
    expect((await svc.from("blueprint_markup").select("id").eq("id", id)).data ?? []).toHaveLength(0);
  });
});
