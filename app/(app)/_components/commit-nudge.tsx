"use client";

import { useEffect, useState } from "react";

/**
 * CommitNudge — TEMPORARY workaround for a framework bug that left saved changes off the screen
 * for ~10 s. Removal condition and rules: docs/engineering/CORRECTNESS-GUARDS.md ("TEMPORARY —
 * CommitNudge"). Side-effect proof: e2e/commit-nudge-safety.spec.ts.
 *
 * WHAT USERS SAW. On many pages (staff profile, holiday entitlement, qualifications, rota, record
 * payment, job crew, settings …) a save wrote its row at once, but the confirmation and the new
 * values only appeared about ten seconds later. Measured in a real browser on the production
 * build: the server answered in ~0.1 s; the browser held the update.
 *
 * WHY. After a form action, the router's update for these pages suspends and React never receives
 * the "data is ready" wake-up for it, so the finished update sits uncommitted until SOMETHING ELSE
 * renders. Any state update anywhere does it: React retries suspended work whenever a new update
 * is scheduled on the root. In the app shell that "something else" happened to be a 10-second
 * poll — hence the exact ten seconds (proven: shortening that poll to 2 s shortened the stall to
 * ≤2 s; nudging a render every 500 ms cut it to ≤0.9 s; clicking after the first tick waited for
 * the next one). It is page-specific and timing-dependent, which is why it looked intermittent.
 * Same class as upstream vercel/next.js#87529 (UI stuck on stale data until any client state
 * change). Removing revalidatePath does not help — router.refresh() stalls the same way.
 *
 * THE WORKAROUND. After any form submission, schedule a few no-op renders of this (empty)
 * component over the next 15 seconds. Each one lets React retry the held update, so it commits
 * as soon as it is ready instead of at the next 10-second tick. The renders are of a component
 * that renders nothing; the cost is negligible. Forms keep their normal behaviour (revalidatePath,
 * router.refresh, StateForm) — nothing about what is saved or authorised changes.
 *
 * REMOVE at the first Next.js / React upgrade where e2e/form-saves-confirm-promptly.spec.ts passes
 * without this component (it fails without it today).
 */
const NUDGE_AFTER_MS = [100, 200, 400, 700, 1000, 1500, 2000, 3000, 4000, 5500, 7000, 9000, 11500, 15000];

export function CommitNudge() {
  const [, setTick] = useState(0);
  useEffect(() => {
    let timers: number[] = [];
    const onSubmit = () => {
      for (const t of timers) window.clearTimeout(t);
      timers = NUDGE_AFTER_MS.map((ms) => window.setTimeout(() => setTick((n) => n + 1), ms));
    };
    // Capture phase: runs for every form on the page (React form actions, StateForm, plain forms)
    // and cannot be stopped by a form's own submit handler.
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);
  return null;
}
