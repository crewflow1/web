import type { OrgPaymentConnectionState } from "@/server/services/org-payment-connections";
import { disconnectStripeConnect, refreshStripeConnectStatusAction } from "./actions";

/**
 * Payments (Stripe Connect) panel — the tenant onboarding surface. DARK.
 *
 * Lets an org bind its OWN Stripe connected account so its CUSTOMERS can pay
 * invoices online in the portal (funds settle to the tenant, never the platform).
 * Because online payments are BOTH feature-flag-gated AND platform-Connect-key-
 * gated, `connectable` is false today, so the connect control renders as a DISABLED
 * "Connect (not configured)" button — it never links to the onboarding flow while
 * dark. Once connectable, the control becomes a live link into
 * /api/integrations/stripe-connect/connect and the panel reflects the account's
 * real capability state (pending / connected) with refresh + disconnect controls.
 *
 * Presentational + server-safe: it takes already-fetched state as props (the page
 * reads it org-pinned under the caller's JWT) and holds no secrets — a Stripe
 * connected-account id is a public handle, not a credential.
 */

const CONNECT_HREF = "/api/integrations/stripe-connect/connect";

export function PaymentsConnectionPanel({
  connection,
  connectable,
}: {
  connection: OrgPaymentConnectionState;
  connectable: boolean;
}) {
  const status = connection.status;
  const isConnected = status === "connected";
  const isPending = status === "pending";
  const isError = status === "error";
  const account = connection.stripeAccountId;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">Online payments (Stripe)</h2>
        <p className="text-xs text-slate-500">
          Connect your Stripe account so customers can pay their invoices online
          from the customer portal. Payments settle directly to your Stripe balance.
        </p>
        {!connectable ? (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Online payments activate only once the payments feature and the platform
            Stripe keys are configured — they are not configured yet.
          </p>
        ) : null}
      </header>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-900">Stripe Connect</p>
          <p className="text-xs text-slate-500">
            {isConnected && account ? (
              <span className="text-emerald-700">
                Connected · {account}
                {connection.payoutsEnabled ? " · payouts enabled" : ""}
              </span>
            ) : isPending ? (
              <span className="text-amber-700">
                Onboarding in progress — finish setup in Stripe to start taking
                payments.
              </span>
            ) : isError ? (
              <span className="text-amber-700">Connection error — reconnect required</span>
            ) : connectable ? (
              "Not connected"
            ) : (
              "Not connected · not configured"
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isConnected ? (
            <>
              <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">
                Connected
              </span>
              <RefreshButton />
              <form action={disconnectStripeConnect}>
                <button
                  type="submit"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Disconnect
                </button>
              </form>
            </>
          ) : isPending && connectable ? (
            <>
              <a
                href={CONNECT_HREF}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              >
                Continue onboarding
              </a>
              <RefreshButton />
              <form action={disconnectStripeConnect}>
                <button
                  type="submit"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Cancel
                </button>
              </form>
            </>
          ) : connectable ? (
            // LIVE: a real link into the Stripe Connect onboarding flow. When the
            // last attempt errored, this doubles as the reconnect control.
            <a
              href={CONNECT_HREF}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              {isError ? "Reconnect Stripe" : "Connect Stripe"}
            </a>
          ) : (
            // DARK: disabled — no link to the onboarding flow while unconfigured.
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 shadow-sm"
              title="Online payments activate once the payments feature flag and the platform Stripe keys are configured."
            >
              Connect (not configured)
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** The status-refresh control — polls Stripe for the account's capability state. */
function RefreshButton() {
  return (
    <form action={refreshStripeConnectStatusAction}>
      <button
        type="submit"
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
      >
        Refresh status
      </button>
    </form>
  );
}
