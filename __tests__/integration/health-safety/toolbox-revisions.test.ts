import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Toolbox Talk revision + re-acknowledgement DB-invariants (M3, 20261027). Proves
 * the RAMS-style revision lineage on the evolved table: a revision is a new draft;
 * issuing it via issue_toolbox_talk_revision atomically supersedes the prior current
 * revision, freezes a fresh snapshot, numbers it TBT-NNNN-R0n, and — crucially —
 * carries ZERO acknowledgements forward (each revision is its own ack version).
 * Also proves the concurrency backstops: one-draft + one-current per series.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res<Row>> }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; update(v: Row): Upd; delete(): Del }
const db = (client: unknown) => client as unknown as {
  from(t: string): Table;
  rpc(fn: string, a: Row): PromiseLike<Res<string>>;
};
const T = `it-ttrev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Toolbox Talk revisions · DB invariants (20261027)", () => {
  let orgA = "", member = "";
  let rootId = "", rev1 = "";
  const REF1 = `TBT-${T}-1`;
  const svc = () => db(serviceClient());

  async function mkUser(label: string): Promise<string> {
    const u = await serviceClient().auth.admin.createUser({ email: `${T}-${label}@x.test`, password: `Pw-${T}`, email_confirm: true });
    const id = u.data.user?.id ?? "";
    await svc().from("users").insert({ id, email: `${T}-${label}@x.test`, full_name: `U ${label}` });
    return id;
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "TT-Rev", slug: `${T}-a` }).select("id").single()).data?.id);
    member = await mkUser("m");
    await svc().from("memberships").insert({ org_id: orgA, user_id: member, role: "staff" });
    // Rev 1: create draft, issue it (origin of the series).
    rev1 = String((await svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Working at height", key_points: "Edge protection" })
      .select("id, root_toolbox_talk_id").single()).data?.id);
    rootId = rev1; // self-roots
    await svc().from("toolbox_talks").update({ status: "issued", reference: REF1, issued_at: new Date().toISOString() }).eq("id", rev1);
    // A member acknowledges rev 1.
    await svc().from("safety_acknowledgements").insert({
      org_id: orgA, subject_type: "toolbox_talk", subject_id: rev1, subject_version: REF1,
      user_id: member, statement: "I attended…", statement_version: "v1", signed_name: "U m",
    });
  });
  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (member) await serviceClient().auth.admin.deleteUser(member);
  });

  // Build a rev-2 draft off the current issued rev 1.
  async function draftRev2(): Promise<string> {
    const r = await svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Working at height", key_points: "Edge protection + updated exclusion zone", root_toolbox_talk_id: rootId, revision_number: 2, supersedes_id: rev1 })
      .select("id").single();
    if (r.error) throw new Error(`draftRev2: ${r.error.message}`);
    return String(r.data?.id);
  }

  it("a new revision draft carries ZERO acknowledgements forward (own version)", async () => {
    const rev2 = await draftRev2();
    const acks = await svc().from("safety_acknowledgements").select("id").eq("subject_id", rev2);
    expect((acks.data ?? []).length, "a fresh revision starts with no acks").toBe(0);
    // rev 1's ack is untouched + historical
    const rev1acks = await svc().from("safety_acknowledgements").select("id").eq("subject_id", rev1);
    expect((rev1acks.data ?? []).length).toBe(1);
    await svc().from("toolbox_talks").delete().eq("id", rev2); // reset for later tests (draft is deletable)
  });

  it("issuing a revision supersedes rev 1, numbers it -R02, freezes a snapshot, keeps one current", async () => {
    const rev2 = await draftRev2();
    const snap = { talk_reference: `${REF1}-R02`, revision: 2, topic: "Working at height" };
    const res = await svc().rpc("issue_toolbox_talk_revision", { p_id: rev2, p_snapshot: snap });
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data)).toBe(`${REF1}-R02`);

    const series = (await svc().from("toolbox_talks").select("id, status, reference, revision_number, snapshot").eq("root_toolbox_talk_id", rootId)).data ?? [];
    const issued = series.filter((s) => s.status === "issued");
    expect(issued.length, "exactly one issued (current) revision per series").toBe(1);
    expect(String(issued[0]?.id)).toBe(rev2);
    expect(issued[0]?.reference).toBe(`${REF1}-R02`);
    expect(issued[0]?.snapshot, "the revision froze its evidence snapshot").not.toBeNull();
    const superseded = series.find((s) => s.id === rev1);
    expect(superseded?.status, "rev 1 is now superseded").toBe("superseded");

    // Re-ack: the member acknowledges rev 2 at ITS version; rev 1 ack remains.
    const reack = await svc().from("safety_acknowledgements").insert({
      org_id: orgA, subject_type: "toolbox_talk", subject_id: rev2, subject_version: `${REF1}-R02`,
      user_id: member, statement: "I attended…", statement_version: "v1", signed_name: "U m",
    });
    expect(reack.error, "the member can re-acknowledge the current revision").toBeNull();

    // A stale acknowledgement against the SUPERSEDED rev 1 is now rejected (not current).
    const u2 = await mkUser("stale");
    await svc().from("memberships").insert({ org_id: orgA, user_id: u2, role: "staff" });
    const stale = await svc().from("safety_acknowledgements").insert({
      org_id: orgA, subject_type: "toolbox_talk", subject_id: rev1, subject_version: REF1,
      user_id: u2, statement: "x", statement_version: "v1", signed_name: "U stale",
    });
    expect(stale.error?.message ?? "", "a superseded revision cannot be acknowledged").toMatch(/cannot acknowledge a superseded toolbox talk/i);
    await serviceClient().auth.admin.deleteUser(u2);
  });

  it("[concurrency] two simultaneous rev-3 drafts → exactly one survives (one-draft/series index)", async () => {
    const mk = () => svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "t", key_points: "k", root_toolbox_talk_id: rootId, revision_number: 3, supersedes_id: rev1 })
      .select("id").single();
    const [a, b] = await Promise.allSettled([mk(), mk()]);
    const errs = [a, b].map((r) => (r.status === "fulfilled" ? r.value.error : { message: "rejected" })).filter(Boolean);
    // one insert wins, the other hits (root, revision_number) unique or the one-draft index
    expect(errs.length, "a concurrent duplicate revision must be rejected").toBe(1);
  });

  it("[concurrency] two simultaneous issues of the same draft → exactly one succeeds (FOR UPDATE)", async () => {
    // fresh draft rev 4 (rev 3 from the previous test occupies the single draft slot → clear it)
    await svc().from("toolbox_talks").delete().eq("root_toolbox_talk_id", rootId).eq("status", "draft");
    const rev = String((await svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "t4", key_points: "k4", root_toolbox_talk_id: rootId, revision_number: 4, supersedes_id: rev1 })
      .select("id").single()).data?.id);
    const snap = { talk_reference: `${REF1}-R04`, revision: 4 };
    const [a, b] = await Promise.allSettled([
      svc().rpc("issue_toolbox_talk_revision", { p_id: rev, p_snapshot: snap }),
      svc().rpc("issue_toolbox_talk_revision", { p_id: rev, p_snapshot: snap }),
    ]);
    const oks = [a, b].filter((r) => r.status === "fulfilled" && !r.value.error).length;
    expect(oks, "the FOR UPDATE lock lets exactly one issue win").toBe(1);
  });
});
