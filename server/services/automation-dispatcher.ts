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

    // Idempotency check.
    const existing = await (
      admin.from("automation_runs" as never) as unknown as {
        select: (cols: string) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{
                data: { id: string } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      }
    )
      .select("id")
      .eq("rule_id", rule.id)
      .eq("correlation_id", correlationId)
      .maybeSingle();

    if (existing.data?.id) {
      out.push({ rule_id: rule.id, status: "skipped" });
      continue;
    }

    if (!rule.enabled) {
      await recordRun(admin, event, rule, correlationId, "skipped", {
        reason: "rule_disabled",
      }, null, 0);
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
    await recordRun(
      admin,
      event,
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

async function recordRun(
  admin: ReturnType<typeof createAdminClient>,
  event: AutomationEvent,
  rule: AutomationRule,
  correlationId: string,
  status: "ok" | "failed" | "skipped",
  result: Record<string, unknown>,
  errorMessage: string | null,
  durationMs: number,
): Promise<void> {
  try {
    await (admin.from("automation_runs" as never) as unknown as {
      insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
    }).insert({
      org_id: event.org_id,
      event_type: event.type,
      rule_id: rule.id,
      correlation_id: correlationId,
      status,
      result,
      error_message: errorMessage,
      duration_ms: durationMs,
    });
  } catch (e) {
    console.error("[automation] failed to record run", {
      rule: rule.id,
      err: e instanceof Error ? e.message : String(e),
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
