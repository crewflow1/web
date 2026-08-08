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
 *   - unauthorized — the access token was rejected (401/403); after a refresh+retry
 *                    this is a TERMINAL dead grant and the caller persists
 *                    status='error' (reconnect required). Mirrors the banking
 *                    adapter's `unauthorized` so the sync engine can split terminal
 *                    from transient identically across integrations.
 *   - error        — connectable but the fetch failed for any other reason (5xx /
 *                    429 / network): TRANSIENT, so the connection stays 'connected'.
 */
export type TelematicsFetchResult =
  | { ok: true; provider: TelematicsProvider; samples: TelematicsSample[] }
  | {
      ok: false;
      provider: TelematicsProvider;
      reason: "unavailable" | "unauthorized" | "error";
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

/**
 * The outcome of resolving the connection HANDLE (the provider account id) from a
 * freshly-issued access token. The OAuth callback query does NOT carry the account
 * id for these aggregators (Samsara), so the handle is resolved by an authenticated
 * provider call (e.g. Samsara `GET /me`) right after the token exchange.
 */
export type TelematicsAccountResult =
  | { ok: true; provider: TelematicsProvider; externalAccountId: string }
  | {
      ok: false;
      provider: TelematicsProvider;
      reason: "unavailable" | "error";
      message: string;
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
  /**
   * Resolve the provider account id (the connection handle the DB CHECK requires
   * for a `connected` row) from a decrypted access token. Refuses — no network —
   * when dark, exactly like fetchReadings; the network call lives strictly AFTER
   * the availability guard.
   */
  resolveAccountHandle(accessToken: string): Promise<TelematicsAccountResult>;
}

/** The `unavailable` result — the ONLY outcome the dark path may produce. */
export function unavailable(
  provider: TelematicsProvider,
  message: string,
): TelematicsFetchResult {
  return { ok: false, provider, reason: "unavailable", message };
}
