import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { deleteDiaryEntry } from "../actions";

type DiaryRow = {
  id: string;
  entry_date: string;
  job_id: string | null;
  weather: string | null;
  labour_count: number | null;
  work_summary: string | null;
  delays: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
};

const SAVED_MAP: Record<string, string> = {
  created: "Entry saved — add site photos below.",
  updated: "Entry updated.",
};

export default async function DiaryEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: entry } = await (
    supabase.from("site_diary_entries" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: DiaryRow | null }>;
        };
      };
    }
  )
    .select(
      "id, entry_date, job_id, weather, labour_count, work_summary, delays, notes, created_by, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!entry) notFound();

  const canDelete =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const staff = await listStaffForOrg(ctx.org.id);
  const authorName = entry.created_by
    ? (staff.find((s) => s.id === entry.created_by)?.full_name ??
      staff.find((s) => s.id === entry.created_by)?.email ??
      null)
    : null;

  let jobName: string | null = null;
  if (entry.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("id", entry.job_id)
      .maybeSingle();
    jobName = job?.customer?.name ?? "Job";
  }

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link
          href="/diary"
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← Site diary
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              {formatDiaryDate(entry.entry_date)}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              {jobName ? (
                <Link href={`/jobs/${entry.job_id}`} className="hover:underline">
                  {jobName}
                </Link>
              ) : (
                "General entry"
              )}
              {authorName ? ` · logged by ${authorName}` : ""}
            </p>
          </div>
          <Link
            href={`/diary/${entry.id}/edit`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Edit
          </Link>
        </div>
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Weather</dt>
            <dd className="mt-0.5 text-slate-900">{entry.weather ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">People on site</dt>
            <dd className="mt-0.5 text-slate-900">{entry.labour_count ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Logged</dt>
            <dd className="mt-0.5 text-slate-900">{entry.created_at.slice(0, 10)}</dd>
          </div>
        </dl>

        <div className="mt-5 space-y-4 border-t border-slate-100 pt-4">
          <Field label="Work done">{entry.work_summary}</Field>
          <Field label="Delays / issues">{entry.delays}</Field>
          <Field label="Notes">{entry.notes}</Field>
        </div>
      </section>

      {/* Site photos — via the universal, audited, RLS-scoped attachments
          pipeline (bucket: tenant-attachments). */}
      <AttachmentsPanel targetTable="site_diary_entries" targetId={entry.id} />

      {canDelete ? (
        <form action={deleteDiaryEntry.bind(null, entry.id)}>
          <button
            type="submit"
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete entry
          </button>
          <span className="ml-3 text-xs text-slate-500">
            A diary is handover evidence — delete only genuine mistakes.
          </span>
        </form>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: string | null;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      {children ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{children}</p>
      ) : (
        <p className="mt-1 text-sm italic text-slate-500">—</p>
      )}
    </div>
  );
}
