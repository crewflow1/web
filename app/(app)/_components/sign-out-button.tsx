"use client";

import { signOut } from "@/app/(auth)/actions";
import { clearAll, clearOfflineIdentity } from "@/lib/blueprints/offline-store";

/**
 * Sign-out control (Programme E shared-device gate). A server action can't touch
 * IndexedDB, so this client wrapper PURGES the CrewFlow offline drawing cache
 * BEFORE invoking the real `signOut()` server action. On a shared site tablet:
 * User A signs out → cached bytes erased → User B signs in → nothing to read.
 * Purge failure never blocks logout (the auth-state listener is the backstop).
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form
      action={async () => {
        // Purge user-scoped offline data before the server clears the session.
        // (SW caches hold ONLY public static/shell assets by the strict allowlist,
        // so there is no private cache to clear here — proven by the security tests.)
        try { await clearAll(); clearOfflineIdentity(); } catch { /* never block logout */ }
        await signOut();
      }}
    >
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
