import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "@/app/(app)/_components/empty-state";
import { listJobOptions } from "@/app/(app)/diary/_data";
import { effectiveStatus, type PermitStatus } from "@/lib/health-safety/permits";
import { listPermits } from "./_data";
import {
  StatusPill,
  TypePill,
  formatWindow,
  errorMessage,
  savedMessage,
  primaryBtn,
} from "./_meta";

/**
 * /health-safety/permits — the Permit-to-Work register.
 *
 * One row per permit, newest first, each showing its reference (or "Draft"),
 * type, title, linked job, its *effective* status (the stored status unless a
 * live permit's window has passed — then "Expired"), the validity window and
 * how many required conditions are confirmed. The list is a single org-scoped
 * read; job names come from one further batched read, grouped in memory.
 */

type SP = Promise<{ saved?: string; error?: string }>;

export default async function PermitsRegisterPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireOrgContext();
  const sp = await searchParams;

  const [rows, jobs] = await Promise.all([listPermits(), listJobOptions()]);
  const jobLabel = new Map(jobs.map((j) => [j.id, j.label] as const));
  const now = new Date();

  const error = errorMessage(sp.error);
  const saved = savedMessage(sp.saved);

  const liveCount = rows.filter(
    (r) => r.status === "issued" || r.status === "active",
  ).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-2 text-sm text-slate-500"
      >
        <Link href="/health-safety" className="hover:text-slate-900">
          Health &amp; safety
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Permits</span>
      </nav>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Permits to work</h1>
          <p className="mt-1 text-sm text-slate-600">
            Authorise high-risk work under controlled conditions. Draft the
            permit, confirm every required control, then issue it — a permit is
            only valid between its ‘valid from’ and ‘valid until’ times.
          </p>
        </div>
        <Link href="/health-safety/permits/new" className={primaryBtn}>
          + New permit
        </Link>
      </header>

      {error ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}
      {saved ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {saved}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📋"
            title="No permits yet"
            body="High-risk work — hot works, confined spaces, working at height and the rest — should run under a permit to work. Draft your first one, confirm its control conditions, then issue it to the site."
            primary={{
              href: "/health-safety/permits/new",
              label: "New permit",
            }}
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const eff = effectiveStatus(
              row.status as PermitStatus,
              row.valid_until,
              now,
              row.valid_from,
            );
            const job = row.job_id
              ? (jobLabel.get(row.job_id) ?? "Linked job")
              : null;
            const conditionsDone =
              row.required_count === 0
                ? "No required conditions"
                : `${row.confirmed_required_count}/${row.required_count} required conditions confirmed`;
            return (
              <li
                key={row.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-medium text-slate-500">
                        {row.reference ?? "Draft"}
                      </span>
                      <StatusPill status={eff} />
                      <TypePill type={row.permit_type} />
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">
                      {row.title}
                    </p>
                    <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      <div className="flex gap-1">
                        <dt className="sr-only">Validity window</dt>
                        <dd>{formatWindow(row.valid_from, row.valid_until)}</dd>
                      </div>
                      <div className="flex gap-1">
                        <dt className="sr-only">Required conditions</dt>
                        <dd>{conditionsDone}</dd>
                      </div>
                      {job ? (
                        <div className="flex gap-1">
                          <dt className="sr-only">Job</dt>
                          <dd className="min-w-0 truncate">📍 {job}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                  <Link
                    href={`/health-safety/permits/${row.id}`}
                    className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                  >
                    {row.status === "draft" ? "Open draft" : "View"}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > 0 ? (
        <p className="text-xs text-slate-500">
          {rows.length} permit{rows.length === 1 ? "" : "s"} · {liveCount} issued
          or active.
        </p>
      ) : null}
    </div>
  );
}
