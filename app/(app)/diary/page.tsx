import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { formatDiaryDate } from "@/lib/site-diary/schema";

/**
 * /diary — the site daily diary: one row per logged day, most recent first.
 * A single org-scoped read; job names resolve in one batched lookup (never
 * per row).
 */

type DiaryRow = {
  id: string;
  entry_date: string;
  job_id: string | null;
  weather: string | null;
  labour_count: number | null;
  work_summary: string | null;
  delays: string | null;
  created_at: string;
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid entry.",
  forbidden: "Only an owner or admin can delete a diary entry.",
  delete_failed: "Couldn't delete that entry.",
  not_found: "That entry no longer exists.",
};
const SAVED_MAP: Record<string, string> = {
  created: "Diary entry saved.",
  updated: "Diary entry updated.",
  deleted: "Diary entry deleted.",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function DiaryPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const { data, error } = await (
    supabase.from("site_diary_entries" as never) as unknown as {
      select: (cols: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            order: (
              col: string,
              opts: { ascending: boolean },
            ) => {
              limit: (n: number) => Promise<{ data: DiaryRow[] | null; error: SupabaseReadError | null }>;
            };
          };
        };
      };
    }
  )
    .select(
      "id, entry_date, job_id, weather, labour_count, work_summary, delays, created_at",
    )
    // ACTIVE-org pin — the diary is dispute evidence and must be one company's.
    .eq("org_id", ctx.org.id)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw readFailure("site diary: register", error);
  const rows = data ?? [];

  const jobIds = [
    ...new Set(rows.map((r) => r.job_id).filter((x): x is string => !!x)),
  ];
  const jobsMap = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .in("id", jobIds);
    for (const j of jobs ?? []) jobsMap.set(j.id, j.customer?.name ?? "Job");
  }

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Site diary</h1>
          <p className="mt-1 text-sm text-slate-600">
            A dated record of each day on site — weather, who was on, what got
            done, and any delays. Your evidence for progress and disputes.
          </p>
        </div>
        <Link
          href="/diary/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + New entry
        </Link>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="📓"
          title="No diary entries yet"
          body="Log today on site — the weather, who was on, what got done. It takes a minute and it's the record that settles disputes later."
          primary={{ href: "/diary/new", label: "Add today's entry" }}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const jobName = row.job_id ? jobsMap.get(row.job_id) : null;
            return (
              <li key={row.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-slate-900">
                        {formatDiaryDate(row.entry_date)}
                      </span>
                      {jobName ? <span>📋 {jobName}</span> : null}
                      {row.weather ? <span>🌦 {row.weather}</span> : null}
                      {row.labour_count != null ? (
                        <span>👷 {row.labour_count} on site</span>
                      ) : null}
                      {row.delays ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                          Delay logged
                        </span>
                      ) : null}
                    </div>
                    {row.work_summary ? (
                      <p className="mt-1.5 line-clamp-2 text-sm text-slate-700">
                        {row.work_summary}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-sm italic text-slate-500">
                        No work summary.
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/diary/${row.id}`}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        {rows.length} entr{rows.length === 1 ? "y" : "ies"} shown.
      </p>
    </div>
  );
}
