import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  SNAG_PRIORITIES,
  SNAG_PRIORITY_LABELS,
  SNAG_STATUS_LABELS,
  SNAG_STATUSES,
  type SnagPriority,
  type SnagStatus,
} from "@/lib/snags/schema";
import {
  deleteSnag,
  reassignSnag,
  setSnagPriority,
  updateSnagStatus,
} from "../actions";

/**
 * /snags/[id] — a single defect: its detail, the status workflow, quick
 * reassign/priority controls, photos (via the universal attachments panel),
 * and an audit trail. Hard delete is owner/admin-only.
 */

type SnagRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  trade: string | null;
  priority: string;
  status: string;
  job_id: string | null;
  assigned_to: string | null;
  reported_by: string | null;
  due_date: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string | null;
};

const STATUS_STYLES: Record<SnagStatus, string> = {
  open: "bg-rose-100 text-rose-800",
  in_progress: "bg-amber-100 text-amber-800",
  fixed: "bg-blue-100 text-blue-800",
  verified: "bg-emerald-100 text-emerald-800",
  wont_fix: "bg-slate-100 text-slate-600",
};

const PRIORITY_STYLES: Record<SnagPriority, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

const ERROR_MAP: Record<string, string> = {
  update_failed: "Couldn't update that snag.",
};
const SAVED_MAP: Record<string, string> = {
  created: "Snag logged — add photos below.",
  status: "Status updated.",
  assigned: "Assignee updated.",
  priority: "Priority updated.",
};

export default async function SnagDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: snag, error: snagError } = await (
    supabase.from("snags" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: SnagRow | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select(
      "id, title, description, location, trade, priority, status, job_id, assigned_to, reported_by, due_date, resolved_at, created_at, updated_at",
    )
    .eq("id", id)
    // ACTIVE-ORG PIN — RLS admits every org the viewer belongs to.
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (snagError) throw readFailure("snag: detail", snagError);

  if (!snag) notFound();

  const status = snag.status as SnagStatus;
  const priority = snag.priority as SnagPriority;
  const canDelete =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  // Resolve names. Staff list is one query (reused for assignee, reporter, and
  // the reassign picker); the job is at most one more.
  const staff = await listStaffForOrg(ctx.org.id);
  const staffMap = new Map(
    staff.map((s) => [s.id, s.full_name || s.email] as const),
  );
  const assigneeName = snag.assigned_to
    ? (staffMap.get(snag.assigned_to) ?? "Someone")
    : null;
  const reporterName = snag.reported_by
    ? (staffMap.get(snag.reported_by) ?? null)
    : null;

  let jobName: string | null = null;
  if (snag.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("id", snag.job_id)
      .maybeSingle();
    jobName = job?.customer?.name ?? "Job";
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdue =
    !!snag.due_date &&
    snag.due_date < today &&
    status !== "verified" &&
    status !== "wont_fix";

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link
          href="/snags"
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← Snagging
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{snag.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.medium}`}
              >
                {SNAG_PRIORITY_LABELS[priority] ?? snag.priority} priority
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}
              >
                {SNAG_STATUS_LABELS[status] ?? snag.status}
              </span>
              {overdue ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800">
                  Overdue
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {snag.description ? (
          <p className="whitespace-pre-wrap text-sm text-slate-700">
            {snag.description}
          </p>
        ) : (
          <p className="text-sm italic text-slate-500">No details added.</p>
        )}
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Detail label="Job / site">
            {snag.job_id ? (
              <Link
                href={`/jobs/${snag.job_id}`}
                className="text-slate-900 underline-offset-2 hover:underline"
              >
                {jobName}
              </Link>
            ) : (
              "—"
            )}
          </Detail>
          <Detail label="Location">{snag.location ?? "—"}</Detail>
          <Detail label="Trade">{snag.trade ?? "—"}</Detail>
          <Detail label="Assigned to">{assigneeName ?? "Unassigned"}</Detail>
          <Detail label="Target fix date">
            <span className={overdue ? "text-red-600" : undefined}>
              {snag.due_date ?? "—"}
            </span>
          </Detail>
          <Detail label="Reported by">{reporterName ?? "—"}</Detail>
        </dl>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Status</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Move the snag along as work happens. Verified and Won&rsquo;t-fix close
          it.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {SNAG_STATUSES.map((s) => {
            const isCurrent = s === status;
            return (
              <form key={s} action={updateSnagStatus}>
                <input type="hidden" name="id" value={snag.id} />
                <input type="hidden" name="status" value={s} />
                <button
                  type="submit"
                  disabled={isCurrent}
                  aria-current={isCurrent ? "true" : undefined}
                  className={
                    isCurrent
                      ? "cursor-default rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                      : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  }
                >
                  {SNAG_STATUS_LABELS[s]}
                </button>
              </form>
            );
          })}
        </div>

        <div className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
          <form action={reassignSnag} className="flex items-end gap-2">
            <input type="hidden" name="id" value={snag.id} />
            <div className="flex-1">
              <label
                htmlFor="assigned_to"
                className="block text-xs font-medium text-slate-600"
              >
                Reassign
              </label>
              <select
                id="assigned_to"
                name="assigned_to"
                defaultValue={snag.assigned_to ?? ""}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              >
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name || s.email}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Update
            </button>
          </form>

          <form action={setSnagPriority} className="flex items-end gap-2">
            <input type="hidden" name="id" value={snag.id} />
            <div className="flex-1">
              <label
                htmlFor="priority"
                className="block text-xs font-medium text-slate-600"
              >
                Priority
              </label>
              <select
                id="priority"
                name="priority"
                defaultValue={priority}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              >
                {SNAG_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {SNAG_PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Update
            </button>
          </form>
        </div>
      </section>

      {/* Photos — the evidence for the defect. Rides the universal, audited,
          RLS-scoped attachments pipeline (bucket: tenant-attachments). */}
      <AttachmentsPanel targetTable="snags" targetId={snag.id} />

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Audit</h2>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Logged
            </dt>
            <dd className="text-slate-700">{snag.created_at.slice(0, 10)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Last updated
            </dt>
            <dd className="text-slate-700">
              {snag.updated_at ? snag.updated_at.slice(0, 10) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Resolved
            </dt>
            <dd className="text-slate-700">
              {snag.resolved_at ? snag.resolved_at.slice(0, 10) : "—"}
            </dd>
          </div>
        </dl>
      </section>

      {canDelete ? (
        <form action={deleteSnag.bind(null, snag.id)}>
          <button
            type="submit"
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete snag
          </button>
          <span className="ml-3 text-xs text-slate-500">
            Deletes the record and its photos. Prefer &ldquo;Won&rsquo;t fix&rdquo;
            to keep the history.
          </span>
        </form>
      ) : null}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  );
}
