import type { MerchantConnection } from "@/server/services/merchant-connections";
import type { MerchantProvider } from "@/lib/integrations/merchants/types";
import { MERCHANT_LABELS } from "@/lib/integrations/merchants/types";
import {
  disconnectMerchantConnection,
  importMerchantCatalogueAction,
} from "./actions";

/**
 * Merchant connections panel — the per-merchant connect surface. DARK.
 *
 * Renders one row per builders' merchant (JP Corry, Jewson, Travis Perkins,
 * Haldane Fisher) showing its connection state. Because the connect flow is
 * credential-gated AND feature-gated AND endpoint-gated (and, above that,
 * needs a trade-account integration contract), every merchant is
 * `connectable: false` today, so the connect control renders as a DISABLED
 * "Connect (not configured)" button — it never links to a connect flow while
 * dark. When a merchant becomes connectable the control becomes a live link, and
 * a `connected` merchant shows its trade account with a disconnect control.
 *
 * Presentational + server-safe: it takes already-fetched state as props (the page
 * reads it org-pinned under the caller's JWT) and holds no secrets — the account
 * secret is never selected into `MerchantConnection`.
 */

export function MerchantConnectionsPanel({
  connections,
  connectable,
}: {
  connections: MerchantConnection[];
  connectable: Record<MerchantProvider, boolean>;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">Builders&apos; merchant connections</h2>
        <p className="text-xs text-slate-500">
          Connect a builders&apos; merchant to import your trade price file and send
          purchase orders electronically instead of by phone or email.
        </p>
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Merchant links activate only once a trade-account integration contract,
          its credentials and endpoint are configured — none is configured yet.
        </p>
      </header>

      <ul className="mt-4 divide-y divide-slate-100">
        {connections.map((conn) => {
          const label = MERCHANT_LABELS[conn.provider];
          const isConnectable = connectable[conn.provider] === true;
          const isConnected = conn.status === "connected";
          const handle = conn.externalAccountId;

          return (
            <li
              key={conn.provider}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{label}</p>
                <p className="text-xs text-slate-500">
                  {isConnected && handle ? (
                    <span className="text-emerald-700">Connected · account {handle}</span>
                  ) : conn.status === "error" ? (
                    <span className="text-amber-700">
                      Connection error — reconnect required
                    </span>
                  ) : isConnectable ? (
                    "Not connected"
                  ) : (
                    "Not connected · not configured"
                  )}
                </p>
              </div>

              {isConnected ? (
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-2">
                    {/* Import the trade price file into this org's catalogue. The
                        server action refuses (dark) unless the merchant is
                        connectable AND connected, so nothing is fetched while the
                        integration is not activated. */}
                    <form action={importMerchantCatalogueAction}>
                      <input type="hidden" name="provider" value={conn.provider} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                      >
                        Import price file
                      </button>
                    </form>
                    <form
                      action={disconnectMerchantConnection}
                      className="flex items-center gap-2"
                    >
                      <input type="hidden" name="provider" value={conn.provider} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                      >
                        Disconnect {label}
                      </button>
                    </form>
                  </div>
                  {conn.lastError ? (
                    <span className="text-xs text-amber-700">Last import: {conn.lastError}</span>
                  ) : conn.lastSyncAt ? (
                    <span className="text-xs text-slate-400">
                      Catalogue imported {new Date(conn.lastSyncAt).toLocaleDateString("en-GB")}
                    </span>
                  ) : null}
                </div>
              ) : isConnectable ? (
                // LIVE: a real link into the connect flow.
                <a
                  href={`/api/integrations/merchants/${conn.provider}/connect`}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Connect {label}
                </a>
              ) : (
                // DARK: disabled — no link to a connect flow while unconfigured.
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 shadow-sm"
                  title={`${label} activates once a trade-account contract, the merchant credentials and endpoint, and the feature flag are all in place.`}
                >
                  Connect (not configured)
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
