import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listJobOptions } from "../../_data";
import { DiaryForm } from "../../_form";
import { updateDiaryEntry } from "../../actions";

type DiaryRow = {
  id: string;
  entry_date: string;
  job_id: string | null;
  weather: string | null;
  labour_count: number | null;
  work_summary: string | null;
  delays: string | null;
  notes: string | null;
  updated_at: string;
};

const ERROR_MAP: Record<string, string> = {
  validation: "Please check the form and try again.",
  record_failed: "Couldn't save your changes. Try again.",
};

export default async function EditDiaryEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  // Pinned to the ACTIVE org — RLS admits every org the viewer belongs to, so a
  // by-id read alone loads another org's diary entry into this org's edit form.
  const [{ data: entry }, jobs] = await Promise.all([
    (
      supabase.from("site_diary_entries" as never) as unknown as {
        select: (cols: string) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{ data: DiaryRow | null }>;
            };
          };
        };
      }
    )
      .select(
        "id, entry_date, job_id, weather, labour_count, work_summary, delays, notes, updated_at",
      )
      .eq("id", id)
      .eq("org_id", ctx.org.id)
      .maybeSingle(),
    listJobOptions(ctx.org.id),
  ]);

  if (!entry) notFound();

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/diary" className="hover:text-slate-900">
          Site diary
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/diary/${entry.id}`} className="hover:text-slate-900">
          Entry
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Edit</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Edit diary entry</h1>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <DiaryForm
        action={updateDiaryEntry}
        jobs={jobs}
        hiddenId={entry.id}
        defaults={entry}
        submitLabel="Save changes"
        cancelHref={`/diary/${entry.id}`}
        mode="update"
        baseVersion={entry.updated_at}
        offline={{ userId: user.id, orgId: ctx.org.id }}
      />
    </div>
  );
}
