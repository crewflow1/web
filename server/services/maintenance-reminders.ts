import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { sendEmail } from "@/lib/email/send";
import { maintenanceRemindersSending } from "@/lib/maintenance/readiness";
import { todayIso } from "@/lib/warranties/schedule";
import {
  computeDueReminders,
  type DueReminder,
  type LoggedReminder,
  type ReminderKind,
  type WarrantyForReminder,
} from "@/lib/maintenance/reminders";

/**
 * Maintenance-reminders drain — the SERVICE layer of the proactive-send engine
 * (Phase 7). Org-pinned. Called per-org by the cron
 * (app/api/cron/maintenance-reminders-drain).
 *
 * It does exactly three things, in order:
 *
 *   1. COMPUTE  — read the org's active, published warranties and their frozen
 *                 completion dates, read the reminders already logged, and ask
 *                 the PURE layer (lib/maintenance/reminders.ts) which reminders
 *                 are newly due. No dates are invented here.
 *   2. RECORD   — upsert each due reminder into `maintenance_reminder_log` as
 *                 `pending`, idempotently (ON CONFLICT DO NOTHING against the
 *                 dedupe key), so a re-run creates nothing new.
 *   3. RESOLVE  — decide the outcome of the org's `pending` rows in one place:
 *                   • FLAG ON + email genuinely sendable ⇒ ATOMICALLY CLAIM each
 *                     row (pending → `sending`, under a per-org advisory lock) so
 *                     no reminder can be sent twice, then send via the existing
 *                     Resend seam and mark `sent` (message id + sent_at). A
 *                     provider refusal releases the claim back to `pending`.
 *                   • OTHERWISE (the default, DARK state) ⇒ mark `skipped_dark`
 *                     and SEND NOTHING.
 *
 * THE DARK GUARANTEE, made structural: the live send is reachable on exactly ONE
 * branch — behind `maintenanceRemindersSending()` (the shared helper = flag on
 * AND email sendable, the SAME predicate the portal copy reads). With the flag
 * off (the production default) that branch is unreachable, so no email can leave
 * the building; the security test asserts this by drain-ing with a spy sender
 * and proving it was never invoked.
 *
 * ONCE-ONLY SENDING, made structural: the live path never reads-then-sends.
 * `claim_due_maintenance_reminders` flips pending → `sending` … RETURNING under
 * a per-org `pg_advisory_xact_lock`, so a row is handed to exactly one drain and
 * a failed `sent` mark cannot cause a re-send (the row is already `sending`).
 *
 * Reads are LOUD: a failed read throws (readFailure) rather than silently
 * behaving as "no warranties" and dropping every reminder on the floor.
 *
 * Runs on the service-role admin client, which BYPASSES RLS — this is an
 * internal, multi-tenant cron writer, and it pins `org_id` in every query so it
 * only ever touches the org it was asked for.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type Res<T> = { data: T | null; error: SupabaseReadError | null };

type WarrantyRow = {
  id: string;
  job_id: string;
  period_months: number;
  service_interval_months: number | null;
  status: string;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
};

type CertRow = { job_id: string | null; completion_date: string };
type LogRow = { warranty_id: string; kind: ReminderKind; due_date: string };
type PendingRow = {
  id: string;
  warranty_id: string;
  job_id: string;
  kind: ReminderKind;
  due_date: string;
};

// job_warranties / maintenance_reminder_log are not in the generated Supabase
// types — cast past the typed client (the same `as unknown as` shim the other
// Phase 7 / HQ services use for untyped tables; a typing convenience, not logic).
type AnyChain = {
  select: (c: string, opts?: Record<string, unknown>) => AnyChain;
  insert: (rows: unknown) => AnyChain;
  update: (row: unknown) => AnyChain;
  eq: (k: string, v: unknown) => AnyChain;
  in: (k: string, v: unknown[]) => AnyChain;
  then: PromiseLike<Res<unknown[]>>["then"];
};
function table(admin: AdminClient, name: string): AnyChain {
  return admin.from(name as never) as unknown as AnyChain;
}

export type DrainResult = {
  ok: true;
  orgId: string;
  /** Distinct reminders newly recorded this run. */
  created: number;
  /** Reminders actually emailed (only ever > 0 when the flag is on). */
  sent: number;
  /** Reminders recorded/held but deliberately NOT sent (the dark default). */
  skippedDark: number;
  /** True when the send path was live this run (flag on AND email sendable). */
  live: boolean;
};

/**
 * Drain due maintenance reminders for one org. See the module docblock.
 * `today` is injectable for deterministic tests; production passes nothing and
 * the UK-safe warranty clock date is used.
 */
export async function drainDueReminders(
  orgId: string,
  opts?: { today?: string },
): Promise<DrainResult> {
  if (!orgId) throw new Error("drainDueReminders: orgId is required");
  const admin = createAdminClient();
  const today = opts?.today ?? todayIso();

  // ── 1. COMPUTE ────────────────────────────────────────────────────────────
  // Active, published warranties for this org — the ones a customer can see and
  // therefore the ones a reminder concerns.
  const warrantyRes = (await table(admin, "job_warranties")
    .select(
      "id, job_id, period_months, service_interval_months, status, portal_published_at, portal_withdrawn_at",
    )
    .eq("org_id", orgId)) as unknown as Res<WarrantyRow[]>;
  if (warrantyRes.error) throw readFailure("maintenance reminders: warranties", warrantyRes.error);

  const warranties = (warrantyRes.data ?? []).filter(
    (w) => w.status === "active" && w.portal_published_at && !w.portal_withdrawn_at,
  );
  if (warranties.length === 0) {
    return { ok: true, orgId, created: 0, sent: 0, skippedDark: 0, live: false };
  }

  // The frozen completion date per job — the ONLY clock a warranty may run on.
  const jobIds = [...new Set(warranties.map((w) => w.job_id))];
  const certRes = (await table(admin, "completion_certificates")
    .select("job_id, completion_date")
    .eq("org_id", orgId)
    .eq("status", "issued")
    .in("job_id", jobIds)) as unknown as Res<CertRow[]>;
  if (certRes.error) throw readFailure("maintenance reminders: certificates", certRes.error);

  const completionByJob = new Map<string, string>();
  for (const c of certRes.data ?? []) {
    if (c.job_id) completionByJob.set(c.job_id, c.completion_date);
  }

  // Reminders already logged for this org — the dedupe input.
  const logRes = (await table(admin, "maintenance_reminder_log")
    .select("warranty_id, kind, due_date")
    .eq("org_id", orgId)) as unknown as Res<LogRow[]>;
  if (logRes.error) throw readFailure("maintenance reminders: existing log", logRes.error);

  const forReminder: WarrantyForReminder[] = warranties.map((w) => ({
    warrantyId: w.id,
    orgId,
    jobId: w.job_id,
    periodMonths: w.period_months,
    serviceIntervalMonths: w.service_interval_months,
    certificateCompletionDate: completionByJob.get(w.job_id) ?? null,
  }));
  const existing: LoggedReminder[] = (logRes.data ?? []).map((r) => ({
    warrantyId: r.warranty_id,
    kind: r.kind,
    dueDate: r.due_date,
  }));

  const due = computeDueReminders({ warranties: forReminder, existing, today });

  // ── 2. RECORD ───────────────────────────────────────────────────────────── ─
  // Upsert as `pending`, idempotent on the dedupe key. ON CONFLICT DO NOTHING is
  // expressed via upsert(..., { onConflict, ignoreDuplicates: true }); a
  // concurrent drain that already inserted the row simply loses the race harmlessly.
  let created = 0;
  if (due.length > 0) {
    const rows = due.map((d: DueReminder) => ({
      org_id: d.orgId,
      warranty_id: d.warrantyId,
      job_id: d.jobId,
      kind: d.kind,
      channel: d.channel,
      due_date: d.dueDate,
      scheduled_for: d.scheduledFor,
      status: "pending" as const,
    }));
    const insertRes = (await (
      admin.from("maintenance_reminder_log" as never) as unknown as {
        upsert: (
          r: unknown,
          o: Record<string, unknown>,
        ) => { select: (c: string) => PromiseLike<Res<{ id: string }[]>> };
      }
    )
      .upsert(rows, {
        onConflict: "org_id,warranty_id,kind,due_date",
        ignoreDuplicates: true,
      })
      .select("id")) as unknown as Res<{ id: string }[]>;
    if (insertRes.error) throw readFailure("maintenance reminders: upsert", insertRes.error);
    created = (insertRes.data ?? []).length;
  }

  // ── 3. RESOLVE ─────────────────────────────────────────────────────────────
  // THE ONE SEND DECISION, from the SAME shared helper the portal copy reads, so
  // the drain and the "we'll email you" copy can never disagree: the flag AND a
  // genuinely-sendable email provider must both be true. With the flag off
  // (production default) `live` is false and no send path is reachable.
  const live = maintenanceRemindersSending();

  if (!live) {
    // DARK PATH — send nothing. Read the org's pending rows and mark them
    // skipped_dark. No claim/lock is needed: nothing leaves the building, so an
    // overlapping dark drain that marks the same rows is harmless and idempotent.
    const pendingRes = (await table(admin, "maintenance_reminder_log")
      .select("id")
      .eq("org_id", orgId)
      .eq("status", "pending")) as unknown as Res<{ id: string }[]>;
    if (pendingRes.error) throw readFailure("maintenance reminders: pending", pendingRes.error);
    const pending = pendingRes.data ?? [];
    if (pending.length === 0) {
      return { ok: true, orgId, created, sent: 0, skippedDark: 0, live: false };
    }
    const upd = (await table(admin, "maintenance_reminder_log")
      .update({ status: "skipped_dark" })
      .eq("org_id", orgId)
      .eq("status", "pending")) as unknown as Res<unknown[]>;
    if (upd.error) throw readFailure("maintenance reminders: mark skipped_dark", upd.error);
    return { ok: true, orgId, created, sent: 0, skippedDark: pending.length, live: false };
  }

  // LIVE PATH — reachable ONLY with the flag on AND email sendable.
  //
  // ATOMIC CLAIM (P2-a/P2-b). We never read-pending-then-send: that re-sends if a
  // mark fails and double-sends if two drains read the same rows. Instead
  // `claim_due_maintenance_reminders` flips pending → 'sending' … RETURNING under
  // a per-org advisory lock and hands back ONLY the rows THIS drain won. A row
  // claimed by an overlapping drain is not returned, so it can never be sent
  // twice; and because the claim precedes the send, a failed markSent leaves the
  // row 'sending' (never re-claimed), not re-sent.
  const claimRes = (await (
    admin as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<Res<PendingRow[]>>;
    }
  ).rpc("claim_due_maintenance_reminders", { p_org_id: orgId })) as unknown as Res<PendingRow[]>;
  if (claimRes.error) throw readFailure("maintenance reminders: claim", claimRes.error);
  const claimed = claimRes.data ?? [];
  if (claimed.length === 0) {
    return { ok: true, orgId, created, sent: 0, skippedDark: 0, live: true };
  }

  const recipientByJob = await loadRecipientEmails(admin, orgId, [
    ...new Set(claimed.map((p) => p.job_id)),
  ]);

  let sent = 0;
  let skippedDark = 0;
  for (const row of claimed) {
    const to = recipientByJob.get(row.job_id);
    if (!to) {
      // No customer email to send to — record it honestly as not-sent rather
      // than claiming a send. Held as skipped_dark (nothing went out).
      await markStatus(admin, orgId, row.id, "skipped_dark");
      skippedDark += 1;
      continue;
    }
    // NOTE (P2-d): the sender identity (from / replyTo) is deliberately the
    // platform default here. Activating a per-org sending identity is
    // provider/domain-gated (per-org SPF/DKIM) and is a separate activation
    // step — do not wire org-specific from/replyTo on this path.
    const result = await sendEmail({
      to,
      subject: reminderSubject(row.kind, row.due_date),
      html: reminderHtml(row.kind, row.due_date),
      text: reminderText(row.kind, row.due_date),
    });
    if (result.sent) {
      await markSent(admin, orgId, row.id, result.id);
      sent += 1;
    } else {
      // Provider refused — release the claim (sending → pending) so a later drain
      // retries, rather than stranding the reminder in 'sending' forever.
      await releaseClaim(admin, orgId, row.id);
      console.error("[maintenance-reminders] send failed", { id: row.id, reason: result.reason });
    }
  }

  return { ok: true, orgId, created, sent, skippedDark, live: true };
}

export type DrainAllResult = {
  ok: true;
  orgs: number;
  created: number;
  sent: number;
  skippedDark: number;
  /** Orgs whose drain threw — the run continues past them, but they are reported. */
  failed: number;
};

/**
 * Drain due reminders across EVERY org — the cron entry point.
 *
 * Enumerates org ids and drains each in turn. One org's failure is isolated:
 * it is caught, counted in `failed`, and the sweep continues, so a single
 * bad tenant cannot starve the rest. Dark-safe: with the flag off every org's
 * drain simply records `skipped_dark`.
 */
export async function drainAllDueReminders(opts?: { today?: string }): Promise<DrainAllResult> {
  const admin = createAdminClient();
  const orgRes = (await table(admin, "organizations").select("id")) as unknown as Res<
    { id: string }[]
  >;
  if (orgRes.error) throw readFailure("maintenance reminders: organizations", orgRes.error);
  const orgIds = (orgRes.data ?? []).map((o) => o.id);

  let created = 0;
  let sent = 0;
  let skippedDark = 0;
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      const r = await drainDueReminders(orgId, opts);
      created += r.created;
      sent += r.sent;
      skippedDark += r.skippedDark;
    } catch (e) {
      failed += 1;
      console.error("[maintenance-reminders] org drain failed", {
        orgId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { ok: true, orgs: orgIds.length, created, sent, skippedDark, failed };
}

// ── helpers ───────────────────────────────────────────────────────────────

async function markStatus(
  admin: AdminClient,
  orgId: string,
  id: string,
  status: "skipped_dark" | "dismissed",
): Promise<void> {
  const res = (await table(admin, "maintenance_reminder_log")
    .update({ status })
    .eq("org_id", orgId)
    .eq("id", id)) as unknown as Res<unknown[]>;
  if (res.error) throw readFailure("maintenance reminders: markStatus", res.error);
}

/** Release a claim (sending → pending) after a provider refusal, so a later
 * drain retries rather than stranding the reminder in `sending`. */
async function releaseClaim(admin: AdminClient, orgId: string, id: string): Promise<void> {
  const res = (await table(admin, "maintenance_reminder_log")
    .update({ status: "pending" })
    .eq("org_id", orgId)
    .eq("id", id)) as unknown as Res<unknown[]>;
  if (res.error) throw readFailure("maintenance reminders: releaseClaim", res.error);
}

async function markSent(
  admin: AdminClient,
  orgId: string,
  id: string,
  messageId: string,
): Promise<void> {
  const res = (await table(admin, "maintenance_reminder_log")
    .update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("id", id)) as unknown as Res<unknown[]>;
  if (res.error) throw readFailure("maintenance reminders: markSent", res.error);
}

/** job_id → customer email, resolved job → customer. Only used on the live path. */
async function loadRecipientEmails(
  admin: AdminClient,
  orgId: string,
  jobIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (jobIds.length === 0) return out;

  const jobsRes = (await table(admin, "jobs")
    .select("id, customer_id")
    .eq("org_id", orgId)
    .in("id", jobIds)) as unknown as Res<{ id: string; customer_id: string | null }[]>;
  if (jobsRes.error) throw readFailure("maintenance reminders: jobs", jobsRes.error);

  const customerByJob = new Map<string, string>();
  const customerIds = new Set<string>();
  for (const j of jobsRes.data ?? []) {
    if (j.customer_id) {
      customerByJob.set(j.id, j.customer_id);
      customerIds.add(j.customer_id);
    }
  }
  if (customerIds.size === 0) return out;

  const custRes = (await table(admin, "customers")
    .select("id, email")
    .eq("org_id", orgId)
    .in("id", [...customerIds])) as unknown as Res<{ id: string; email: string | null }[]>;
  if (custRes.error) throw readFailure("maintenance reminders: customers", custRes.error);

  const emailByCustomer = new Map<string, string>();
  for (const c of custRes.data ?? []) {
    if (c.email) emailByCustomer.set(c.id, String(c.email));
  }
  for (const [jobId, customerId] of customerByJob) {
    const email = emailByCustomer.get(customerId);
    if (email) out.set(jobId, email);
  }
  return out;
}

function reminderSubject(kind: ReminderKind, dueDate: string): string {
  return kind === "expiry"
    ? `Your warranty ends on ${dueDate}`
    : `Warranty service due on ${dueDate}`;
}
function reminderText(kind: ReminderKind, dueDate: string): string {
  return kind === "expiry"
    ? `This is a reminder that your warranty cover ends on ${dueDate}.`
    : `This is a reminder that a service to keep your warranty valid is due on ${dueDate}.`;
}
function reminderHtml(kind: ReminderKind, dueDate: string): string {
  return `<p>${reminderText(kind, dueDate)}</p>`;
}
