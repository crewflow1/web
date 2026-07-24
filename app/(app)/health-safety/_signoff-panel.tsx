import { acknowledgeSafetyDocument } from "./signoff-actions";
import { ackStatement, acknowledgementProgress, type AckSubjectType } from "@/lib/health-safety/acknowledgements";

type Ack = { id: string; user_id: string; acknowledged_at: string; signed_name: string; signer_name: string };

/**
 * Operative sign-off panel (shared by the RAMS + permit detail pages). Shows the
 * sign-off register and — if the current worker hasn't yet signed THIS issued
 * version — an explicit, non-dark-pattern acknowledgement form (typed-name
 * attestation). Version-anchored via `reference`. Server component: the form
 * posts a server action, no client JS needed.
 */
export function SignoffPanel({
  subjectType, subjectId, reference, acks, currentUserId, memberCount,
}: {
  subjectType: AckSubjectType;
  subjectId: string;
  reference: string;
  acks: Ack[];
  currentUserId: string;
  memberCount: number;
}) {
  const mine = acks.find((a) => a.user_id === currentUserId);
  const progress = acknowledgementProgress(acks, memberCount);
  const statement = ackStatement(subjectType, reference);

  return (
    <section aria-labelledby="signoff-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="signoff-heading" className="text-base font-semibold text-slate-900">Operative sign-off</h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
          {progress.signed} of {progress.expected} signed
        </span>
      </div>

      {acks.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No one has acknowledged this version yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {acks.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-sm">
              <span className="font-medium text-slate-800">{a.signer_name}</span>
              <span className="text-slate-500">signed “{a.signed_name}” · {a.acknowledged_at.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}

      {mine ? (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" role="status">
          ✓ You acknowledged this on {mine.acknowledged_at.slice(0, 10)}.
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
            className="min-h-[44px] rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800"
          >
            I have read and understood — sign
          </button>
        </form>
      )}
    </section>
  );
}
