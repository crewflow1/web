"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";

/**
 * Impersonate button + confirmation modal.
 *
 * HQ-10: real session-swap. Clicking the submit button:
 *   * Writes an impersonation_sessions row (admin_user_id,
 *     target_org_id, reason).
 *   * Sets the cf_impersonation_session cookie (24h cap).
 *   * Redirects the operator to /dashboard where the customer-side
 *     layout renders a red "you are impersonating X" banner with
 *     an "Exit" button.
 *
 * Every load re-validates the impersonation row server-side — the
 * cookie alone can never grant access.
 */
export function CustomerImpersonateModal({
  orgId,
  orgName,
  action,
}: {
  orgId: string;
  orgName: string;
  action: (formData: FormData) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-indigo-500/15 px-3 py-1.5 text-xs font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30 transition-colors hover:bg-indigo-500/25"
      >
        Impersonate
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="impersonate-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
            <header className="border-b border-slate-800 px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                High-risk action · audit-logged
              </p>
              <h2
                id="impersonate-title"
                className="mt-1 text-lg font-bold text-white"
              >
                Impersonate {orgName}
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                You&apos;ll be dropped into the customer&apos;s workspace
                with a persistent banner. Auto-expires after 24h. Click
                &ldquo;Exit&rdquo; from the banner to return to HQ.
              </p>
            </header>
            <form action={action} className="space-y-3 px-5 py-4">
              <input type="hidden" name="org_id" value={orgId} />
              <label className="block text-[11px] font-medium text-slate-400">
                Reason
                <Input
                  name="reason"
                  required
                  maxLength={500}
                  placeholder="e.g. Diagnose customer-reported import failure"
                  className="mt-1"
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  onClick={() => setOpen(false)}
                  variant="glass"
                  size="sm"
                >
                  Cancel
                </Button>
                <Button type="submit" variant="danger" size="sm">
                  Start impersonating
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
