import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { gatherScheduleFacts, type ScheduleClient } from "@/server/services/schedule-integrity";
import { detectScheduleConflicts } from "@/lib/schedule/conflicts";
import { buildScheduleWindow } from "@/lib/schedule/window";
import {
  MAX_COVER_CANDIDATES,
  recommendForConflicts,
  type RecommendationCandidate,
  type ScheduleRecommendation,
} from "@/lib/schedule/recommendations";

/**
 * Schedule RECOMMENDATIONS against REAL Postgres.
 *
 * The detector's own integration suite proves the findings. This one proves the
 * three things that only appear once you try to RESOLVE a finding:
 *
 *   1. THE ROSTER IS THE WHOLE TEAM, NOT THE CONFLICTED FEW. Detection only
 *      ever needed the handful of people a conflict names. A recommendation
 *      needs the opposite set — the colleague who appears in NO conflict is
 *      exactly the one who is free — so the membership read became the roster.
 *      `pat` below is in no conflict at all and must still be offered.
 *   2. THE ROSTER IS ORG-PINNED. That widening is the dangerous half: proposing
 *      from `users` or from an RLS-only membership read would offer a dual-org
 *      viewer's OTHER company's staff as cover for this company's job — a
 *      cross-tenant leak dressed up as helpfulness. `bob` exists only in org B
 *      and is deliberately FREE at the exact clash window, so a lost pin makes
 *      him the top suggestion and this suite goes red.
 *   3. STILL NO WRITES. Every scheduling row count is captured before and after,
 *      and a table-level write proxy sits in front of the client — a
 *      recommender that "helpfully" applied its own suggestion would throw.
 *
 * Residue-independent: every fixture is namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run, so a dirty database (or a
 * concurrent suite on the shared local stack) can neither pass nor fail it
 * spuriously.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  select(c?: string, o?: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del {
  eq(c: string, v: unknown): Del & PromiseLike<Res<null>>;
}
interface Table {
  select(c?: string, o?: unknown): Sel;
  insert(r: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PAGE = 2; // force real page boundaries on a tiny fixture

/** Pinned clock → a fixed, reproducible fortnight: 10–23 August 2026 (BST). */
const NOW = new Date("2026-08-10T09:00:00Z");
const WINDOW = buildScheduleWindow(NOW);
const DAY_CLASH = "2026-08-12";
const DAY_EMPTY = "2026-08-20";

const SCHEDULE_TABLES = ["rota_entries", "jobs", "leave_requests", "asset_assignments"] as const;

function readOnlyClient(client: unknown): ScheduleClient {
  const inner = client as { from(t: string): Record<string, unknown> };
  const FORBIDDEN = new Set(["insert", "update", "upsert", "delete", "rpc"]);
  return {
    from(table: string) {
      const builder = inner.from(table);
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && FORBIDDEN.has(prop)) {
            throw new Error(`schedule recommendations attempted a WRITE (${prop}) on ${table}`);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as ReturnType<ScheduleClient["from"]>;
    },
  };
}

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(
  suffix: string,
  orgIds: string[],
  fullName: string,
): Promise<{ id: string; token: string; name: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: fullName });
  for (const orgId of orgIds) {
    const m = await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role: "staff" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token, name: fullName };
}

async function scheduleCounts(orgIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of SCHEDULE_TABLES) {
    for (const orgId of orgIds) {
      const res = await db(serviceClient()).from(table).select("id").eq("org_id", orgId);
      out[`${table}:${orgId}`] = (res.data ?? []).length;
    }
  }
  return out;
}

async function recommendationsFor(
  token: string,
  orgId: string,
  pageSize = PAGE,
): Promise<Map<string, ScheduleRecommendation>> {
  const facts = await gatherScheduleFacts(readOnlyClient(userClient(token)), orgId, WINDOW, pageSize);
  return recommendForConflicts(detectScheduleConflicts(facts), facts);
}

const byKind = (
  recs: ReadonlyMap<string, ScheduleRecommendation>,
  kind: string,
): ScheduleRecommendation => {
  const hit = [...recs.values()].filter((r) => r.kind === kind);
  expect(hit, `expected exactly one ${kind} recommendation`).toHaveLength(1);
  return hit[0]!;
};

const coverNames = (rec: ScheduleRecommendation): string[] =>
  rec.candidates.filter((c: RecommendationCandidate) => c.kind === "cover").map((c) => c.userName);

describeIntegration("schedule recommendations · real resolutions + roster org isolation (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  /** Member of BOTH orgs — the blend probe's viewer. Free at the clash window. */
  let zoe = { id: "", token: "", name: "" };
  /** Double-booked in org A by the job-assignment trigger. */
  let dave = { id: "", token: "", name: "" };
  /** Org A, free at the clash window — the answer. */
  let erin = { id: "", token: "", name: "" };
  /** Org A, on APPROVED leave across the clash — a cited rejection. */
  let sam = { id: "", token: "", name: "" };
  /** Org A, in NO conflict whatsoever — must still be offered. */
  let pat = { id: "", token: "", name: "" };
  /** Org B ONLY, and free at the exact clash window — must never be proposed. */
  let bob = { id: "", token: "", name: "" };

  const orgAJobs: string[] = [];
  let jobEmptyA = "";
  let leaveSam = "";

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Rec A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Rec B", slug: `${TOKEN}-b` });

    zoe = await mkUser("zoe", [orgA, orgB], `${TOKEN} Zoe Viewer`);
    dave = await mkUser("dave", [orgA, orgB], `${TOKEN} Dave Baker`);
    erin = await mkUser("erin", [orgA], `${TOKEN} Erin Cole`);
    sam = await mkUser("sam", [orgA], `${TOKEN} Sam Okafor`);
    pat = await mkUser("pat", [orgA], `${TOKEN} Pat Quinn`);
    bob = await mkUser("bob", [orgB], `${TOKEN} Bob Ordell`);

    const customerA = await insId(svc, "customers", { org_id: orgA, name: `${TOKEN} Harborne Build Co` });

    // ── org A · a REAL double-booking, made the way production makes one ──────
    // Two jobs, one person, one date. `jobs_rota_sync_trigger` writes a default
    // 08:00–17:00 shift for each — both JOB-BOUND, which is also what makes the
    // day-move limit assertable against real data rather than a fixture.
    orgAJobs.push(
      await insId(svc, "jobs", {
        org_id: orgA, customer_id: customerA, assigned_to: dave.id,
        scheduled_date: DAY_CLASH, status: "new",
      }),
      await insId(svc, "jobs", {
        org_id: orgA, customer_id: customerA, assigned_to: dave.id,
        scheduled_date: DAY_CLASH, status: "in-progress",
      }),
    );

    // ── org A · Sam is on approved leave across the clash ─────────────────────
    // No shift of his own, so this is NOT a leave clash — it exists purely so a
    // rejection has a real `leave_requests` row to cite.
    leaveSam = await insId(svc, "leave_requests", {
      org_id: orgA, user_id: sam.id, type: "holiday", status: "approved",
      starts_at: "2026-08-11", ends_at: "2026-08-13",
    });

    // ── org A · a job with nobody on it, on a day everyone is free ────────────
    jobEmptyA = await insId(svc, "jobs", {
      org_id: orgA, customer_id: customerA, scheduled_date: DAY_EMPTY, status: "new",
    });
    orgAJobs.push(jobEmptyA);

    // ── org B · Bob is FREE at org A's exact clash window ─────────────────────
    // He is the trap. Nothing else about him differs from Erin; only the org
    // pin keeps him out of org A's answer.
    await insId(svc, "jobs", { org_id: orgB, scheduled_date: DAY_EMPTY, status: "new" });
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [zoe, dave, erin, sam, pat, bob]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  // ── Resolutions computed from real rows ────────────────────────────────────

  it("answers the trigger-made double-booking with real, free colleagues", async () => {
    const rec = byKind(await recommendationsFor(zoe.token, orgA), "staff_double_booked");
    // The default shift the trigger wrote is 08:00–17:00Z → 09:00–18:00 in BST.
    expect(rec.need.summary).toContain("09:00–18:00");
    expect(coverNames(rec)).toContain(erin.name);
    expect(coverNames(rec)).toContain(pat.name);
    // The double-booked person is never offered as their own cover.
    expect(coverNames(rec)).not.toContain(dave.name);
    expect(rec.ruledOut.find((r) => r.userId === dave.id)?.code).toBe("is_the_conflicted_person");
  });

  it("offers a colleague who appears in NO conflict — the roster, not the cited few", async () => {
    // Pat holds no shift, no leave and no job. He is invisible to detection and
    // is precisely the person a manager needs: only a roster read finds him.
    const rec = byKind(await recommendationsFor(zoe.token, orgA), "staff_double_booked");
    const patCandidate = rec.candidates.find((c) => c.userId === pat.id);
    expect(patCandidate, "Pat must be offered").toBeDefined();
    expect(patCandidate!.role).toBe("staff");
    expect(patCandidate!.explanation).toContain("no approved leave covering that window");
  });

  it("rules out approved leave against the real leave_requests row", async () => {
    const rec = byKind(await recommendationsFor(zoe.token, orgA), "staff_double_booked");
    const samRuled = rec.ruledOut.find((r) => r.userId === sam.id);
    expect(samRuled?.code).toBe("on_approved_leave");
    expect(samRuled?.evidence).toEqual([leaveSam]);
    expect(samRuled?.text).toContain("holiday");
    expect(coverNames(rec)).not.toContain(sam.name);
  });

  it("refuses to move a job-bound shift, and says why — against real trigger rows", async () => {
    const rec = byKind(await recommendationsFor(zoe.token, orgA), "staff_double_booked");
    expect(rec.candidates.some((c) => c.kind === "move_day")).toBe(false);
    expect(rec.notes.join(" ")).toContain("tied to a job scheduled for");
  });

  it("staffs the empty job from the whole team, capped but honestly counted", async () => {
    const rec = byKind(await recommendationsFor(zoe.token, orgA), "job_unassigned");
    expect(rec.need.jobId).toBe(jobEmptyA);
    // Five org-A members, every one of them free that day.
    expect(rec.considered).toBe(5);
    expect(rec.candidateTotal).toBe(5);
    expect(rec.candidates).toHaveLength(MAX_COVER_CANDIDATES);
    expect(rec.impossible).toBeNull();
    // The apply link opens the EXISTING rota form for this very job.
    expect(rec.candidates[0]!.applyHref).toContain(`assign_job=${jobEmptyA}`);
    expect(rec.candidates[0]!.applyHref.startsWith("/staff/rota?")).toBe(true);
  });

  // ── THE ORG PIN ON THE ROSTER ──────────────────────────────────────────────

  /**
   * The proof this suite exists for. Bob is free at exactly the window org A
   * needs covered, and the viewer belongs to both orgs — so an RLS-only
   * membership read, or resolving the roster from `users`, makes him a
   * suggestion. Drop the `.eq("org_id", …)` pin and this goes red.
   */
  it("never proposes the viewer's OTHER org's staff as cover for this org", async () => {
    const recs = await recommendationsFor(zoe.token, orgA);
    for (const rec of recs.values()) {
      expect(rec.candidates.map((c) => c.userId), rec.kind).not.toContain(bob.id);
      expect(rec.ruledOut.map((r) => r.userId), rec.kind).not.toContain(bob.id);
      const text = [
        ...rec.candidates.map((c) => c.explanation),
        ...rec.ruledOut.map((r) => r.text),
        rec.impossible ?? "",
      ].join(" | ");
      expect(text).not.toContain(bob.name);
    }
  });

  it("counts only THIS org's team when it says how many were considered", async () => {
    // Six users exist across the two orgs; org A has five. A blended roster
    // would say six and quietly widen every candidate list.
    const recs = await recommendationsFor(zoe.token, orgA);
    for (const rec of recs.values()) expect(rec.considered).toBe(5);
  });

  it("serves org B its OWN roster to the same dual-org viewer", async () => {
    const recs = await recommendationsFor(zoe.token, orgB);
    const rec = byKind(recs, "job_unassigned");
    // Org B has three members: Zoe, Dave and Bob. Erin/Sam/Pat are org A only.
    expect(rec.considered).toBe(3);
    const seen = rec.candidates.map((c) => c.userName);
    expect(seen).toContain(bob.name);
    for (const outsider of [erin.name, sam.name, pat.name]) {
      expect(seen).not.toContain(outsider);
    }
  });

  it("shows a member of only the OTHER org nothing at all for org A", async () => {
    expect((await recommendationsFor(bob.token, orgA)).size).toBe(0);
  });

  it("denies an unauthenticated (anon) caller", async () => {
    const facts = await gatherScheduleFacts(readOnlyClient(anonClient()), orgA, WINDOW, PAGE);
    expect(facts.roster).toEqual([]);
    expect(recommendForConflicts(detectScheduleConflicts(facts), facts).size).toBe(0);
  });

  // ── Still read-only, still deterministic ───────────────────────────────────

  it("performs NO writes — every scheduling row count is unchanged", async () => {
    const before = await scheduleCounts([orgA, orgB]);
    await recommendationsFor(zoe.token, orgA);
    await recommendationsFor(zoe.token, orgB);
    const after = await scheduleCounts([orgA, orgB]);
    expect(after).toEqual(before);
    // …and the counts are not trivially zero, so "unchanged" means something.
    expect(before[`rota_entries:${orgA}`]).toBe(2);
  });

  it("is repeatable: the same window over the same data yields identical proposals", async () => {
    const a = await recommendationsFor(zoe.token, orgA);
    const b = await recommendationsFor(zoe.token, orgA);
    expect(JSON.stringify([...b])).toBe(JSON.stringify([...a]));
  });

  it("pages the roster read without dropping a member", async () => {
    // Five org-A memberships at a page size of 2 crosses two real boundaries.
    const small = await gatherScheduleFacts(readOnlyClient(userClient(zoe.token)), orgA, WINDOW, PAGE);
    const big = await gatherScheduleFacts(readOnlyClient(userClient(zoe.token)), orgA, WINDOW);
    expect(small.roster).toHaveLength(5);
    expect(small.roster.map((m) => m.userId)).toEqual(big.roster.map((m) => m.userId));
    expect(new Set(small.roster.map((m) => m.userId)).size).toBe(5);
  });
});
