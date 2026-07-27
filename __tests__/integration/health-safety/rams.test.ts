import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * RAMS DB-invariant proofs against real Postgres (Health & Safety, 20261018).
 * These are enforced in the database, not the app, so they hold for EVERY caller
 * incl. service_role: generated 5×5 risk ratings, hazard org derivation (client
 * cannot spoof a child into another tenant), the immutability-on-issue freeze,
 * the lifecycle CHECK constraints, and cross-org job rejection.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
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

const TOKEN = `it-rams-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("RAMS · DB invariants", () => {
  let orgA = "";
  let orgB = "";
  let jobB = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "RAMS A", slug: `${TOKEN}-a` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    const b = await svc.from("organizations").insert({ name: "RAMS B", slug: `${TOKEN}-b` }).select("id").single();
    orgB = String(b.data?.id ?? "");
    const j = await svc.from("jobs").insert({ org_id: orgB }).select("id").single();
    jobB = String(j.data?.id ?? "");
  });

  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("risk_rating + residual_rating are generated as likelihood × severity", async () => {
    const svc = db(serviceClient());
    const ra = await svc.from("risk_assessments").insert({ org_id: orgA, title: "Gen", activity: "x" }).select("id").single();
    const raId = String(ra.data?.id);
    const hz = await svc.from("risk_assessment_hazards")
      .insert({ org_id: orgA, risk_assessment_id: raId, hazard: "Fall", likelihood: 4, severity: 5, control_measures: "harness", residual_likelihood: 2, residual_severity: 3 })
      .select("risk_rating, residual_rating").single();
    expect(hz.error, hz.error?.message).toBeNull();
    expect(hz.data?.risk_rating).toBe(20);
    expect(hz.data?.residual_rating).toBe(6);
  });

  it("a hazard's org_id is derived from its parent — a spoofed org_id is overwritten", async () => {
    const svc = db(serviceClient());
    const ra = await svc.from("risk_assessments").insert({ org_id: orgA, title: "Derive", activity: "x" }).select("id").single();
    const raId = String(ra.data?.id);
    // Insert with orgB (wrong) — the BEFORE trigger must overwrite it to orgA.
    const hz = await svc.from("risk_assessment_hazards")
      .insert({ org_id: orgB, risk_assessment_id: raId, hazard: "Spoof", likelihood: 1, severity: 1, control_measures: "x" })
      .select("org_id").single();
    expect(hz.error, hz.error?.message).toBeNull();
    expect(hz.data?.org_id).toBe(orgA);
  });

  it("rejects a job link from another organisation", async () => {
    const { error } = await db(serviceClient()).from("risk_assessments")
      .insert({ org_id: orgA, title: "CrossJob", activity: "x", job_id: jobB });
    expect(error, "cross-org job link must be rejected").not.toBeNull();
  });

  it("a draft cannot jump straight to superseded (needs a reference — CHECK)", async () => {
    const svc = db(serviceClient());
    const ra = await svc.from("risk_assessments").insert({ org_id: orgA, title: "Jump", activity: "x" }).select("id").single();
    const { error } = await svc.from("risk_assessments").update({ status: "superseded" }).eq("id", String(ra.data?.id));
    expect(error, "draft->superseded without reference/issue must fail").not.toBeNull();
  });

  it("an ISSUED risk assessment is immutable; only issued→superseded/withdrawn is allowed", async () => {
    const svc = db(serviceClient());
    const ra = await svc.from("risk_assessments").insert({ org_id: orgA, title: "Freeze", activity: "Tiling", assessor_id: null }).select("id").single();
    const raId = String(ra.data?.id);
    await svc.from("risk_assessment_hazards").insert({ org_id: orgA, risk_assessment_id: raId, hazard: "H", likelihood: 3, severity: 3, control_measures: "c" });

    // Issue it (reference + issued_at satisfy the lifecycle CHECKs).
    const issue = await svc.from("risk_assessments")
      .update({ status: "issued", reference: `RA-${TOKEN}`, issued_at: new Date().toISOString() }).eq("id", raId);
    expect(issue.error, issue.error?.message).toBeNull();

    // Content mutation is refused.
    const mutate = await svc.from("risk_assessments").update({ title: "changed" }).eq("id", raId);
    expect(mutate.error, "issued content must be immutable").not.toBeNull();

    // Adding a hazard to an issued RA is refused.
    const addHz = await svc.from("risk_assessment_hazards")
      .insert({ org_id: orgA, risk_assessment_id: raId, hazard: "late", likelihood: 1, severity: 1, control_measures: "x" });
    expect(addHz.error, "cannot add hazards to an issued RA").not.toBeNull();

    // Deleting a hazard from an issued RA is refused.
    const del = await svc.from("risk_assessment_hazards").delete().eq("risk_assessment_id", raId);
    expect(del.error, "cannot delete hazards from an issued RA").not.toBeNull();

    // The allowed lifecycle move succeeds.
    const supersede = await svc.from("risk_assessments").update({ status: "superseded" }).eq("id", raId);
    expect(supersede.error, supersede.error?.message).toBeNull();

    // A superseded record is terminal — no going back to issued.
    const revert = await svc.from("risk_assessments").update({ status: "issued" }).eq("id", raId);
    expect(revert.error, "superseded is terminal").not.toBeNull();
  });
});
