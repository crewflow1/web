import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import {
  TOOLBOX_TALK_STATUS_META,
  canIssue,
  isEditable,
  type ToolboxTalkStatus,
} from "@/lib/health-safety/toolbox-talks";
import { SignoffPanel } from "../../health-safety/_signoff-panel";
import { listAcknowledgements, requiredOperatives, priorRevisionSignoff } from "../../health-safety/_signoff-data";
import { summariseSignoff, TOOLBOX_REVISABLE } from "@/lib/health-safety/acknowledgements";
import {
  createToolboxTalkRevision,
  deleteToolboxTalk,
  issueToolboxTalk,
  issueToolboxTalkRevision,
  withdrawToolboxTalk,
} from "../actions";

type TalkRow = {
  id: string;
  status: ToolboxTalkStatus;
  reference: string | null;
  revision_number: number | null;
  root_toolbox_talk_id: string | null;
  talk_date: string;
  topic: string;
  key_points: string | null;
  location: string | null;
  presenter: string | null;
  ppe: string[] | null;
  attendees: string | null;
  attendee_count: number | null;
  notes: string | null;
  job_id: string | null;
  risk_assessment_id: string | null;
  permit_to_work_id: string | null;
  created_by: string | null;
  issued_by: string | null;
  issued_at: string | null;
  created_at: string;
};

const SAVED_MAP: Record<string, string> = {
  created: "Draft saved — add the key points, then deliver it.",
  updated: "Draft updated.",
  issued: "Talk delivered — it's now frozen evidence with a reference.",
  withdrawn: "Talk withdrawn.",
  acknowledged: "Acknowledgement recorded — thank you.",
  revision_created: "Revision draft created from the delivered talk. Edit it, then deliver — delivering supersedes the previous version and re-opens acknowledgement.",
};
const ERROR_MAP: Record<string, string> = {
  not_editable: "That talk has been delivered — it's frozen evidence and can't be edited.",
  not_deletable: "Only a draft can be deleted. Withdraw a delivered talk instead.",
  not_found: "That talk no longer exists.",
  numbering_failed: "Couldn't allocate a reference. Try again.",
  numbering_clash: "Another talk took that reference just now — deliver again to get the next one.",
  forbidden: "Only an owner or admin can do that.",
  only_issued_can_be_revised: "Only a delivered talk can be revised.",
  revision_in_progress: "A revision of this talk is already in progress — deliver or delete that draft first.",
  no_origin_revision: "Couldn't find the original delivered version to number against.",
  use_revision_flow: "This is a revision — deliver it using the revision flow.",
  bad_transition: "That change isn't allowed for this talk.",
  bad_id: "That link looks invalid.",
  delete_failed: "Couldn't delete the draft. Try again.",
  issue_failed: "Couldn't deliver the revision. Try again.",
};

export default async function ToolboxTalkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx, user } = await requireOrgContext();
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
      "id, status, reference, revision_number, root_toolbox_talk_id, talk_date, topic, key_points, location, presenter, ppe, attendees, attendee_count, notes, job_id, risk_assessment_id, permit_to_work_id, created_by, issued_by, issued_at, created_at",
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (!talk) notFound();

  // Pure, no-I/O scalars first.
  const isIssued = talk.status === "issued";
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const editable = isEditable(talk.status);
  const gate = canIssue({ status: talk.status, topic: talk.topic, key_points: talk.key_points });
  const meta = TOOLBOX_TALK_STATUS_META[talk.status];
  const isRevisionDraft = (talk.revision_number ?? 1) > 1;
  const issueAction = isRevisionDraft ? issueToolboxTalkRevision : issueToolboxTalk;
  // First delivery (rev 1) is open to a foreman; delivering a REVISION is an owner/admin
  // action (matches the server action + DB gate) — don't offer a button that will 403.
  const canDeliver = !isRevisionDraft || isAdmin;

  // Every downstream read depends only on `talk` (or nothing), so run them in ONE
  // parallel batch rather than a serial waterfall (M7 perf — ~5 RTTs → 1 on mobile):
  // Tier-A acks + required crew (issued only), the re-ack prompt, the revision series,
  // the org staff (for display names), the job name, and the linked RAMS/permit labels.
  const [acks, required, priorSignoff, siblings, staff, jobRow, rams, permit] = await Promise.all([
    isIssued ? listAcknowledgements("toolbox_talk", talk.id) : Promise.resolve([]),
    isIssued ? requiredOperatives(talk.job_id) : Promise.resolve([]),
    isIssued && isRevisionDraft && talk.root_toolbox_talk_id
      ? priorRevisionSignoff(talk.root_toolbox_talk_id, talk.revision_number ?? 1, user.id, TOOLBOX_REVISABLE)
      : Promise.resolve(null),
    loadRevisionSeries(supabase, talk.root_toolbox_talk_id ?? talk.id),
    listStaffForOrg(ctx.org.id),
    talk.job_id
      ? supabase.from("jobs").select("id, customer:customers ( name )").eq("id", talk.job_id).maybeSingle()
      : Promise.resolve({ data: null as { customer?: { name?: string | null } | null } | null }),
    talk.risk_assessment_id ? loadDocLabel(supabase, "risk_assessments", talk.risk_assessment_id) : Promise.resolve(null),
    talk.permit_to_work_id ? loadDocLabel(supabase, "permits_to_work", talk.permit_to_work_id) : Promise.resolve(null),
  ]);

  const signoff = summariseSignoff(required.map((o) => o.id), acks.map((a) => a.user_id));
  const outstanding = required.filter((o) => signoff.outstanding.includes(o.id));
  const currentIssued = siblings.find((s) => s.status === "issued") ?? null;
  const isCurrentIssued = talk.status === "issued" && currentIssued?.id === talk.id;
  const nameOf = (uid: string | null) =>
    uid ? (staff.find((s) => s.id === uid)?.full_name ?? staff.find((s) => s.id === uid)?.email ?? null) : null;
  const jobName = talk.job_id ? (jobRow?.data?.customer?.name ?? "Job") : null;

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link
          href="/toolbox"
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← Toolbox talks
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">{talk.topic}</h1>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.tone}`}>{meta.label}</span>
          {talk.reference ? <span className="font-mono text-sm text-slate-500">{talk.reference}</span> : null}
        </div>
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
          {talk.presenter ? ` · delivered by ${talk.presenter}` : ""}
        </p>
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      {/* Deliver (issue) panel — drafts only. */}
      {editable ? (
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Ready to deliver?</h2>
              <p className="mt-0.5 text-xs text-slate-600">
                Delivering freezes the talk as evidence and gives it a reference. It can&rsquo;t be edited afterwards.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href={`/toolbox/${talk.id}/edit`}
                className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Edit
              </Link>
              {canDeliver ? (
                <form action={issueAction}>
                  <input type="hidden" name="id" value={talk.id} />
                  <button
                    type="submit"
                    disabled={!gate.ok}
                    className="inline-flex min-h-[44px] items-center rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isRevisionDraft ? "Deliver revision" : "Deliver talk"}
                  </button>
                </form>
              ) : (
                <span className="text-xs text-slate-500">Only an owner or admin can deliver a revision.</span>
              )}
            </div>
          </div>
          {!gate.ok ? (
            <ul className="mt-3 space-y-1 border-t border-slate-200 pt-3 text-xs text-amber-800">
              {gate.reasons.map((r) => (
                <li key={r}>• {r}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <Field label="Key points briefed">{talk.key_points}</Field>
        <dl className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
          <Meta label="Location / area">{talk.location ?? "—"}</Meta>
          <Meta label="Attended">{talk.attendee_count != null ? `${talk.attendee_count} people` : "—"}</Meta>
          <Meta label="PPE required">{talk.ppe && talk.ppe.length ? talk.ppe.join(", ") : "—"}</Meta>
          <Meta label="Linked RAMS">
            {rams ? (
              <Link href={`/health-safety/${talk.risk_assessment_id}`} className="text-slate-900 hover:underline">
                {rams}
              </Link>
            ) : (
              "—"
            )}
          </Meta>
          <Meta label="Linked permit">
            {permit ? (
              <Link href={`/health-safety/permits/${talk.permit_to_work_id}`} className="text-slate-900 hover:underline">
                {permit}
              </Link>
            ) : (
              "—"
            )}
          </Meta>
          {talk.status === "issued" || talk.status === "superseded" || talk.status === "withdrawn" ? (
            <Meta label="Delivered">
              {talk.issued_at ? `${formatDiaryDate(talk.issued_at.slice(0, 10))}${nameOf(talk.issued_by) ? ` · ${nameOf(talk.issued_by)}` : ""}` : "—"}
            </Meta>
          ) : null}
        </dl>
        <div className="space-y-4 border-t border-slate-100 pt-4">
          <Field label="Notes">{talk.notes}</Field>
        </div>
      </section>

      {/* Tier A — authenticated CrewFlow acknowledgements (issued talks only). */}
      {isIssued ? (
        <SignoffPanel
          subjectType="toolbox_talk"
          subjectId={talk.id}
          reference={talk.reference ?? ""}
          docTitle={talk.topic}
          revisionLabel={(talk.revision_number ?? 1) > 1 ? `Revision ${talk.revision_number}` : null}
          isCurrent={isCurrentIssued}
          acks={acks}
          currentUserId={user.id}
          summary={signoff}
          outstanding={outstanding}
          priorSignoff={priorSignoff}
          pdfHref={`/api/health-safety/toolbox-talks/${talk.id}/pdf`}
        />
      ) : null}

      {/* A delivered-but-superseded/withdrawn talk keeps its evidence PDF (the panel
          above only renders for the current issued revision). */}
      {!isIssued && talk.status !== "draft" ? (
        <a
          href={`/api/health-safety/toolbox-talks/${talk.id}/pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          <span aria-hidden>⤓ </span>Download evidence PDF<span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}

      {/* Tier B — recorded (manual/paper) attendance. Deliberately SEPARATE from the
          authenticated acknowledgements above and never counted toward N-of-M: these
          are names written down or a photographed sign-off sheet, not CrewFlow-verified
          identities. The honesty rule (attendance ≠ authenticated acknowledgement). */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Recorded attendance</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Manual record for anyone not signing in CrewFlow — external or subcontract attendees, or a paper
          sign-off sheet. Not counted as an authenticated acknowledgement above.
        </p>
        <div className="mt-4">
          <Field label="Who attended (names / trades)">{talk.attendees}</Field>
        </div>
        {/* Signed attendance sheet + site photos — universal attachments pipeline.
            Once the talk is delivered the evidence is frozen (append-only): the DB
            attachment-freeze trigger + the panel's `frozen` UX both enforce it. */}
        <div className="mt-4">
          <AttachmentsPanel targetTable="toolbox_talks" targetId={talk.id} frozen={talk.status !== "draft"} />
        </div>
      </section>

      {/* Revision series (M3) — the full lineage, current marked, historical accessible. */}
      {siblings.length > 1 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Revisions</h2>
          <ul className="mt-3 divide-y divide-slate-100">
            {siblings.map((s) => {
              const sMeta = TOOLBOX_TALK_STATUS_META[s.status] ?? TOOLBOX_TALK_STATUS_META.draft;
              const isThis = s.id === talk.id;
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-slate-800">Revision {s.revision_number}</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${sMeta.tone}`}>{sMeta.label}</span>
                    {s.reference ? <span className="font-mono text-xs text-slate-500">{s.reference}</span> : null}
                  </span>
                  {isThis ? (
                    <span className="text-xs font-medium text-slate-500">Viewing</span>
                  ) : (
                    <Link href={`/toolbox/${s.id}`} className="text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline">
                      Open
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          {!isCurrentIssued && currentIssued && currentIssued.id !== talk.id ? (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This isn&rsquo;t the current version.{" "}
              <Link href={`/toolbox/${currentIssued.id}`} className="font-semibold hover:underline">
                Open the current revision ({currentIssued.reference ?? `Revision ${currentIssued.revision_number}`})
              </Link>
              .
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Lifecycle actions. */}
      {isCurrentIssued && isAdmin ? (
        <form action={createToolboxTalkRevision}>
          <input type="hidden" name="id" value={talk.id} />
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Create revision
          </button>
          <span className="ml-3 text-xs text-slate-500">
            Re-briefed the crew? Raise a revision — delivering it supersedes this version and re-opens acknowledgement.
          </span>
        </form>
      ) : null}
      {editable && isAdmin ? (
        <form action={deleteToolboxTalk.bind(null, talk.id)}>
          <button
            type="submit"
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete draft
          </button>
          <span className="ml-3 text-xs text-slate-500">Only a draft can be deleted.</span>
        </form>
      ) : null}
      {talk.status === "issued" && isAdmin ? (
        <form action={withdrawToolboxTalk}>
          <input type="hidden" name="id" value={talk.id} />
          <button
            type="submit"
            className="rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-50"
          >
            Withdraw talk
          </button>
          <span className="ml-3 text-xs text-slate-500">
            Withdrawing keeps the record but marks it no longer current. The evidence is never deleted.
          </span>
        </form>
      ) : null}
    </div>
  );
}

type SiblingRow = { id: string; status: ToolboxTalkStatus; revision_number: number; reference: string | null };
async function loadRevisionSeries(supabase: unknown, rootId: string): Promise<SiblingRow[]> {
  const { data } = await (
    supabase as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  )
    .from("toolbox_talks")
    .select("id, status, revision_number, reference")
    .eq("root_toolbox_talk_id", rootId)
    .order("revision_number", { ascending: false });
  return (data ?? []) as SiblingRow[];
}

async function loadDocLabel(supabase: unknown, table: string, id: string): Promise<string | null> {
  const { data } = await (
    supabase as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  )
    .from(table)
    .select("id, reference, title")
    .eq("id", id)
    .maybeSingle();
  const r = data as { reference?: string | null; title?: string | null } | null;
  if (!r) return null;
  return [r.reference, r.title].filter((s): s is string => !!s).join(" · ") || null;
}

function Field({ label, children }: { label: string; children: string | null }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {children ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{children}</p>
      ) : (
        <p className="mt-1 text-sm italic text-slate-500">—</p>
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  );
}
