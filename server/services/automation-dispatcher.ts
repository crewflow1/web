import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import type { NotificationCreate } from "@/lib/notifications/types";
import {
  AUTOMATION_RULES,
  correlationIdFor,
  rulesForEvent,
} from "@/lib/automation/rules";
import type {
  AutomationActionType,
  AutomationEvent,
  AutomationRule,
} from "@/lib/automation/events";

/**
 * Automation OS dispatcher.
 *
 * Called by domain server actions after they save the row that
 * triggered an event. E.g. `acceptQuoteAsOwner` calls
 * `dispatchAutomation({type:"quote.accepted", org_id, source_table:
 * "quotes", source_id: quote.id, payload: {...}})`.
 *
 * For each rule that matches the event:
 *   1. Check the (rule_id, correlation_id) pair in `automation_runs`.
 *      If present → no-op (idempotent). Re-firing the same event is
 *      always safe — webhook replays, double-clicks, retries.
 *   2. Run each action handler in sequence. Per-action errors are
 *      captured per-action; one bad action does not abort the rule.
 *   3. Insert one `automation_runs` row capturing result + duration.
 *
 * Never throws — domain actions don't get derailed by an automation
 * failure. Errors are logged + persisted.
 *
 * Action handlers live inline here for v1 — small enough that a
 * separate registry is over-engineering until the catalogue grows.
 */

export type DispatchResult = {
  ran: ReadonlyArray<{
    rule_id: string;
    status: "ok" | "failed" | "skipped";
    error?: string;
  }>;
};

export async function dispatchAutomation(
  event: AutomationEvent,
): Promise<DispatchResult> {
  const matched = rulesForEvent(event.type);
  if (matched.length === 0) return { ran: [] };

  const admin = createAdminClient();
  const out: Array<{ rule_id: string; status: "ok" | "failed" | "skipped"; error?: string }> = [];

  for (const rule of matched) {
    const correlationId = correlationIdFor(
      event.type,
      event.source_table,
      event.source_id,
    );

    if (!rule.enabled) {
      // Terminal + immediate: claim and stamp complete in one step, so a
      // disabled rule can never be "reclaimed" and re-skipped forever.
      await recordDisabled(admin, event, rule, correlationId);
      out.push({ rule_id: rule.id, status: "skipped" });
      continue;
    }

    // THE CLAIM. Postgres decides the winner, not a read.
    //
    // This replaced a read-then-insert whose window was the entire action
    // execution: two callers both read "not found", both ran the actions, and
    // only the second INSERT collided — so the duplicate alert/notification had
    // already happened. The unique constraint guarded the row, never the work.
    const claim = await claimRun(admin, event, rule, correlationId);
    if (!claim.ok) {
      // A database error during the claim is surfaced, never swallowed: we do
      // not know whether we hold the claim, so we must not act.
      out.push({ rule_id: rule.id, status: "failed", error: claim.error });
      continue;
    }
    if (!claim.won) {
      out.push({ rule_id: rule.id, status: "skipped" });
      continue;
    }

    const startedAt = Date.now();
    const actionResults: Record<string, unknown> = {};
    let ruleError: string | null = null;

    for (const action of rule.actions) {
      try {
        const r = await runAction(action, event, rule);
        actionResults[action] = r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        actionResults[action] = { ok: false, error: msg };
        ruleError = ruleError ?? `${action}: ${msg}`;
        console.error("[automation] action failed", {
          rule: rule.id,
          action,
          error: msg,
        });
      }
    }

    const status: "ok" | "failed" = ruleError ? "failed" : "ok";
    await finishRun(
      admin,
      rule,
      correlationId,
      status,
      actionResults,
      ruleError,
      Date.now() - startedAt,
    );
    out.push({ rule_id: rule.id, status, error: ruleError ?? undefined });
  }

  return { ran: out };
}

/** How long a 'running' claim is honoured before it is treated as orphaned. */
export const AUTOMATION_CLAIM_LEASE_MS = 15 * 60 * 1000;

type ClaimOutcome =
  | { ok: true; won: boolean }
  | { ok: false; won: false; error: string };

/**
 * Atomically claim (rule_id, correlation_id) before ANY action runs.
 *
 * Two steps, both atomic, neither a read-then-write:
 *
 *  1. INSERT ... ON CONFLICT DO NOTHING. Postgres admits exactly one winner
 *     against `unique (rule_id, correlation_id)`. A returned row IS the claim.
 *
 *  2. If the insert conflicted, someone else owns the row. Try to RECLAIM it
 *     with a conditional UPDATE — a single statement, so concurrent reclaimers
 *     serialise on the row lock and the WHERE is re-evaluated under it. Exactly
 *     one can win. Reclaim is permitted only when:
 *       - completed_at IS NULL          (never steal finished work), AND
 *       - status = 'failed'             (a live dispatcher RELEASED it — nothing
 *                                        is in flight, so no lease is needed), OR
 *       - claimed_at < now() - lease    (orphaned: no route can run 300s+).
 *     An active 'running' lease matches neither, so it is left alone.
 *
 * Returns won:false for "someone else holds or finished this" — the caller must
 * then run NOTHING. Returns ok:false on a database error: we cannot tell whether
 * we hold the claim, so the only safe action is none.
 */
async function claimRun(
  admin: ReturnType<typeof createAdminClient>,
  event: AutomationEvent,
  rule: AutomationRule,
  correlationId: string,
): Promise<ClaimOutcome> {
  const nowIso = new Date().toISOString();

  const ins = await (
    admin.from("automation_runs" as never) as unknown as {
      insert: (row: unknown, opts?: { onConflict?: string }) => {
        select: (cols: string) => Promise<{
          data: Array<{ id: string }> | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    }
  )
    .insert(
      {
        org_id: event.org_id,
        event_type: event.type,
        rule_id: rule.id,
        correlation_id: correlationId,
        status: "running",
        claimed_at: nowIso,
        completed_at: null,
      },
      { onConflict: "rule_id,correlation_id" },
    )
    .select("id");

  if (!ins.error) {
    // Won the insert race outright.
    if ((ins.data?.length ?? 0) > 0) return { ok: true, won: true };
    // No row and no error: the insert was ignored as a duplicate. Fall through
    // to the reclaim path.
  } else if (ins.error.code !== "23505") {
    // A real database failure — surfaced, never swallowed. The old code
    // discarded this entirely (the `{ error }` return was never checked).
    console.error("[automation] claim insert failed", {
      rule: rule.id,
      correlation_id: correlationId,
      code: ins.error.code,
      message: ins.error.message,
    });
    return { ok: false, won: false, error: `claim_failed: ${ins.error.message}` };
  }

  // Someone already holds the row. Reclaim ONLY if it is releasable.
  const leaseCutoff = new Date(Date.now() - AUTOMATION_CLAIM_LEASE_MS).toISOString();
  const upd = await (
    admin.from("automation_runs" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            is: (k: string, v: unknown) => {
              or: (f: string) => {
                select: (cols: string) => Promise<{
                  data: Array<{ id: string }> | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
    }
  )
    .update({ status: "running", claimed_at: nowIso, error_message: null })
    .eq("rule_id", rule.id)
    .eq("correlation_id", correlationId)
    // Never steal completed work — completed_at is the only proof of done.
    .is("completed_at", null)
    .or(`status.eq.failed,claimed_at.lt.${leaseCutoff}`)
    .select("id");

  if (upd.error) {
    console.error("[automation] claim reclaim failed", {
      rule: rule.id,
      correlation_id: correlationId,
      message: upd.error.message,
    });
    return { ok: false, won: false, error: `reclaim_failed: ${upd.error.message}` };
  }
  // Rows updated → we reclaimed it. None → it is complete, or an active lease
  // is held by someone still working. Either way: run nothing.
  return { ok: true, won: (upd.data?.length ?? 0) > 0 };
}

/**
 * Close out a claimed run.
 *
 * ONLY a run whose actions all succeeded is stamped `completed_at` — that is
 * the single fact separating "done, never touch again" from "retryable".
 *
 * A failure RELEASES the claim: status 'failed', completed_at stays NULL. The
 * next caller may reclaim it immediately, because a live dispatcher recorded
 * this and nothing is in flight — no lease is involved.
 *
 * PARTIAL FAILURE, stated honestly: if any action failed, the rule is NOT
 * completed, so a retry re-runs EVERY action — including those that already
 * succeeded. That is at-least-once. Per-action claims would fix it and are a
 * genuine redesign; this does not pretend to a stronger guarantee. Per-action
 * results are preserved either way, so a successful action is never reported as
 * failed and vice versa.
 */
async function finishRun(
  admin: ReturnType<typeof createAdminClient>,
  rule: AutomationRule,
  correlationId: string,
  status: "ok" | "failed",
  result: Record<string, unknown>,
  errorMessage: string | null,
  durationMs: number,
): Promise<void> {
  const res = await (
    admin.from("automation_runs" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => Promise<{
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .update({
      status,
      result,
      // Cleared on success so a retry that fixes a previously failed run does
      // not leave the stale error behind.
      error_message: status === "ok" ? null : errorMessage,
      duration_ms: durationMs,
      completed_at: status === "ok" ? new Date().toISOString() : null,
    })
    .eq("rule_id", rule.id)
    .eq("correlation_id", correlationId);

  // Explicit: Supabase RETURNS { error } rather than throwing, so the old
  // try/catch here could never fire and silently discarded every failure.
  if (res.error) {
    console.error("[automation] failed to record run outcome", {
      rule: rule.id,
      correlation_id: correlationId,
      status,
      message: res.error.message,
    });
  }
}

/**
 * A disabled rule: terminal immediately, in one write.
 *
 * Claimed and completed together — there is no work to interrupt, so it must
 * never sit 'running' waiting on a lease that will never expire meaningfully.
 */
async function recordDisabled(
  admin: ReturnType<typeof createAdminClient>,
  event: AutomationEvent,
  rule: AutomationRule,
  correlationId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const res = await (
    admin.from("automation_runs" as never) as unknown as {
      insert: (row: unknown, opts?: { onConflict?: string }) => Promise<{
        error: { message: string; code?: string } | null;
      }>;
    }
  ).insert(
    {
      org_id: event.org_id,
      event_type: event.type,
      rule_id: rule.id,
      correlation_id: correlationId,
      status: "skipped",
      result: { reason: "rule_disabled" },
      duration_ms: 0,
      claimed_at: nowIso,
      completed_at: nowIso,
    },
    { onConflict: "rule_id,correlation_id" },
  );
  // 23505 is expected and benign here: another caller already recorded this
  // exact skip. Anything else is surfaced rather than discarded.
  if (res.error && res.error.code !== "23505") {
    console.error("[automation] failed to record disabled-rule skip", {
      rule: rule.id,
      correlation_id: correlationId,
      message: res.error.message,
    });
  }
}

// ---------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------

async function runAction(
  action: AutomationActionType,
  event: AutomationEvent,
  rule: AutomationRule,
): Promise<Record<string, unknown>> {
  switch (action) {
    case "create_notification":
      return runCreateNotification(event, rule);
    case "create_alert":
      // Alerts integrate with the existing HQ-5 alerts engine. For v1
      // we just record an audit-log entry tagged with the alert
      // context; the actual alert row is owned by the rules engine
      // running on its own cron schedule.
      await recordAdminActivity({
        actorId: null,
        actorEmail: event.actor_email ?? null,
        action: `automation.${rule.id}.alert`,
        targetTable: event.source_table,
        targetId: event.source_id,
        metadata: { event_type: event.type, payload: event.payload },
      });
      return { ok: true, kind: "alert_audited" };
    case "add_internal_note":
      await recordAdminActivity({
        actorId: null,
        actorEmail: event.actor_email ?? null,
        action: `automation.${rule.id}.note`,
        targetTable: event.source_table,
        targetId: event.source_id,
        metadata: { event_type: event.type, payload: event.payload },
      });
      return { ok: true, kind: "note_recorded" };
    case "create_milestone":
      // Milestones are owned by the retention layer
      // (server/services/retention-milestones.ts). The dispatcher
      // doesn't create them directly — the dashboard's
      // ensureMilestoneNotifications picks them up on next render.
      // For v1 we just audit the trigger.
      await recordAdminActivity({
        actorId: null,
        actorEmail: event.actor_email ?? null,
        action: `automation.${rule.id}.milestone`,
        targetTable: event.source_table,
        targetId: event.source_id,
        metadata: { event_type: event.type, payload: event.payload },
      });
      return { ok: true, kind: "milestone_signal_recorded" };
    case "send_email_queue":
    case "create_invoice_draft":
    case "update_status":
      // Future expansion. The directive's Step 4 built-ins ALREADY
      // emit notifications via 'create_notification' which fans out
      // to email through the existing notification_email_queue cron.
      // Direct queue writes / invoice creation / status mutation
      // are reserved for a future user-rule authoring phase.
      return { ok: true, kind: `${action}_noop_v1` };
  }
}

async function runCreateNotification(
  event: AutomationEvent,
  rule: AutomationRule,
): Promise<Record<string, unknown>> {
  // Domain-specific copy for each event type. The dispatcher owns
  // the wording — keeps the rule catalogue declarative.
  const audience = event.type.startsWith("demo.") ? "hq" : "customer";
  const titles: Record<string, string> = {
    "quote.accepted": "A quote was just accepted",
    "quote.declined": "A quote was declined",
    "quote.sent": "Quote sent to customer",
    "invoice.overdue": "An invoice is overdue",
    "invoice.created": "Invoice created",
    "job.completed": "Job marked complete — send the invoice?",
    "job.created": "New job scheduled",
    "import.completed": "Migration committed",
    "demo.booked": "New demo booked",
    "demo.approved": "Demo approved",
    "onboarding.completed": "Setup complete — welcome!",
    "support.ticket.created": "A new support ticket was opened",
    "support.ticket.replied": "Support ticket has a new reply",
    "milestone.reached": "New milestone reached",
    "account.created": "Welcome to CrewFlow",
    "payment.recorded": "Payment recorded",
  };

  const note: NotificationCreate = {
    org_id: event.org_id,
    user_id: null,
    audience: audience as "customer" | "hq",
    type: `automation.${event.type}`,
    category: "system",
    priority: event.type === "invoice.overdue" ? "high" : "medium",
    title: titles[event.type] ?? rule.label,
    body: null,
    action_url:
      event.source_table === "quotes"
        ? `/quotes/${event.source_id}`
        : event.source_table === "invoices"
          ? `/invoices/${event.source_id}`
          : event.source_table === "jobs"
            ? `/jobs/${event.source_id}`
            : event.source_table === "imports"
              ? `/imports/${event.source_id}`
              : event.source_table === "support_tickets"
                ? `/support/${event.source_id}`
                : `/dashboard`,
    source_module: "automation",
    source_id: event.source_id,
    metadata: { rule_id: rule.id, event_type: event.type },
  };

  await emitNotifications([note]);
  return { ok: true, kind: "notification_emitted", audience };
}

// ---------------------------------------------------------------------
// Read-side helpers (for /admin/automations)
// ---------------------------------------------------------------------

export type AutomationRuleHealth = {
  rule: AutomationRule;
  runs_7d: number;
  failures_7d: number;
  last_run_at: string | null;
  last_status: "ok" | "failed" | "skipped" | null;
};

export async function readAutomationHealth(): Promise<
  ReadonlyArray<AutomationRuleHealth>
> {
  const admin = createAdminClient();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 86_400_000,
  ).toISOString();

  type Row = {
    rule_id: string;
    status: "ok" | "failed" | "skipped";
    created_at: string;
  };

  const { data } = await (admin.from("automation_runs" as never) as unknown as {
    select: (cols: string) => {
      gte: (k: string, v: string) => {
        order: (k: string, opts: { ascending: boolean }) => Promise<{
          data: Row[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  })
    .select("rule_id, status, created_at")
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false });

  const rows = data ?? [];

  return AUTOMATION_RULES.map((rule) => {
    const ruleRows = rows.filter((r) => r.rule_id === rule.id);
    const latest = ruleRows[0] ?? null;
    return {
      rule,
      runs_7d: ruleRows.length,
      failures_7d: ruleRows.filter((r) => r.status === "failed").length,
      last_run_at: latest?.created_at ?? null,
      last_status: latest?.status ?? null,
    };
  });
}
