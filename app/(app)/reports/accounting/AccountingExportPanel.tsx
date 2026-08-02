"use client";

import { useActionState } from "react";
import {
  requestAccountingPush,
  type AccountingPushState,
} from "./actions";

/**
 * Export-to-accounting control for the Reports page.
 *
 * The CSV path is a plain download link — no credentials, works today. The
 * Xero / QuickBooks buttons drive the dark provider-push action, which records a
 * `skipped_dark` audit row and returns a "coming soon" sentence rather than
 * contacting any provider. Route depth is 1, so `useActionState` here is not the
 * deep-swap navigation trap.
 */
export function AccountingExportPanel() {
  const [state, formAction, pending] = useActionState<
    AccountingPushState | null,
    FormData
  >(requestAccountingPush, null);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Export to accounting
          </h2>
          <p className="text-xs text-slate-500">
            Invoices and payments as canonical accounting rows, scoped to this
            organisation.
          </p>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* CSV — the credential-free path, works now. */}
        <a
          href="/api/accounting/export"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          target="_blank"
          rel="noopener noreferrer"
        >
          Download CSV
        </a>

        {/* Provider push — dark today. */}
        <form action={formAction} className="flex items-center gap-2">
          <button
            type="submit"
            name="provider"
            value="xero"
            disabled={pending}
            className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 shadow-sm hover:bg-slate-100 disabled:opacity-60"
            title="Xero API push activates once its OAuth credentials are configured."
          >
            Connect Xero (coming soon)
          </button>
          <button
            type="submit"
            name="provider"
            value="quickbooks"
            disabled={pending}
            className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 shadow-sm hover:bg-slate-100 disabled:opacity-60"
            title="QuickBooks API push activates once its OAuth credentials are configured."
          >
            Connect QuickBooks (coming soon)
          </button>
        </form>
      </div>

      {state?.message ? (
        <p
          className={`mt-3 text-xs ${state.ok ? "text-emerald-700" : "text-slate-500"}`}
          role="status"
        >
          {state.message}
        </p>
      ) : null}

      {/* Truncation disclosure: a very large export is capped per read. When the
          cap is hit the download is PARTIAL — never silent — and the response
          carries an `X-Accounting-Export-Truncated` header with the row count,
          and the export history records a truncation note. Narrow the date range
          to export the remaining rows. */}
      <p className="mt-3 text-[11px] text-slate-400">
        Very large exports are capped at 50,000 rows per read. If an export is
        truncated it is flagged in the response and the export history — narrow
        the date range to export the rest.
      </p>
    </section>
  );
}
