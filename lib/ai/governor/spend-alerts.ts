import "server-only";

/**
 * AI Cost Governor — HQ alerts when a monthly ceiling crosses 80% and 100%.
 *
 * WHAT IT DOES
 * ------------
 * Tells HQ (in-app HQ notification + the configured HQ e-mail recipients) the
 * first time in a Europe/London month that
 *   - an ORG's monthly AI ceiling reaches 80%, and when it is reached (100%),
 *   - the CREWFLOW-WIDE ceiling (20261358000000) reaches 80% / 100%.
 * Exactly once per (month, scope, org, threshold): the database decides who
 * notifies — `ai_claim_spend_alerts` (20261363000000) inserts the crossed
 * thresholds with ON CONFLICT DO NOTHING and returns only the rows THIS caller
 * inserted, so concurrent callers on any number of server instances cannot
 * double-notify.
 *
 * "100%" is the REFUSAL: the reservation refuses a call that would cross the
 * ceiling, so committed spend normally stops just short of it. A reservation
 * refused by the org ceiling (`ceiling`) or the CrewFlow-wide one
 * (`platform_ceiling`) is passed as `refused` and raises the 100% notice.
 *
 * WHY IT IS CHEAP ON THE REQUEST PATH
 * -----------------------------------
 * It runs after a call has already settled (or been refused), never before a
 * provider call, and it never calls a provider. Most calls make NO extra round
 * trip at all:
 *   - the ORG check runs only when the reservation's own figures (already in
 *     hand) put the org at >= 80% after this claim;
 *   - the PLATFORM check runs at most once per PLATFORM_CHECK_INTERVAL_MS per
 *     server instance (its position is not in hand without a query);
 *   - once this instance has seen a threshold claimed, it never asks again
 *     that month.
 * When a check does run it is one RPC, bounded by SPEND_ALERT_RPC_TIMEOUT_MS,
 * that returns early once the month's marks exist.
 *
 * IT NEVER THROWS AND NEVER BLOCKS AN AI CALL. An alert is advisory; the
 * ceiling itself is enforced by the reservation whether or not HQ was told.
 * If the RPC fails, nothing is memoised, so the next eligible call retries.
 * The claim-then-notify order means a crash between the two loses that one
 * notice (at-most-once); it can never send two.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { hqBudgetOrgId } from "./attribution";
import { AI_MONTHLY_CEILING_PENCE, formatPence, ukMonthKeyOf, addMonths, type MonthKey } from "./policy";

export const SPEND_ALERT_FN = "ai_claim_spend_alerts";
/** The org check runs once the reservation's own figures reach this share. */
export const SPEND_ALERT_ORG_FRACTION = 0.8;
/** At most one platform (and one per-org) check per instance per interval. */
export const PLATFORM_CHECK_INTERVAL_MS = 60_000;
/** Hard bound on the one RPC; an alert must not hold a response up. */
export const SPEND_ALERT_RPC_TIMEOUT_MS = 1_500;

export type SpendAlertScope = "org" | "platform";
export type SpendAlertThreshold = 80 | 100;

export type SpendAlertMark = {
  scope: SpendAlertScope;
  orgId: string | null;
  threshold: SpendAlertThreshold;
  spentPence: number;
  ceilingPence: number;
  /** `YYYY-MM-01` — the Europe/London budget month the mark belongs to. */
  monthStart: string;
};

export type SpendAlertTrigger =
  /** A governed call settled; the figures are the reservation's own. */
  | {
      kind: "settled";
      orgId: string;
      committedPence: number;
      reservedPence: number;
      claimPence: number;
      ceilingPence: number;
    }
  /** A reservation was refused by the org or the CrewFlow-wide ceiling. */
  | { kind: "refused"; orgId: string; scope: SpendAlertScope };

// ── Per-instance memory (bounded; keys carry the month so they go stale) ─────
const lastCheckedAt = new Map<string, number>();
const claimedKnown = new Set<string>();
const MEMO_MAX = 10_000;

const markKey = (month: MonthKey, scope: SpendAlertScope, orgId: string | null, t: SpendAlertThreshold) =>
  `${month}|${scope}|${scope === "platform" ? "-" : orgId}|${t}`;
const checkKey = (scope: SpendAlertScope, orgId: string | null, refused: boolean) =>
  `${scope}|${scope === "platform" ? "-" : orgId}|${refused ? "refused" : "settled"}`;

function prune(): void {
  if (lastCheckedAt.size > MEMO_MAX) lastCheckedAt.clear();
  if (claimedKnown.size > MEMO_MAX) claimedKnown.clear();
}

/** Test seam: forget everything this instance has memoised. */
export function __resetSpendAlertMemoForTests(): void {
  lastCheckedAt.clear();
  claimedKnown.clear();
}

/**
 * PURE: should this trigger cost one RPC, and with which `p_refused`?
 * Reads (never writes) the per-instance memory passed in.
 */
export function planSpendAlertCheck(
  trigger: SpendAlertTrigger,
  ctx: {
    nowMs: number;
    month: MonthKey;
    lastCheckedAt: ReadonlyMap<string, number>;
    claimedKnown: ReadonlySet<string>;
  },
): { call: boolean; refused: SpendAlertScope | null; touch: string[] } {
  const due = (k: string) => ctx.nowMs - (ctx.lastCheckedAt.get(k) ?? -Infinity) >= PLATFORM_CHECK_INTERVAL_MS;

  if (trigger.kind === "refused") {
    const orgId = trigger.scope === "platform" ? null : trigger.orgId;
    const k = checkKey(trigger.scope, orgId, true);
    const known = ctx.claimedKnown.has(markKey(ctx.month, trigger.scope, orgId, 100));
    return known || !due(k)
      ? { call: false, refused: null, touch: [] }
      : { call: true, refused: trigger.scope, touch: [k] };
  }

  const touch: string[] = [];
  const ceiling = trigger.ceilingPence;
  const position = trigger.committedPence + trigger.reservedPence + trigger.claimPence;
  const orgNear = ceiling > 0 && position >= ceiling * SPEND_ALERT_ORG_FRACTION;
  const orgK = checkKey("org", trigger.orgId, false);
  if (orgNear && !ctx.claimedKnown.has(markKey(ctx.month, "org", trigger.orgId, 80)) && due(orgK)) {
    touch.push(orgK);
  }
  const platK = checkKey("platform", null, false);
  if (!ctx.claimedKnown.has(markKey(ctx.month, "platform", null, 80)) && due(platK)) {
    touch.push(platK);
  }
  return { call: touch.length > 0, refused: null, touch };
}

function parseMarks(data: unknown): SpendAlertMark[] {
  if (!Array.isArray(data)) return [];
  const out: SpendAlertMark[] = [];
  for (const raw of data as Array<Record<string, unknown>>) {
    const scope = raw?.scope;
    const threshold = Number(raw?.threshold);
    if ((scope !== "org" && scope !== "platform") || (threshold !== 80 && threshold !== 100)) continue;
    out.push({
      scope,
      orgId: typeof raw.org_id === "string" ? raw.org_id : null,
      threshold,
      spentPence: Number(raw.spent_pence) || 0,
      ceilingPence: Number(raw.ceiling_pence) || 0,
      monthStart: String(raw.month_start ?? ""),
    });
  }
  return out;
}

/** "1 December" — the day the next budget month opens. Display only. */
function nextMonthLabel(monthStart: string): string {
  const next = addMonths(monthStart.slice(0, 7), 1);
  const d = new Date(`${next}-01T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? "the start of next month"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" });
}

/**
 * PURE: the HQ notification for one mark. `orgName` is display-only.
 * Typed structurally so this module does not import the notifications service
 * eagerly (it is loaded only when there is something to send).
 */
export function buildSpendAlertNotification(
  mark: SpendAlertMark,
  ctx: { triggeringOrgId: string; orgName?: string | null; hqOrgId?: string | null },
) {
  const reached = mark.threshold === 100;
  const pct = mark.ceilingPence > 0 ? Math.floor((mark.spentPence / mark.ceilingPence) * 100) : 0;
  const spent = formatPence(mark.spentPence);
  const ceiling = formatPence(mark.ceilingPence);
  const until = nextMonthLabel(mark.monthStart);
  const isPlatform = mark.scope === "platform";
  const who = isPlatform ? "CrewFlow-wide" : (ctx.orgName?.trim() || "A company");

  const title = isPlatform
    ? reached
      ? "CrewFlow-wide AI budget reached — AI requests are being refused"
      : "CrewFlow-wide AI budget is 80% used"
    : reached
      ? `AI budget reached: ${who} — AI requests are being refused`
      : `AI budget 80% used: ${who}`;

  const body = isPlatform
    ? reached
      ? `${spent} of the ${ceiling} CrewFlow-wide monthly AI budget is committed (${pct}%). New AI requests from every company are refused until ${until} or until HQ raises the CrewFlow-wide ceiling.`
      : `${spent} of the ${ceiling} CrewFlow-wide monthly AI budget is committed (${pct}%). At 100% every company's AI requests are refused until ${until}.`
    : reached
      ? `${spent} of this company's ${ceiling} monthly AI budget is committed (${pct}%), and a request was refused because it would exceed the ceiling. Its AI features fall back to their non-AI behaviour until ${until} or until HQ raises its ceiling.`
      : `${spent} of this company's ${ceiling} monthly AI budget is committed (${pct}%). At 100% its AI requests are refused until ${until}.`;

  return {
    // HQ audience: org_id is only the routing key. A CrewFlow-wide notice is
    // filed under HQ's own org when one is configured, else the org whose call
    // tripped it.
    org_id: isPlatform ? (ctx.hqOrgId ?? ctx.triggeringOrgId) : (mark.orgId ?? ctx.triggeringOrgId),
    user_id: null,
    audience: "hq" as const,
    type: reached ? "ai.budget.reached" : "ai.budget.warn_80",
    category: "alert" as const,
    priority: reached ? ("urgent" as const) : ("high" as const),
    title,
    body,
    action_url: "/admin/ai-costs",
    source_module: "ai_budget",
    source_id: `${mark.scope}:${mark.orgId ?? "-"}:${mark.monthStart}:${mark.threshold}`,
    metadata: {
      scope: mark.scope,
      threshold: mark.threshold,
      month_start: mark.monthStart,
      spent_pence: mark.spentPence,
      ceiling_pence: mark.ceilingPence,
    },
    // Fan out to the HQ e-mail recipients configured on /admin/settings (quiet
    // hours honoured by the bridge); with none configured nothing is queued.
    email: {},
  };
}

/** Keep only the highest threshold per (scope, org): a 100% notice supersedes 80%. */
export function highestPerSubject(marks: readonly SpendAlertMark[]): SpendAlertMark[] {
  const best = new Map<string, SpendAlertMark>();
  for (const m of marks) {
    const k = `${m.scope}|${m.orgId ?? "-"}`;
    const cur = best.get(k);
    if (!cur || m.threshold > cur.threshold) best.set(k, m);
  }
  return [...best.values()];
}

type RpcBuilder = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  abortSignal?: (s: AbortSignal) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
type Db = {
  rpc(fn: string, args: Record<string, unknown>): RpcBuilder;
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
    };
  };
};

/**
 * Raise any newly-crossed 80% / 100% alerts for this trigger. Never throws.
 * Returns the marks this call claimed (and notified), for tests and logs.
 */
export async function raiseSpendAlerts(
  trigger: SpendAlertTrigger,
  opts: { defaultCeilingPence?: number; nowMs?: number } = {},
): Promise<SpendAlertMark[]> {
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const month = ukMonthKeyOf(nowMs);
    const plan = planSpendAlertCheck(trigger, { nowMs, month, lastCheckedAt, claimedKnown });
    if (!plan.call) return [];
    prune();
    for (const k of plan.touch) lastCheckedAt.set(k, nowMs);

    const client = createAdminClient() as unknown as Db;
    const q = client.rpc(SPEND_ALERT_FN, {
      p_org_id: trigger.orgId,
      p_default_ceiling_pence: opts.defaultCeilingPence ?? AI_MONTHLY_CEILING_PENCE,
      p_refused: plan.refused,
    });
    const bounded =
      typeof q.abortSignal === "function" ? q.abortSignal(AbortSignal.timeout(SPEND_ALERT_RPC_TIMEOUT_MS)) : q;
    const { data, error } = await bounded;
    if (error) {
      console.error("[ai/spend-alerts] threshold claim failed — will retry on a later call", error.message);
      for (const k of plan.touch) lastCheckedAt.delete(k);
      return [];
    }

    const marks = parseMarks(data);
    for (const m of marks) {
      const mk = ukMonthKeyOf(`${m.monthStart}T12:00:00Z`);
      claimedKnown.add(markKey(mk, m.scope, m.orgId, m.threshold));
      if (m.threshold === 100) claimedKnown.add(markKey(mk, m.scope, m.orgId, 80));
    }
    // A refusal check that succeeded means the 100% mark now exists (ours or
    // another instance's): this instance need not ask again this month.
    if (plan.refused) {
      const orgId = plan.refused === "platform" ? null : trigger.orgId;
      claimedKnown.add(markKey(month, plan.refused, orgId, 100));
      claimedKnown.add(markKey(month, plan.refused, orgId, 80));
    }
    if (marks.length === 0) return [];

    await notifyHq(highestPerSubject(marks), trigger.orgId, client);
    return marks;
  } catch (e) {
    console.error("[ai/spend-alerts] threshold alert threw — ignored", e instanceof Error ? e.message : String(e));
    return [];
  }
}

async function notifyHq(marks: readonly SpendAlertMark[], triggeringOrgId: string, client: Db): Promise<void> {
  let orgName: string | null = null;
  const orgMark = marks.find((m) => m.scope === "org" && m.orgId);
  if (orgMark?.orgId) {
    try {
      const { data } = await client.from("organizations").select("name").eq("id", orgMark.orgId).maybeSingle();
      const n = (data as { name?: unknown } | null)?.name;
      orgName = typeof n === "string" ? n : null;
    } catch {
      orgName = null; // display only — the notice still goes out
    }
  }
  const hqOrgId = hqBudgetOrgId();
  const notifications = marks.map((m) => buildSpendAlertNotification(m, { triggeringOrgId, orgName, hqOrgId }));
  const { emitNotifications } = await import("@/server/services/notifications-service");
  await emitNotifications(notifications);
  for (const m of marks) {
    console.warn(
      `[ai/spend-alerts] HQ notified: ${m.scope}${m.orgId ? ` ${m.orgId}` : ""} reached ${m.threshold}% ` +
        `(${m.spentPence}p of ${m.ceilingPence}p, ${m.monthStart})`,
    );
  }
}
