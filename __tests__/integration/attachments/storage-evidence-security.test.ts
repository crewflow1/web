import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Storage evidence security wave — DB-enforced against real Postgres.
 *   S0: a poisoned storage_path (org-A row → org-B object) is rejected at INSERT/UPDATE.
 *   S1: authenticated (tenant-JWT) storage.objects mutation is default-denied (service-role only).
 *   S2: content_hash CHECK + universal write-once immutability of the evidence identity columns.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res<Row>> }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Table { select(c?: string): Sel; insert(r: Row): Ins; update(v: Row): Upd; delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> } }
const db = (c: unknown) => c as unknown as { from(t: string): Table };
const T = `it-sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describeIntegration("Storage evidence security (S0/S1/S2, real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let memberId = "";
  let memberTok = "";
  let adminId = "";
  let adminTok = "";
  const svc = () => db(serviceClient());
  const member = () => db(userClient(memberTok));

  async function mkMember(role: string, tag: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${T}`, email_confirm: true });
    if (created.error) throw new Error(`createUser ${tag}: ${created.error.message}`);
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: `${role}` });
    await svc().from("memberships").insert({ org_id: orgA, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(`signIn ${tag}: ${s.error.message}`);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "SEC A", slug: `${T}-a` }).select("id").single()).data?.id ?? "");
    orgB = String((await svc().from("organizations").insert({ name: "SEC B", slug: `${T}-b` }).select("id").single()).data?.id ?? "");
    jobA = String((await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single()).data?.id ?? "");
    if (!orgA || !orgB || !jobA) throw new Error("fixture setup failed");
    ({ id: memberId, token: memberTok } = await mkMember("staff", "mem"));
    ({ id: adminId, token: adminTok } = await mkMember("admin", "adm"));
    if (!memberTok || !adminTok) throw new Error("member tokens missing");
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    if (memberId) await serviceClient().auth.admin.deleteUser(memberId);
    if (adminId) await serviceClient().auth.admin.deleteUser(adminId);
  });

  // ---- S0: org-path binding -------------------------------------------------
  it("[S0] a member cannot insert a tenant_attachments row whose storage_path points at another org", async () => {
    const poison = await member().from("tenant_attachments").insert({
      org_id: orgA, target_table: "jobs", target_id: jobA, filename: "x.pdf",
      storage_path: `${orgB}/jobs/${jobA}/${T}.pdf`, mime_type: "application/pdf", size_bytes: 3,
    }).select("id").single();
    expect(poison.error?.message ?? "", "cross-org storage_path must be rejected").toMatch(/under the owning org|check_violation|storage_path/i);
  });

  it("[S0] a member CAN insert a row whose storage_path is under their own org (no false positive)", async () => {
    const ok = await member().from("tenant_attachments").insert({
      org_id: orgA, target_table: "jobs", target_id: jobA, filename: "ok.pdf",
      storage_path: `${orgA}/jobs/${jobA}/${T}-ok.pdf`, mime_type: "application/pdf", size_bytes: 3, content_hash: HASH_A,
    }).select("id").single();
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("[S0] a crafted UPDATE repointing storage_path to another org is rejected", async () => {
    const r = await svc().from("tenant_attachments").insert({
      org_id: orgA, target_table: "jobs", target_id: jobA, filename: "u.pdf",
      storage_path: `${orgA}/jobs/${jobA}/${T}-u.pdf`, mime_type: "application/pdf", size_bytes: 3,
    }).select("id").single();
    const id = String(r.data?.id);
    // service-role UPDATE (the only writer that can even attempt it) — still blocked by immutability;
    // but prove the org-binding specifically by attempting a same-org->other-org repoint via a member is impossible
    // (member has no UPDATE grant). Here we assert the immutability guard blocks any storage_path change.
    const upd = await svc().from("tenant_attachments").update({ storage_path: `${orgB}/x.pdf` }).eq("id", id);
    expect(upd.error?.message ?? "", "storage_path is immutable / org-bound").toMatch(/immutable|under the owning org/i);
  });

  // ---- S1: storage mutation lockdown ---------------------------------------
  it("[S1] a tenant-JWT admin cannot delete, and a member cannot upload, a tenant-attachments object; service role can", async () => {
    const key = `${orgA}/jobs/${jobA}/${T}-obj.pdf`;
    const bytes = new Uint8Array([37, 80, 68, 70]); // %PDF
    const up = await serviceClient().storage.from("tenant-attachments").upload(key, bytes, { contentType: "application/pdf", upsert: false });
    expect(up.error, `service-role upload should work: ${up.error?.message}`).toBeNull();

    const memberUp = await userClient(memberTok).storage.from("tenant-attachments").upload(`${orgA}/jobs/${jobA}/${T}-hack.pdf`, bytes, { contentType: "application/pdf" });
    expect(memberUp.error, "a tenant-JWT member must NOT be able to upload bytes directly").not.toBeNull();

    const adminDel = await userClient(adminTok).storage.from("tenant-attachments").remove([key]);
    // Supabase returns ok with an empty data array when RLS removed 0 rows; assert the object still exists.
    const stillThere = await serviceClient().storage.from("tenant-attachments").createSignedUrl(key, 30);
    expect(stillThere.error, "the object must survive a tenant-JWT admin delete attempt").toBeNull();
    void adminDel;

    await serviceClient().storage.from("tenant-attachments").remove([key]); // service-role cleanup works
  });

  // ---- S2: content_hash + immutability --------------------------------------
  it("[S2] content_hash must be well-formed sha256 hex (CHECK)", async () => {
    const bad = await svc().from("tenant_attachments").insert({
      org_id: orgA, target_table: "jobs", target_id: jobA, filename: "b.pdf",
      storage_path: `${orgA}/jobs/${jobA}/${T}-b.pdf`, mime_type: "application/pdf", size_bytes: 3, content_hash: "NOT-A-HASH",
    }).select("id").single();
    expect(bad.error?.message ?? "", "a malformed content_hash must be rejected").toMatch(/content_hash|check/i);
  });

  it("[S2] content_hash / storage_path / size_bytes are write-once (universal, non-toolbox target)", async () => {
    const r = await svc().from("tenant_attachments").insert({
      org_id: orgA, target_table: "jobs", target_id: jobA, filename: "s2.pdf",
      storage_path: `${orgA}/jobs/${jobA}/${T}-s2.pdf`, mime_type: "application/pdf", size_bytes: 10, content_hash: HASH_A,
    }).select("id").single();
    const id = String(r.data?.id);
    expect(r.error, r.error?.message).toBeNull();
    for (const [patch, label] of [
      [{ content_hash: HASH_B }, "content_hash"],
      [{ storage_path: `${orgA}/jobs/${jobA}/${T}-moved.pdf` }, "storage_path"],
      [{ size_bytes: 99 }, "size_bytes"],
      [{ mime_type: "image/png" }, "mime_type"],
    ] as const) {
      const upd = await svc().from("tenant_attachments").update(patch as Row).eq("id", id);
      expect(upd.error?.message ?? "", `${label} must be immutable once set`).toMatch(/immutable/i);
    }
    // a benign edit (filename) is still allowed — the guard is column-scoped, not a row lock
    const fn = await svc().from("tenant_attachments").update({ filename: "renamed.pdf" }).eq("id", id);
    expect(fn.error, "filename edits must remain allowed").toBeNull();
  });

  it("[S2] content_hash backfill: null -> value is allowed once, then value -> different is rejected", async () => {
    const r = await svc().from("tenant_attachments").insert({
      org_id: orgA, target_table: "jobs", target_id: jobA, filename: "bf.pdf",
      storage_path: `${orgA}/jobs/${jobA}/${T}-bf.pdf`, mime_type: "application/pdf", size_bytes: 4, // no hash (historical row)
    }).select("id").single();
    const id = String(r.data?.id);
    const set = await svc().from("tenant_attachments").update({ content_hash: HASH_A }).eq("id", id);
    expect(set.error, "null -> value backfill must be allowed once").toBeNull();
    const change = await svc().from("tenant_attachments").update({ content_hash: HASH_B }).eq("id", id);
    expect(change.error?.message ?? "", "value -> different must be rejected").toMatch(/immutable/i);
  });

  // ---- S2b: compliance_documents evidence immutability (adversarial follow-up)
  it("[S2b] compliance_documents storage_path/size/mime are write-once; benign edits still allowed", async () => {
    const r = await svc().from("compliance_documents").insert({
      org_id: orgA, kind: "insurance", title: "Cert", storage_path: `${orgA}/${T}-cert.pdf`, mime_type: "application/pdf", size_bytes: 10,
    }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data?.id);
    for (const [patch, label] of [
      [{ storage_path: `${orgA}/${T}-swap.pdf` }, "storage_path"],
      [{ size_bytes: 99 }, "size_bytes"],
      [{ mime_type: "image/png" }, "mime_type"],
    ] as const) {
      const upd = await svc().from("compliance_documents").update(patch as Row).eq("id", id);
      expect(upd.error?.message ?? "", `compliance ${label} must be immutable`).toMatch(/immutable/i);
    }
    const okTitle = await svc().from("compliance_documents").update({ title: "Renamed" }).eq("id", id);
    expect(okTitle.error, "compliance title edits stay allowed").toBeNull();
  });

  // ---- S0 extension: jobs.photos path binding (append_job_photo) ------------
  it("[S0] append_job_photo rejects a foreign-org photo_path; an org-first path is accepted", async () => {
    const bad = await userClient(memberTok).rpc("append_job_photo", { target_job_id: jobA, photo_path: `${orgB}/${jobA}/hack.jpg` });
    expect(bad.error?.message ?? "", "a cross-org photo path must be rejected").toMatch(/under the job|org/i);
    const ok = await userClient(memberTok).rpc("append_job_photo", { target_job_id: jobA, photo_path: `${orgA}/${jobA}/ok.jpg` });
    expect(ok.error, "an org-first photo path must be accepted").toBeNull();
  });
});
