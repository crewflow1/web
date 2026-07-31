"use client";

import { useEffect, useState } from "react";
import { signOut } from "@/app/(auth)/actions";
import { clearAll, clearOfflineIdentity } from "@/lib/blueprints/offline-store";
import {
  clearAll as clearWriteQueue,
  countOnDevice,
} from "@/lib/offline/write-queue";

/**
 * Sign-out control (Programme E shared-device gate + the offline write queue).
 *
 * A server action can't touch IndexedDB, so this client wrapper PURGES CrewFlow's
 * browser-local user data BEFORE invoking the real `signOut()` server action. On a
 * shared site tablet: User A signs out → local data erased → User B signs in →
 * nothing to read and nothing of A's to send.
 *
 * ── Two purges, two different risk profiles ───────────────────────────────────
 *
 * The DRAWING CACHE is a copy of something the server still has, so purging it can
 * only cost a re-download. It is purged unconditionally and never blocks logout.
 *
 * The WRITE QUEUE is the opposite: it holds work that exists NOWHERE ELSE. Leaving
 * it is a security breach (one person's unsent words sitting in a browser handed to
 * the next person); deleting it silently is data loss. Both are unacceptable, so
 * the user is ASKED — once, with the number in front of them — and then it is
 * purged either way. That is the only honest resolution: the person who wrote the
 * entries is the only one who can decide whether to go back and sync them, and they
 * cannot decide if they are not told.
 *
 * Order matters and is asserted by the security tests: every purge completes BEFORE
 * `signOut()` clears the session, because after that the outbox can no longer sync
 * anything and the identity needed to scope a partition is gone.
 *
 * NO-JS fallback: the button still submits the form, so `signOut()` runs. That is
 * correct rather than a hole — without JavaScript nothing was ever written to
 * IndexedDB in the first place, so there is nothing to purge.
 */
export function SignOutButton({ className }: { className?: string }) {
  const [queued, setQueued] = useState(0);

  // Polled rather than event-driven: this button lives in the layout header on
  // every page, and the count only has to be right at the moment it is clicked.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const n = await countOnDevice();
      if (alive) setQueued(n);
    };
    void read();
    const t = setInterval(read, 10_000);
    window.addEventListener("crewflow:outbox-changed", read);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("crewflow:outbox-changed", read);
    };
  }, []);

  return (
    <form
      action={async () => {
        // Re-read at the moment of truth: the polled count above could be up to
        // 10s stale, and the warning must reflect what is actually on the device.
        let unsent = 0;
        try {
          unsent = await countOnDevice();
        } catch {
          /* if we cannot count, we still purge below */
        }
        if (unsent > 0) {
          const ok = window.confirm(
            `${unsent} ${unsent === 1 ? "entry has" : "entries have"} not been sent to CrewFlow yet.\n\n` +
              `Signing out deletes ${unsent === 1 ? "it" : "them"} from this device for good, because unsent work must not be left on a shared tablet.\n\n` +
              `Cancel, get a signal, and let ${unsent === 1 ? "it" : "them"} sync first — or press OK to sign out and lose ${unsent === 1 ? "it" : "them"}.`,
          );
          if (!ok) return; // stay signed in; the outbox keeps trying
        }
        // Purge user-scoped offline data before the server clears the session.
        // Unsent writes first: they are the only thing here that cannot be re-fetched.
        try {
          await clearWriteQueue();
        } catch {
          /* never block logout */
        }
        // (SW caches hold ONLY public static/shell assets by the strict allowlist,
        // so there is no private cache to clear here — proven by the security tests.)
        try { await clearAll(); clearOfflineIdentity(); } catch { /* never block logout */ }
        await signOut();
      }}
    >
      <button type="submit" className={className}>
        Sign out
        {queued > 0 ? (
          <span
            data-signout-unsent={queued}
            className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900"
            title={`${queued} entr${queued === 1 ? "y" : "ies"} not yet sent — signing out will delete ${queued === 1 ? "it" : "them"}`}
          >
            {queued}
          </span>
        ) : null}
      </button>
    </form>
  );
}
