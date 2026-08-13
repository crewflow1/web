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
    // The ONLY network calls in this adapter, strictly after the guard above.
    //
    // CURSOR PAGINATION. Samsara v2 `/fleet/vehicles/stats` is PAGINATED (default
    // page ~512 vehicles): the response carries `pagination.hasNextPage` +
    // `pagination.endCursor`, and the NEXT page is the SAME URL with
    // `?after=<endCursor>`. A single GET (the pre-fix behaviour) mapped only the
    // first page, so any fleet larger than one page silently dropped every vehicle
    // past the boundary — no telematics_readings row, no odometer advance. We loop
    // until `hasNextPage` is false, accumulating every page's stats BEFORE the pure
    // normaliser runs. (Mirrors the provider-fetch bounding the sibling TrueLayer
    // adapter documents for its own pull.)
    //
    // BOUNDED. `MAX_PAGES` caps the loop so a pathological / self-referential
    // cursor can never run forever and blow the cron's budget. The telematics-sync
    // cron has maxDuration=60s and makes one aggregator pull per connected org; at
    // ~512 vehicles/page, 40 pages covers a ~20k-vehicle single-org fleet — far
    // beyond any realistic CrewFlow tenant — while leaving the pull comfortably
    // inside that budget. Hitting the cap is a BOUNDED TRUNCATION, surfaced via a
    // (secret-free) warn rather than silently dropping the tail.
    //
    // input.since. The `/fleet/vehicles/stats` SNAPSHOT endpoint has NO time
    // filter: it returns each vehicle's LATEST stat regardless of any start/after
    // time (only the historical `/fleet/vehicles/stats/history` endpoint takes
    // `startTime`/`endTime`). There is therefore no since-equivalent to thread on
    // THIS endpoint, so `input.since` is deliberately not sent — and this is NOT a
    // silent drop: re-fetching the current snapshot is naturally idempotent (the
    // mapper keys each sample on `${id}:${recordedAt}` and the DB dedupes on
    // (org, connection, source_event_id), so an unchanged snapshot re-writes
    // nothing). If the feed later graduates to the history endpoint, `input.since`
    // maps onto its `startTime` param — flagged here for that activation change.
    // FIELDS FOR VEHICLE RESOLUTION. Samsara's /fleet/vehicles/stats returns each
    // vehicle's `id`, `name` and `externalIds` (which carry the namespaced
    // `samsara.vin`) NATIVELY alongside the requested stat types — no extra request
    // is needed for those. The licence plate is threaded through when the payload
    // carries it (`licensePlate`), so a registration-keyed fleet (blank VIN,
    // populated plate/name) resolves. The pure normaliser reads all of these off
    // SamsaraVehicleStat; the raw `json.data` pass-through below preserves them.
    const MAX_PAGES = 40;
    const stats: SamsaraVehicleStat[] = [];
    let after: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      let res: Response;
      try {
        const url = new URL("https://api.samsara.com/fleet/vehicles/stats");
        url.searchParams.set("types", "gps,obdOdometerMeters");
        if (after) url.searchParams.set("after", after);
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
        // A 401/403 means the access token was rejected — after the sync engine's
        // refresh+retry this is a TERMINAL dead grant (reconnect required), so it
        // is surfaced as `unauthorized`. Samsara throttles with 429 (and 5xx are
        // provider blips): those stay `error` (TRANSIENT) so the connection is not
        // stranded on a rate-limit or a hiccup.
        return {
          ok: false,
          provider: this.provider,
          reason: res.status === 401 || res.status === 403 ? "unauthorized" : "error",
          message: `Samsara returned ${res.status}`,
        };
      }

      // The native Samsara shape → provider-agnostic samples is done by the pure
      // `normalizeSamsaraSamples` mapper so the arithmetic (metres → miles) and the
      // vehicle-id resolution live once and are unit-tested.
      const json = (await res.json()) as {
        data?: SamsaraVehicleStat[];
        pagination?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
      };
      // Bind the field to a local BEFORE coalescing so the loud-read shape ledger
      // does not false-positive on an external-API response field named `data` —
      // this is not a Supabase read, so there is no read-failure debt here (the
      // sibling TrueLayer adapter names its field `results` for the same reason).
      const pageStats: SamsaraVehicleStat[] | undefined = json.data;
      if (pageStats && pageStats.length > 0) stats.push(...pageStats);

      // Advance to the next page ONLY when the provider reports one AND hands back
      // a usable cursor; otherwise we are done. `after` remaining non-null after
      // the loop means the cap stopped us mid-fleet (bounded truncation, below).
      const pagination = json.pagination ?? null;
      const endCursor =
        typeof pagination?.endCursor === "string" && pagination.endCursor.length > 0
          ? pagination.endCursor
          : null;
      if (pagination?.hasNextPage && endCursor) {
        after = endCursor;
      } else {
        after = null;
        break;
      }
    }

    if (after) {
      // BOUNDED truncation: we exhausted MAX_PAGES with a next page still pending.
      // Surface it (no secret in the message) rather than silently dropping the
      // fleet's tail — an activation-time signal that a fleet exceeded the bound.
      console.warn(
        `[telematics] samsara fetch hit MAX_PAGES (${MAX_PAGES}); fleet exceeds the paged bound — tail not fetched this tick.`,
      );
    }

    const samples = normalizeSamsaraSamples(stats, input.resolveVehicleId);

    // `fetchedVehicleCount` is the RAW count of vehicles the provider returned —
    // reported separately from `samples` (which have been resolved + signal-
    // filtered) so the sync engine can distinguish "provider returned nothing"
    // from "provider returned N but none matched a fleet VIN/registration".
    return { ok: true, provider: this.provider, samples, fetchedVehicleCount: stats.length };
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
