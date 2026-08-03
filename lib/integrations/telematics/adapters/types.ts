/**
 * Telematics feed — the aggregator ADAPTER seam.
 *
 * Pulling vehicle location/odometer feeds from a telematics provider (Samsara /
 * Verizon Connect) is a DARK seam behind the aggregator's OAuth. This file
 * defines the contract every aggregator satisfies, so activation is only ever
 * "supply the credentials + bind the provider", never a code change to the ingest
 * pipeline that consumes the mapped readings.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * An adapter reports `isAvailable()` false whenever the connect substrate is not
 * connectable for it (flag off / no credentials / provider unbound) — which is
 * ALWAYS, today. When unavailable, `fetchReadings` MUST return an `unavailable`
 * result WITHOUT constructing a client and WITHOUT making any network request. An
 * aggregator is never contacted without credentials; there is no code path from
 * "no credentials" to `fetch`. The security suite proves this against the adapter
 * source.
 */

import type { TelematicsSample } from "../reading-map";

export type TelematicsProvider = "samsara" | "verizon_connect";

/**
 * The outcome of a readings fetch.
 *   - ok           — samples returned by the aggregator (unreachable today).
 *   - unavailable  — not connectable; nothing was fetched (the dark path).
 *   - error        — connectable but the fetch failed.
 */
export type TelematicsFetchResult =
  | { ok: true; provider: TelematicsProvider; samples: TelematicsSample[] }
  | {
      ok: false;
      provider: TelematicsProvider;
      reason: "unavailable" | "error";
      message: string;
    };

/** What an adapter needs to pull readings for a connected org (unreachable dark). */
export type TelematicsFetchInput = {
  /** DECRYPTED access token — only ever resolved after the connectable guard. */
  accessToken: string;
  /** The provider account id bound to this org. */
  externalAccountId: string;
  /**
   * Resolve a provider vehicle id to a fleet_vehicles.asset_id (a tenant mapping).
   * The adapter passes it to the pure normaliser so unmapped vehicles are skipped.
   */
  resolveVehicleId: (providerVehicleId: string) => string | null;
  /** Only pull samples recorded on/after this ISO timestamp, when supported. */
  since?: string | null;
};

export interface TelematicsAdapter {
  readonly provider: TelematicsProvider;
  /**
   * True only when the connect substrate is connectable for this provider. A pure
   * env check — no network, never throws. Drives readiness and the UI's
   * connected/coming-soon state.
   */
  isAvailable(): boolean;
  /**
   * Pull location/odometer readings for a connected org. Returns `unavailable` —
   * no network — when dark. The ONLY network call lives strictly AFTER the
   * availability guard.
   */
  fetchReadings(input: TelematicsFetchInput): Promise<TelematicsFetchResult>;
}

/** The `unavailable` result — the ONLY outcome the dark path may produce. */
export function unavailable(
  provider: TelematicsProvider,
  message: string,
): TelematicsFetchResult {
  return { ok: false, provider, reason: "unavailable", message };
}
