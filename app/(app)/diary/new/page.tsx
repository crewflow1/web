import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listJobOptions } from "../_data";
import { DiaryForm } from "../_form";
import { createDiaryEntry } from "../actions";

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't save the entry. Try again.",
  validation: "Please check the form and try again.",
};

type SP = Promise<{ error?: string; job?: string; date?: string }>;

export default async function NewDiaryEntryPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const jobs = await listJobOptions(ctx.org.id);

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/diary" className="hover:text-slate-900">
          Site diary
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">New diary entry</h1>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <DiaryForm
        action={createDiaryEntry}
        jobs={jobs}
        defaults={{ entry_date: sp.date ?? today, job_id: sp.job ?? "" }}
        submitLabel="Save entry"
        cancelHref="/diary"
      />
    </div>
  );
}
