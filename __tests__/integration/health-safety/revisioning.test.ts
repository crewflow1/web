import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * RAMS revisioning DB invariants against real Postgres (H&S M6a, 20261022).
 * Enforced in the database for every caller: series lineage (root + revision +
 * supersede), the single-current-revision invariant, the single-open-draft
 * invariant, atomic issue-of-a-revision (supersede old + promote new), and
 * lineage immutability once issued. Concurrency is proven with a real race.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res<Row>> }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; update(p: Row): Upd }
const db = (client: unknown) => client as unknown as { from(t: string): Table; rpc(fn: string, a: Row): PromiseLike<Res<unknown>> };
const TOKEN = `it-rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("RAMS revisioning · DB invariants", () => {
  let orgA = "", orgB = "";
  const svc = () => db(serviceClient());

  // Create an ISSUED revision-1 RAMS in `org`, returning its id + reference.
  async function issuedRev1(org: string, tag: string): Promise<{ id: string; ref: string; root: string }> {
    const id = String((await svc().from("risk_assessments").insert({ org_id: org, title: `S-${tag}`, activity: "x", assessor_id: null }).select("id").single()).data?.id);
    await svc().from("risk_assessment_hazards").insert({ org_id: org, risk_assessment_id: id, hazard: "H", likelihood: 3, severity: 3, control_measures: "c" });
    const ref = `RA-${tag}`;
    const iss = await svc().from("risk_assessments").update({ status: "issued", reference: ref, issued_at: new Date().toISOString() }).eq("id", id);
    expect(iss.error, iss.error?.message).toBeNull();
    return { id, ref, root: id };
  }
  // Create a draft revision N of a series (copies a hazard so an issue-gate would pass).
  async function draftRevision(org: string, root: string, supersedes: string, n: number): Promise<Res<Row>> {
    const res = await svc().from("risk_assessments")
      .insert({ org_id: org, title: "rev", activity: "x", assessor_id: null, root_risk_assessment_id: root, revision_number: n, supersedes_id: supersedes })
      .select("id").single();
    if (res.data?.id) await svc().from("risk_assessment_hazards").insert({ org_id: org, risk_assessment_id: String(res.data.id), hazard: "H", likelihood: 2, severity: 2, control_measures: "c" });
    return res;
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "Rev A", slug: `${TOKEN}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "Rev B", slug: `${TOKEN}-b` }).select("id").single()).data?.id);
  });
  afterAll(async () => {
    for (const o of [orgA, orgB]) if (o) await (svc().from("organizations") as unknown as { delete(): { eq(c: string, v: unknown): PromiseLike<unknown> } }).delete().eq("id", o);
  });

  it("a new RAMS self-roots (root = id) and is revision 1", async () => {
    const id = String((await svc().from("risk_assessments").insert({ org_id: orgA, title: "root", activity: "x" }).select("id").single()).data?.id);
    const row = (await svc().from("risk_assessments").select("root_risk_assessment_id, revision_number").eq("id", id).maybeSingle()).data;
    expect(row?.root_risk_assessment_id).toBe(id);
    expect(row?.revision_number).toBe(1);
  });

  it("issue_rams_revision atomically supersedes the current revision and promotes the draft", async () => {
    const r1 = await issuedRev1(orgA, `${TOKEN}-flow`);
    const d = await draftRevision(orgA, r1.root, r1.id, 2);
    expect(d.error, d.error?.message).toBeNull();
    const rev2 = String(d.data?.id);
    const out = await svc().rpc("issue_rams_revision", { p_id: rev2 });
    expect(out.error, out.error?.message).toBeNull();
    expect(String(out.data)).toBe(`${r1.ref}-R02`);
    const after = (await svc().from("risk_assessments").select("id, status, reference, revision_number").eq("root_risk_assessment_id", r1.root)).data ?? [];
    const issued = after.filter((r) => r.status === "issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]!.id).toBe(rev2);
    expect(after.find((r) => r.id === r1.id)?.status).toBe("superseded");
  });

  it("[one current] a superseded revision cannot be forced back to issued while another is current", async () => {
    const r1 = await issuedRev1(orgA, `${TOKEN}-cur`);
    const rev2 = String((await draftRevision(orgA, r1.root, r1.id, 2)).data?.id);
    await svc().rpc("issue_rams_revision", { p_id: rev2 });
    // r1 is now superseded, rev2 issued. Forcing r1 back to issued must violate the
    // one-issued-per-series partial unique index.
    const { error } = await svc().from("risk_assessments").update({ status: "issued" }).eq("id", r1.id);
    expect(error, "two issued revisions in one series must be impossible").not.toBeNull();
  });

  it("[one draft] a series cannot have two open drafts at once", async () => {
    const r1 = await issuedRev1(orgA, `${TOKEN}-2draft`);
    const first = await draftRevision(orgA, r1.root, r1.id, 2);
    expect(first.error, first.error?.message).toBeNull();
    const second = await draftRevision(orgA, r1.root, r1.id, 3);
    expect(second.error, "a second concurrent draft in the same series must be rejected").not.toBeNull();
  });

  it("[concurrency] two racing create-revision attempts yield exactly one draft", async () => {
    const r1 = await issuedRev1(orgA, `${TOKEN}-race`);
    const results = await Promise.all([
      draftRevision(orgA, r1.root, r1.id, 2),
      draftRevision(orgA, r1.root, r1.id, 2),
    ]);
    const ok = results.filter((r) => !r.error).length;
    expect(ok, "exactly one of two concurrent revision drafts must win").toBe(1);
  });

  it("[lineage] self-supersede, cross-series and cross-org lineage are rejected", async () => {
    const r1 = await issuedRev1(orgA, `${TOKEN}-lin`);
    // self-supersede
    const selfSup = await svc().from("risk_assessments").insert({ org_id: orgA, title: "self", activity: "x", root_risk_assessment_id: r1.root, revision_number: 2, supersedes_id: r1.root, id: r1.root });
    expect(selfSup.error).not.toBeNull();
    // cross-series supersede (supersede a RAMS from a different series)
    const other = await issuedRev1(orgA, `${TOKEN}-lin2`);
    const crossSeries = await svc().from("risk_assessments").insert({ org_id: orgA, title: "x", activity: "x", root_risk_assessment_id: r1.root, revision_number: 2, supersedes_id: other.id });
    expect(crossSeries.error, "supersedes must be same-series").not.toBeNull();
    // cross-org root
    const crossOrg = await svc().from("risk_assessments").insert({ org_id: orgB, title: "x", activity: "x", root_risk_assessment_id: r1.root, revision_number: 2 });
    expect(crossOrg.error, "series root must be same-org").not.toBeNull();
  });

  it("[immutability] lineage fields are frozen once a revision is issued", async () => {
    const r1 = await issuedRev1(orgA, `${TOKEN}-imm`);
    const bump = await svc().from("risk_assessments").update({ revision_number: 9 }).eq("id", r1.id);
    expect(bump.error, "revision_number is frozen on an issued RAMS").not.toBeNull();
  });

  it("[rpc guards] a non-draft, and a revision-1 draft, cannot be issued as a revision", async () => {
    const r1 = await issuedRev1(orgA, `${TOKEN}-guard`);
    const onIssued = await svc().rpc("issue_rams_revision", { p_id: r1.id });
    expect(onIssued.error, "only a draft can be issued as a revision").not.toBeNull();
    const bareDraft = String((await svc().from("risk_assessments").insert({ org_id: orgA, title: "d", activity: "x" }).select("id").single()).data?.id);
    const onRev1 = await svc().rpc("issue_rams_revision", { p_id: bareDraft });
    expect(onRev1.error, "the first issue is not a revision").not.toBeNull();
  });
});
