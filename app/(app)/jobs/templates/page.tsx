import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../../_components/empty-state";
import { PAGE_SIZE, parsePage, offsetForPage, pageWindow } from "@/lib/jobs/list";

/**
 * Job templates list — reusable milestone + checklist blueprints by job type.
 *
 * ACTIVE-org pinned and paginated with an EXACT count via .range() (F-1): the
 * headline count and the page window are always correct, and no template is
 * unreachable past a fixed cap. Admins manage templates; members see them so
 * they know what a new job can be started from.
 */

type SP = Promise<{ page?: string; saved?: string; deleted?: string }>;

type TemplateRow = {
  id: string;
  name: string;
  job_type: string | null;
  is_active: boolean;
  updated_at: string;
};

export default async function JobTemplatesPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const supabase = await createClient();
  const page = parsePage(sp.page);
  const offset = offsetForPage(page);

  const { data, count, error } = await supabase
    .from("job_templates")
    .select("id, name, job_type, is_active, updated_at", { count: "exact" })
    // ACTIVE-org pin — RLS admits every org the viewer belongs to.
    .eq("org_id", ctx.org.id)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw readFailure("job templates: list", error);

  const rows = (data ?? []) as TemplateRow[];
  const totalCount = count ?? 0;
  const { totalPages, from, to } = pageWindow(totalCount, offset, rows.length);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Job templates</h1>
          <p className="mt-1 text-sm text-slate-600">
            {totalCount} {totalCount === 1 ? "template" : "templates"} · pre-load
            milestones &amp; a checklist on new jobs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/jobs"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Jobs
          </Link>
          {isAdmin ? (
            <Link
              href="/jobs/templates/new"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              + New template
            </Link>
          ) : null}
        </div>
      </header>

      {sp.saved ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Template saved.
        </div>
      ) : null}
      {sp.deleted ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Template deleted.
        </div>
      ) : null}

      {totalCount === 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📋"
            title="No templates yet"
            body="Capture the milestones and checklist you run on the same kind of job, then start new jobs from it in one click."
            primary={
              isAdmin
                ? { href: "/jobs/templates/new", label: "Create first template" }
                : undefined
            }
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Job type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{t.name}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {t.job_type ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {t.is_active ? (
                      <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                        Retired
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin ? (
                      <Link
                        href={`/jobs/templates/${t.id}`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        Edit →
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalCount > 0 ? (
        <nav
          aria-label="Pagination"
          className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600"
        >
          <span>
            Showing {from}–{to} of {totalCount}
          </span>
          {totalPages > 1 ? (
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  href={{ pathname: "/jobs/templates", query: { page: page - 1 } }}
                  className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                >
                  ← Previous
                </Link>
              ) : null}
              <span>
                Page {page} of {totalPages}
              </span>
              {page < totalPages ? (
                <Link
                  href={{ pathname: "/jobs/templates", query: { page: page + 1 } }}
                  className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                >
                  Next →
                </Link>
              ) : null}
            </div>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
