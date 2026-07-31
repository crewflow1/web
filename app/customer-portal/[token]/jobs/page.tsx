import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  loadProgressForJobs,
  type ProgressClient,
} from "@/server/services/job-progress";
import { toPortalProgress, type PortalProgress } from "@/lib/job-progress/portal";
import { formatDateShortUK } from "@/lib/time/format";

/**
 * Customer portal — Job progress.
 *
 * Shows every job currently linked to this customer with status,
 * scheduled date and assigned tech. Read-only. Service-role read, but
 * every query is filtered on customer_id (the portal loader's session)
 * so no other org's jobs can leak.
 *
 * Phase 3 directive Step 4. The directive lists "client can view: job
 * status / key dates / assigned team if allowed / uploaded documents
 * / progress updates / messages" — this covers status + dates +
 * assigned. Documents/messages live on the dedicated /messages tab;
 * per-job-thread is a future extension.
 *
 * DELIBERATELY NOT SHOWN — do not add these back without a customer-
 * visibility model to gate them:
 *   - `jobs.notes`: the staff-authored internal field from the job form
 *     ("Scope, materials, access notes…"), previously rendered here
 *     verbatim to any token holder.
 *   - the assigned user's `email`: internal staff PII, previously used
 *     as a display fallback when `full_name` was null.
 * The directive's "assigned team IF ALLOWED" conditional was never
 * built, and `jobs` carries no customer-visibility flag — so the only
 * safe reading of "if allowed" is to show nothing that isn't plainly
 * customer-facing. Surfacing customer-readable job notes needs its own
 * field or flag; it is not a rendering tweak.
 */

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  "in-progress": "In progress",
  completed: "Completed",
  blocked: "Blocked",
};

const STATUS_STYLES: Record<string, string> = {
  new: "bg-blue-100 text-blue-700",
  "in-progress": "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  blocked: "bg-red-100 text-red-700",
};

/**
 * The customer's view of progress: a percentage, when it was last updated, the
 * factual movement wording, and a bar.
 *
 * Takes `PortalProgress` and NOTHING else — it is structurally incapable of
 * rendering a staff note or an author, because neither is on the type. The
 * wording comes from PORTAL_MOVEMENT_LABELS, which is deliberately factual
 * ("No change since the last update") rather than the internal verdict
 * ("Stalled") — see lib/job-progress/portal.ts.
 *
 * No planned/expected line is shown, for the same reason the staff panel shows
 * none: the platform holds no programme, and a fabricated baseline shown to a
 * paying client would be a commercial claim with nothing behind it.
 */
function JobProgress({ progress }: { progress: PortalProgress | undefined }) {
  if (!progress || !progress.hasProgress || progress.percent === null) {
    return null;
  }
  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs font-semibold text-slate-900">
          {progress.percent}% complete
        </span>
        <span className="text-[11px] text-slate-500">
          {progress.updatedOn
            ? `Updated ${formatDateShortUK(progress.updatedOn)}`
            : null}
        </span>
      </div>
      <div
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="img"
        aria-label={`${progress.percent}% complete`}
      >
        <div
          className="h-full rounded-full bg-emerald-500"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      {/* The movement WORD, never colour alone (WCAG 1.4.1). */}
      <p className="mt-1.5 text-[11px] text-slate-500">{progress.movement}</p>
    </div>
  );
}

export default async function PortalJobsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();
  // SECURITY: never SELECT internal fields here, don't just avoid rendering
  // them. `jobs.notes` is the same free-text field staff fill in from the job
  // form (placeholder: "Scope, materials, access notes…") — access codes, key
  // locations, margin and internal commentary all plausibly live in it. The
  // assigned user's `email` is internal staff PII. Leaving either out of the
  // query means no future render can leak them by accident, and nothing
  // sensitive crosses the wire to a page served on an unauthenticated token.
  const { data: jobsRaw, error: jobsError } = await admin
    .from("jobs")
    .select(
      `
        id, status, scheduled_date, created_at,
        assigned:users!jobs_assigned_to_fkey ( full_name )
      `,
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("scheduled_date", { ascending: true, nullsFirst: false })
    .limit(100);
  if (jobsError) {
    throw readFailure("portal jobs: jobs", jobsError);
  }

  type Row = {
    id: string;
    status: string;
    scheduled_date: string | null;
    created_at: string;
    assigned: { full_name: string | null } | null;
  };
  const jobs = (jobsRaw ?? []) as unknown as Row[];

  /**
   * Progress per job, narrowed to the CUSTOMER-SAFE shape before it can reach
   * the markup below.
   *
   * SECURITY: `loadProgressForJobs` returns the INTERNAL summary — which
   * carries staff notes, author ids and the originating report id — so the
   * `toPortalProgress` narrowing on the next line is not cosmetic. It is the
   * boundary. `PortalProgress` has no field any of those values could occupy
   * (lib/job-progress/portal.ts), so nothing internal reaches this page's
   * render tree or the HTML sent to an unauthenticated token holder. Proven by
   * __tests__/security/job-progress-portal-safety.test.ts.
   *
   * Scoping: two batched reads (never N+1), pinned to this customer's org AND
   * to the job ids already filtered by `customer_id` above.
   */
  const jobIds = jobs.map((j) => j.id);
  const progress = await loadProgressForJobs(
    admin as unknown as ProgressClient,
    customer.org_id,
    jobIds,
  );
  const progressByJob = new Map<string, PortalProgress>();
  for (const [jobId, summary] of progress.byJob) {
    progressByJob.set(jobId, toPortalProgress(summary));
  }

  return (
    <PortalShell customer={customer} org={org} token={token} active="jobs">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Your jobs</h2>
        <p className="text-sm text-slate-600">
          Progress on the work {org.name} is doing for you.
        </p>
      </header>

      {jobs.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">
            No jobs scheduled yet
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Once {org.name} accepts a quote and books the work, the job
            will appear here with its status and dates.
          </p>
        </section>
      ) : (
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li
              key={j.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[j.status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {STATUS_LABELS[j.status] ?? j.status}
                    </span>
                    {j.scheduled_date ? (
                      <span className="text-xs text-slate-600">
                        Scheduled {j.scheduled_date}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">
                        No date set yet
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    {/* No identifying fallback: an assigned member without a
                        display name is reported as assigned (which is true and
                        useful) but never identified by email. "Not yet
                        assigned" is reserved for genuinely unassigned jobs —
                        using it here would be a lie, not a redaction. */}
                    {j.assigned?.full_name
                      ? `Assigned: ${j.assigned.full_name}`
                      : j.assigned
                        ? "Assigned"
                        : "Not yet assigned"}
                  </p>
                  <JobProgress progress={progressByJob.get(j.id)} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  );
}
