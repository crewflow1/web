import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 80% / 100% HQ SPEND ALERTS — the TypeScript seam (lib/ai/governor/spend-alerts.ts)
 * and its wiring into invokeWithGovernor.
 *
 * The exactly-once guarantee itself is the database's (ai_claim_spend_alerts,
 * 20261363000000) and is proven against real Postgres, including under
 * concurrency, in __tests__/integration/ai/spend-threshold-alerts.test.ts. Here
 * the RPC is mocked so we can prove, as behaviour:
 *   • the gating that keeps the request path cheap (no RPC below 80% once the
 *     platform has been checked this minute; nothing again once claimed);
 *   • a refusal by the org / CrewFlow-wide ceiling raises the 100% notice;
 *   • one HQ notification per subject, highest threshold wins, urgent at 100%;
 *   • an RPC error never throws, never memoises, and retries on a later call;
 *   • the governor still refuses / returns exactly as before.
 */

const tierModelRef = vi.hoisted(
  () => ({ cheap: null, mid: null, high: null, embedding: null, transcription: null }) as Record<string, unknown>,
);
vi.mock("@/lib/ai/governor/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/governor/registry")>();
  return { ...actual, TIER_MODEL: tierModelRef };
});

const state = vi.hoisted(() => ({
  reserveRow: null as Record<string, unknown> | null,
  claimRows: [] as Array<Record<string, unknown>>,
  claimError: null as { message: string } | null,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  aborted: 0,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async () => ({ error: null }),
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === "organizations" ? { name: "Acme Builders" } : null, error: null }),
        }),
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      const result = (async () => {
        if (fn === "ai_reserve_invocation") return { data: state.reserveRow ? [state.reserveRow] : [], error: null };
        if (fn === "ai_settle_reservation") return { data: [{ outcome: "settled" }], error: null };
        if (fn === "ai_claim_spend_alerts") return { data: state.claimError ? null : state.claimRows, error: state.claimError };
        return { data: [], error: null };
      })();
      // Mirror PostgREST's builder: thenable + abortSignal().
      return Object.assign(result, {
        abortSignal: (s: AbortSignal) => {
          if (s instanceof AbortSignal) state.aborted += 1;
          return result;
        },
      });
    },
  }),
}));

const emitted = vi.hoisted(() => ({ batches: [] as unknown[][] }));
vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: async (n: unknown) => {
    emitted.batches.push(Array.isArray(n) ? n : [n]);
  },
}));

import { invokeWithGovernor } from "@/lib/ai/governor";
import {
  __resetSpendAlertMemoForTests,
  buildSpendAlertNotification,
  highestPerSubject,
  planSpendAlertCheck,
  raiseSpendAlerts,
  PLATFORM_CHECK_INTERVAL_MS,
  type SpendAlertMark,
} from "@/lib/ai/governor/spend-alerts";

const ORG = "11111111-1111-4111-8111-111111111111";
const MONTH = "2026-11";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const claims = () => state.calls.filter((c) => c.fn === "ai_claim_spend_alerts");
const mark = (over: Partial<SpendAlertMark>): Record<string, unknown> => ({
  scope: "org",
  org_id: ORG,
  threshold: 80,
  spent_pence: 8_100,
  ceiling_pence: 10_000,
  month_start: "2026-11-01",
  ...Object.fromEntries(
    Object.entries(over).map(([k, v]) => [
      ({ orgId: "org_id", spentPence: "spent_pence", ceilingPence: "ceiling_pence", monthStart: "month_start" } as Record<string, string>)[k] ?? k,
      v,
    ]),
  ),
});

let prevKey: string | undefined;
let prevHq: string | undefined;
beforeEach(() => {
  __resetSpendAlertMemoForTests();
  for (const t of Object.keys(tierModelRef)) tierModelRef[t] = null;
  tierModelRef.mid = {
    provider: "anthropic",
    model: "test-mid",
    usdPerMTokIn: 1,
    usdPerMTokOut: 1,
    reserveInputTokens: 1000,
    reserveOutputTokens: 500,
  };
  prevKey = process.env.ANTHROPIC_API_KEY;
  prevHq = process.env.CREWFLOW_INTERNAL_ORG_ID;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.CREWFLOW_INTERNAL_ORG_ID;
  state.reserveRow = null;
  state.claimRows = [];
  state.claimError = null;
  state.calls = [];
  state.aborted = 0;
  emitted.batches = [];
});
afterEach(() => {
  for (const t of Object.keys(tierModelRef)) tierModelRef[t] = null;
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
  if (prevHq === undefined) delete process.env.CREWFLOW_INTERNAL_ORG_ID;
  else process.env.CREWFLOW_INTERNAL_ORG_ID = prevHq;
});

describe("planSpendAlertCheck — the request-path gate (pure)", () => {
  const empty = { nowMs: NOW, month: MONTH, lastCheckedAt: new Map<string, number>(), claimedKnown: new Set<string>() };
  const settled = (committed: number) =>
    ({ kind: "settled", orgId: ORG, committedPence: committed, reservedPence: 0, claimPence: 10, ceilingPence: 10_000 }) as const;

  it("below 80%: only the (throttled) platform check is due", () => {
    const p = planSpendAlertCheck(settled(1_000), empty);
    expect(p.call).toBe(true);
    expect(p.touch).toEqual(["platform|-|settled"]);
    expect(p.refused).toBeNull();
  });

  it("below 80% and the platform checked inside the interval: NO round trip", () => {
    const last = new Map([["platform|-|settled", NOW - PLATFORM_CHECK_INTERVAL_MS + 1]]);
    expect(planSpendAlertCheck(settled(1_000), { ...empty, lastCheckedAt: last }).call).toBe(false);
  });

  it("at >= 80% of the org ceiling (reservation figures incl. this claim) the org check is due", () => {
    const last = new Map([["platform|-|settled", NOW]]);
    const p = planSpendAlertCheck(settled(7_990), { ...empty, lastCheckedAt: last });
    expect(p.call).toBe(true);
    expect(p.touch).toEqual([`org|${ORG}|settled`]);
  });

  it("once this instance knows the 80% marks exist, a settle costs nothing", () => {
    const known = new Set([`${MONTH}|org|${ORG}|80`, `${MONTH}|platform|-|80`]);
    expect(planSpendAlertCheck(settled(9_000), { ...empty, claimedKnown: known }).call).toBe(false);
  });

  it("a ceiling of 0 (AI switched off) never looks 'near'", () => {
    const last = new Map([["platform|-|settled", NOW]]);
    const p = planSpendAlertCheck(
      { kind: "settled", orgId: ORG, committedPence: 0, reservedPence: 0, claimPence: 1, ceilingPence: 0 },
      { ...empty, lastCheckedAt: last },
    );
    expect(p.call).toBe(false);
  });

  it("a refusal asks with p_refused, once — then not again once the 100% mark is known", () => {
    const p = planSpendAlertCheck({ kind: "refused", orgId: ORG, scope: "platform" }, empty);
    expect(p).toEqual({ call: true, refused: "platform", touch: ["platform|-|refused"] });
    const known = new Set([`${MONTH}|platform|-|100`]);
    expect(planSpendAlertCheck({ kind: "refused", orgId: ORG, scope: "platform" }, { ...empty, claimedKnown: known }).call).toBe(false);
  });
});

describe("buildSpendAlertNotification / highestPerSubject (pure)", () => {
  const m80: SpendAlertMark = { scope: "org", orgId: ORG, threshold: 80, spentPence: 8_100, ceilingPence: 10_000, monthStart: "2026-11-01" };

  it("80% → HQ audience, high priority, links to /admin/ai-costs, e-mails HQ recipients", () => {
    const n = buildSpendAlertNotification(m80, { triggeringOrgId: ORG, orgName: "Acme Builders" });
    expect(n).toMatchObject({
      org_id: ORG,
      user_id: null,
      audience: "hq",
      category: "alert",
      priority: "high",
      type: "ai.budget.warn_80",
      action_url: "/admin/ai-costs",
      email: {},
    });
    expect(n.title).toBe("AI budget 80% used: Acme Builders");
    expect(n.body).toContain("£81.00 of this company's £100.00");
    expect(n.body).toContain("1 December");
  });

  it("100% → urgent, says requests are refused and what the features do", () => {
    const n = buildSpendAlertNotification({ ...m80, threshold: 100, spentPence: 9_990 }, { triggeringOrgId: ORG, orgName: "Acme" });
    expect(n.priority).toBe("urgent");
    expect(n.type).toBe("ai.budget.reached");
    expect(n.title).toMatch(/AI requests are being refused/);
    expect(n.body).toMatch(/fall back to their non-AI behaviour/);
  });

  it("platform notices are filed under HQ's own org when configured, else the triggering org", () => {
    const p: SpendAlertMark = { ...m80, scope: "platform", orgId: null };
    expect(buildSpendAlertNotification(p, { triggeringOrgId: ORG }).org_id).toBe(ORG);
    expect(buildSpendAlertNotification(p, { triggeringOrgId: ORG, hqOrgId: "hq-org" }).org_id).toBe("hq-org");
    expect(buildSpendAlertNotification(p, { triggeringOrgId: ORG }).title).toBe("CrewFlow-wide AI budget is 80% used");
  });

  it("a 100% mark supersedes an 80% mark for the same subject", () => {
    const out = highestPerSubject([m80, { ...m80, threshold: 100 }, { ...m80, scope: "platform", orgId: null }]);
    expect(out.map((m) => `${m.scope}:${m.threshold}`).sort()).toEqual(["org:100", "platform:80"]);
  });
});

describe("raiseSpendAlerts — claim, notify once, never throw", () => {
  it("notifies HQ for each newly-claimed subject, bounded by an abort signal", async () => {
    state.claimRows = [mark({ threshold: 80 }), mark({ threshold: 100 })];
    const out = await raiseSpendAlerts({ kind: "refused", orgId: ORG, scope: "org" }, { nowMs: NOW });
    expect(out).toHaveLength(2);
    expect(claims()[0]!.args).toEqual({ p_org_id: ORG, p_default_ceiling_pence: 10_000, p_refused: "org" });
    expect(state.aborted).toBe(1);
    expect(emitted.batches).toHaveLength(1);
    const batch = emitted.batches[0] as Array<{ priority: string; title: string }>;
    expect(batch).toHaveLength(1); // 100 supersedes 80
    expect(batch[0]!.priority).toBe("urgent");
    expect(batch[0]!.title).toContain("Acme Builders");
  });

  it("the same refusal again on this instance makes NO round trip and sends nothing", async () => {
    state.claimRows = [mark({ threshold: 100 })];
    await raiseSpendAlerts({ kind: "refused", orgId: ORG, scope: "org" }, { nowMs: NOW });
    state.claimRows = [];
    await raiseSpendAlerts({ kind: "refused", orgId: ORG, scope: "org" }, { nowMs: NOW + 10 * PLATFORM_CHECK_INTERVAL_MS });
    expect(claims()).toHaveLength(1);
    expect(emitted.batches).toHaveLength(1);
  });

  it("another instance already claimed it: the RPC returns nothing, nothing is sent", async () => {
    state.claimRows = [];
    const out = await raiseSpendAlerts({ kind: "refused", orgId: ORG, scope: "org" }, { nowMs: NOW });
    expect(out).toEqual([]);
    expect(emitted.batches).toHaveLength(0);
  });

  it("an RPC error is swallowed, nothing is memoised, and the next call retries", async () => {
    state.claimError = { message: "boom" };
    await expect(raiseSpendAlerts({ kind: "refused", orgId: ORG, scope: "platform" }, { nowMs: NOW })).resolves.toEqual([]);
    state.claimError = null;
    state.claimRows = [mark({ scope: "platform", orgId: null, threshold: 100 })];
    const out = await raiseSpendAlerts({ kind: "refused", orgId: ORG, scope: "platform" }, { nowMs: NOW + 1 });
    expect(out).toHaveLength(1);
    expect(claims()).toHaveLength(2);
  });
});

describe("invokeWithGovernor — alert wiring, refusal behaviour unchanged", () => {
  it("a CrewFlow-wide refusal still blocks without running fn, and raises the platform 100% alert", async () => {
    state.reserveRow = { outcome: "blocked", block_reason: "platform_ceiling", committed_pence: 10, reserved_pence: 0, ceiling_pence: 10_000 };
    state.claimRows = [mark({ scope: "platform", orgId: null, threshold: 100, spentPence: 49_990, ceilingPence: 50_000 })];
    const fn = vi.fn(async () => ({ value: "x", usage: null }));
    const out = await invokeWithGovernor("quote.writer_draft", "drafting", fn, { orgId: ORG, userId: "u1" });
    expect(out.status).toBe("blocked");
    if (out.status === "blocked") expect(out.reason).toBe("platform_ceiling");
    expect(fn).not.toHaveBeenCalled();
    expect(claims()[0]!.args.p_refused).toBe("platform");
    expect((emitted.batches[0] as Array<{ title: string }>)[0]!.title).toMatch(/^CrewFlow-wide AI budget reached/);
  });

  it("an employee-limit refusal raises NO org/platform alert (it is not a ceiling)", async () => {
    state.reserveRow = { outcome: "blocked", block_reason: "employee_limit", committed_pence: 10, reserved_pence: 0, ceiling_pence: 10_000 };
    await invokeWithGovernor("quote.writer_draft", "drafting", vi.fn(), { orgId: ORG, userId: "u1" });
    expect(claims()).toHaveLength(0);
  });

  it("a settled call at >= 80% raises the org alert AFTER settlement, and the call still returns its value", async () => {
    state.reserveRow = { outcome: "reserved", reservation_id: "r1", committed_pence: 8_000, reserved_pence: 0, ceiling_pence: 10_000 };
    state.claimRows = [mark({ threshold: 80 })];
    const out = await invokeWithGovernor(
      "quote.writer_draft",
      "drafting",
      async () => ({ value: "drafted", usage: { provider: "anthropic", model: "test-mid", inputTokens: 10, outputTokens: 10 } }),
      { orgId: ORG, userId: "u1" },
    );
    expect(out.status).toBe("ran");
    if (out.status === "ran") expect(out.value).toBe("drafted");
    const order = state.calls.map((c) => c.fn);
    expect(order.indexOf("ai_claim_spend_alerts")).toBeGreaterThan(order.indexOf("ai_settle_reservation"));
    expect(emitted.batches).toHaveLength(1);
  });

  it("a throwing alert path can never break the governed call", async () => {
    state.reserveRow = { outcome: "reserved", reservation_id: "r2", committed_pence: 9_000, reserved_pence: 0, ceiling_pence: 10_000 };
    state.claimRows = [{ scope: "org", org_id: ORG, threshold: 80, spent_pence: 9_000, ceiling_pence: 10_000, month_start: "2026-11-01" }];
    emitted.batches = null as unknown as unknown[][]; // emitNotifications mock will now throw on push
    const out = await invokeWithGovernor(
      "quote.writer_draft",
      "drafting",
      async () => ({ value: "ok", usage: { provider: "anthropic", model: "test-mid", inputTokens: 1, outputTokens: 1 } }),
      { orgId: ORG, userId: "u1" },
    );
    expect(out.status).toBe("ran");
    emitted.batches = [];
  });
});
