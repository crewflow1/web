"use client";

import { useState } from "react";

/**
 * Impersonate button + confirmation modal.
 *
 * Full session-swap impersonation is a high-risk feature — it gets its
 * own focused PR (HQ-3.1) where we'll:
 *   - inject a banner into the customer workspace so the operator can
 *     never accidentally type AS the customer
 *   - cap the impersonation session duration
 *   - write a dedicated impersonation-session row + audit pair
 *
 * For HQ-3.0 this button records the operator's intent (mandatory
 * "reason" field) into admin_activity_log so the audit trail is in
 * place before the real flow lands. Clicking submit writes the audit
 * entry and bounces back to the page with a banner.
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
                Full session-swap lands in HQ-3.1. For now this records your
                intent into the audit log so the trail is in place before
                the live flow ships.
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
                  className="rounded-md bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800"
                >
                  Log impersonation intent
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
