import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { ASSIGNMENT_TYPE_LABELS, isOverdue, type AssignmentType } from "@/lib/assets/assignment";

export const metadata = { title: "Asset holdings · CrewFlow" };

/**
 * /assets/holdings — who has what, right now (integration slice). Every OPEN
 * custody assignment org-wide, grouped by holder kind: staff-held, on jobs, on
 * vehicles, at locations. One bounded, RLS-scoped read with joined names; the
 * operator's "where is everything?" answer.
 */

type Row = {
  id: string;
  asset_id: string;
  assignment_type: AssignmentType;
  location: string | null;
  assigned_at: string;
  expected_return_at: string | null;
  assignee_id: string | null;
  job_id: string | null;
  assets: { id: string; name: string } | null;
  users: { full_name: string | null; email: string | null } | null;
};

const GROUPS: ReadonlyArray<readonly [AssignmentType[], string]> = [
  [["issued_to_staff"], "Staff-held"],
  [["allocated_to_job"], "On jobs"],
  [["loaded_on_vehicle"], "On vehicles"],
  [["stored_at_depot", "sent_for_repair", "returned_to_supplier"], "Depots, repair & suppliers"],
];

/** Chainable `.eq()` so the active-org pin sits alongside the status filter. */
type HoldingsQuery = {
  eq: (k: string, v: unknown) => HoldingsQuery;
  order: (
    c: string,
    o: { ascending: boolean },
  ) => { limit: (n: number) => Promise<{ data: Row[] | null }> };
};

export default async function HoldingsPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data } = await (
    supabase.from("asset_assignments" as never) as unknown as {
      select: (c: string) => HoldingsQuery;
    }
  )
    .select(
      "id, asset_id, assignment_type, location, assigned_at, expected_return_at, assignee_id, job_id, assets(id, name), users!asset_assignments_assignee_id_fkey(full_name, email)",
    )
    // ACTIVE-org pin — RLS admits every org the viewer belongs to, so without
    // this "who has what" mixes both companies' custody records.
    .eq("org_id", ctx.org.id)
    .eq("status", "open")
    .order("assigned_at", { ascending: false })
    .limit(300);
  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <Link href="/assets" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
          ← Assets
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Holdings</h1>
        <p className="mt-1 text-sm text-slate-600">
          Who has what, right now — staff, jobs, vehicles and depots.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
          Nothing is checked out. Check assets out from their detail pages.
        </p>
      ) : (
        GROUPS.map(([types, title]) => {
          const group = rows.filter((r) => types.includes(r.assignment_type));
          if (group.length === 0) return null;
          return (
            <section key={title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">{title}</h2>
                <span className="text-xs text-slate-500">{group.length}</span>
              </div>
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {group.map((r) => {
                  const holder =
                    r.assignment_type === "issued_to_staff"
                      ? (r.users?.full_name || r.users?.email || "Staff member")
                      : r.assignment_type === "allocated_to_job" && r.job_id
                        ? "Job"
                        : (r.location ?? ASSIGNMENT_TYPE_LABELS[r.assignment_type]);
                  const overdue = isOverdue(r.expected_return_at, "open", today);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5">
                      <Link href={`/assets/${r.asset_id}`} className="font-medium text-slate-900 hover:underline">
                        {r.assets?.name ?? "Asset"}
                      </Link>
                      <span className="text-xs text-slate-500">→ {holder}</span>
                      {r.assignment_type === "allocated_to_job" && r.job_id ? (
                        <Link href={`/jobs/${r.job_id}`} className="text-xs text-slate-500 underline">
                          view job
                        </Link>
                      ) : null}
                      <span className="text-xs text-slate-400">since {r.assigned_at.slice(0, 10)}</span>
                      {r.expected_return_at ? (
                        <span
                          className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            overdue ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {overdue ? "Overdue — due back" : "Due back"} {r.expected_return_at}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
