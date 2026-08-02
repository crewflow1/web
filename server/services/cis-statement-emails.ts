import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { listStatements, type CisStatementRow } from "@/server/services/cis-statements";
import {
  CIS_STATEMENT_EMAIL_SUBJECT_PREFIX,
  planStatementEmails,
  type CisStatementEmailPlan,
  type CisStatementForEmail,
} from "@/lib/cis/statement-email";

/**
 * H2-CIS M5 — queue a subcontractor's payment & deduction statement onto the
 * EXISTING outbound email queue (`notification_email_queue`), for the existing
 * cron drain (app/api/cron/notifications-drain) to send via Resend.
 *
 * ── NOTHING HERE FILES ANYTHING WITH HMRC ───────────────────────────────────
 * Emailing a subcontractor their statement is a contractor obligation owed to
 * the SUBCONTRACTOR (CIS340 3.15), not a submission to HMRC. There is no HMRC
 * endpoint, no Government Gateway credential and no `fetch` behind this module —
 * it inserts queue rows and returns. The actual dispatch is the platform's one
 * outbound path, so no new email provider is introduced.
 *
 * ── DARK-SAFE BY REUSE ──────────────────────────────────────────────────────
 * The send only happens in the shared drain, which marks a row `skipped` when
 * RESEND_API_KEY is unset (lib/notifications/email.ts). So enqueuing is always
 * safe: with no provider configured (the production default) nothing leaves the
 * building, and no code here can override that.
 *
 * ── CLIENTS: RLS FOR READS, SERVICE-ROLE FOR THE QUEUE ──────────────────────
 * Statements and supplier emails are read through the TENANT (user-JWT) client,
 * so the admin-only RLS on `cis_statements` and the org policy on `suppliers`
 * are the real boundary and this inherits the caller's authority. The queue
 * (`notification_email_queue`) has NO RLS policies — it is service-role-only by
 * design — so ONLY its existence-check and insert use the admin client, and
 * every such query pins `org_id` explicitly (honouring the active-org rule,
 * #456). The admin client is never used to read a tax document.
 *
 * ── IDEMPOTENCY, AND ITS ZERO-MIGRATION LIMIT ───────────────────────────────
 * A statement is emailed at most once: the queue row's `subject` carries the
 * statement number (unique per org, immutable, changes on reissue), and we skip
 * any statement whose subject is already queued for the org. The maintenance-
 * reminder engine gets a HARD guarantee from a dedicated log table with a unique
 * index + an advisory-lock claim RPC; this train is ZERO-MIGRATION, so we cannot
 * add that index here. The check-then-insert therefore has a small residual race
 * for two truly-simultaneous admin clicks (both could miss the other's insert
 * and double-queue one statement). It is bounded to that window, this is an
 * admin-triggered action rather than a high-fan-out cron, and the honest fix is
 * a follow-up migration adding a unique index on a per-statement queue key.
 */

export type QueueStatementEmailsResult = {
  ok: true;
  taxMonthEnd: string;
  /** Rows newly inserted into the queue this run. */
  queued: number;
  /** Already queued for this org (idempotency skip). */
  alreadyQueued: number;
  /** Issued+statutory but the subcontractor has no email on file. */
  noEmail: number;
  /** Paid gross — statement is good practice, not compelled — so not auto-sent. */
  notStatutory: number;
  /** Superseded or withdrawn — the subcontractor is owed the current document. */
  notIssued: number;
};

type Res<T> = { data: T | null; error: { message: string } | null };

type LooseInsert = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        like: (k: string, v: string) => PromiseLike<Res<{ subject: string }[]>>;
      };
    };
    insert: (rows: unknown) => PromiseLike<{ error: { message: string } | null }>;
  };
};

/**
 * The tenant client, reached through the same structural cast the CIS domain
 * uses (server/services/cis-statements.ts) — `suppliers.email` is `citext`, and
 * these queries are simpler to keep loosely typed than to thread through the
 * generated types. RLS still applies: this is the user-JWT client.
 */
type LooseRead = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        in: (k: string, v: unknown[]) => PromiseLike<Res<Array<{ id: string; email: string | null }>>>;
      };
    };
  };
};

/**
 * Map a frozen statement row (as `listStatements` returns it) onto the pure
 * plan's input shape. No recomputation — only field selection.
 */
function toEmailInput(s: CisStatementRow): CisStatementForEmail {
  return {
    id: s.id,
    supplier_id: s.supplier_id,
    statement_number: s.statement_number,
    status: s.status,
    subcontractor_name: s.subcontractor_name,
    contractor_name: s.contractor_name,
    contractor_paye_reference: s.contractor_paye_reference,
    tax_month_start: s.tax_month_start,
    tax_month_end: s.tax_month_end,
    statement_due_on: s.statement_due_on,
    gross_amount: s.gross_amount,
    materials_amount: s.materials_amount,
    deduction_amount: s.deduction_amount,
    rate_is_uniform: s.rate_is_uniform,
    deduction_rate: s.deduction_rate,
    is_statutory: s.is_statutory,
  };
}

/**
 * Queue emails for every issued, statutory statement in one tax month that has
 * not already been queued. Org-scoped throughout. Returns a per-outcome summary
 * for the caller to surface — nothing is dropped silently.
 */
export async function queueCisStatementEmails(input: {
  orgId: string;
  taxMonthEnd: string;
}): Promise<QueueStatementEmailsResult> {
  const { orgId, taxMonthEnd } = input;

  // 1. Read the month's statements through the RLS-gated tenant client.
  const statements = await listStatements(orgId, { taxMonthEnd });

  // 2. Resolve subcontractor emails for the suppliers on those statements —
  //    tenant client, org-pinned. Loud read: a failure must not masquerade as
  //    "no emails on file" and silently skip everyone.
  const supplierIds = [...new Set(statements.map((s) => s.supplier_id))];
  const emailBySupplier = new Map<string, string>();
  if (supplierIds.length > 0) {
    const supabase = (await createClient()) as unknown as LooseRead;
    const { data, error } = await supabase
      .from("suppliers")
      .select("id, email")
      .eq("org_id", orgId)
      .in("id", supplierIds);
    if (error) throw readFailure("cis: subcontractor emails", error);
    for (const row of data ?? []) {
      const email = (row.email ?? "").trim();
      if (email) emailBySupplier.set(row.id, email);
    }
  }

  // 3. Existing queued subjects for this org — the idempotency guard. The queue
  //    is service-role-only, so this read uses the admin client, org-pinned.
  const admin = createAdminClient() as unknown as LooseInsert;
  const { data: existingRows, error: existingErr } = await admin
    .from("notification_email_queue")
    .select("subject")
    .eq("org_id", orgId)
    .like("subject", `${CIS_STATEMENT_EMAIL_SUBJECT_PREFIX}%`);
  if (existingErr) throw readFailure("cis: existing statement emails", existingErr);
  const existingKeys = new Set((existingRows ?? []).map((r) => r.subject));

  // 4. Decide, purely.
  const plan: CisStatementEmailPlan = planStatementEmails({
    statements: statements.map(toEmailInput),
    emailBySupplier,
    existingKeys,
  });

  // 5. Insert the new rows. notification_id = NULL is the documented escape
  //    hatch for a transactional email outside the in-app notification system
  //    (20260611000000) — a subcontractor is not a CrewFlow user, so this must
  //    NOT create an in-app notification.
  if (plan.toQueue.length > 0) {
    const now = new Date().toISOString();
    const rows = plan.toQueue.map((q) => ({
      notification_id: null,
      org_id: orgId,
      user_id: null,
      to_email: q.toEmail,
      reply_to_email: null,
      subject: q.subject,
      body_text: q.body,
      body_html: null,
      status: "queued" as const,
      retry_count: 0,
      last_error: null,
      provider: null,
      provider_message_id: null,
      scheduled_for: now,
    }));
    const { error: insertErr } = await admin.from("notification_email_queue").insert(rows);
    if (insertErr) throw readFailure("cis: queue statement emails", insertErr);
  }

  const count = (reason: string) => plan.skipped.filter((s) => s.reason === reason).length;
  return {
    ok: true,
    taxMonthEnd,
    queued: plan.toQueue.length,
    alreadyQueued: count("already_queued"),
    noEmail: count("no_email"),
    notStatutory: count("not_statutory"),
    notIssued: count("not_issued"),
  };
}
