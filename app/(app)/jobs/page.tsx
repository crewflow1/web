import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";

/**
 * Jobs list.
 *
 * Joins customer name + assigned user name in a single PostgREST select
 * via the FK relationships (jobs.customer_id -> customers.id, jobs.assigned_to
 * -> users.id). RLS scopes everything to the caller's org automatically.
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

export default async function JobsPage() {
  await requireOrgContext();

  const supabase = await createClient();
  const { data: jobs, error } = await supabase
    .from("jobs")
    .select(
      `
        id,
        status,
        scheduled_date,
        notes,
        created_at,
        customer:customers ( id, name ),
        assigned:users!jobs_assigned_to_fkey ( id, full_name, email )
      `,
    )
    .order("scheduled_date", { ascending: true, nullsFirst: false })
    .limit(200);

  if (error) {
    console.error("[jobs] list failed", error);
  }
  const rows = jobs ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Jobs</h1>
          <p className="mt-1 text-sm text-slate-600">
            {rows.length} {rows.length === 1 ? "job" : "jobs"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/jobs/calendar"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Calendar
          </Link>
          <Link
            href="/jobs/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            + New job
          </Link>
        </div>
      </header>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        {rows.length === 0 ? (
          <EmptyState
            icon="🔧"
            title="No jobs yet"
            body="Schedule your first job — pick a customer, set a date, assign a staff member. Field staff can attach photos as work progresses."
            primary={{ href: "/jobs/new", label: "Create first job" }}
            secondary={{ href: "/customers/new", label: "Add a customer first" }}
          />
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Assigned</th>
                <th className="px-4 py-3">Scheduled</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((j) => (
                <tr key={j.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[j.status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {STATUS_LABELS[j.status] ?? j.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {j.customer?.name ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {j.assigned?.full_name ?? j.assigned?.email ?? (
                      <span className="text-slate-400">Unassigned</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {j.scheduled_date ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/jobs/${j.id}`}
                      className="text-sm font-medium text-slate-700 hover:text-slate-900"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
