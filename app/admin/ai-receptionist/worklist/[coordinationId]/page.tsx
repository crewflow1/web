import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { getCoordinationById } from "@/server/services/receptionist-coordination-view";
import { getClaimForCoordination } from "@/server/services/receptionist-claim-view";
import { projectClaimOwnership } from "@/lib/receptionist/conversation-claim-view";
import {
  projectCoordinationDetail,
  type CoordinationDetailView,
  type CoordinationHeadlineView,
  type DetailSection,
  type DetailField,
  type TimelineStep,
} from "./detail-view";
import { ClaimPanel } from "./claim-panel";

/**
 * /admin/ai-receptionist/worklist/[coordinationId] — the CONVERSATION WORKLIST DETAIL SURFACE
 * (Directive #018, R45: CONVERSATION WORKLIST DETAIL SURFACE).
 *
 * The single authorised read-only INSPECTION surface for ONE Conversation Worklist item. Where R44's
 * operator surface lists the worklists, this surface opens a single coordinated conversation and shows
 * the WHOLE work item: the recorded coordination decision, its expected booking, its causal timeline
 * (fulfilment → verification → recovery → resolution → lifecycle → orchestration → coordination), the
 * six linked per-engine contexts in full, and the provenance chain — a complete inspection of what the
 * receptionist decided and how it got there.
 *
 * IT CONSUMES ONLY THE AUTHORISED STACKS. Its READ paths are the two authorised read seams — the R37
 * Coordination Read Model's single-item seam {@link getCoordinationById} for the coordination, and the
 * R47 ownership reader {@link getClaimForCoordination} for the current claim — and its ONE WRITE path is
 * the R46 runtime, reached ONLY through the {@link ClaimPanel}'s `claimWorkItemAction` server action. It
 * opens no database client, names no ledger and no write primitive, and reaches around no layer. The R37
 * read model stays the authoritative single source of a recorded coordination; behind it the Coordination
 * Engine (and Lifecycle, Resolution, Recovery, Verification, Fulfilment, Orchestration) stay authoritative
 * over every fact; and the R46 runtime stays the sole authority over recording a claim. This surface adds
 * pixels and a SINGLE claim affordance — not a second read path, not a second write path, and not a
 * decision.
 *
 * ORGANISATION ISOLATION IS PRESERVED. Auth is the EXISTING HQ gate (`requireHqPage`); the organisation
 * the read AND the claim are scoped to is resolved ONLY from the session (`requireOrgContext` →
 * `ctx.org.id`), exactly as the R40 API resolves it — never from the URL. The coordination id comes from
 * the path, but the read is org-scoped, so a coordination id belonging to ANOTHER organisation resolves to
 * null and renders a 404: a caller can only ever inspect a coordination that belongs to the organisation
 * their session resolves to. The claim action re-resolves the org the same way, and the R46 runtime's
 * storage guard refuses any coordination not recorded in that org — so a claim can never cross a tenant
 * boundary either.
 *
 * IT OFFERS EXACTLY ONE OPERATOR ACTION — CLAIM OWNERSHIP — AND NOTHING ELSE. Beyond the read it displays
 * the current owner and, ONLY when the item is unclaimed, a single Claim button. That button's only path
 * is the R46 runtime (`claimConversationWork`), through the server action — the surface cannot bypass the
 * runtime. It does NOT assign, reassign, release, dispatch, notify, schedule, fulfil or execute any work —
 * every one an explicit R47 non-goal. The claim it records lands in R46's append-only ledger through the
 * runtime; this surface introduces no second write path and no execution path.
 */

type Params = Promise<{ coordinationId: string }>;

export default async function HqReceptionistWorklistDetailPage({
  params,
}: {
  params: Params;
}) {
  // The EXISTING HQ gate authenticates the operator; the org is resolved from the SESSION (never the URL),
  // exactly as the R40 API does — so the reads below can only be scoped to the caller's org. The gate's
  // user is the VIEWER whose ownership view the claim panel is projected for (drives "You hold this claim").
  const user = await requireHqPage();
  const { ctx } = await requireOrgContext();
  const { coordinationId } = await params;

  // The coordination read — the R37 read model's org-scoped single-item seam. A coordination that does not
  // belong to this organisation resolves to null and 404s: organisation isolation, structurally.
  const record = await getCoordinationById({
    org_id: ctx.org.id,
    coordination_id: coordinationId,
  });
  if (!record) notFound();

  const detail = projectCoordinationDetail(record);

  // The ownership read — the R47 org-scoped claim reader. Returns the current claim on this item, or null
  // when unclaimed; projected (with the viewer's id) into the ownership view the claim panel renders.
  const owner = await getClaimForCoordination({
    org_id: ctx.org.id,
    coordination_id: coordinationId,
  });
  const ownership = projectClaimOwnership({ owner, viewerOperatorId: user.id });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <Link href="/admin/ai-receptionist/worklist" className="hover:text-slate-900">
          Conversation worklist
        </Link>
        <span aria-hidden>/</span>
        <span className="font-mono text-slate-900">{detail.coordinationId.slice(0, 8)}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{detail.headline.title}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Inspect one coordinated conversation — the recorded decision, its timeline and its linked
            context — and claim ownership of it. Claiming records who owns the item; no other action
            follows.
          </p>
        </div>
        <span className="inline-flex rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">
          {detail.headline.status}
        </span>
      </header>

      <ClaimPanel coordinationId={detail.coordinationId} ownership={ownership} />

      {ownership.claimed ? (
        <div className="text-sm">
          <Link
            href={`/admin/ai-receptionist/worklist/${detail.coordinationId}/reassign`}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            Reassign ownership →
          </Link>
        </div>
      ) : null}

      <Metadata detail={detail} />

      <Headline headline={detail.headline} />

      <Booking booking={detail.booking} />

      <Timeline steps={detail.timeline} />

      <div className="grid gap-4 md:grid-cols-2">
        {detail.sections.map((section) => (
          <SectionCard key={section.key} section={section} />
        ))}
      </div>

      <Provenance fields={detail.provenance} />
    </div>
  );
}

/** The conversation reference + correlation — the item's identity within the coordinated conversation. */
function Metadata({ detail }: { detail: CoordinationDetailView }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Conversation</h2>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <Field label="Coordination id" value={detail.coordinationId} mono />
        <Field label="Conversation id" value={detail.conversationId ?? "—"} mono />
        <Field label="Correlation id" value={detail.correlationId} mono />
      </dl>
    </section>
  );
}

/** The recorded coordination decision — the complete work item, humanised. */
function Headline({ headline }: { headline: CoordinationHeadlineView }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Coordination details</h2>
        {headline.requiresHuman ? (
          <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            Human review required
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
            Autonomous
          </span>
        )}
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Type" value={headline.type} />
        <Field label="Outcome" value={headline.outcome} />
        <Field label="Mode" value={headline.mode} />
        <Field label="Lead participant" value={headline.leadParticipant} />
        <Field label="Participants" value={String(headline.participantCount)} />
        <Field label="Orchestration route" value={headline.orchestrationRoute} />
        <Field label="Lifecycle state" value={headline.lifecycleState} />
        <Field label="Approval state" value={headline.approvalState} />
        <Field label="Requires human" value={headline.requiresHuman ? "Yes" : "No"} />
        <Field label="Autonomous" value={headline.autonomous ? "Yes" : "No"} />
        <Field label="Status" value={headline.status} />
        <Field label="Recorded" value={headline.at} />
      </dl>
    </section>
  );
}

/** The expected booking the coordination concerns — carried through from the recorded decision. */
function Booking({ booking }: { booking: CoordinationDetailView["booking"] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Booking</h2>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <Field label="Job type" value={booking.jobType} />
        <Field label="Postcode" value={booking.postcode} />
        <Field label="Phone" value={booking.phone} mono />
      </dl>
    </section>
  );
}

/** The causal timeline — the linked engine contexts oldest-first, ending in the coordination itself. */
function Timeline({ steps }: { steps: readonly TimelineStep[] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Timeline</h2>
      <p className="mt-1 text-xs text-slate-500">
        The recorded chain of engine decisions that led to this coordination, oldest first.
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((step) => (
          <li key={step.key} className="flex gap-3">
            <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-400" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">
                {step.label}
                <span className="ml-2 text-xs font-normal text-slate-500">{step.at}</span>
              </p>
              <p className="text-xs text-slate-600">
                {step.type} · {step.outcome} · {step.status}
              </p>
              <p className="truncate font-mono text-[11px] text-slate-400">{step.reference}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One linked per-engine context, or an explicit "not recorded" note when the context was absent. */
function SectionCard({ section }: { section: DetailSection }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">{section.title}</h2>
      {section.present ? (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          {section.fields.map((field) => (
            <Field key={field.label} label={field.label} value={field.value} />
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-slate-500">Not recorded for this coordination.</p>
      )}
    </section>
  );
}

/** The full provenance chain — every ledger id the coordination was threaded to. */
function Provenance({ fields }: { fields: readonly DetailField[] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Provenance</h2>
      <p className="mt-1 text-xs text-slate-500">
        The linked identifiers this coordination was recorded against, for audit and cross-reference.
      </p>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => (
          <Field key={field.label} label={field.label} value={field.value} mono />
        ))}
      </dl>
    </section>
  );
}

/** One labelled value in a detail grid — presentation only; the value is the projection's. */
function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={mono ? "mt-0.5 truncate font-mono text-xs text-slate-900" : "mt-0.5 text-sm text-slate-900"}>
        {value}
      </dd>
    </div>
  );
}
