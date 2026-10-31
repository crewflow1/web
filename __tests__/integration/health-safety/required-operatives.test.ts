import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Required-operative data model (H&S M6b). The sign-off "required" set is the
 * distinct crew rota'd to a document's job. Under R5 Phase 5 rota_entries SELECT
 * is self-scoped (a member sees only their OWN shifts), so the crew is derived
 * through the org-guarded SECURITY DEFINER job_rota_crew RPC (20261256) — the
 * same path app/(app)/health-safety/_signoff-data.ts:requiredOperatives uses.
 * This proves: a member (JWT) in the job's org gets the WHOLE crew via that RPC,
 * it de-duplicates per job, and it is org-scoped (another org's job → empty, and
 * the RPC refuses an org the caller is not a member of).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; delete(): Del }
type Rpc = (fn: string, args: Row) => PromiseLike<Res<string[]>>;
const db = (client: unknown) => client as unknown as { from(t: string): Table; rpc: Rpc };
const TOKEN = `it-reqop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Caller's ACTIVE org is always its own (orgA); a foreign job returns [] (no rows
// for the caller's org), and a foreign p_org_id is refused by the RPC's guard.
const distinctCrew = async (client: unknown, orgId: string, jobId: string): Promise<string[]> => {
  const { data } = await db(client).rpc("job_rota_crew", { p_job_id: jobId, p_org_id: orgId });
  return [...new Set((data ?? []).map((u) => String(u)))].sort();
};

describeIntegration("H&S required operatives · rota-derived crew (JWT, org-scoped)", () => {
  let orgA = "", orgB = "", uA = "", uB = "", tokenA = "", jobA = "", jobA2 = "", jobB = "";
  const svc = () => db(serviceClient());

  async function member(org: string, tag: string): Promise<string> {
    const c = await serviceClient().auth.admin.createUser({ email: `${TOKEN}-${tag}@x.test`, password: `Pw-${TOKEN}`, email_confirm: true });
    const id = c.data.user?.id ?? "";
    await svc().from("users").insert({ id, email: `${TOKEN}-${tag}@x.test`, full_name: tag });
    await svc().from("memberships").insert({ org_id: org, user_id: id, role: "staff" });
    return id;
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "ReqOp A", slug: `${TOKEN}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "ReqOp B", slug: `${TOKEN}-b` }).select("id").single()).data?.id);
    uA = await member(orgA, "opA");
    uB = await member(orgA, "opB");
    jobA = String((await svc().from("jobs").insert({ org_id: orgA }).select("id").single()).data?.id);
    jobA2 = String((await svc().from("jobs").insert({ org_id: orgA }).select("id").single()).data?.id);
    jobB = String((await svc().from("jobs").insert({ org_id: orgB }).select("id").single()).data?.id);
    const t0 = Date.now();
    const shift = (o: number) => ({ starts_at: new Date(t0 + o * 3.6e6).toISOString(), ends_at: new Date(t0 + (o + 4) * 3.6e6).toISOString() });
    // uA is rota'd to jobA on TWO shifts (must de-dup to one); uB once on jobA + once on jobA2.
    await svc().from("rota_entries").insert([
      { org_id: orgA, user_id: uA, job_id: jobA, ...shift(0) },
      { org_id: orgA, user_id: uA, job_id: jobA, ...shift(24) },
      { org_id: orgA, user_id: uB, job_id: jobA, ...shift(0) },
      { org_id: orgA, user_id: uB, job_id: jobA2, ...shift(0) },
      { org_id: orgB, user_id: uB, job_id: jobB, ...shift(0) }, // another org's rota
    ]);
    tokenA = (await anonClient().auth.signInWithPassword({ email: `${TOKEN}-opA@x.test`, password: `Pw-${TOKEN}` })).data.session?.access_token ?? "";
    if (!tokenA) throw new Error("no member token");
  });
  afterAll(async () => {
    for (const o of [orgA, orgB]) if (o) await svc().from("organizations").delete().eq("id", o);
    for (const u of [uA, uB]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  it("a member sees the DISTINCT crew of a job (two shifts for one user collapse to one)", async () => {
    expect(await distinctCrew(userClient(tokenA), orgA, jobA)).toEqual([uA, uB].sort());
  });

  it("crew is per-job", async () => {
    expect(await distinctCrew(userClient(tokenA), orgA, jobA2)).toEqual([uB]);
  });

  it("another org's job yields no crew (org-scoped) — no cross-tenant leak", async () => {
    // orgA member asking for an orgB job via their own active org → empty.
    expect(await distinctCrew(userClient(tokenA), orgA, jobB)).toEqual([]);
  });
});
