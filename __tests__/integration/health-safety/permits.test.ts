import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Permit-to-Work DB-invariant proofs against real Postgres (H&S M2, 20261019).
 * Enforced in the database for EVERY caller incl. service_role: tenant + job +
 * RAMS link integrity, condition org-derivation, the lifecycle transition matrix,
 * the issue-gate (all required conditions confirmed), and immutability-on-issue.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): PromiseLike<Res<null>> & { select(c?: string): { single(): PromiseLike<Res<Row>> } };
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-ptw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function newPermit(orgId: string, over: Row = {}): Promise<string> {
  const svc = db(serviceClient());
  const r = await svc.from("permits_to_work")
    .insert({ org_id: orgId, permit_type: "hot_works", title: "Weld", scope: "Weld beam", ...over })
    .select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data?.id);
}

describeIntegration("Permit-to-Work · DB invariants", () => {
  let orgA = "", orgB = "", jobA = "", jobB = "", ramsA = "", ramsB = "", userA = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const u = await serviceClient().auth.admin.createUser({ email: `${TOKEN}@example.test`, password: `Pw-${TOKEN}`, email_confirm: true });
    userA = u.data.user?.id ?? "";
    await svc.from("users").insert({ id: userA, email: `${TOKEN}@example.test`, full_name: "PTW User" });
    orgA = String((await svc.from("organizations").insert({ name: "PTW A", slug: `${TOKEN}-a` }).select("id").single()).data?.id);
    orgB = String((await svc.from("organizations").insert({ name: "PTW B", slug: `${TOKEN}-b` }).select("id").single()).data?.id);
    jobA = String((await svc.from("jobs").insert({ org_id: orgA }).select("id").single()).data?.id);
    jobB = String((await svc.from("jobs").insert({ org_id: orgB }).select("id").single()).data?.id);
    ramsA = String((await svc.from("risk_assessments").insert({ org_id: orgA, title: "RA A", activity: "x", job_id: jobA }).select("id").single()).data?.id);
    ramsB = String((await svc.from("risk_assessments").insert({ org_id: orgB, title: "RA B", activity: "x" }).select("id").single()).data?.id);
  });
  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
    if (userA) await serviceClient().auth.admin.deleteUser(userA);
  });

  it("rejects a cross-org job link", async () => {
    const { error } = await db(serviceClient()).from("permits_to_work").insert({ org_id: orgA, permit_type: "general", title: "x", scope: "x", job_id: jobB });
    expect(error, "cross-org job must be rejected").not.toBeNull();
  });
  it("rejects a cross-org RAMS link", async () => {
    const { error } = await db(serviceClient()).from("permits_to_work").insert({ org_id: orgA, permit_type: "general", title: "x", scope: "x", risk_assessment_id: ramsB });
    expect(error, "cross-org RAMS must be rejected").not.toBeNull();
  });
  it("rejects a job-scoped permit referencing a different job's RAMS", async () => {
    // permit on jobA, RAMS anchored to a different job would be caught; here RAMS ramsA is jobA (ok),
    // but linking jobB is cross-org already; use a same-org RAMS on no job (allowed) and a mismatched pair:
    const raOtherJob = String((await db(serviceClient()).from("risk_assessments").insert({ org_id: orgA, title: "RA J", activity: "x", job_id: jobA }).select("id").single()).data?.id);
    // make a second job in orgA
    const jobA2 = String((await db(serviceClient()).from("jobs").insert({ org_id: orgA }).select("id").single()).data?.id);
    const { error } = await db(serviceClient()).from("permits_to_work").insert({ org_id: orgA, permit_type: "general", title: "x", scope: "x", job_id: jobA2, risk_assessment_id: raOtherJob });
    expect(error, "permit on jobA2 must not reference jobA's RAMS").not.toBeNull();
  });
  it("allows a same-org, same-job RAMS link", async () => {
    const id = await newPermit(orgA, { job_id: jobA, risk_assessment_id: ramsA });
    expect(id).toBeTruthy();
  });

  it("derives a condition's org_id from its parent (spoof overwritten)", async () => {
    const id = await newPermit(orgA);
    const c = await db(serviceClient()).from("permit_conditions")
      .insert({ org_id: orgB, permit_id: id, label: "Fire watch", required: true }).select("org_id").single();
    expect(c.error, c.error?.message).toBeNull();
    expect(c.data?.org_id).toBe(orgA);
  });

  it("blocks issue while a required condition is unconfirmed, then allows it once confirmed", async () => {
    const svc = db(serviceClient());
    const id = await newPermit(orgA, { valid_from: "2026-06-15T08:00:00Z", valid_until: "2026-06-15T16:00:00Z" });
    const cond = await svc.from("permit_conditions").insert({ org_id: orgA, permit_id: id, label: "Isolation confirmed", required: true }).select("id").single();
    // issue blocked
    const blocked = await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-1`, issued_at: new Date().toISOString() }).eq("id", id);
    expect(blocked.error, "issue must be blocked with an unconfirmed required condition").not.toBeNull();
    // confirm it (a valid confirmation carries who + when — the stamp CHECK)
    const conf = await svc.from("permit_conditions").update({ confirmed: true, confirmed_by: userA, confirmed_at: new Date().toISOString() }).eq("id", String(cond.data?.id));
    expect(conf.error, conf.error?.message).toBeNull();
    const ok = await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-1`, issued_at: new Date().toISOString() }).eq("id", id);
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("enforces the lifecycle matrix + immutability-on-issue", async () => {
    const svc = db(serviceClient());
    const id = await newPermit(orgA, { valid_from: "2026-06-15T08:00:00Z", valid_until: "2026-06-15T16:00:00Z" });
    // draft -> active is invalid (must issue first)
    const jump = await svc.from("permits_to_work").update({ status: "active" }).eq("id", id);
    expect(jump.error, "draft->active must fail").not.toBeNull();
    // issue (no required conditions) then activate then suspend then active then close
    expect((await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-2`, issued_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    // content is now immutable
    const mutate = await svc.from("permits_to_work").update({ title: "changed" }).eq("id", id);
    expect(mutate.error, "issued content must be immutable").not.toBeNull();
    expect((await svc.from("permits_to_work").update({ status: "active", activated_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    expect((await svc.from("permits_to_work").update({ status: "suspended", suspended_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    expect((await svc.from("permits_to_work").update({ status: "active" }).eq("id", id)).error).toBeNull();
    expect((await svc.from("permits_to_work").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    // closed is terminal
    const revert = await svc.from("permits_to_work").update({ status: "active" }).eq("id", id);
    expect(revert.error, "closed is terminal").not.toBeNull();
  });

  it("rejects a validity window where until <= from (CHECK)", async () => {
    const { error } = await db(serviceClient()).from("permits_to_work")
      .insert({ org_id: orgA, permit_type: "general", title: "x", scope: "x", valid_from: "2026-06-15T16:00:00Z", valid_until: "2026-06-15T08:00:00Z" });
    expect(error, "until<=from must be rejected").not.toBeNull();
  });

  // --- adversarial-review regression tests (P0/P1 hardening) ---

  it("[P0-1] a permit cannot be born already-issued via direct INSERT", async () => {
    const { error } = await db(serviceClient()).from("permits_to_work")
      .insert({ org_id: orgA, permit_type: "general", title: "x", scope: "x", status: "issued", reference: `PTW-${TOKEN}-ins`, issued_at: new Date().toISOString(), valid_from: "2026-06-15T08:00:00Z", valid_until: "2026-06-15T16:00:00Z" });
    expect(error, "INSERT with status=issued must be rejected").not.toBeNull();
  });

  it("[P0-2] a contractual field cannot be edited while riding a status transition", async () => {
    const svc = db(serviceClient());
    const id = await newPermit(orgA, { valid_from: "2026-06-15T08:00:00Z", valid_until: "2026-06-15T16:00:00Z" });
    await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-p02`, issued_at: new Date().toISOString() }).eq("id", id);
    // bundle a scope rewrite with the issued->active transition
    const bundled = await svc.from("permits_to_work").update({ status: "active", activated_at: new Date().toISOString(), scope: "SECRETLY REWRITTEN" }).eq("id", id);
    expect(bundled.error, "a bundled content edit must be rejected").not.toBeNull();
  });

  it("[P1-3] a confirmed condition on an issued permit cannot be un-confirmed or deleted", async () => {
    const svc = db(serviceClient());
    const id = await newPermit(orgA, { valid_from: "2026-06-15T08:00:00Z", valid_until: "2026-06-15T16:00:00Z" });
    const cond = await svc.from("permit_conditions").insert({ org_id: orgA, permit_id: id, label: "Gas test", required: true, confirmed: true, confirmed_by: userA, confirmed_at: new Date().toISOString() }).select("id").single();
    await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-p13`, issued_at: new Date().toISOString() }).eq("id", id);
    const unconf = await svc.from("permit_conditions").update({ confirmed: false, confirmed_by: null, confirmed_at: null }).eq("id", String(cond.data?.id));
    expect(unconf.error, "un-confirm on a live permit must be rejected").not.toBeNull();
    const del = await svc.from("permit_conditions").delete().eq("id", String(cond.data?.id));
    expect(del.error, "deleting a condition from a live permit must be rejected").not.toBeNull();
  });

  it("[P1-4] a permit cannot be issued with no validity window", async () => {
    const svc = db(serviceClient());
    const id = await newPermit(orgA); // no window
    const { error } = await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-p14`, issued_at: new Date().toISOString() }).eq("id", id);
    expect(error, "issue with no window must be rejected").not.toBeNull();
  });

  it("[P1-5] a permit cannot be issued under a non-issued RAMS", async () => {
    const svc = db(serviceClient());
    // ramsA is a DRAFT risk assessment
    const id = await newPermit(orgA, { job_id: jobA, risk_assessment_id: ramsA, valid_from: "2026-06-15T08:00:00Z", valid_until: "2026-06-15T16:00:00Z" });
    const { error } = await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-p15`, issued_at: new Date().toISOString() }).eq("id", id);
    expect(error, "issue under a draft RAMS must be rejected").not.toBeNull();
  });

  it("[P2-7] a draft permit can be cancelled without burning a permit number", async () => {
    const svc = db(serviceClient());
    const id = await newPermit(orgA);
    const { error } = await svc.from("permits_to_work").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", id);
    expect(error, error?.message).toBeNull();
  });
});
