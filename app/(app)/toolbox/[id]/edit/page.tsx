import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateToolboxTalk } from "../../actions";
import { loadToolboxFormOptions } from "../../_form-options";
import { TalkForm } from "../../_talk-form";

/**
 * Edit a DRAFT toolbox talk. A delivered (issued) talk is frozen evidence — the DB
 * blocks the write and this page redirects to the read-only detail before the form
 * is ever shown, so the "editable" affordance never lies.
 */

type TalkRow = {
  id: string;
  status: string;
  talk_date: string;
  topic: string;
  key_points: string | null;
  location: string | null;
  job_id: string | null;
  risk_assessment_id: string | null;
  permit_to_work_id: string | null;
  presenter: string | null;
  ppe: string[] | null;
  attendees: string | null;
  attendee_count: number | null;
  notes: string | null;
};

export default async function EditToolboxTalkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: talk } = await (
    supabase.from("toolbox_talks" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: TalkRow | null }> };
        };
      };
    }
  )
    .select(
      "id, status, talk_date, topic, key_points, location, job_id, risk_assessment_id, permit_to_work_id, presenter, ppe, attendees, attendee_count, notes",
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (!talk) notFound();
  if (talk.status !== "draft") redirect(`/toolbox/${id}?error=not_editable`);

  const options = await loadToolboxFormOptions(ctx.org.id);
  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/toolbox" className="hover:text-slate-900">
          Toolbox talks
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/toolbox/${id}`} className="hover:text-slate-900">
          {talk.topic}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Edit</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Edit draft</h1>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <TalkForm action={updateToolboxTalk} options={options} defaults={talk} submitLabel="Save changes" cancelHref={`/toolbox/${id}`} />
    </div>
  );
}
