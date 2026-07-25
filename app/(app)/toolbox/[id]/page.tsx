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
import { deleteToolboxTalk, issueToolboxTalk, withdrawToolboxTalk } from "../actions";

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
};
const ERROR_MAP: Record<string, string> = {
  not_editable: "That talk has been delivered — it's frozen evidence and can't be edited.",
  not_deletable: "Only a draft can be deleted. Withdraw a delivered talk instead.",
  not_found: "That talk no longer exists.",
  numbering_failed: "Couldn't allocate a reference. Try again.",
  forbidden: "Only an owner or admin can do that.",
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
        eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: TalkRow | null }> };
      };
    }
  )
    .select(
      "id, status, reference, revision_number, root_toolbox_talk_id, talk_date, topic, key_points, location, presenter, ppe, attendees, attendee_count, notes, job_id, risk_assessment_id, permit_to_work_id, created_by, issued_by, issued_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!talk) notFound();

  // --- Operative sign-off (M2) — Tier A: authenticated acknowledgements against the
  // crew rota'd to this talk's job. Only a delivered (issued) talk is acknowledgeable;
  // the same reads power the manager's completion view. Parallel (mobile-latency).
  const isIssued = talk.status === "issued";
  const [acks, required, priorSignoff] = await Promise.all([
    isIssued ? listAcknowledgements("toolbox_talk", talk.id) : Promise.resolve([]),
    isIssued ? requiredOperatives(talk.job_id) : Promise.resolve([]),
    isIssued && (talk.revision_number ?? 1) > 1 && talk.root_toolbox_talk_id
      ? priorRevisionSignoff(talk.root_toolbox_talk_id, talk.revision_number ?? 1, user.id, TOOLBOX_REVISABLE)
      : Promise.resolve(null),
  ]);
  const signoff = summariseSignoff(required.map((o) => o.id), acks.map((a) => a.user_id));
  const outstanding = required.filter((o) => signoff.outstanding.includes(o.id));

  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const editable = isEditable(talk.status);
  const gate = canIssue({ status: talk.status, topic: talk.topic, key_points: talk.key_points });
  const meta = TOOLBOX_TALK_STATUS_META[talk.status];

  const staff = await listStaffForOrg();
  const nameOf = (uid: string | null) =>
    uid ? (staff.find((s) => s.id === uid)?.full_name ?? staff.find((s) => s.id === uid)?.email ?? null) : null;

  let jobName: string | null = null;
  if (talk.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("id", talk.job_id)
      .maybeSingle();
    jobName = job?.customer?.name ?? "Job";
  }

  const [rams, permit] = await Promise.all([
    talk.risk_assessment_id ? loadDocLabel(supabase, "risk_assessments", talk.risk_assessment_id) : Promise.resolve(null),
    talk.permit_to_work_id ? loadDocLabel(supabase, "permits_to_work", talk.permit_to_work_id) : Promise.resolve(null),
  ]);

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
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Edit
              </Link>
              <form action={issueToolboxTalk}>
                <input type="hidden" name="id" value={talk.id} />
                <button
                  type="submit"
                  disabled={!gate.ok}
                  className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Deliver talk
                </button>
              </form>
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
          isCurrent={talk.status === "issued"}
          acks={acks}
          currentUserId={user.id}
          summary={signoff}
          outstanding={outstanding}
          priorSignoff={priorSignoff}
        />
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
        {/* Signed attendance sheet + site photos — universal attachments pipeline. */}
        <div className="mt-4">
          <AttachmentsPanel targetTable="toolbox_talks" targetId={talk.id} />
        </div>
      </section>

      {/* Lifecycle actions. */}
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
        <p className="mt-1 text-sm italic text-slate-400">—</p>
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
