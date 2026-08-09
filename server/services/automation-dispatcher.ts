import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import {
  effectiveEnabled,
  loadRuleOverridesBestEffort,
} from "@/server/services/automation-rules";
import { invoiceDueDate } from "@/lib/invoices/due-date";
import type {
  NotificationCreate,
  NotificationEmailDirective,
} from "@/lib/notifications/types";
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

  // Per-org enable-state OVERRIDE (table automation_rules, 20261096). The static
  // catalogue flag is the DEFAULT; a per-org row overrides it. Read ONCE per
  // dispatch, pinned to THIS event's org, and best-effort — a read failure falls
  // back to the catalogue defaults, so the engine never throws and never changes
  // behaviour on a transient error. Pinning to event.org_id is also a tenancy
  // guard: a rule's enable-state is resolved against its own org, never blended.
  const overrides = await loadRuleOverridesBestEffort(
    admin as unknown as { from: (t: string) => never },
    event.org_id,
  );

  for (const rule of matched) {
    const correlationId = correlationIdFor(
      event.type,
      event.source_table,
      event.source_id,
    );

    if (!effectiveEnabled(rule, overrides)) {
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
      return runSendEmailQueue(event, rule);
    case "create_invoice_draft":
      return runCreateInvoiceDraft(event);
    case "update_status":
      // DOCUMENTED NO-OP — deliberately NOT wired, and this is the honest call.
      //
      // There is no SAFE, GENERIC status-mutation authority to reuse. Every
      // domain status transition is guarded by its own invariants and its own
      // server action: quotes freeze on acceptance and revert to pending on
      // post-approval edits (triggers quotes_freeze_accepted / the approval
      // gate), invoices and jobs have their own lifecycles. A generic,
      // payload-driven UPDATE from the dispatcher would bypass exactly those
      // guards — and, fired from an arbitrary event, could target the wrong
      // table entirely. Wiring it would fabricate authority the engine must not
      // hold. A real status change must go through its domain-specific guarded
      // action; this stays a no-op until such an action is exposed to automation.
      return { ok: true, kind: "update_status_noop_documented" };
  }
}

/**
 * send_email_queue — WIRED to the existing notification→email bridge.
 *
 * `emitNotifications` with an `email` directive is the ONE authorised path from
 * the in-app bus to email: it persists the notification then enqueues a row on
 * `notification_email_queue`, drained to Resend by /api/cron/notifications-drain.
 * We reuse it verbatim rather than writing the queue directly, so recipient
 * resolution, org-email routing and the queue's own (notification_id)
 * idempotency all apply unchanged.
 *
 * ORG-SCOPED: the notification carries `event.org_id`, and the recipient is
 * resolved from THAT org's contact email — never another tenant's. IDEMPOTENT:
 * the whole rule run is guarded by the dispatcher's (rule_id, correlation_id)
 * claim, so a re-fire never double-queues.
 */
async function runSendEmailQueue(
  event: AutomationEvent,
  rule: AutomationRule,
): Promise<Record<string, unknown>> {
  const audience = event.type.startsWith("demo.") ? "hq" : "customer";

  // Recipient directive. The default `{}` means "resolve from the audience" —
  // for a customer/both audience that is `organizations.email`, the ORG's OWN
  // inbox (see resolveEmailRecipient). That default is fine for a generic
  // customer-audience notice, but WRONG for a `payment.recorded` receipt, which
  // is FOR the paying customer and must reach THEM, not the org's own inbox.
  //
  // So for payment.recorded we resolve the payer's email explicitly (org-pinned,
  // service-role — mirroring runCreateInvoiceDraft's resolution in this file) and
  // set it as the directive `to`, so resolveEmailRecipient's explicit-to branch
  // wins. If NO customer email is resolvable we SKIP-with-ok rather than let the
  // blank-to default silently route the receipt to organizations.email — that
  // silent org fallback was the defect this fixes.
  let email: NotificationEmailDirective = {};
  if (event.type === "payment.recorded") {
    const customerEmail = await resolvePaymentCustomerEmail(event);
    if (!customerEmail) {
      return { ok: true, kind: "email_skipped_no_customer_email" };
    }
    email = { to: customerEmail };
  }

  const note: NotificationCreate = {
    org_id: event.org_id,
    user_id: null,
    audience: audience as "customer" | "hq",
    type: `automation.${event.type}.email`,
    category: "system",
    priority: event.type === "invoice.overdue" ? "high" : "medium",
    title: notificationTitleFor(event, rule),
    body: null,
    action_url: actionUrlForEvent(event),
    source_module: "automation",
    source_id: event.source_id,
    metadata: { rule_id: rule.id, event_type: event.type, channel: "email" },
    // The opt-in directive that makes emitNotifications ALSO queue an email.
    email,
  };
  await emitNotifications([note]);
  return { ok: true, kind: "email_queued", audience };
}

/**
 * Resolve the PAYING customer's email for a `payment.recorded` event.
 *
 * A payment receipt is a customer-facing document — it must reach the customer
 * who paid, never the org's own inbox. The `payment.recorded` payload carries no
 * customer id/email, so we resolve it from the durable rows, org-pinned on every
 * hop (mirroring runCreateInvoiceDraft): a foreign/absent id reads as nothing, so
 * a crafted cross-org source_id can never leak another tenant's customer.
 *
 * Two source shapes, matching the dispatch sites:
 *   - source_table = "payments"          → payments.customer_id → customers.email
 *   - source_table = "invoice_payments"  → invoice_payments.invoice_id →
 *                                          invoices.customer_id → customers.email
 *
 * Returns the trimmed email, or null when it cannot be resolved (unknown source,
 * missing row, no linked customer, or a blank/absent customer email). A null is a
 * deliberate SKIP signal — the caller must NOT fall back to the org address.
 * Genuine DB read errors throw, so the run is recorded failed + retryable rather
 * than silently swallowed.
 */
async function resolvePaymentCustomerEmail(
  event: AutomationEvent,
): Promise<string | null> {
  const admin = createAdminClient();
  let customerId: string | null = null;

  if (event.source_table === "payments") {
    const row = await readOneOrgScoped<{ customer_id: string | null }>(
      admin,
      "payments",
      "customer_id",
      event.source_id,
      event.org_id,
    );
    customerId = row?.customer_id ?? null;
  } else if (event.source_table === "invoice_payments") {
    const ip = await readOneOrgScoped<{ invoice_id: string | null }>(
      admin,
      "invoice_payments",
      "invoice_id",
      event.source_id,
      event.org_id,
    );
    if (ip?.invoice_id) {
      const inv = await readOneOrgScoped<{ customer_id: string | null }>(
        admin,
        "invoices",
        "customer_id",
        ip.invoice_id,
        event.org_id,
      );
      customerId = inv?.customer_id ?? null;
    }
  } else {
    // Unknown payment source — do not guess a recipient.
    return null;
  }

  if (!customerId) return null;

  const customer = await readOneOrgScoped<{ email: string | null }>(
    admin,
    "customers",
    "email",
    customerId,
    event.org_id,
  );
  const email = customer?.email;
  return typeof email === "string" && email.trim().length > 0
    ? email.trim()
    : null;
}

/**
 * Read a single row by (id, org_id) via the service-role client. Every hop in
 * recipient resolution is org-pinned through this helper, so a foreign id can
 * never resolve. A genuine read error throws; a not-found reads as null.
 */
async function readOneOrgScoped<T extends Record<string, unknown>>(
  admin: ReturnType<typeof createAdminClient>,
  table: string,
  cols: string,
  id: string,
  orgId: string,
): Promise<T | null> {
  const res = await (
    admin.from(table as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: T | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select(cols)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (res.error) {
    throw new Error(`payment_receipt ${table} read failed: ${res.error.message}`);
  }
  return res.data;
}

/**
 * create_invoice_draft — WIRED to the real quote→draft-invoice authority.
 *
 * Reuses the exact path the quote-acceptance flow uses (app/(app)/quotes/
 * actions.ts): allocate a number via the `next_invoice_number` RPC and insert a
 * `status='draft'` invoice. Because the dispatcher runs service-role, tenancy is
 * pinned EXPLICITLY on every hop — the quote read, the number allocation
 * (`target_org`) and the insert all carry `event.org_id`, so this can only ever
 * bill within its own org.
 *
 * SCOPE — quote-sourced events only. A draft invoice needs a priced source; the
 * only such source in the model is a quote. For any other source_table this is a
 * documented skip (returns ok) rather than a fabricated invoice.
 *
 * IDEMPOTENT — three layers: the dispatcher's rule claim (one run per event),
 * the reuse-existing-invoice-for-quote guard here, and the DB partial unique
 * index on invoices(quote_id). A 23505 on insert is treated as "already exists".
 */
async function runCreateInvoiceDraft(
  event: AutomationEvent,
): Promise<Record<string, unknown>> {
  if (event.source_table !== "quotes") {
    // No priced source to invoice from — documented skip, not a fabrication.
    return { ok: true, kind: "invoice_draft_skipped_not_quote" };
  }
  const admin = createAdminClient();

  // Resolve the quote WITHIN this org. A foreign/absent quote reads as nothing,
  // so a crafted cross-org source_id can never produce an invoice.
  const quoteRes = await (
    admin.from("quotes" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: Record<string, unknown> | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select("id, org_id, customer_id, subtotal, vat_total, job_id")
    .eq("id", event.source_id)
    .eq("org_id", event.org_id)
    .maybeSingle();
  if (quoteRes.error) {
    throw new Error(`invoice_draft quote read failed: ${quoteRes.error.message}`);
  }
  const quote = quoteRes.data;
  if (!quote) {
    return { ok: true, kind: "invoice_draft_skipped_no_quote" };
  }

  // Reuse guard (org-scoped): never post a second invoice for a quote that
  // already has one — the in-code half of invoices(quote_id) uniqueness.
  const existing = await (
    admin.from("invoices" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            limit: (n: number) => {
              maybeSingle: () => Promise<{
                data: { id: string } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    }
  )
    .select("id")
    .eq("quote_id", quote.id as string)
    .eq("org_id", event.org_id)
    .limit(1)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`invoice_draft existing read failed: ${existing.error.message}`);
  }
  if (existing.data?.id) {
    return { ok: true, kind: "invoice_draft_exists", invoice_id: existing.data.id };
  }

  // Allocate the next per-org invoice number (MUTATES the org's sequence — so
  // target_org must be event.org_id, never another tenant's series).
  const numRes = await (
    admin as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc("next_invoice_number", { target_org: event.org_id });
  if (numRes.error || !numRes.data) {
    throw new Error(
      `invoice_draft number alloc failed: ${numRes.error?.message ?? "no number"}`,
    );
  }

  const ins = await (
    admin.from("invoices" as never) as unknown as {
      insert: (row: unknown) => {
        select: (c: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string; code?: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: event.org_id,
      quote_id: quote.id,
      customer_id: quote.customer_id ?? null,
      number: numRes.data as string,
      amount: quote.subtotal ?? 0,
      vat_total: quote.vat_total ?? 0,
      status: "draft",
      job_id: quote.job_id ?? null,
      due_date: invoiceDueDate(new Date().toISOString()),
    })
    .select("id")
    .single();

  if (ins.error) {
    // A concurrent creator won the invoices(quote_id) race — idempotent success.
    if (ins.error.code === "23505") {
      return { ok: true, kind: "invoice_draft_exists_race" };
    }
    throw new Error(`invoice_draft insert failed: ${ins.error.message}`);
  }
  return { ok: true, kind: "invoice_draft_created", invoice_id: ins.data?.id };
}

/**
 * Domain-specific notification copy per event type. The dispatcher owns the
 * wording so the rule catalogue stays declarative. Shared by create_notification
 * and send_email_queue.
 */
function notificationTitleFor(
  event: AutomationEvent,
  rule: AutomationRule,
): string {
  const titles: Record<string, string> = {
    "quote.accepted": "A quote was just accepted",
    "quote.declined": "A quote was declined",
    "quote.sent": "Quote sent to customer",
    "lead.created": "A new lead came in",
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
  return titles[event.type] ?? rule.label;
}

/** Deep-link for a notification, derived from the source table. */
function actionUrlForEvent(event: AutomationEvent): string {
  switch (event.source_table) {
    case "quotes":
      return `/quotes/${event.source_id}`;
    case "invoices":
      return `/invoices/${event.source_id}`;
    case "jobs":
      return `/jobs/${event.source_id}`;
    case "imports":
      return `/imports/${event.source_id}`;
    case "leads":
      return `/leads/${event.source_id}`;
    case "support_tickets":
      return `/support/${event.source_id}`;
    default:
      return `/dashboard`;
  }
}

async function runCreateNotification(
  event: AutomationEvent,
  rule: AutomationRule,
): Promise<Record<string, unknown>> {
  const audience = event.type.startsWith("demo.") ? "hq" : "customer";
  const note: NotificationCreate = {
    org_id: event.org_id,
    user_id: null,
    audience: audience as "customer" | "hq",
    type: `automation.${event.type}`,
    category: "system",
    priority: event.type === "invoice.overdue" ? "high" : "medium",
    title: notificationTitleFor(event, rule),
    body: null,
    action_url: actionUrlForEvent(event),
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

  // F-1: this is a cross-org 7-day health rollup. A single read is clamped to
  // PostgREST max_rows (1000), so a busy week silently under-reports run/failure
  // counts; page the full window on a stable (created_at, id) order.
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      (
        admin.from("automation_runs" as never) as unknown as {
          select: (cols: string) => {
            gte: (k: string, v: string) => {
              order: (
                k: string,
                opts: { ascending: boolean },
              ) => {
                order: (
                  k: string,
                  opts: { ascending: boolean },
                ) => {
                  range: (
                    from: number,
                    to: number,
                  ) => PromiseLike<{ data: Row[] | null; error: unknown }>;
                };
              };
            };
          };
        }
      )
        .select("id, rule_id, status, created_at")
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) throw readFailure("automation-dispatcher: automation runs", error);

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
