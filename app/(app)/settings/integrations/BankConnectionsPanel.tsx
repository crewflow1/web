import type { BankConnection } from "@/server/services/bank-connections";
import type { BankingProvider } from "@/lib/integrations/banking/adapters";
import { disconnectBankConnection } from "./actions";

/**
 * Bank connections panel — the per-aggregator connect surface. DARK.
 *
 * Renders one row per aggregator (TrueLayer, Plaid, Nordigen) showing its
 * connection state. Because the OAuth flow is credential-gated, feature-gated AND
 * FCA-gated, every provider is `connectable: false` today, so the connect control
 * renders as a DISABLED "Connect (not configured)" button — it never links to the
 * OAuth flow while dark. When a provider becomes connectable the control becomes a
 * live link to the connect route, and a `connected` provider shows its bank with a
 * disconnect control.
 *
 * Presentational + server-safe: it takes already-fetched state as props (the page
 * reads it org-pinned under the caller's JWT) and holds no secrets — tokens are
 * never selected into `BankConnection`.
 */

const PROVIDER_LABEL: Record<BankingProvider, string> = {
  truelayer: "TrueLayer",
  plaid: "Plaid",
  nordigen: "Nordigen (GoCardless)",
};

export function BankConnectionsPanel({
  connections,
  connectable,
}: {
  connections: BankConnection[];
  connectable: Record<BankingProvider, boolean>;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">Bank feed connections</h2>
        <p className="text-xs text-slate-500">
          Connect a bank through an Open Banking aggregator to import statement
          lines automatically for reconciliation. Read-only account information.
        </p>
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Bank feeds are FCA-regulated (Account Information Services). This feature
          activates only once FCA authorisation and an aggregator contract are in
          place — it is not configured yet.
        </p>
      </header>

      <ul className="mt-4 divide-y divide-slate-100">
        {connections.map((conn) => {
          const label = PROVIDER_LABEL[conn.provider];
          const isConnectable = connectable[conn.provider] === true;
          const isConnected = conn.status === "connected";
          const handle = conn.institutionName ?? conn.institutionId ?? conn.connectionRef;

          return (
            <li
              key={conn.provider}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{label}</p>
                <p className="text-xs text-slate-500">
                  {isConnected && handle ? (
                    <span className="text-emerald-700">Connected · {handle}</span>
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
                <form
                  action={disconnectBankConnection}
                  className="flex items-center gap-2"
                >
                  <input type="hidden" name="provider" value={conn.provider} />
                  <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">
                    Connected
                  </span>
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                  >
                    Disconnect {label}
                  </button>
                </form>
              ) : isConnectable ? (
                // LIVE: a real link into the OAuth connect flow.
                <a
                  href={`/api/integrations/banking/${conn.provider}/connect`}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Connect {label}
                </a>
              ) : (
                // DARK: disabled — no link to the OAuth flow while unconfigured.
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 shadow-sm"
                  title={`${label} activates once FCA authorisation, the aggregator credentials and the feature flag are all in place.`}
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
