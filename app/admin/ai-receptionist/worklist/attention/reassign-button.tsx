"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reassignFromQueueAction } from "./reassign-actions";
import type {
  ReassignmentActionView,
  ReassignmentCandidate,
} from "@/lib/receptionist/conversation-reassignment-view";

/**
 * The CONVERSATION ATTENTION QUEUE SURFACE — the client REASSIGN CONTROL (CEO Directive #018, R62: REASSIGN FROM QUEUE).
 *
 * The third ownership affordance on the queue, alongside R60's claim and R61's release: transfer a row you OWN to another
 * authorised operator without leaving the queue. The page renders this control ONLY on rows the pure view marked
 * `canReassign` (the rows the VIEWER holds, in "in progress"); an unowned row — or a row owned by someone else — offers
 * no control at all. It performs NO write itself — its only reassignment path is the server action
 * {@link reassignFromQueueAction}, which consumes the R52 runtime AND ONLY the R52 runtime (the SAME reassignment
 * capability the R52 pipeline and R54 detail surface exercise; R62 introduces no new mechanism). This component opens no
 * database client, names no ledger, and holds no organisation or source-operator identity of its own — both are resolved
 * server-side, from the session, by the action.
 *
 * IT TAKES THE COORDINATION ID AND THE DESTINATION CANDIDATES — both primitives the page composed. The page reads the
 * org roster once and derives the candidate set (every authorised operator EXCEPT the viewer, who is the owner of every
 * `canReassign` row) with the pure `toReassignmentCandidates`, passing the SAME list to every owned row's control. This
 * control does NOT import the queue's view core, so the queue view core stays consumed by the page alone; it is a leaf
 * affordance keyed by the one id the action needs plus the destination options it renders. When the candidate set is
 * empty (no other operator exists to receive the item) it renders nothing — there is no one to transfer to.
 *
 * REASSIGNS ONLY WHAT THE VIEWER HOLDS, DISPLAYS CONFLICT CORRECTLY, REFRESHES. Because the control shows only on
 * `canReassign` (owned-by-viewer) rows, a row the operator does not hold is never reassignable here — the queue neither
 * claims nor releases on another's behalf, and it never auto-selects a destination (the operator picks it). When
 * ownership changed underneath the viewer (a race — released or transferred out in another tab), the action returns
 * `not_owned`; the control shows that conflict verbatim and then refreshes, so the queue settles on the present
 * ownership. On success it refreshes too — together with the action's queue revalidation, the transferred row re-reads
 * with its new owner and leaves the viewer's hands.
 *
 * IT INTRODUCES NO EXECUTION PATH: it reassigns (through the runtime) and refreshes the read — it assigns nobody
 * automatically, claims nothing, releases nothing, dispatches nothing, notifies no one, executes no business action, and
 * transfers exactly the one coordination named (no bulk path).
 */
export function AttentionQueueReassignButton({
  coordinationId,
  candidates,
}: {
  coordinationId: string;
  candidates: readonly ReassignmentCandidate[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ReassignmentActionView | null>(null);
  const [selected, setSelected] = useState<string>("");

  // No destination exists — there is no operator to transfer to, so the control offers nothing. (The pure view may still
  // mark the row `canReassign`; whether a DESTINATION exists is decided here, from the candidate set the page composed.)
  if (candidates.length === 0) return null;

  function onReassign() {
    if (!selected) return;
    start(async () => {
      // The ONE reassignment path — the server action, which consumes the R52 runtime. Never a direct write.
      const view = await reassignFromQueueAction({ coordinationId, toOperatorId: selected });
      setResult(view);
      setSelected("");
      // Re-read the queue: on success the row now shows its new owner (control gone for the old owner); on a lost-
      // ownership conflict it settles on the present ownership. Paired with the action's queue revalidation.
      router.refresh();
    });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select
        aria-label="Reassign to operator"
        value={selected}
        disabled={pending}
        onChange={(e) => {
          setSelected(e.target.value);
          setResult(null);
        }}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:border-slate-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">Reassign to…</option>
        {candidates.map((candidate) => (
          <option key={candidate.operatorId} value={candidate.operatorId}>
            {candidate.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onReassign}
        disabled={pending || !selected}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Reassigning…" : "Reassign"}
      </button>
      {result ? <ResultNote result={result} /> : null}
    </div>
  );
}

/** The result of the last reassignment attempt, styled by the pure view's tone — the SAME tone vocabulary R47's claim
 *  surface and R61's release surface use, so claim, release and reassign results read identically. */
function ResultNote({ result }: { result: ReassignmentActionView }) {
  const cls =
    result.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : result.tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-red-200 bg-red-50 text-red-800";
  return (
    <p role="status" className={`w-full rounded-md border px-2 py-1 text-xs ${cls}`}>
      {result.message}
    </p>
  );
}
