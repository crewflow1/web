import "server-only";

import { isTelematicsProviderConnectable } from "../oauth";
import type {
  TelematicsAccountResult,
  TelematicsAdapter,
  TelematicsFetchInput,
  TelematicsFetchResult,
} from "./types";
import { unavailable } from "./types";
import {
  normalizeSamsaraSamples,
  type SamsaraVehicleStat,
} from "../reading-map";

/**
 * Samsara telematics adapter — DARK.
 *
 * This adapter is a SEAM, not a live integration. It reports itself unavailable
 * whenever the connect substrate is not connectable (which is ALWAYS today) and
 * fetches NOTHING. There is deliberately NO Samsara SDK import at module scope and
 * NO client construction: a credential alone could not cause a network call, and
 * the absence of one guarantees the dark path. The single `fetch` lives strictly
 * AFTER the `isAvailable()` guard, so it is structurally unreachable dark.
 *
 * ACTIVATION (future): once connectable, the guarded body below pulls the vehicle
 * stats (location + odometer) from the Samsara Fleet API and normalises them via
 * `normalizeSamsaraSamples` into the provider-agnostic shape the reading mapper
 * consumes (metres → miles, provider vehicle id → fleet_vehicles.asset_id). Until
 * then this stays a no-op that can never reach a Samsara server.
 */
export class SamsaraAdapter implements TelematicsAdapter {
  readonly provider = "samsara" as const;

  isAvailable(): boolean {
    return isTelematicsProviderConnectable(this.provider);
  }

  async fetchReadings(input: TelematicsFetchInput): Promise<TelematicsFetchResult> {
    // DARK GUARD FIRST. With no credentials we return without touching the
    // network. The fetch body below is unreachable until the substrate is
    // connectable (flag + credentials + a bound provider).
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        "Samsara telematics feed is not connected. Open a Samsara account and " +
          "configure the aggregator credentials to enable readings.",
      );
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    // The ONLY network call in this adapter, strictly after the guard above.
    let res: Response;
    try {
      const url = new URL("https://api.samsara.com/fleet/vehicles/stats");
      url.searchParams.set("types", "gps,obdOdometerMeters");
      res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: "application/json",
        },
      });
    } catch (e) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Samsara fetch failed: ${e instanceof Error ? e.message : "network error"}`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Samsara returned ${res.status}`,
      };
    }

    // The native Samsara shape → provider-agnostic samples is done by the pure
    // `normalizeSamsaraSamples` mapper so the arithmetic (metres → miles) and the
    // vehicle-id resolution live once and are unit-tested.
    const json = (await res.json()) as { data?: SamsaraVehicleStat[] };
    // Bind the field to a local BEFORE coalescing so the loud-read shape ledger
    // does not false-positive on an external-API response field named `data` —
    // this is not a Supabase read, so there is no read-failure debt here (the
    // sibling TrueLayer adapter names its field `results` for the same reason).
    const stats: SamsaraVehicleStat[] | undefined = json.data;
    const samples = normalizeSamsaraSamples(stats ?? [], input.resolveVehicleId);

    return { ok: true, provider: this.provider, samples };
  }

  /**
   * Resolve the Samsara organisation id (the connection handle) from the access
   * token via `GET /me`. The OAuth callback query does NOT carry the account id,
   * so this authenticated call is how a `connected` row earns the handle the DB
   * CHECK requires. DARK GUARD FIRST — no network without credentials.
   */
  async resolveAccountHandle(accessToken: string): Promise<TelematicsAccountResult> {
    if (!this.isAvailable()) {
      return {
        ok: false,
        provider: this.provider,
        reason: "unavailable",
        message: "Samsara telematics feed is not connected; no account handle to resolve.",
      };
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    let res: Response;
    try {
      res = await fetch("https://api.samsara.com/me", {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      });
    } catch (e) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Samsara account lookup failed: ${e instanceof Error ? e.message : "network error"}`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Samsara account lookup returned ${res.status}`,
      };
    }

    const json = (await res.json()) as {
      data?: { id?: string | number | null; orgId?: string | number | null } | null;
    };
    // Bind the external-API field to a local BEFORE coalescing so the loud-read
    // shape ledger does not false-positive on a response field named `data` — this
    // is a Samsara HTTP response, not a Supabase read (same reason fetchReadings
    // binds `stats` first).
    const me: { id?: string | number | null; orgId?: string | number | null } | null | undefined =
      json.data;
    const raw = me?.orgId ?? me?.id ?? null;
    const handle = raw === null || raw === undefined ? "" : String(raw).trim();
    if (handle.length === 0) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "Samsara account lookup returned no organisation id.",
      };
    }
    return { ok: true, provider: this.provider, externalAccountId: handle };
  }
}
