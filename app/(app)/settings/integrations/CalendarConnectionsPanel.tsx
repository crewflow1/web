import type { CalendarConnection } from "@/server/services/calendar-connections";
import type { CalendarProvider } from "@/lib/integrations/calendar/oauth";
import { disconnectCalendarConnection } from "./actions";

/**
 * Calendar connections panel — the per-provider connect surface. DARK.
 *
 * Renders one row per provider (Google, Microsoft) showing its connection state.
 * Because the OAuth flow is credential-gated and off today, every provider is
 * `connectable: false`, so the connect control renders as a DISABLED
 * "Connect (configure credentials)" button — it never links to the OAuth flow
 * while dark. When a provider becomes connectable the control becomes a live link
 * to the connect route, and a `connected` provider shows its account handle with
 * a disconnect control.
 *
 * Presentational + server-safe: it takes already-fetched state as props (the page
 * reads it org-pinned under the caller's JWT) and holds no secrets — tokens are
 * never selected into `CalendarConnection`.
 */

const PROVIDER_LABEL: Record<CalendarProvider, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft 365 Calendar",
};

export function CalendarConnectionsPanel({
  connections,
  connectable,
}: {
  connections: CalendarConnection[];
  connectable: Record<CalendarProvider, boolean>;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">Calendar connections</h2>
        <p className="text-xs text-slate-500">
          Connect a calendar to push scheduled jobs and rota shifts as events
          automatically. One-way push only for now.
        </p>
      </header>

      <ul className="mt-4 divide-y divide-slate-100">
        {connections.map((conn) => {
          const label = PROVIDER_LABEL[conn.provider];
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
                    "Not connected · configure credentials to enable"
                  )}
                </p>
              </div>

              {isConnected ? (
                // Disconnect is a live admin action once connected: a server
                // action (admin+org gated, loud) clears the tokens + handle and
                // returns the row to disconnected. Progressive-enhancement form.
                <form
                  action={disconnectCalendarConnection}
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
                  href={`/api/integrations/calendar/${conn.provider}/connect`}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Connect {label}
                </a>
              ) : (
                // DARK: disabled — no link to the OAuth flow while credentials
                // are absent.
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 shadow-sm"
                  title={`${label} activates once its OAuth client credentials are configured and the feature is enabled.`}
                >
                  Connect (configure credentials)
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
