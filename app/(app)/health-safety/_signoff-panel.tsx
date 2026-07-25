import { acknowledgeSafetyDocument } from "./signoff-actions";
import type { PriorSignoff } from "./_signoff-data";
import {
  ackStatement,
  SIGNOFF_STATE_LABEL,
  type AckSubjectType,
  type SignoffSummary,
} from "@/lib/health-safety/acknowledgements";

type Ack = { id: string; user_id: string; acknowledged_at: string; signed_name: string; signer_name: string };
type Outstanding = { id: string; name: string };

/**
 * Operative sign-off panel (shared by the RAMS + permit detail pages). Field-first
 * (M6c): a compact "You are signing" identity header (what/reference/revision/whether
 * current), a re-acknowledgement prompt when the worker signed an EARLIER revision, the
 * status against the required operatives, the outstanding workers as a scannable list,
 * and — if the current worker hasn't signed THIS version — a typed-name attestation.
 * Version-anchored via `reference`. Server component; the form posts a server action.
 */

const STATE_STYLES: Record<SignoffSummary["state"], string> = {
  fully_signed: "bg-emerald-100 text-emerald-800",
  partially_signed: "bg-amber-100 text-amber-800",
  unsigned: "bg-red-100 text-red-800",
  not_tracked: "bg-slate-100 text-slate-600",
};

export function SignoffPanel({
  subjectType, subjectId, reference, docTitle, revisionLabel, isCurrent,
  acks, currentUserId, summary, outstanding, priorSignoff, pdfHref,
}: {
  subjectType: AckSubjectType;
  subjectId: string;
  reference: string;
  docTitle: string;
  revisionLabel?: string | null;
  isCurrent: boolean;
  acks: Ack[];
  currentUserId: string;
  summary: SignoffSummary;
  outstanding: Outstanding[];
  priorSignoff?: PriorSignoff | null;
  pdfHref?: string;
}) {
  const mine = acks.find((a) => a.user_id === currentUserId);
  const statement = ackStatement(subjectType, reference);
  // Re-acknowledge prompt: the worker signed an earlier revision but not this one.
  const needsReAck = !mine && priorSignoff != null;

  return (
    <section aria-labelledby="signoff-heading" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="signoff-heading" className="text-base font-semibold text-slate-900">Operative sign-off</h2>
        <div className="flex items-center gap-2">
          {pdfHref ? (
            <a
              href={pdfHref} target="_blank" rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <span aria-hidden>⤓ </span>Download PDF<span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLES[summary.state]}`}>
            {SIGNOFF_STATE_LABEL[summary.state]}
            {summary.state !== "not_tracked" ? ` · ${summary.signedRequired}/${summary.required}` : ""}
          </span>
        </div>
      </div>

      {/* Identity anchor: what is being signed, which version, and whether it is current. */}
      <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
        <p className="font-medium text-slate-900">{docTitle}</p>
        <p className="mt-0.5 text-slate-600">
          <span className="font-mono">{reference}</span>
          {revisionLabel ? <> · {revisionLabel}</> : null}
          {" · "}
          {isCurrent
            ? <span className="font-medium text-emerald-700">Current version</span>
            : <span className="font-medium text-amber-700">Not the current version</span>}
        </p>
      </div>

      {needsReAck ? (
        <div role="status" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="font-semibold">Re-acknowledgement needed.</span>{" "}
          You acknowledged {priorSignoff!.reference ?? "an earlier revision"} (Revision {priorSignoff!.revisionNumber})
          on {priorSignoff!.acknowledgedAt.slice(0, 10)}. This is an updated revision — please read it and sign again below.
        </div>
      ) : null}

      {/* Required-operative denominator (or an honest "not tracked"). */}
      <p className="mt-2 text-xs text-slate-500" aria-live="polite">
        {summary.state === "not_tracked" ? (
          <>
            {acks.length} signed. No crew is assigned to this document&rsquo;s job, so there is
            no required-operative list — link it to a job to track who must sign.
          </>
        ) : (
          <>
            {summary.signedRequired} of {summary.required} assigned operative
            {summary.required === 1 ? "" : "s"} have acknowledged the current version
            {summary.extraSigned > 0 ? ` (+${summary.extraSigned} other${summary.extraSigned === 1 ? "" : "s"})` : ""}.
          </>
        )}
      </p>

      {outstanding.length > 0 ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p className="font-semibold">Awaiting sign-off ({outstanding.length}):</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {outstanding.map((o) => (
              <li key={o.id} className="rounded-full bg-white/70 px-2 py-0.5 font-medium">{o.name}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {acks.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No one has acknowledged this version yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {acks.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-sm">
              <span className="font-medium text-slate-800">{a.signer_name}</span>
              <span className="text-slate-500">signed &ldquo;{a.signed_name}&rdquo; · {a.acknowledged_at.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}

      {mine ? (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" role="status">
          <span aria-hidden>✓ </span>You acknowledged this on {mine.acknowledged_at.slice(0, 10)}.
        </p>
      ) : (
        <form action={acknowledgeSafetyDocument} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <input type="hidden" name="subjectType" value={subjectType} />
          <input type="hidden" name="subjectId" value={subjectId} />
          <input type="hidden" name="subjectVersion" value={reference} />
          <p className="text-sm text-slate-700">{statement}</p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Type your full name to sign</span>
            <input
              name="signedName" required minLength={2} maxLength={120} autoComplete="name"
              placeholder="e.g. Jordan Smith"
              className="min-h-[44px] w-full max-w-sm rounded-md border border-slate-300 px-3 text-sm"
            />
          </label>
          <button
            type="submit"
            className="min-h-[44px] w-full rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
          >
            I have read and understood — sign
          </button>
        </form>
      )}
    </section>
  );
}
