"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { releaseFromQueueAction } from "./release-actions";
import type { ReleaseActionView } from "@/lib/receptionist/conversation-release-view";

/**
 * The CONVERSATION ATTENTION QUEUE SURFACE — the client RELEASE BUTTON (CEO Directive #018, R61: RELEASE FROM QUEUE).
 *
 * The mirror of R60's claim button on the other side of ownership: release a row you OWN without leaving the queue. The
 * page renders this button ONLY on rows the pure view marked `canRelease` (the rows the VIEWER holds, in "in progress");
 * an unowned row — or a row owned by someone else — offers no button at all. It performs NO write itself — its only
 * release path is the server action {@link releaseFromQueueAction}, which consumes the R50 runtime AND ONLY the R50
 * runtime (the SAME release capability the R50 pipeline exercises; R61 introduces no new mechanism). This component
 * opens no database client, names no ledger, and holds no organisation or operator identity of its own — both are
 * resolved server-side, from the session, by the action.
 *
 * IT TAKES ONLY THE COORDINATION ID — a primitive. It does NOT import the queue's view core, so the queue view core
 * stays consumed by the page alone; the button is a leaf affordance keyed by the one id the action needs.
 *
 * RELEASES ONLY WHAT THE VIEWER HOLDS, DISPLAYS CONFLICT CORRECTLY, REFRESHES. Because the button shows only on
 * `canRelease` (owned-by-viewer) rows, a row the operator does not hold is never releasable here — the queue neither
 * reassigns nor claims on another's behalf (both explicit R61 non-goals). When ownership changed underneath the viewer
 * (a race — released or transferred out in another tab), the action returns `not_owned`; the button shows that conflict
 * verbatim and then refreshes, so the queue settles on the present ownership. On success it refreshes too — together
 * with the action's queue revalidation, the released row re-reads as unowned and moves from "in progress" back into
 * "waiting to be picked up".
 *
 * IT INTRODUCES NO EXECUTION PATH: it releases (through the runtime) and refreshes the read — it assigns nothing,
 * dispatches nothing, notifies no one and executes no business action.
 */
export function AttentionQueueReleaseButton({ coordinationId }: { coordinationId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ReleaseActionView | null>(null);

  function onRelease() {
    start(async () => {
      // The ONE release path — the server action, which consumes the R50 runtime. Never a direct write.
      const view = await releaseFromQueueAction(coordinationId);
      setResult(view);
      // Re-read the queue: on success the row now reads as unowned (button gone); on a lost-ownership conflict it
      // settles on the present ownership. Paired with the action's queue revalidation.
      router.refresh();
    });
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onRelease}
        disabled={pending}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Releasing…" : "Release"}
      </button>
      {result ? <ResultNote result={result} /> : null}
    </div>
  );
}

/** The result of the last release attempt, styled by the pure view's tone — the SAME tone vocabulary R47's claim
 *  surface uses, so claim and release results read identically. */
function ResultNote({ result }: { result: ReleaseActionView }) {
  const cls =
    result.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : result.tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-red-200 bg-red-50 text-red-800";
  return (
    <p role="status" className={`mt-2 rounded-md border px-2 py-1 text-xs ${cls}`}>
      {result.message}
    </p>
  );
}
