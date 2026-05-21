"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Refresh status — re-runs the server access gate.
 *
 * The user is on /access-pending because requireOrgContext() bounced
 * them here when the org status was non-active. If a CrewFlow admin has
 * since approved the org, the status flipped to 'active' or 'trial' in
 * the DB. router.refresh() forces a fresh server render — the page
 * will then redirect onward to /dashboard automatically.
 *
 * No new API endpoint, no module: relies on the existing redirect path
 * baked into AccessPendingPage.
 */
export function RefreshStatusButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lastChecked, setLastChecked] = useState<number | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          startTransition(() => {
            router.refresh();
            setLastChecked(Date.now());
          });
        }}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? "Checking…" : "Refresh status"}
      </button>
      {lastChecked && !pending ? (
        <span className="text-[11px] text-slate-500">
          Still pending. We&apos;ll email you when access is unlocked.
        </span>
      ) : null}
    </div>
  );
}
