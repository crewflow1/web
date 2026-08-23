import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
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
 * ── IDEMPOTENCY: ONE EMAIL PER STATEMENT, ENFORCED BY THE DATABASE ───────────
 * A statement is emailed at most once, and that is now a DATABASE invariant, not
 * just an application check. Each queued row carries the statement number in a
 * dedicated `cis_statement_key` column (unique per org, immutable, changes on
 * reissue — so a corrected statement is a new number and is correctly emailed
 * again), and the unique index `notification_email_queue_cis_statement_uniq`
 * (migration 20261217000000) forbids a second queued row for the same
 * (org_id, statement number). The insert is an `upsert ... ON CONFLICT DO
 * NOTHING`, so two truly-simultaneous admin clicks — or a retried server action —
 * settle to exactly one queued email with no error surfaced to the caller: the
 * loser's row is silently ignored and counted as already-queued.
 *
 * The pre-insert `subject` read below is kept only as a fast path so re-running
 * over an unchanged month reports accurate skip reasons without attempting
 * inserts; correctness no longer depends on it (see the count reconciliation at
 * the return). NULL `cis_statement_key` (every non-CIS email) is exempt from the
 * index by Postgres NULLS-DISTINCT semantics, so no other email flow is touched.
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

type LooseQ = PromiseLike<Res<{ subject: string }[]>> & {
  order: (k: string, o: { ascending: boolean }) => LooseQ;
  range: (from: number, to: number) => LooseQ;
};
type LooseInsert = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        like: (k: string, v: string) => LooseQ;
      };
    };
    /**
     * The race-proof write: `ON CONFLICT (org_id, cis_statement_key) DO NOTHING`
     * against the unique index (20261217000000). `.select("id")` returns ONLY the
     * rows actually inserted — the ignored (already-queued) rows are omitted — so
     * the caller can report the true newly-queued count under concurrency.
     */
    upsert: (
      rows: unknown,
      opts: { onConflict: string; ignoreDuplicates: boolean },
    ) => {
      select: (c: string) => PromiseLike<Res<{ id: string }[]>>;
    };
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
  // PAGED (F-1): the queue is append-only and grows every month, so this
  // idempotency read must see EVERY previously-queued statement subject — a
  // truncated read would drop old keys from the guard Set and could re-queue
  // (duplicate) subcontractor emails. Paged under the cap on `id`.
  const existingRes = await fetchAllRows<{ subject: string }>((from, to) =>
    admin
      .from("notification_email_queue")
      .select("subject")
      .eq("org_id", orgId)
      .like("subject", `${CIS_STATEMENT_EMAIL_SUBJECT_PREFIX}%`)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (existingRes.error) throw readFailure("cis: existing statement emails", existingRes.error);
  const existingKeys = new Set((existingRes.data ?? []).map((r) => r.subject));

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
  //    The write is idempotent at the DATABASE: `cis_statement_key` carries the
  //    per-statement key and the unique index (20261217000000) makes a second
  //    queued row for the same (org, statement) impossible. `ON CONFLICT DO
  //    NOTHING` (upsert + ignoreDuplicates) means a concurrent duplicate is
  //    silently dropped rather than erroring the caller; `.select("id")` returns
  //    only the rows that were actually inserted, so `queued` is the TRUE count.
  let insertedCount = 0;
  if (plan.toQueue.length > 0) {
    const now = new Date().toISOString();
    const rows = plan.toQueue.map((q) => ({
      notification_id: null,
      org_id: orgId,
      user_id: null,
      to_email: q.toEmail,
      reply_to_email: null,
      subject: q.subject,
      cis_statement_key: q.statementNumber,
      body_text: q.body,
      body_html: null,
      status: "queued" as const,
      retry_count: 0,
      last_error: null,
      provider: null,
      provider_message_id: null,
      scheduled_for: now,
    }));
    const { data: inserted, error: insertErr } = await admin
      .from("notification_email_queue")
      .upsert(rows, { onConflict: "org_id,cis_statement_key", ignoreDuplicates: true })
      .select("id");
    if (insertErr) throw readFailure("cis: queue statement emails", insertErr);
    insertedCount = inserted?.length ?? 0;
  }

  const count = (reason: string) => plan.skipped.filter((s) => s.reason === reason).length;
  // Any planned row NOT inserted lost the ON CONFLICT race to a concurrent run —
  // its email is already queued by the winner, so it belongs with already-queued.
  const raced = plan.toQueue.length - insertedCount;
  return {
    ok: true,
    taxMonthEnd,
    queued: insertedCount,
    alreadyQueued: count("already_queued") + raced,
    noEmail: count("no_email"),
    notStatutory: count("not_statutory"),
    notIssued: count("not_issued"),
  };
}
