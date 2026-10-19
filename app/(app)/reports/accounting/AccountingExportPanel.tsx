"use client";

import { useActionState } from "react";
import {
  requestAccountingPush,
  type AccountingPushState,
} from "./actions";
import type { AccountingProvider } from "@/lib/integrations/accounting/adapters";

/**
 * Export-to-accounting control for the Reports page.
 *
 * The CSV path is a plain download link — no credentials, works today. The
 * provider buttons (Xero / QuickBooks / Sage — every provider the push action
 * and adapters support) drive the ONE push composition, `syncToProvider`.
 * Button state follows the org's CONNECTION for that provider (the same state
 * the connections panel below renders):
 *   • connected      → a live "Push to {provider}" control; the action resolves
 *     tokens and pushes the canonical rows through the provider adapter.
 *   • not connected  → the control renders disabled, pointing at the
 *     connections panel — a push without a connection can only be refused
 *     (recorded honestly as skipped_dark), so the panel says so up front
 *     rather than mislabelling a shipped capability as future work (it
 *     activates per-org by connecting the provider).
 * Route depth is 1, so `useActionState` here is not the deep-swap navigation
 * trap.
 */

const PROVIDER_LABEL: Record<AccountingProvider, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
  sage: "Sage",
};

const PROVIDERS: readonly AccountingProvider[] = ["xero", "quickbooks", "sage"];

export function AccountingExportPanel({
  connections,
}: {
  /** Per-provider connection state, as the reports page loaded it (org-pinned). */
  connections: Array<{ provider: AccountingProvider; status: string }>;
}) {
  const [state, formAction, pending] = useActionState<
    AccountingPushState | null,
    FormData
  >(requestAccountingPush, null);

  const isConnected = (provider: AccountingProvider): boolean =>
    connections.some((c) => c.provider === provider && c.status === "connected");

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

        {/* Provider push — one control per supported provider, gated on the
            org's connection (the state the connections panel below manages). */}
        <form action={formAction} className="flex flex-wrap items-center gap-2">
          {PROVIDERS.map((provider) => {
            const label = PROVIDER_LABEL[provider];
            const connected = isConnected(provider);
            return connected ? (
              <button
                key={provider}
                type="submit"
                name="provider"
                value={provider}
                disabled={pending}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
                title={`Pushes this organisation's invoices and payments to ${label}.`}
              >
                Push to {label}
              </button>
            ) : (
              <button
                key={provider}
                type="button"
                disabled
                aria-disabled="true"
                className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 shadow-sm"
                title={`Connect ${label} in the accounting connections panel below to enable the push. CSV export works today regardless.`}
              >
                Push to {label} (not connected)
              </button>
            );
          })}
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
