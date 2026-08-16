import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { emitNotifications } from "@/server/services/notifications-service";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeRetentionSchedule } from "@/lib/retentions/schedule";
import { formatGbp } from "@/lib/money";
import type { NotificationCreate } from "@/lib/notifications/types";

/**
 * Retention RELEASE-REMINDER scheduler.
 *
 * The retention release schedule (lib/retentions/schedule.ts) forecasts WHEN a
 * job's two held-retention moieties fall due back to the builder — the first at
 * Practical Completion, the second at the end of the Defects Liability Period.
 * That forecast was a PASSIVE dashboard number: nobody was ever TOLD a release
 * had come due, so retention the builder is owed sits unclaimed. This scheduler
 * turns each due moiety into a notification, once.
 *
 * SHAPE — modelled on the invoice-overdue scheduler (lib/invoices/overdue-
 * scheduler.ts): a whole-fleet, admin-client scan that pages the ENTIRE
 * candidate set on a STABLE total order (F-1: never a bare `.select()` clamped
 * at PostgREST's 1000-row cap), is LOUD on any read failure (a swallowed error
 * must never look like "nothing due"), and fans work out org-agnostically so no
 * single tenant can starve another. Notifications go through the shared
 * `emitNotifications` bus (in-app; no email directive, exactly like the
 * compliance-expiry reminders).
 *
 * IDEMPOTENCY — a per-moiety once-ever guard, the SAME self-excluding-marker
 * shape compliance-expiry uses. Two nullable timestamps on `jobs`
 * (retention_first_reminded_at / retention_second_reminded_at) record dispatch.
 * Before emitting, the scheduler CAS-CLAIMS the marker
 * (`update … where marker is null returning id`): only the run that flips it from
 * NULL wins, so a retried, concurrent or re-scanned pass fires each moiety
 * EXACTLY once. A moiety whose date later slips does not re-fire — re-arming is
 * a deliberate future decision, not an omission (same V1 stance as overdue).
 *
 * ORG-FAIR / SELF-DRAINING — the candidate query is filtered to jobs that carry
 * retention, have a Practical Completion date (so a date is forecastable) and
 * have at least one un-reminded moiety. A reminded moiety leaves the set, so the
 * work only ever shrinks; per-job work is an in-memory schedule computation, and
 * a claim+notification is written ONLY for a moiety actually coming due. There is
 * no per-item external I/O, so a busy tenant costs the same as a quiet one.
 */

/** Tolerance mirrors lib/retentions/schedule.ts — sub-penny is "nothing left". */
const TOL = 0.005;

/** Bounded fan-out — a claim + notify is a couple of DB round-trips per moiety. */
type CandidateJob = {
  id: string;
  org_id: string;
  retention_percent: number | string | null;
  practical_completion_date: string | null;
  defects_liability_months: number | string | null;
  retention_first_release_pct: number | string | null;
  retention_first_reminded_at: string | null;
  retention_second_reminded_at: string | null;
};

type MoneyRow = { job_id: string | null; status?: string; amount: number | string | null };

export type RetentionReminderSummary = {
  jobs_scanned: number;
  fired_first: number;
  fired_second: number;
  skipped_already: number;
  errors: number;
};

/**
 * Loose client shim. The two `jobs` reminder columns (and even the EXISTING
 * retention columns) post-date the generated Supabase types, and the scan reads
 * tables by a dynamic name, so the admin client is reached through the same
 * structural cast the other post-types services use (org-cash.ts,
 * retention-register.ts). `AnyB` is BOTH a thenable (so the CAS `.select("id")`
 * awaits) and chainable (so a read pages through `.range`).
 */
type Err = { message: string } | null;
type AnyB = PromiseLike<{ data: Record<string, unknown>[] | null; error: Err }> & {
  select: (c: string) => AnyB;
  gt: (k: string, v: number) => AnyB;
  not: (k: string, op: string, v: unknown) => AnyB;
  or: (f: string) => AnyB;
  in: (k: string, v: readonly string[]) => AnyB;
  eq: (k: string, v: unknown) => AnyB;
  is: (k: string, v: null) => AnyB;
  update: (row: Record<string, unknown>) => AnyB;
  order: (k: string, o: { ascending: boolean }) => AnyB;
  range: (f: number, t: number) => AnyB;
};
type LooseClient = { from: (t: string) => AnyB };

/**
 * One scan pass. `now` is injectable so the test can pin an instant.
 */
export async function runRetentionReminders(
  now: Date = new Date(),
): Promise<RetentionReminderSummary> {
  const db = createAdminClient() as unknown as LooseClient;
  const summary: RetentionReminderSummary = {
    jobs_scanned: 0,
    fired_first: 0,
    fired_second: 0,
    skipped_already: 0,
    errors: 0,
  };

  // CANDIDATE JOBS — retention on the contract, a PC date to anchor the forecast,
  // and at least one un-reminded moiety (so a fully-reminded job LEAVES the set).
  // Paged in full on the unique `id` order (F-1); LOUD on failure.
  const { data: jobs, error: jobsErr } = await fetchAllRows<CandidateJob>((from, to) =>
    db
      .from("jobs")
      .select(
        "id, org_id, retention_percent, practical_completion_date, " +
          "defects_liability_months, retention_first_release_pct, " +
          "retention_first_reminded_at, retention_second_reminded_at",
      )
      .gt("retention_percent", 0)
      .not("practical_completion_date", "is", null)
      .or("retention_first_reminded_at.is.null,retention_second_reminded_at.is.null")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<CandidateJob>>,
  );
  if (jobsErr) throw readFailure("retention reminders: jobs", jobsErr);
  summary.jobs_scanned = jobs.length;
  if (jobs.length === 0) return summary;

  const jobIds = jobs.map((j) => j.id);

  // The retention BASE (non-draft invoiced net) and the releases ledger — read
  // ONCE for the whole candidate set, chunked over `job_id` and paged in full.
  const invoices = await readByJobIds(db, "invoices", "job_id, status, amount", jobIds);
  const releases = await readByJobIds(db, "retention_releases", "job_id, amount", jobIds);
  const invByJob = groupByJob(invoices);
  const relByJob = groupByJob(releases);

  for (const job of jobs) {
    try {
      const position = computeRetentionPosition({
        ratePercent: job.retention_percent,
        invoices: (invByJob.get(job.id) ?? []).map((i) => ({
          status: String(i.status ?? ""),
          amount: i.amount,
        })),
        releases: (relByJob.get(job.id) ?? []).map((r) => ({ amount: r.amount })),
      });
      const schedule = computeRetentionSchedule({
        position,
        practicalCompletionDate: job.practical_completion_date,
        defectsLiabilityMonths: Number(job.defects_liability_months ?? 12),
        firstReleasePct: Number(job.retention_first_release_pct ?? 50),
        now,
      });

      for (const moiety of schedule.moieties) {
        // Only a moiety that is DUE, still has money to release, and has not
        // already been reminded is a candidate to fire.
        if (moiety.status !== "due" || moiety.remaining <= TOL) continue;
        const column =
          moiety.key === "first"
            ? "retention_first_reminded_at"
            : "retention_second_reminded_at";
        const already =
          moiety.key === "first"
            ? job.retention_first_reminded_at
            : job.retention_second_reminded_at;
        if (already) {
          summary.skipped_already++;
          continue;
        }

        // CAS-claim the marker: only the pass that flips it from NULL emits.
        const claimed = await claimMarker(db, job.id, column, now);
        if (!claimed) {
          summary.skipped_already++;
          continue;
        }

        await emitNotifications([
          buildNotification(job, moiety.key, moiety.remaining, moiety.dueDate),
        ]).catch((e) =>
          console.error("[retention-reminders] notify failed", job.id, e),
        );
        if (moiety.key === "first") summary.fired_first++;
        else summary.fired_second++;
      }
    } catch (e) {
      console.error("[retention-reminders] per-job error", job.id, e);
      summary.errors++;
    }
  }

  return summary;
}

/** Read a money table for a set of job ids, chunked over `.in` and paged in full. */
async function readByJobIds(
  db: LooseClient,
  table: string,
  cols: string,
  jobIds: string[],
): Promise<MoneyRow[]> {
  const out: MoneyRow[] = [];
  // PostgREST/URL length bounds the `.in` list; chunk it. Each chunk is paged in
  // full on the unique `id` order (F-1) so no page edge drops a base row and
  // under-states retention.
  const CHUNK = 200;
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const chunk = jobIds.slice(i, i + CHUNK);
    const { data, error } = await fetchAllRows<MoneyRow>((from, to) =>
      db
        .from(table)
        .select(cols)
        .in("job_id", chunk)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<MoneyRow>>,
    );
    if (error) throw readFailure(`retention reminders: ${table}`, error);
    out.push(...data);
  }
  return out;
}

function groupByJob(rows: MoneyRow[]): Map<string, MoneyRow[]> {
  const m = new Map<string, MoneyRow[]>();
  for (const r of rows) {
    if (!r.job_id) continue;
    (m.get(r.job_id) ?? m.set(r.job_id, []).get(r.job_id)!).push(r);
  }
  return m;
}

/**
 * Atomically claim a reminder marker. Returns true iff THIS call flipped it from
 * NULL — the concurrency-safe once-ever guard.
 */
async function claimMarker(
  db: LooseClient,
  jobId: string,
  column: "retention_first_reminded_at" | "retention_second_reminded_at",
  now: Date,
): Promise<boolean> {
  const { data, error } = await db
    .from("jobs")
    .update({ [column]: now.toISOString() })
    .eq("id", jobId)
    .is(column, null)
    .select("id");
  if (error) {
    console.error("[retention-reminders] claim failed", jobId, column, error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

function buildNotification(
  job: CandidateJob,
  key: "first" | "second",
  remaining: number,
  dueDate: string | null,
): NotificationCreate {
  const amount = formatGbp(remaining);
  return {
    org_id: job.org_id,
    user_id: null,
    audience: "customer",
    type: `retention.release_due_${key}`,
    category: "system",
    priority: "medium",
    title:
      key === "first"
        ? `Retention release due — ${amount} at practical completion`
        : `Retention release due — ${amount} at end of defects period`,
    body:
      "This job's held retention has reached a scheduled release date. Review the " +
      "retention register and release it to the customer if the contract terms are met.",
    action_url: `/jobs/${job.id}`,
    source_module: "retention",
    source_id: job.id,
    metadata: { moiety: key, due_date: dueDate, remaining },
  };
}
