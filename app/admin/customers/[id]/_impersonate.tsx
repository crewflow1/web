"use client";

import { useState } from "react";

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
        className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-800 hover:bg-indigo-100"
      >
        Impersonate
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="impersonate-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4 py-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <header className="border-b border-slate-200 px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                High-risk action · audit-logged
              </p>
              <h2 id="impersonate-title" className="mt-1 text-lg font-bold text-slate-900">
                Impersonate {orgName}
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                You&apos;ll be dropped into the customer&apos;s workspace
                with a persistent banner. Auto-expires after 24h. Click
                &ldquo;Exit&rdquo; from the banner to return to HQ.
              </p>
            </header>
            <form action={action} className="space-y-3 px-5 py-4">
              <input type="hidden" name="org_id" value={orgId} />
              <label className="block text-[11px] font-medium text-slate-700">
                Reason
                <input
                  name="reason"
                  required
                  maxLength={500}
                  placeholder="e.g. Diagnose customer-reported import failure"
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800"
                >
                  Start impersonating
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
