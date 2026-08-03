import type { HmrcConnection } from "@/server/services/hmrc-connections";

/**
 * HMRC MTD connection panel — the Making Tax Digital connect surface. DARK.
 *
 * Shows the org's HMRC connection state for VAT digital filing + CIS300. Because
 * the OAuth flow is two-switch gated (HMRC client credentials + the
 * NEXT_PUBLIC_FEATURE_HMRC_CONNECT flag) and off today, `connectable` is false,
 * so the connect controls render DISABLED — they never link to the OAuth flow
 * while dark.
 *
 * LEGAL BOUNDARY, SHOWN TO THE USER. Even once connected, CrewFlow prepares and
 * HOLDS returns; it does not file them. HMRC vendor recognition is a separate
 * legal gate. The copy below never implies otherwise (no "file" / "submit").
 *
 * Presentational + server-safe: takes already-fetched state as props (the page
 * reads it org-pinned under the caller's JWT) and holds no secrets — tokens are
 * never selected into `HmrcConnection`.
 */

const FLOW_LABEL: Record<"vat" | "cis", string> = {
  vat: "VAT (Making Tax Digital)",
  cis: "CIS300 monthly returns",
};

export function HmrcConnectionPanel({
  connection,
  connectable,
}: {
  connection: HmrcConnection;
  connectable: boolean;
}) {
  const isConnected = connection.status === "connected";

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">HMRC — Making Tax Digital</h2>
        <p className="text-xs text-slate-500">
          Connect HMRC to prepare digital VAT returns and CIS300 monthly returns from
          your CrewFlow figures.
        </p>
      </header>

      <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        CrewFlow prepares and holds these returns — it does not file them with HMRC.
        Live filing needs HMRC to formally recognise CrewFlow as filing software, a
        step that is not yet in place.
      </p>

      <p className="mt-2 text-xs text-slate-500">
        Prepare and review your held VAT and CIS300 returns on the{" "}
        <a href="/tax" className="font-medium text-slate-700 underline hover:text-slate-900">
          Tax page
        </a>
        . No HMRC connection is required to prepare them — they are built from your
        own CrewFlow figures and never sent.
      </p>

      <ul className="mt-4 divide-y divide-slate-100">
        {(["vat", "cis"] as const).map((flow) => (
          <li key={flow} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">{FLOW_LABEL[flow]}</p>
              <p className="text-xs text-slate-500">
                {isConnected && connection.vrn ? (
                  <span className="text-emerald-700">Connected · VRN {connection.vrn}</span>
                ) : connection.status === "error" ? (
                  <span className="text-amber-700">Connection error — reconnect required</span>
                ) : connectable ? (
                  "Not connected"
                ) : (
                  "Not configured · set HMRC credentials to enable"
                )}
              </p>
            </div>

            {connectable && !isConnected ? (
              // LIVE (unreachable dark): a real link into the OAuth connect flow.
              <a
                href={`/api/integrations/hmrc/${flow}/connect`}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              >
                Connect
              </a>
            ) : (
              // DARK: disabled — no link to the OAuth flow while dark.
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 shadow-sm"
                title="HMRC activates once its OAuth client credentials are configured, the feature is enabled, and HMRC recognition is in place."
              >
                {isConnected ? "Connected" : "Connect (not configured)"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
