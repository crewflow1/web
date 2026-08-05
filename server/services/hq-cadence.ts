import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { computeNextRun, isValidCron } from "@/lib/automation/cron";
import {
  getCadence,
  isKnownCadenceKey,
  type CadenceKey,
} from "@/lib/hq/cadence/catalogue";
// The EXISTING HQ authorities each cadence routes to — the SAME drain the
// hand-rolled app/api/cron/* route calls. The tick dispatches THROUGH these; it
// never re-implements a side effect.
import { drainResearchTasks } from "@/server/services/hq-research";
import { drainQualificationTasks } from "@/server/services/hq-qualification";
import { drainOutreachTasks } from "@/server/services/hq-outreach";
import {
  drainNotificationEmailQueue,
  cleanupOldEmailRows,
} from "@/lib/notifications/email";
import { drainDueSchedules } from "@/server/services/automation-schedules";

/**
 * CrewFlow HQ — the operating-model cadence clock service (migration 20261108).
 *
 * This is the ONE authority over the schedule registry (hq_ai_schedules) and the
 * deterministic tick that fires enabled cadences. A cadence is company
 * infrastructure — HQ-GLOBAL, no org_id (#456) — so every write below uses the
 * service-role admin client, which BYPASSES RLS; the super-admin gate therefore
 * lives HERE in code (isSuperAdminEmail), exactly as hq-workflow / hq-decisions
 * gate their service-role writes.
 *
 * ── REUSE, NOT REINVENT ──────────────────────────────────────────────────────
 *  · The next occurrence is computed by the ONE shared evaluator
 *    (lib/automation/cron.ts `computeNextRun`, UTC + deterministic) — there is no
 *    second cron evaluator.
 *  · A due cadence routes to its EXISTING HQ authority via CADENCE_DISPATCH — the
 *    same drainResearchTasks / drainQualificationTasks / drainOutreachTasks /
 *    drainNotificationEmailQueue / drainDueSchedules the legacy crons call. The
 *    tick adds a clock and a claim; it adds no new side effect.
 *
 * ── SINGLE-FIRE UNDER CONCURRENT TICKS ───────────────────────────────────────
 * Advancing next_run_at is a CONDITIONAL update keyed on the exact value the tick
 * observed: `update ... where id = ? and next_run_at = <observed>`. Two
 * overlapping ticks observe the same next_run_at; Postgres serialises on the row;
 * the first advances it and owns the occurrence, the second's predicate no longer
 * matches and updates 0 rows — so an occurrence dispatches AT MOST ONCE. This is
 * the same optimistic claim automation_schedules relies on, and it depends on
 * `computeNextRun` being deterministic so both ticks agree on the new value.
 *
 * ── DARK BY DEFAULT ──────────────────────────────────────────────────────────
 * Seeded rows are enabled=false with next_run_at NULL — the scan ignores them, so
 * the layer fires nothing until a super-admin enables a cadence. Enabling sets
 * next_run_at from cron_expr; disabling nulls it. The legacy crons keep firing
 * throughout — this is an additive modelling layer.
 *
 * Reads fail LOUDLY (readFailure); business outcomes return, never throw.
 */

export type CadenceScheduleRow = {
  id: string;
  cadence_key: string;
  cron_expr: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const COLS =
  "id, cadence_key, cron_expr, enabled, next_run_at, last_run_at, description, created_by, created_at, updated_at";

// ── The injectable client shim ───────────────────────────────────────────────
// hq_ai_schedules / hq_ai_schedule_runs are service-role-only HQ tables, not in
// the generated Supabase types — the same `as unknown as` cast idiom the sibling
// HQ services use. Narrowed to the exact chain the service needs, so a fake
// client (unit tests) or the real admin client (prod / integration) both satisfy
// it — the tick is testable without a database.
type Row = Record<string, unknown>;
type ListRes = { data: Row[] | null; error: { message: string } | null };

export type CadenceClient = {
  from: (table: string) => {
    select: (c: string) => {
      order: (k: string, o: { ascending: boolean }) => PromiseLike<ListRes>;
      eq: (k: string, v: unknown) => {
        lte: (k: string, v: unknown) => {
          order: (k: string, o: { ascending: boolean }) => {
            limit: (n: number) => PromiseLike<ListRes>;
          };
        };
      };
    };
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          select: (c: string) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
        };
      };
    };
    insert: (row: unknown) => PromiseLike<{ error: { message: string } | null }>;
  };
};

function defaultClient(): CadenceClient {
  return createAdminClient() as unknown as CadenceClient;
}

// ── The dispatch binding: cadence_key → its EXISTING HQ authority ─────────────
export type CadenceDispatchCtx = { now: Date; limit: number };
export type CadenceDispatch = (ctx: CadenceDispatchCtx) => Promise<Record<string, unknown>>;

/**
 * The map from a modelled cadence to the drain the legacy cron already calls.
 * Routing here — never a re-implemented side effect — is what makes the clock an
 * additive modelling layer over the existing authorities.
 */
export const CADENCE_DISPATCH: Record<CadenceKey, CadenceDispatch> = {
  "research-drain": async ({ limit }) => ({ ...(await drainResearchTasks(Math.min(limit, 5))) }),
  "qualification-drain": async ({ limit }) => ({
    ...(await drainQualificationTasks(Math.min(limit, 5))),
  }),
  "outreach-drain": async ({ limit }) => ({ ...(await drainOutreachTasks(Math.min(limit, 5))) }),
  "notifications-drain": async () => {
    const summary = await drainNotificationEmailQueue();
    const pruned = await cleanupOldEmailRows();
    return { ok: true, summary, pruned };
  },
  "automation-schedules-drain": async ({ now, limit }) => ({
    ...(await drainDueSchedules(now, limit)),
  }),
};

// ── Reads ────────────────────────────────────────────────────────────────────

/** Every modelled cadence, ordered by key. LOUD. Super-admin surface only. */
export async function listCadences(
  client: CadenceClient = defaultClient(),
): Promise<CadenceScheduleRow[]> {
  const res = await client
    .from("hq_ai_schedules")
    .select(COLS)
    .order("cadence_key", { ascending: true });
  if (res.error) throw readFailure("hq cadence: list", res.error);
  return (res.data ?? []) as unknown as CadenceScheduleRow[];
}

// ── Admin write: enable / pause a cadence ────────────────────────────────────

export type CadenceActor = { id: string; email: string };
export type SetEnabledResult =
  | { ok: true; cadenceKey: string; enabled: boolean; nextRunAt: string | null }
  | { ok: false; error: "forbidden" | "unknown_cadence" | "invalid_cron" | "not_found" | "write_failed" };

/**
 * Enable or pause a cadence. Super-admin gated (the service-role client bypasses
 * RLS, so the gate is here). Enabling computes next_run_at deterministically from
 * cron_expr; pausing nulls it so a stale past occurrence can never fire on
 * re-enable. Idempotent-safe: writes the requested enabled state either way.
 */
export async function setCadenceEnabled(
  input: { actor: CadenceActor; cadenceKey: string; enabled: boolean },
  now: Date = new Date(),
  client: CadenceClient = defaultClient(),
): Promise<SetEnabledResult> {
  const { actor, cadenceKey, enabled } = input;
  if (!isSuperAdminEmail(actor.email)) return { ok: false, error: "forbidden" };

  const def = getCadence(cadenceKey);
  if (!def) return { ok: false, error: "unknown_cadence" };
  if (!isValidCron(def.cronExpr)) return { ok: false, error: "invalid_cron" };

  const nextRunAt = enabled ? computeNextRun(def.cronExpr, now).toISOString() : null;

  // Pin cadence_key twice on the update so the change targets exactly this row
  // (the second .eq is a harmless idempotent guard mirroring the update chain).
  const upd = await client
    .from("hq_ai_schedules")
    .update({ enabled, next_run_at: nextRunAt })
    .eq("cadence_key", cadenceKey)
    .eq("cadence_key", cadenceKey)
    .select("id");
  if (upd.error) return { ok: false, error: "write_failed" };
  if ((upd.data?.length ?? 0) === 0) return { ok: false, error: "not_found" };

  await recordAdminActivity({
    actorId: actor.id,
    actorEmail: actor.email,
    action: enabled ? "hq_cadence.enabled" : "hq_cadence.paused",
    targetTable: "hq_ai_schedules",
    targetId: String(upd.data?.[0]?.id ?? cadenceKey),
    metadata: { cadence_key: cadenceKey, next_run_at: nextRunAt },
  });

  return { ok: true, cadenceKey, enabled, nextRunAt };
}

// ── The deterministic tick / drain ───────────────────────────────────────────

export type TickResult = {
  cadence_key: string;
  status: "fired" | "claim_lost" | "no_dispatch" | "cron_error";
};
export type TickOutcome = {
  scanned: number;
  fired: number;
  skipped: number;
  results: ReadonlyArray<TickResult>;
};

/**
 * Fire every due, enabled cadence ONCE. Service-role (HQ-global; no org scope).
 * Safe to run concurrently: the per-row optimistic claim guarantees each
 * occurrence dispatches at most once. Bounded by `limit`. Each dispatch routes to
 * the cadence's EXISTING HQ authority via the injected `dispatch` map (defaults to
 * CADENCE_DISPATCH); the `client` and `now` are injectable so the tick is
 * deterministic and unit-testable without a database.
 */
export async function tickCadences(opts?: {
  now?: Date;
  limit?: number;
  client?: CadenceClient;
  dispatch?: Record<string, CadenceDispatch | undefined>;
}): Promise<TickOutcome> {
  const now = opts?.now ?? new Date();
  const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, 100) : 50;
  const client = opts?.client ?? defaultClient();
  const dispatch = opts?.dispatch ?? CADENCE_DISPATCH;
  const nowIso = now.toISOString();

  // Due = enabled AND next_run_at <= now. The partial index (enabled) keeps the
  // scan off dark cadences entirely; next_run_at is NULL for dark rows, so the
  // <= comparison excludes them regardless.
  const due = await client
    .from("hq_ai_schedules")
    .select(COLS)
    .eq("enabled", true)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(Math.min(limit, 1000)); // F-1: provable cap; PostgREST clamps to 1000

  if (due.error) {
    console.error("[hq-cadence] due scan failed", due.error.message);
    return { scanned: 0, fired: 0, skipped: 0, results: [] };
  }

  const rows = (due.data ?? []) as unknown as CadenceScheduleRow[];
  const results: TickResult[] = [];
  let fired = 0;
  let skipped = 0;

  for (const row of rows) {
    const def = getCadence(row.cadence_key);
    const fn = isKnownCadenceKey(row.cadence_key)
      ? dispatch[row.cadence_key]
      : undefined;
    if (!def || !fn) {
      // A registry row whose cadence the catalogue no longer binds. Leave it
      // untouched (an operator can pause it); never invent a dispatch.
      skipped++;
      results.push({ cadence_key: row.cadence_key, status: "no_dispatch" });
      await logRun(client, row.id, row.cadence_key, row.next_run_at, "no_dispatch", {
        reason: "unknown_cadence_key",
      });
      continue;
    }

    // Compute the next occurrence BEFORE claiming, so an invalid cron fails
    // loudly here rather than after a partial write.
    let nextRunAt: string;
    try {
      nextRunAt = computeNextRun(row.cron_expr, now).toISOString();
    } catch (e) {
      console.error("[hq-cadence] cron compute failed", {
        cadence_key: row.cadence_key,
        cron_expr: row.cron_expr,
        error: e instanceof Error ? e.message : String(e),
      });
      skipped++;
      results.push({ cadence_key: row.cadence_key, status: "cron_error" });
      continue;
    }

    // THE CLAIM. Advance next_run_at ONLY if it still equals what we observed —
    // the optimistic lock that makes concurrent ticks single-fire.
    const claim = await client
      .from("hq_ai_schedules")
      .update({ next_run_at: nextRunAt, last_run_at: nowIso })
      .eq("id", row.id)
      .eq("next_run_at", row.next_run_at)
      .select("id");

    if (claim.error) {
      console.error("[hq-cadence] claim failed", {
        cadence_key: row.cadence_key,
        error: claim.error.message,
      });
      skipped++;
      results.push({ cadence_key: row.cadence_key, status: "claim_lost" });
      continue;
    }
    if ((claim.data?.length ?? 0) === 0) {
      // Another tick advanced it first — this occurrence is theirs.
      skipped++;
      results.push({ cadence_key: row.cadence_key, status: "claim_lost" });
      continue;
    }

    // We own the occurrence. Route to the EXISTING HQ authority. A dispatch
    // failure must not abort the rest of the tick, and next_run_at is already
    // advanced, so the cadence keeps ticking rather than wedging on one bad fire.
    let outcome: "dispatched" | "dispatch_failed" = "dispatched";
    let detail: Record<string, unknown> = {};
    try {
      detail = await fn({ now, limit });
    } catch (e) {
      outcome = "dispatch_failed";
      detail = { error: e instanceof Error ? e.message : String(e) };
      console.error("[hq-cadence] dispatch failed", {
        cadence_key: row.cadence_key,
        error: detail.error,
      });
    }

    await logRun(client, row.id, row.cadence_key, row.next_run_at, outcome, detail);
    fired++;
    results.push({ cadence_key: row.cadence_key, status: "fired" });
  }

  return { scanned: rows.length, fired, skipped, results };
}

/** Append one immutable run-log row. Best-effort — never breaks the tick. */
async function logRun(
  client: CadenceClient,
  scheduleId: string,
  cadenceKey: string,
  occurrence: string | null,
  outcome: "dispatched" | "dispatch_failed" | "no_dispatch",
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await client.from("hq_ai_schedule_runs").insert({
      schedule_id: scheduleId,
      cadence_key: cadenceKey,
      occurrence: occurrence ?? new Date(0).toISOString(),
      outcome,
      detail,
    });
    if (res.error) {
      console.error("[hq-cadence] run-log insert failed", res.error.message);
    }
  } catch (e) {
    console.error("[hq-cadence] run-log insert threw", {
      cadence_key: cadenceKey,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
