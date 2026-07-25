import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * S4/S5 — RAMS + permit lifecycle authorization, proven against real Postgres.
 *   S4 (integrity): a draft RAMS can no longer be PATCHed straight to a terminal state,
 *       bypassing the issue gate (the toolbox-P0 forgery class). First-delivery by a member
 *       still works — this is an integrity fix, NOT a role change.
 *   S5 (intent lock): RAMS + permit lifecycle transitions remain MEMBER-LEVEL in both app and
 *       DB (as-built product policy). These positive tests pin that intent so the member→admin
 *       question stays an explicit product decision, never a silent regression.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res<Row>> }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Table { select(c?: string): Sel; insert(r: Row): Ins; update(v: Row): Upd; delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> } }
const db = (c: unknown) => c as unknown as { from(t: string): Table };
const T = `it-hsauthz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();

describeIntegration("RAMS + permit lifecycle authz (S4 integrity / S5 intent, real Postgres)", () => {
  let orgA = "";
  let jobA = "";
  let memberId = "";
  let memberTok = "";
  const svc = () => db(serviceClient());
  const me = () => db(userClient(memberTok));

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "HZ A", slug: `${T}-a` }).select("id").single()).data?.id ?? "");
    jobA = String((await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single()).data?.id ?? "");
    const email = `${T}-m@x.test`;
    const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${T}`, email_confirm: true });
    if (created.error) throw new Error(created.error.message);
    memberId = created.data.user?.id ?? "";
    await svc().from("users").insert({ id: memberId, email, full_name: "Staff" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: memberId, role: "staff" });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(s.error.message);
    memberTok = s.data.session?.access_token ?? "";
    if (!orgA || !jobA || !memberTok) throw new Error("fixture setup failed");
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (memberId) await serviceClient().auth.admin.deleteUser(memberId);
  });

  // ---- S4: RAMS draft->terminal forgery bypass is closed ---------------------
  it("[S4] a member cannot PATCH a draft RAMS straight to withdrawn/superseded", async () => {
    for (const to of ["withdrawn", "superseded"] as const) {
      const d = await me().from("risk_assessments").insert({ org_id: orgA, title: "Forge", activity: "x" }).select("id").single();
      expect(d.error, d.error?.message).toBeNull();
      const id = String(d.data?.id);
      const r = await me().from("risk_assessments")
        .update({ status: to, reference: `RA-${T}-${to}`, issued_at: "2020-01-01T00:00:00Z", issued_by: memberId }).eq("id", id);
      expect(r.error?.message ?? "", `draft->${to} must be rejected`).toMatch(/can only be issued/i);
      await svc().from("risk_assessments").delete().eq("id", id);
    }
  });

  it("[S4] a member CAN still author a draft RAMS and issue it (first delivery stays member-level)", async () => {
    const d = await me().from("risk_assessments").insert({ org_id: orgA, title: "Real", activity: "roofing", assessor_id: memberId }).select("id").single();
    expect(d.error, d.error?.message).toBeNull();
    const id = String(d.data?.id);
    await me().from("risk_assessment_hazards").insert({ org_id: orgA, risk_assessment_id: id, hazard: "Fall", likelihood: 3, severity: 3, control_measures: "harness" });
    const iss = await me().from("risk_assessments").update({ status: "issued", reference: `RA-${T}-ok`, issued_at: now() }).eq("id", id);
    expect(iss.error, "a member must still be able to issue a ready RAMS").toBeNull();
    // and the DB pinned provenance to the member (not forgeable)
    const row = (await svc().from("risk_assessments").select("status, issued_by").eq("id", id).maybeSingle()).data;
    expect(row?.status).toBe("issued");
    expect(row?.issued_by).toBe(memberId);
  });

  // ---- S5: permits remain member-level (intent lock, per product policy) ------
  it("[S5] a member CAN suspend and close an issued permit (member-level lifecycle is the current policy)", async () => {
    // Seed an issued+active permit via service role (wide validity window, no conditions).
    const d = await svc().from("permits_to_work")
      .insert({ org_id: orgA, permit_type: "general", title: "P", scope: "s", job_id: jobA, valid_from: "2020-01-01T00:00:00Z", valid_until: "2999-01-01T00:00:00Z" })
      .select("id").single();
    expect(d.error, d.error?.message).toBeNull();
    const id = String(d.data?.id);
    const iss = await svc().from("permits_to_work").update({ status: "issued", reference: `PTW-${T}`, issued_at: now() }).eq("id", id);
    expect(iss.error, `seed issue: ${iss.error?.message}`).toBeNull();
    await svc().from("permits_to_work").update({ status: "active", activated_at: now() }).eq("id", id);
    // As a NON-ADMIN member (tenant JWT): suspend + reactivate + close all succeed today.
    expect((await me().from("permits_to_work").update({ status: "suspended", suspended_at: now() }).eq("id", id)).error, "member suspend must succeed (member-level policy)").toBeNull();
    expect((await me().from("permits_to_work").update({ status: "active" }).eq("id", id)).error, "member reactivate must succeed").toBeNull();
    expect((await me().from("permits_to_work").update({ status: "closed", closed_at: now() }).eq("id", id)).error, "member close must succeed").toBeNull();
  });
});
