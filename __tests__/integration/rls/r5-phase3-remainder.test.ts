import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 3 (remainder) — the FK-dependent / self-scoped operational tables
 * (migs 20261270–20261273), against real Postgres with real JWTs:
 *   - blueprint_pins / blueprint_markup: assignment-scoped via denormalised job_id
 *     (seeded through a blueprint + version parent);
 *   - asset_assignments: assignment-scoped, and JOB-LESS rows are admin-only;
 *   - worker_acknowledgements: SELF-scoped (a worker sees only their own ack);
 *   - revoked assignment: removing a worker's job_assignment revokes their read.
 * Roles exercised: owner, admin, assigned staff, unassigned staff, revoked staff,
 * cross-org, anon.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; in(c: string, v: unknown[]): Sel }
interface Ins extends PromiseLike<Res<null>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del { eq(c: string, v: unknown): { eq(c: string, v: unknown): PromiseLike<Res<null>> } }
interface Upd { eq(c: string, v: unknown): PromiseLike<Res<null>> }
interface Table { select(c?: string): Sel; insert(r: Row): Ins; delete(): Del; update(r: Row): Upd }
const db = (c: unknown) => c as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());
const T = `r5rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "", orgB = "", jobA = "", jobU = "", jobB = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
const id: Record<string, string> = {}; // seeded row ids by label

const insId = async (t: string, r: Row): Promise<string> => {
  const res = await svc().from(t).insert(r).select("id").single();
  if (res.error) throw new Error(`seed ${t}: ${res.error.message}`);
  return String(res.data?.id ?? "");
};
async function mk(s: string): Promise<{ id: string; token: string }> {
  const email = `${T}-${s}@e.test`, pw = `Pw-${T}-${s}-${Math.random().toString(36).slice(2)}`;
  const c = await serviceClient().auth.admin.createUser({ email, password: pw, email_confirm: true });
  const i = c.data.user?.id ?? "";
  await svc().from("users").insert({ id: i, email, full_name: s });
  const t = (await anonClient().auth.signInWithPassword({ email, password: pw })).data.session?.access_token ?? "";
  if (!i || !t) throw new Error(`mk ${s}`);
  return { id: i, token: t };
}
const seenIn = async (who: string, table: string, ids: string[]): Promise<Set<string>> => {
  const r = await db(userClient(tok[who] ?? "")).from(table).select("id").in("id", ids);
  expect(r.error, `${who}/${table}: ${r.error?.message}`).toBeNull();
  return new Set((r.data ?? []).map((x) => String(x.id)));
};

describeIntegration("rls · R5 Phase 3 remainder (20261270-273)", () => {
  beforeAll(async () => {
    orgA = await insId("organizations", { name: `${T}A`, slug: `${T}-a` });
    orgB = await insId("organizations", { name: `${T}B`, slug: `${T}-b` });
    for (const w of ["owner", "admin", "assigned", "unassigned", "revoked", "otherOrg"]) {
      const u = await mk(w); uid[w] = u.id; tok[w] = u.token;
    }
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.owner, role: "owner" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.admin, role: "admin" });
    for (const w of ["assigned", "unassigned", "revoked"]) await svc().from("memberships").insert({ org_id: orgA, user_id: uid[w], role: "staff" });
    await svc().from("memberships").insert({ org_id: orgB, user_id: uid.otherOrg, role: "owner" });

    jobA = await insId("jobs", { org_id: orgA, status: "in-progress" });
    jobU = await insId("jobs", { org_id: orgA, status: "in-progress" });
    jobB = await insId("jobs", { org_id: orgB, status: "in-progress" });
    await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobA, user_id: uid.assigned });
    await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobA, user_id: uid.revoked }); // removed later

    // blueprint + version + pin + markup per job
    const mkBp = async (org: string, job: string, label: string) => {
      const bp = await insId("blueprints", { org_id: org, job_id: job, drawing_number: `D-${label}`, title: `T-${label}` });
      const ver = await insId("blueprint_versions", { blueprint_id: bp, org_id: org, version: 1, revision: "A", storage_path: `${org}/${job}/${label}.pdf`, file_name: `${label}.pdf`, mime_type: "application/pdf", size_bytes: 10 });
      // org_id/job_id are trigger-derived from the version.
      id[`pin_${label}`] = await insId("blueprint_pins", { blueprint_version_id: ver, page_number: 1, u: 0.5, v: 0.5, kind: "note", note: "n" });
      id[`mk_${label}`] = await insId("blueprint_markup", { blueprint_version_id: ver, shape: "freehand", geom: { points: [{ u: 0, v: 0 }, { u: 0.5, v: 0.5 }] }, color: "#112233", bbox_u: 0, bbox_v: 0, bbox_w: 1, bbox_h: 1, page_number: 1 });
    };
    await mkBp(orgA, jobA, "A"); await mkBp(orgA, jobU, "U"); await mkBp(orgB, jobB, "B");

    // asset_assignments — distinct assets; job-linked (A/U/B) + a JOB-LESS orgA row
    const asset = async (org: string, n: string) => insId("assets", { org_id: org, name: `${T}-${n}` });
    id.aa_A = await insId("asset_assignments", { org_id: orgA, asset_id: await asset(orgA, "aA"), assignment_type: "allocated_to_job", job_id: jobA });
    id.aa_U = await insId("asset_assignments", { org_id: orgA, asset_id: await asset(orgA, "aU"), assignment_type: "allocated_to_job", job_id: jobU });
    id.aa_jobless = await insId("asset_assignments", { org_id: orgA, asset_id: await asset(orgA, "aJ"), assignment_type: "issued_to_staff" });
    id.aa_B = await insId("asset_assignments", { org_id: orgB, asset_id: await asset(orgB, "aB"), assignment_type: "allocated_to_job", job_id: jobB });

    // worker_acknowledgements — admin-only in-app. subject_id is the acknowledged
    // DOCUMENT (a toolbox talk on jobA), captured against an external worker token.
    const token = await insId("worker_signoff_tokens", { org_id: orgA, job_id: jobA, token_hash: (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 64), worker_name: "W", expires_at: "2027-01-01T00:00:00Z" });
    const talk = await insId("toolbox_talks", { org_id: orgA, job_id: jobA, topic: "Site Safety" }); // born draft
    const talkRef = `TBT-${T}`;
    const issue = await svc().from("toolbox_talks").update({ status: "issued", issued_at: "2026-01-01T00:00:00Z", reference: talkRef }).eq("id", talk);
    expect(issue.error, `issue talk: ${issue.error?.message}`).toBeNull();
    id.ack = await insId("worker_acknowledgements", { org_id: orgA, job_id: jobA, token_id: token, subject_type: "toolbox_talk", subject_id: talk, subject_version: talkRef, statement: "I acknowledge", signed_name: "Worker One" });
  });

  it("blueprint_pins: assigned staff see only their job's pin; unassigned none; admin all; cross-org/anon none", async () => {
    const all = [id.pin_A!, id.pin_U!, id.pin_B!];
    expect([...(await seenIn("assigned", "blueprint_pins", all))]).toEqual([id.pin_A!]);
    expect((await seenIn("unassigned", "blueprint_pins", all)).size).toBe(0);
    const owner = await seenIn("owner", "blueprint_pins", all);
    expect(owner.has(id.pin_A!) && owner.has(id.pin_U!)).toBe(true);
    expect(owner.has(id.pin_B!)).toBe(false);
    expect((await seenIn("otherOrg", "blueprint_pins", [id.pin_A!])).size).toBe(0);
    expect((await db(anonClient()).from("blueprint_pins").select("id").in("id", all)).data ?? []).toHaveLength(0);
  });

  it("blueprint_markup: assignment-scoped", async () => {
    const all = [id.mk_A!, id.mk_U!, id.mk_B!];
    expect([...(await seenIn("assigned", "blueprint_markup", all))]).toEqual([id.mk_A!]);
    expect((await seenIn("unassigned", "blueprint_markup", all)).size).toBe(0);
    expect((await seenIn("admin", "blueprint_markup", all)).has(id.mk_U!)).toBe(true);
  });

  it("asset_assignments: assignment-scoped, and JOB-LESS rows are admin-only", async () => {
    const all = [id.aa_A!, id.aa_U!, id.aa_jobless!, id.aa_B!];
    expect([...(await seenIn("assigned", "asset_assignments", all))], "assigned sees only its job's assignment — NOT the job-less one").toEqual([id.aa_A!]);
    const admin = await seenIn("admin", "asset_assignments", all);
    expect(admin.has(id.aa_A!) && admin.has(id.aa_U!) && admin.has(id.aa_jobless!), "admin sees job-linked + job-less").toBe(true);
    expect(admin.has(id.aa_B!), "never cross-org").toBe(false);
    expect((await seenIn("unassigned", "asset_assignments", all)).size).toBe(0);
  });

  it("worker_acknowledgements: ADMIN-ONLY in-app — staff never read workers' private ack records", async () => {
    const all = [id.ack!];
    expect((await seenIn("owner", "worker_acknowledgements", all)).has(id.ack!), "owner sees acks").toBe(true);
    expect((await seenIn("admin", "worker_acknowledgements", all)).has(id.ack!), "admin sees acks (compliance)").toBe(true);
    expect((await seenIn("assigned", "worker_acknowledgements", all)).size, "assigned staff see NONE").toBe(0);
    expect((await seenIn("unassigned", "worker_acknowledgements", all)).size, "unassigned staff see none").toBe(0);
    expect((await seenIn("otherOrg", "worker_acknowledgements", all)).size, "cross-tenant none").toBe(0);
    expect((await db(anonClient()).from("worker_acknowledgements").select("id").in("id", all)).data ?? [], "anon none").toHaveLength(0);
  });

  it("REVOKED assignment: removing a worker's job_assignment revokes their read", async () => {
    // `revoked` was assigned to jobA → currently sees jobA's pin.
    expect((await seenIn("revoked", "blueprint_pins", [id.pin_A!])).has(id.pin_A!), "still assigned → sees it").toBe(true);
    const del = await svc().from("job_assignments").delete().eq("job_id", jobA).eq("user_id", uid.revoked);
    expect(del.error, del.error?.message).toBeNull();
    expect((await seenIn("revoked", "blueprint_pins", [id.pin_A!])).size, "after removal → no read").toBe(0);
  });
});
