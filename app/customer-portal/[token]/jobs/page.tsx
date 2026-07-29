import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";

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
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  );
}
