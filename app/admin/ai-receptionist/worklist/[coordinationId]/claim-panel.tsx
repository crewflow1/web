"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimWorkItemAction } from "./claim-actions";
import type { ClaimOwnershipView, ClaimActionView } from "@/lib/receptionist/conversation-claim-view";

/**
 * The CONVERSATION WORK CLAIM SURFACE — the client CLAIM PANEL (CEO Directive #018, R47: CONVERSATION WORK CLAIM
 * SURFACE).
 *
 * The ONE operator affordance the Detail Surface offers: claim ownership of this Conversation Worklist item. It renders
 * the current OWNERSHIP (the pure `ClaimOwnershipView` the page projected) and, ONLY when the item is unclaimed, a
 * single Claim button. It performs NO write itself — its only claim path is the server action {@link claimWorkItemAction},
 * which consumes the R46 runtime and nothing else. This component opens no database client, names no ledger, and holds
 * no organisation or operator identity of its own (both are resolved server-side, from the session, by the action).
 *
 * PREVENTS DUPLICATE CLAIMS, DISPLAYS "ALREADY CLAIMED" CORRECTLY. The Claim button appears ONLY when `canClaim` — i.e.
 * the item is unclaimed — so an already-owned item offers no claim affordance (the surface neither reassigns nor
 * releases; both are explicit non-goals). When two operators race, the loser's action returns `already_claimed`; the
 * panel shows that conflict verbatim and then refreshes, so the display settles on the winning owner. On success it
 * refreshes too, so the ownership display re-reads the recorded claim.
 *
 * IT INTRODUCES NO EXECUTION PATH: it claims (through the runtime) and refreshes the read — it assigns nothing,
 * dispatches nothing and notifies no one.
 */
export function ClaimPanel({
  coordinationId,
  ownership,
}: {
  coordinationId: string;
  ownership: ClaimOwnershipView;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ClaimActionView | null>(null);

  function onClaim() {
    start(async () => {
      // The ONE claim path — the server action, which consumes the R46 runtime. Never a direct write.
      const view = await claimWorkItemAction(coordinationId);
      setResult(view);
      // Re-read the ownership display: on success it now shows the viewer as owner (button gone); on a conflict it
      // settles on the operator who won the race.
      router.refresh();
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Ownership</h2>
        <OwnershipBadge ownership={ownership} />
      </div>

      <p className="mt-2 text-sm text-slate-600">{ownership.summary}</p>

      {ownership.claimed ? (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Owner</dt>
            <dd className="mt-0.5 text-sm text-slate-900">{ownership.ownerLabel ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Claimed at</dt>
            <dd className="mt-0.5 text-sm text-slate-900">
              {ownership.claimedAt ? ownership.claimedAt.slice(0, 16).replace("T", " ") : "—"}
            </dd>
          </div>
        </dl>
      ) : null}

      {ownership.canClaim ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={onClaim}
            disabled={pending}
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Claiming…" : "Claim this item"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Claiming records that you have taken ownership of this coordinated conversation. It records ownership
            only — no other action follows.
          </p>
        </div>
      ) : null}

      {result ? <ResultNote result={result} /> : null}
    </section>
  );
}

/** A pill naming the ownership state — "You hold this" / "Claimed" / "Unclaimed". Presentation only. */
function OwnershipBadge({ ownership }: { ownership: ClaimOwnershipView }) {
  if (ownership.viewerHoldsClaim) {
    return (
      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        You hold this claim
      </span>
    );
  }
  if (ownership.claimed) {
    return (
      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        Claimed
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      Unclaimed
    </span>
  );
}

/** The result of the last claim attempt, styled by the pure view's tone. */
function ResultNote({ result }: { result: ClaimActionView }) {
  const cls =
    result.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : result.tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-red-200 bg-red-50 text-red-800";
  return (
    <p role="status" className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>
      {result.message}
    </p>
  );
}
