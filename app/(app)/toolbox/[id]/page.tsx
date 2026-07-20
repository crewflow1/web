import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { deleteToolboxTalk } from "../actions";

type TalkRow = {
  id: string;
  talk_date: string;
  topic: string;
  presenter: string | null;
  attendees: string | null;
  attendee_count: number | null;
  notes: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: string;
};

const SAVED_MAP: Record<string, string> = {
  created: "Talk recorded — attach the signed sheet below.",
};

export default async function ToolboxTalkPage({
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

  const { data: talk } = await (
    supabase.from("toolbox_talks" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: TalkRow | null }>;
        };
      };
    }
  )
    .select(
      "id, talk_date, topic, presenter, attendees, attendee_count, notes, job_id, created_by, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!talk) notFound();

  const canDelete =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const staff = await listStaffForOrg();
  const loggerName = talk.created_by
    ? (staff.find((s) => s.id === talk.created_by)?.full_name ??
      staff.find((s) => s.id === talk.created_by)?.email ??
      null)
    : null;

  let jobName: string | null = null;
  if (talk.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("id", talk.job_id)
      .maybeSingle();
    jobName = job?.customer?.name ?? "Job";
  }

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link
          href="/toolbox"
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← Toolbox talks
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">{talk.topic}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {formatDiaryDate(talk.talk_date)}
          {jobName ? (
            <>
              {" · "}
              <Link href={`/jobs/${talk.job_id}`} className="hover:underline">
                {jobName}
              </Link>
            </>
          ) : null}
          {loggerName ? ` · recorded by ${loggerName}` : ""}
        </p>
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Delivered by</dt>
            <dd className="mt-0.5 text-slate-900">{talk.presenter ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Attended</dt>
            <dd className="mt-0.5 text-slate-900">
              {talk.attendee_count != null ? `${talk.attendee_count} people` : "—"}
            </dd>
          </div>
        </dl>
        <div className="mt-5 space-y-4 border-t border-slate-100 pt-4">
          <Field label="Who attended">{talk.attendees}</Field>
          <Field label="Notes">{talk.notes}</Field>
        </div>
      </section>

      {/* Signed attendance sheet + any photos — via the universal attachments
          pipeline (bucket: tenant-attachments). */}
      <AttachmentsPanel targetTable="toolbox_talks" targetId={talk.id} />

      {canDelete ? (
        <form action={deleteToolboxTalk.bind(null, talk.id)}>
          <button
            type="submit"
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete talk
          </button>
          <span className="ml-3 text-xs text-slate-500">
            A safety record is H&amp;S evidence — delete only genuine mistakes.
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
        <p className="mt-1 text-sm italic text-slate-400">—</p>
      )}
    </div>
  );
}
