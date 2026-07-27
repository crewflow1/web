"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reassignWorkItemAction } from "./reassign-actions";
import type {
  ReassignmentView,
  ReassignmentActionView,
} from "@/lib/receptionist/conversation-reassignment-view";

/**
 * The CONVERSATION WORK REASSIGNMENT SURFACE — the client REASSIGN PANEL (CEO Directive #018, R54: CONVERSATION WORK
 * REASSIGNMENT SURFACE).
 *
 * The ONE operator affordance this surface offers: transfer ownership of a held Conversation Worklist item to another
 * authorised operator. It renders the current OWNERSHIP (the pure `ReassignmentView` the page projected) and, ONLY when
 * the item is owned AND another operator exists to receive it, a destination picker + a two-step (choose → confirm)
 * transfer control. It performs NO write itself — its only reassignment path is the server action
 * {@link reassignWorkItemAction}, which consumes the R52 runtime and nothing else. This component opens no database
 * client, names no ledger, and holds no organisation or source-operator identity of its own (both are resolved
 * server-side, from the session + the Ownership Read Model, by the action).
 *
 * IT REQUIRES CONFIRMATION AND REFRESHES ON COMPLETION. The operator picks a destination and must CONFIRM before the
 * transfer is recorded — a mis-click never transfers ownership. On completion the panel refreshes, so the ownership
 * display re-reads the recorded transfer (the item now shows the selected operator as owner). A `not_owned` result
 * (ownership changed under the operator) is shown verbatim and then refreshed, so the display settles on the truth.
 *
 * IT INTRODUCES NO EXECUTION PATH: it transfers ownership (through the runtime) and refreshes the read — it dispatches
 * nothing, notifies no one and executes no business action.
 */
export function ReassignPanel({ view }: { view: ReassignmentView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ReassignmentActionView | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [confirming, setConfirming] = useState(false);

  const chosen = view.candidates.find((c) => c.operatorId === selected) ?? null;

  function onConfirm() {
    if (!chosen) return;
    start(async () => {
      // The ONE reassignment path — the server action, which consumes the R52 runtime. Never a direct write.
      const outcome = await reassignWorkItemAction({
        coordinationId: view.coordinationId,
        toOperatorId: chosen.operatorId,
      });
      setResult(outcome);
      setConfirming(false);
      setSelected("");
      // Re-read the ownership display: on success it now shows the selected operator as owner.
      router.refresh();
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Ownership</h2>
        <OwnershipBadge view={view} />
      </div>

      <p className="mt-2 text-sm text-slate-600">{view.summary}</p>

      {view.owned ? (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Current owner</dt>
            <dd className="mt-0.5 text-sm text-slate-900">{view.currentOwnerLabel ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Claimed at</dt>
            <dd className="mt-0.5 text-sm text-slate-900">{formatInstant(view.claimedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Held since</dt>
            <dd className="mt-0.5 text-sm text-slate-900">{formatInstant(view.heldSince)}</dd>
          </div>
        </dl>
      ) : null}

      {view.canReassign ? (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <label htmlFor="reassign-destination" className="block text-sm font-medium text-slate-900">
            Transfer ownership to
          </label>
          <select
            id="reassign-destination"
            value={selected}
            disabled={pending || confirming}
            onChange={(e) => {
              setSelected(e.target.value);
              setResult(null);
            }}
            className="mt-2 w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">Select an operator…</option>
            {view.candidates.map((c) => (
              <option key={c.operatorId} value={c.operatorId}>
                {c.label}
              </option>
            ))}
          </select>

          {confirming && chosen ? (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm text-amber-900">
                Transfer ownership of this item to <span className="font-semibold">{chosen.label}</span>? This
                records the transfer and cannot be undone from here.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={pending}
                  className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {pending ? "Reassigning…" : "Confirm reassignment"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                  className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!chosen || pending}
                className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Reassign this item
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Reassigning records that ownership passed to the selected operator. It records the transfer only —
                no other action follows.
              </p>
            </div>
          )}
        </div>
      ) : view.owned ? (
        <p className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-500">
          No other operators are available to receive this item.
        </p>
      ) : null}

      {result ? <ResultNote result={result} /> : null}
    </section>
  );
}

/** A pill naming the ownership state — "You hold this" / "Reassigned" / "Owned" / "Unowned". Presentation only. */
function OwnershipBadge({ view }: { view: ReassignmentView }) {
  if (!view.owned) {
    return (
      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
        Unowned
      </span>
    );
  }
  if (view.viewerHoldsOwnership) {
    return (
      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        You hold this item
      </span>
    );
  }
  if (view.reassigned) {
    return (
      <span className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800">
        Reassigned
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
      Owned
    </span>
  );
}

/** The result of the last reassignment attempt, styled by the pure view's tone. */
function ResultNote({ result }: { result: ReassignmentActionView }) {
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

/** Trim an ISO instant to a readable "YYYY-MM-DD HH:MM", or an em dash when absent. Presentation only. */
function formatInstant(value: string | null): string {
  return value ? value.slice(0, 16).replace("T", " ") : "—";
}
