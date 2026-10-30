import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { StateForm } from "@/components/forms/StateForm";
import { formatDateTimeUK } from "@/lib/time/format";
import { listStaffForOrg, type StaffOption } from "../_form-helpers";
import { assignWorker, removeWorker } from "./assignment-actions";

/**
 * Job assignments panel — the job's crew (owner/admin only).
 *
 * The job page renders this ONLY for owner/admin (the capability the server
 * actions enforce), so it is never in a staff member's RSC payload.
 *
 * SERVICE-ROLE READ. `job_assignments` is service-role-only (RLS on, client
 * grants revoked — migration 20261242000000), so this server component reads it
 * through `createAdminClient()`. The read is pinned to BOTH job_id and org_id:
 * the admin client bypasses RLS, so the org pin is the tenant boundary here
 * (the composite FK makes a cross-org row impossible regardless).
 *
 * LOUD READ. A failed read renders an explicit error rather than an empty crew —
 * "nobody assigned" and "the query failed" must not look identical.
 *
 * The add/remove controls are <StateForm>s bound to the server actions; on
 * success the actions `revalidatePath` the job page, so this section refreshes
 * in place without a navigation.
 */

type AssignmentRow = {
  id: string;
  user_id: string;
  assigned_by: string | null;
  assigned_at: string;
};

type UserRow = { id: string; full_name: string | null; email: string };

type ListResult<T> = { data: T[] | null; error: { message: string } | null };

interface AssignmentSelect {
  eq: (column: string, value: unknown) => AssignmentSelect;
  order: (
    column: string,
    opts: { ascending: boolean },
  ) => Promise<ListResult<AssignmentRow>>;
}
interface UsersSelect {
  in: (column: string, values: readonly string[]) => Promise<ListResult<UserRow>>;
}
type ReaderLike = {
  from: (table: string) => {
    select: (columns: string) => AssignmentSelect & UsersSelect;
  };
};

// Separate minimal reader for the job's legacy single-assignee column.
type SingleJob = { data: { assigned_to: string | null } | null; error: { message: string } | null };
interface JobFilter {
  eq: (column: string, value: unknown) => JobFilter;
  maybeSingle: () => Promise<SingleJob>;
}
type JobReaderLike = { from: (table: string) => { select: (columns: string) => JobFilter } };

/** One row of the displayed crew — a real job_assignments row, or the legacy
 *  jobs.assigned_to primary synthesised in so both models are visible + managed
 *  during the transition. `legacy` entries carry no assigned_at/by. */
type CrewMember = {
  key: string;
  userId: string;
  assignedAt: string | null;
  assignedBy: string | null;
  legacy: boolean;
};

function displayName(u: UserRow | undefined, fallback: string): string {
  if (!u) return fallback;
  return u.full_name ?? u.email;
}

export async function JobAssignmentsSection({
  jobId,
  orgId,
}: {
  jobId: string;
  orgId: string;
}) {
  const admin = createAdminClient() as unknown as ReaderLike;

  const { data: rows, error } = await admin
    .from("job_assignments")
    .select("id, user_id, assigned_by, assigned_at")
    .eq("job_id", jobId)
    .eq("org_id", orgId)
    .order("assigned_at", { ascending: true });

  if (error) {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
        <h2 className="text-base font-semibold text-red-800">Assigned team</h2>
        <p className="mt-1 text-sm text-red-700">
          Couldn&apos;t load who&apos;s assigned to this job. Refresh to try
          again — this is a failed read, not an empty one.
        </p>
      </section>
    );
  }

  const assignments = rows ?? [];

  // Legacy single-assignee bridge: a worker assigned via the old JobForm select
  // lives on jobs.assigned_to, NOT job_assignments. Surface them here (deduped)
  // so the crew panel shows everyone with access during the transition; removing
  // them clears both paths (see removeWorker).
  const jobReader = createAdminClient() as unknown as JobReaderLike;
  const { data: jobRow } = await jobReader
    .from("jobs")
    .select("assigned_to")
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  const assignedIdSet = new Set(assignments.map((a) => a.user_id));
  const legacyAssignee =
    jobRow?.assigned_to && !assignedIdSet.has(jobRow.assigned_to) ? jobRow.assigned_to : null;

  // Unified crew = real assignment rows + the legacy primary (if any), deduped.
  const crew: CrewMember[] = [
    ...assignments.map((a) => ({
      key: a.id,
      userId: a.user_id,
      assignedAt: a.assigned_at,
      assignedBy: a.assigned_by,
      legacy: false,
    })),
    ...(legacyAssignee
      ? [{ key: `legacy:${legacyAssignee}`, userId: legacyAssignee, assignedAt: null, assignedBy: null, legacy: true }]
      : []),
  ];

  // Resolve names/emails for the assignees AND the people who assigned them, in
  // one admin read. (Not an embed — job_assignments isn't in the generated types
  // and we don't rely on a PostgREST relationship.)
  const idSet = new Set<string>();
  for (const a of assignments) {
    idSet.add(a.user_id);
    if (a.assigned_by) idSet.add(a.assigned_by);
  }
  if (legacyAssignee) idSet.add(legacyAssignee);
  const userIds = [...idSet];
  let usersById = new Map<string, UserRow>();
  if (userIds.length > 0) {
    const { data: users } = await admin
      .from("users")
      .select("id, full_name, email")
      .in("id", userIds);
    usersById = new Map((users ?? []).map((u) => [u.id, u]));
  }

  // Assignable = org staff not already on the crew (incl. the legacy primary).
  const crewIds = new Set(crew.map((m) => m.userId));
  const staff = await listStaffForOrg(orgId);
  const assignable: StaffOption[] = staff.filter((s) => !crewIds.has(s.id));

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Assigned team</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Everyone working this job. Add or remove workers — removing someone
            revokes their access.
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          {crew.length} assigned
        </span>
      </div>

      {crew.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          No workers assigned yet. Add one below.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
          {crew.map((m) => {
            const name = displayName(usersById.get(m.userId), "Unknown worker");
            const assignedByName = m.assignedBy
              ? displayName(usersById.get(m.assignedBy), "a teammate")
              : null;
            return (
              <li
                key={m.key}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">
                    {name}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {m.legacy
                      ? "Primary assignee (from the job record)"
                      : `Assigned ${formatDateTimeUK(m.assignedAt ?? "")}${assignedByName ? ` · by ${assignedByName}` : ""}`}
                  </div>
                </div>
                <StateForm
                  action={removeWorker.bind(null, jobId)}
                  confirm={`Remove ${name} from this job? This revokes their access.`}
                  className="shrink-0"
                >
                  <input type="hidden" name="user_id" value={m.userId} />
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                  >
                    Remove
                  </button>
                </StateForm>
              </li>
            );
          })}
        </ul>
      )}

      <StateForm
        action={assignWorker.bind(null, jobId)}
        className="mt-5 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4"
      >
        <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
          Add a worker
          <select
            name="user_id"
            required
            defaultValue=""
            disabled={assignable.length === 0}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-400"
          >
            <option value="" disabled>
              {assignable.length === 0
                ? "— Everyone is already assigned —"
                : "— Choose a worker —"}
            </option>
            {assignable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name ?? s.email}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={assignable.length === 0}
          className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Assign
        </button>
      </StateForm>
    </section>
  );
}
