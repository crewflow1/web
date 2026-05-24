import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";

/**
 * Customer portal — Job progress.
 *
 * Shows every job currently linked to this customer with status,
 * scheduled date, assigned tech, and notes. Read-only. Service-role
 * read, but every query is filtered on customer_id (the portal
 * loader's session) so no other org's jobs can leak.
 *
 * Phase 3 directive Step 4. The directive lists "client can view: job
 * status / key dates / assigned team if allowed / uploaded documents
 * / progress updates / messages" — this v1 covers status + dates +
 * assigned + brief notes. Documents/messages live on the dedicated
 * /messages tab; per-job-thread is a future extension.
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
  const { data: jobsRaw } = await admin
    .from("jobs")
    .select(
      `
        id, status, scheduled_date, notes, created_at,
        assigned:users!jobs_assigned_to_fkey ( full_name, email )
      `,
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("scheduled_date", { ascending: true, nullsFirst: false })
    .limit(100);

  type Row = {
    id: string;
    status: string;
    scheduled_date: string | null;
    notes: string | null;
    created_at: string;
    assigned: { full_name: string | null; email: string | null } | null;
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
                      <span className="text-xs text-slate-400">
                        No date set yet
                      </span>
                    )}
                  </div>
                  {j.notes ? (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                      {j.notes}
                    </p>
                  ) : null}
                  <p className="mt-2 text-[11px] text-slate-500">
                    {j.assigned?.full_name
                      ? `Assigned: ${j.assigned.full_name}`
                      : j.assigned?.email
                        ? `Assigned: ${j.assigned.email}`
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
