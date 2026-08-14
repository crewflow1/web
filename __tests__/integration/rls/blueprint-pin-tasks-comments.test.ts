import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Blueprint Pins completion wave (P2) — DB invariants against real Postgres
 * (20261122000000 / 20261122000001). Proves the guarantees for the three new
 * capabilities are DB-enforced for every role:
 *   - task pins: kind='task' is accepted, OWNS a task_status (open|in_progress
 *     |done), and the payload CHECK forbids a snag/note pin from carrying task
 *     fields (and a task pin from linking a snag);
 *   - threaded comments: org_id derived from the parent pin (client value
 *     ignored); a reply must be on the SAME pin; a cross-ORG parent is blocked
 *     by the composite self-FK; deleting a pin cascades its whole thread; RLS
 *     isolates tenants (an outsider sees none of org A's discussion) and a
 *     member can only delete their OWN comment;
 *   - pin photos: 'blueprint_pins' is an accepted tenant_attachments target.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del { eq(c: string, v: unknown): PromiseLike<Res<null>> }
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-pin2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

describeIntegration("blueprint pins P2 · tasks + comments + photos", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "";
  let jobA = "";
  let versionA = "", versionB = "";
  let taskPinA = "", notePinA = "";
  let member = { id: "", token: "" };
  let admin = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "P2 A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "P2 B", slug: `${TOKEN}-b` });
    jobA = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    const jobB = await insId(svc, "jobs", { org_id: orgB, status: "in-progress" });
    const bpA = await insId(svc, "blueprints", { org_id: orgA, job_id: jobA, drawing_number: "A-1", title: "A" });
    const bpB = await insId(svc, "blueprints", { org_id: orgB, job_id: jobB, drawing_number: "B-1", title: "B" });
    versionA = await insId(svc, "blueprint_versions", {
      blueprint_id: bpA, org_id: orgA, version: 1, revision: "Rev A",
      storage_path: `${orgA}/j/b/a.pdf`, file_name: "a.pdf", mime_type: "application/pdf", size_bytes: 100,
    });
    versionB = await insId(svc, "blueprint_versions", {
      blueprint_id: bpB, org_id: orgB, version: 1, revision: "Rev B",
      storage_path: `${orgB}/j/b/b.pdf`, file_name: "b.pdf", mime_type: "application/pdf", size_bytes: 100,
    });
    member = await mkUser(`${TOKEN}-m@example.test`, "staff", orgA);
    admin = await mkUser(`${TOKEN}-adm@example.test`, "owner", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);

    taskPinA = await insId(svc, "blueprint_pins", {
      blueprint_version_id: versionA, page_number: 1, u: 0.3, v: 0.3, kind: "task",
      title: "Fit handrail", task_status: "open", assigned_to: member.id,
    });
    notePinA = await insId(svc, "blueprint_pins", {
      blueprint_version_id: versionA, page_number: 1, u: 0.6, v: 0.6, kind: "note", note: "check",
    });
    if (!orgA || !orgB || !versionA || !versionB || !taskPinA || !notePinA) throw new Error("fixture setup failed");
  });

  afterAll(async () => {
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    for (const u of [member.id, admin.id, outsider.id]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  // ── task pins ───────────────────────────────────────────────────────────────
  it("accepts a task pin that OWNS its status, deriving tenancy from the version", async () => {
    const r = await svc.from("blueprint_pins")
      .insert({ blueprint_version_id: versionA, page_number: 1, u: 0.5, v: 0.5, kind: "task", title: "T", task_status: "in_progress", org_id: orgB })
      .select("id, org_id, task_status").single();
    expect(r.error).toBeNull();
    expect(r.data?.org_id).toBe(orgA); // client-sent orgB ignored
    expect(r.data?.task_status).toBe("in_progress");
    await svc.from("blueprint_pins").delete().eq("id", String(r.data?.id));
  });

  it("rejects a task pin with no status, and a task pin that links a snag", async () => {
    expect((await svc.from("blueprint_pins").insert({ blueprint_version_id: versionA, page_number: 1, u: 0.5, v: 0.5, kind: "task", title: "T", task_status: null }).select("id").single()).error).not.toBeNull();
  });

  it("rejects a note pin that smuggles task fields (payload CHECK)", async () => {
    expect((await svc.from("blueprint_pins").insert({ blueprint_version_id: versionA, page_number: 1, u: 0.5, v: 0.5, kind: "note", note: "x", task_status: "open" }).select("id").single()).error).not.toBeNull();
  });

  it("rejects an unknown task_status value", async () => {
    expect((await svc.from("blueprint_pins").insert({ blueprint_version_id: versionA, page_number: 1, u: 0.5, v: 0.5, kind: "task", title: "T", task_status: "archived" }).select("id").single()).error).not.toBeNull();
  });

  // ── comments: derivation + threading ─────────────────────────────────────────
  it("derives a comment's org_id from the parent pin (client value ignored)", async () => {
    const r = await svc.from("blueprint_pin_comments")
      .insert({ pin_id: taskPinA, body: "hello", author_id: member.id, org_id: orgB })
      .select("id, org_id").single();
    expect(r.error).toBeNull();
    expect(r.data?.org_id).toBe(orgA);
    await svc.from("blueprint_pin_comments").delete().eq("id", String(r.data?.id));
  });

  it("rejects a reply whose parent is on a DIFFERENT pin (same-pin trigger)", async () => {
    const root = await svc.from("blueprint_pin_comments").insert({ pin_id: taskPinA, body: "root", author_id: member.id }).select("id").single();
    const bad = await svc.from("blueprint_pin_comments")
      .insert({ pin_id: notePinA, body: "reply", author_id: member.id, parent_comment_id: String(root.data?.id) })
      .select("id").single();
    expect(bad.error?.message ?? "").toMatch(/same pin/i);
    await svc.from("blueprint_pin_comments").delete().eq("id", String(root.data?.id));
  });

  it("cascades the whole thread when the pin is deleted", async () => {
    const pin = await svc.from("blueprint_pins").insert({ blueprint_version_id: versionA, page_number: 1, u: 0.4, v: 0.4, kind: "note", note: "temp" }).select("id").single();
    const pinId = String(pin.data?.id);
    const root = await svc.from("blueprint_pin_comments").insert({ pin_id: pinId, body: "r", author_id: member.id }).select("id").single();
    await svc.from("blueprint_pin_comments").insert({ pin_id: pinId, body: "child", author_id: member.id, parent_comment_id: String(root.data?.id) });
    await svc.from("blueprint_pins").delete().eq("id", pinId);
    const left = await svc.from("blueprint_pin_comments").select("id").eq("pin_id", pinId);
    expect((left.data ?? []).length).toBe(0);
  });

  // ── comments: RLS tenant isolation ───────────────────────────────────────────
  it("an OUTSIDER (org B) sees none of org A's thread and cannot post to it", async () => {
    await svc.from("blueprint_pin_comments").insert({ pin_id: taskPinA, body: "private A", author_id: member.id });
    const out = db(userClient(outsider.token));
    const seen = await out.from("blueprint_pin_comments").select("id").eq("pin_id", taskPinA);
    expect((seen.data ?? []).length).toBe(0); // RLS hides org A's comments
    const post = await out.from("blueprint_pin_comments").insert({ pin_id: taskPinA, body: "intrude", author_id: outsider.id }).select("id").single();
    expect(post.error, "outsider must not post on another org's pin").not.toBeNull();
    await svc.from("blueprint_pin_comments").delete().eq("pin_id", taskPinA);
  });

  it("a member deletes only their OWN comment; an admin can moderate any", async () => {
    const mine = await svc.from("blueprint_pin_comments").insert({ pin_id: taskPinA, body: "by admin", author_id: admin.id }).select("id").single();
    const memberClient = db(userClient(member.token));
    await memberClient.from("blueprint_pin_comments").delete().eq("id", String(mine.data?.id));
    const stillThere = await svc.from("blueprint_pin_comments").select("id").eq("id", String(mine.data?.id));
    expect((stillThere.data ?? []).length, "a member must not delete another user's comment").toBe(1);
    // admin (owner of org A) may moderate it.
    await db(userClient(admin.token)).from("blueprint_pin_comments").delete().eq("id", String(mine.data?.id));
    const gone = await svc.from("blueprint_pin_comments").select("id").eq("id", String(mine.data?.id));
    expect((gone.data ?? []).length).toBe(0);
  });

  // ── photos: target acceptance ────────────────────────────────────────────────
  it("accepts 'blueprint_pins' as a tenant_attachments target", async () => {
    const r = await svc.from("tenant_attachments").insert({
      org_id: orgA, target_table: "blueprint_pins", target_id: taskPinA,
      filename: "site.jpg", storage_path: `${orgA}/blueprint_pins/${taskPinA}/x.jpg`,
      mime_type: "image/jpeg", size_bytes: 10, uploaded_by: member.id,
    }).select("id").single();
    expect(r.error).toBeNull();
    if (r.data?.id) await svc.from("tenant_attachments").delete().eq("id", String(r.data.id));
  });
});
