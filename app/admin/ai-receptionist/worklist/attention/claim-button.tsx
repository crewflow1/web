"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimFromQueueAction } from "./claim-actions";
import type { ClaimActionView } from "@/lib/receptionist/conversation-claim-view";

/**
 * The CONVERSATION ATTENTION QUEUE SURFACE — the client CLAIM BUTTON (CEO Directive #018, R60: CLAIM FROM QUEUE).
 *
 * The ONE operator affordance R60 adds to the Attention Queue: claim an UNOWNED row's ownership without leaving the
 * queue. The page renders this button ONLY on rows the pure view marked `canClaim` (the unowned rows in "waiting to be
 * picked up"); an already-owned row offers no button at all. It performs NO write itself — its only claim path is the
 * server action {@link claimFromQueueAction}, which consumes the R46 runtime AND ONLY the R46 runtime (the SAME claim
 * capability the R47 detail surface reuses; R60 introduces no new mechanism). This component opens no database client,
 * names no ledger, and holds no organisation or operator identity of its own — both are resolved server-side, from the
 * session, by the action.
 *
 * IT TAKES ONLY THE COORDINATION ID — a primitive. It does NOT import the queue's view core, so the queue view core
 * stays consumed by the page alone; the button is a leaf affordance keyed by the one id the action needs.
 *
 * PREVENTS DUPLICATE CLAIMS, DISPLAYS CONFLICT CORRECTLY, REFRESHES. Because the button shows only on `canClaim`
 * (unowned) rows, an owned row is never claimable here — the queue neither reassigns nor releases (both explicit R60
 * non-goals). When two operators race, the loser's action returns `already_claimed`; the button shows that conflict
 * verbatim and then refreshes, so the queue settles with the row owned by the winner. On success it refreshes too —
 * together with the action's queue revalidation, the claimed row re-reads as owned and moves from "waiting to be picked
 * up" into "in progress".
 *
 * IT INTRODUCES NO EXECUTION PATH: it claims (through the runtime) and refreshes the read — it assigns nothing,
 * dispatches nothing, notifies no one and executes no business action.
 */
export function AttentionQueueClaimButton({ coordinationId }: { coordinationId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ClaimActionView | null>(null);

  function onClaim() {
    start(async () => {
      // The ONE claim path — the server action, which consumes the R46 runtime. Never a direct write.
      const view = await claimFromQueueAction(coordinationId);
      setResult(view);
      // Re-read the queue: on success the row now reads as owned (button gone); on a conflict it settles on the operator
      // who won the race. Paired with the action's queue revalidation.
      router.refresh();
    });
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onClaim}
        disabled={pending}
        className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Claiming…" : "Claim"}
      </button>
      {result ? <ResultNote result={result} /> : null}
    </div>
  );
}

/** The result of the last claim attempt, styled by the pure view's tone — the SAME projection the R47 surface uses. */
function ResultNote({ result }: { result: ClaimActionView }) {
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
