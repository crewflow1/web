"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The CONVERSATION ATTENTION QUEUE SURFACE — the client REFRESH BUTTON (CEO Directive #018, R59: CONVERSATION ATTENTION
 * QUEUE SURFACE).
 *
 * The queue is a READ of two authoritative read models (the R39 worklist read surface and the R48 ownership read model),
 * composed by the R58 runtime and projected by the R59 pure core. Because ownership changes over time (an operator
 * claims an unowned item; a claim is reassigned), the operator needs to RE-READ the queue on demand. This is that one
 * affordance: it re-fetches the server component with the SAME request (`router.refresh()`), so the page re-runs its
 * org-scoped reads and re-projects the queue. It is the exact read-only refresh pattern the claim / reassign panels
 * already use in this surface tree.
 *
 * IT IS PURELY A RE-READ. It calls NO server action, issues NO fetch of its own, sends NO body and holds NO organisation
 * or operator identity — `router.refresh()` re-invokes the already-authorised page (which resolves the org from the
 * session and reads through the authoritative seams). It records nothing, mutates nothing, dispatches nothing and
 * notifies no one; it introduces no execution path. It only asks the page to read again.
 */
export function AttentionQueueRefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onRefresh() {
    // Re-run the server component's org-scoped reads and re-project the queue. No write, no action, no fetch — a re-read
    // of the same page, through the same authorised seams.
    start(() => {
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={pending}
      className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
