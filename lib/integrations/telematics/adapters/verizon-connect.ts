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
  normalizeVerizonConnectSamples,
  type VerizonConnectVehicleStatus,
} from "../reading-map";
import { validateWebhookUrl } from "@/lib/webhooks/ssrf";

/**
 * Verizon Connect (Reveal) telematics adapter — DARK.
 *
 * A REAL adapter mirroring SamsaraAdapter's shape + dark-gating exactly, for the
 * SECOND aggregator the substrate can bind to. It is a SEAM, not a live
 * integration: it reports itself unavailable whenever the connect substrate is not
 * connectable (which is ALWAYS today) and fetches NOTHING. There is deliberately NO
 * Reveal SDK import at module scope and NO client construction — a credential alone
 * could not cause a network call, and the absence of one guarantees the dark path.
 * Every `fetch` lives strictly AFTER the `isAvailable()` guard, so it is
 * structurally unreachable dark. The security suite proves this against the source.
 *
 * ACTIVATION (future): once connectable, the guarded bodies below pull the fleet's
 * latest vehicle status (location + odometer) from the Verizon Connect Reveal REST
 * API and normalise it via `normalizeVerizonConnectSamples` into the SAME provider-
 * agnostic shape the Samsara adapter emits (Reveal already reports miles + decimal
 * degrees; provider vehicle key → fleet_vehicles.asset_id). Until then this stays a
 * no-op that can never reach a Reveal server.
 *
 * ── TOKEN MODEL ─────────────────────────────────────────────────────────────
 * Like Samsara, the adapter receives an ALREADY-DECRYPTED access token (the sync
 * engine's decrypt-on-use seam turns the AES-256-GCM ciphertext at rest back into a
 * secret immediately before the call). The adapter itself never touches the
 * encryption seam and never persists a token; it uses the bearer token for one pull.
 *
 * ── HOST OVERRIDE + SSRF ────────────────────────────────────────────────────
 * Reveal is regionalised (US / EU / AU hosts), so the API base is an OPTIONAL,
 * NON-SECRET env override (VERIZON_CONNECT_API_BASE_URL, default the US host),
 * exactly the QBO_API_BASE_URL pattern. Because that base is operator-supplied
 * input that forms the request URL, EVERY outbound URL is vetted through the shared
 * SSRF policy (https-only, no IP literal, no private / internal / platform host)
 * BEFORE any fetch — a mis-set base can never point the server at an internal
 * address. No provider-supplied URL is ever fetched: pagination walks an integer
 * `page` param against the vetted base, so a malicious pagination link cannot
 * redirect the pull.
 */

/** The default Reveal REST API host (US region). Overridable, non-secret. */
const DEFAULT_VERIZON_CONNECT_API = "https://fim.api.us.fleetmatics.com";

/**
 * Resolve the Reveal REST API base — the optional non-secret regional override, or
 * the US default. Trimmed; an empty/whitespace override falls back to the default.
 */
function verizonConnectBase(): string {
  return process.env.VERIZON_CONNECT_API_BASE_URL?.trim() || DEFAULT_VERIZON_CONNECT_API;
}

/**
 * Build + SSRF-vet an absolute Reveal URL from the operator base. Returns the vetted
 * URL string, or a `reason` when the base is malformed or the host is not permitted
 * — so the caller REFUSES before any fetch. Never contacts the network.
 */
function vettedRevealUrl(
  path: string,
  params?: Record<string, string>,
): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(path, verizonConnectBase());
  } catch {
    return { ok: false, reason: "invalid-base-url" };
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  // Shared SSRF policy: https-only, no IP literal / numeric host, no private /
  // internal / platform host. The same audited classifier the outbound-webhook
  // dispatcher uses.
  const vetted = validateWebhookUrl(url.toString());
  if (!vetted.ok) return { ok: false, reason: vetted.reason };
  return { ok: true, url: vetted.url };
}

export class VerizonConnectAdapter implements TelematicsAdapter {
  readonly provider = "verizon_connect" as const;

  isAvailable(): boolean {
    return isTelematicsProviderConnectable(this.provider);
  }

  async fetchReadings(input: TelematicsFetchInput): Promise<TelematicsFetchResult> {
    // DARK GUARD FIRST. With no credentials we return without touching the network.
    // Every fetch below is unreachable until the substrate is connectable
    // (flag + credentials + a bound provider).
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        "Verizon Connect telematics feed is not connected. Open a Verizon Connect " +
          "Reveal account and configure the aggregator credentials to enable readings.",
      );
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    // The ONLY network calls in this adapter, strictly after the guard above.
    //
    // PAGE PAGINATION. The Reveal REST vehicle-status feed is paginated by an
    // INTEGER `page` param (Reveal's list convention); a page shorter than the
    // provider's page size — an EMPTY page in the general case — is the last page.
    // A single GET mapped only the first page, so any fleet larger than one page
    // silently dropped every vehicle past the boundary (no reading, no odometer
    // advance). We loop, accumulating every page's rows BEFORE the pure normaliser
    // runs. We NEVER follow a provider-supplied "next" link — every fetched URL is
    // derived from the SSRF-vetted operator base, so a malicious pagination link
    // cannot redirect the pull. Mirrors the Samsara adapter's cursor loop.
    //
    // BOUNDED. `MAX_PAGES` caps the loop so a pathological page counter can never
    // run forever and blow the cron's budget (maxDuration=60s, one aggregator pull
    // per connected org). Hitting the cap is a BOUNDED TRUNCATION, surfaced via a
    // secret-free warn rather than silently dropping the tail.
    //
    // input.since. The Reveal vehicle-status SNAPSHOT feed returns each vehicle's
    // LATEST status regardless of a start time, so — exactly as for Samsara's
    // snapshot endpoint — there is no since-equivalent to thread here and
    // `input.since` is deliberately not sent. This is NOT a silent drop: re-fetching
    // the snapshot is naturally idempotent (the normaliser keys each sample on
    // `${VehicleNumber}:${UpdateUTC}` and the DB dedupes on
    // (org, connection, source_event_id), so an unchanged snapshot re-writes
    // nothing). If the feed later graduates to a history endpoint, `input.since`
    // maps onto its start-time param — flagged here for that activation change.
    const MAX_PAGES = 40;
    const statuses: VerizonConnectVehicleStatus[] = [];
    let truncated = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const built = vettedRevealUrl("/rad/v1/vehicles/status", { page: String(page) });
      if (!built.ok) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: `Verizon Connect API host is not permitted (${built.reason})`,
        };
      }

      let res: Response;
      try {
        res = await fetch(built.url, {
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
          message: `Verizon Connect fetch failed: ${e instanceof Error ? e.message : "network error"}`,
        };
      }
      if (!res.ok) {
        // A 401/403 means the access token was rejected — after the sync engine's
        // refresh+retry this is a TERMINAL dead grant (reconnect required), so it
        // is surfaced as `unauthorized`. Reveal throttles with 429 (and 5xx are
        // provider blips): those stay `error` (TRANSIENT) so the connection is not
        // stranded on a rate-limit or a hiccup. Same split as the Samsara adapter.
        return {
          ok: false,
          provider: this.provider,
          reason: res.status === 401 || res.status === 403 ? "unauthorized" : "error",
          message: `Verizon Connect returned ${res.status}`,
        };
      }

      // Reveal returns either a { Vehicles: [...] } wrapper or a bare array
      // depending on the endpoint version; accept BOTH. Bind the external-API field
      // to a local BEFORE coalescing so the loud-read shape ledger does not
      // false-positive on a response field named `Vehicles` — this is an HTTP
      // response, not a Supabase read (same reason the Samsara adapter binds
      // `stats` first).
      const json = (await res.json()) as
        | { Vehicles?: VerizonConnectVehicleStatus[] | null }
        | VerizonConnectVehicleStatus[]
        | null;
      const pageRows: VerizonConnectVehicleStatus[] = Array.isArray(json)
        ? json
        : (json?.Vehicles ?? []);

      // An empty page is the last page — stop cleanly.
      if (pageRows.length === 0) break;
      statuses.push(...pageRows);
      // Still returning a full (non-empty) page at the cap ⇒ there may be more we
      // did not fetch: a bounded truncation, surfaced below.
      if (page === MAX_PAGES) truncated = true;
    }

    if (truncated) {
      // BOUNDED truncation: MAX_PAGES exhausted with a non-empty final page. Surface
      // it (no secret in the message) rather than silently dropping the tail — an
      // activation-time signal that a fleet exceeded the paged bound.
      console.warn(
        `[telematics] verizon_connect fetch hit MAX_PAGES (${MAX_PAGES}); fleet exceeds the paged bound — tail not fetched this tick.`,
      );
    }

    const samples = normalizeVerizonConnectSamples(statuses, input.resolveVehicleId);

    // `fetchedVehicleCount` is the RAW count of vehicles the provider returned —
    // reported separately from `samples` (resolved + signal-filtered) so the sync
    // engine can distinguish "provider returned nothing" from "provider returned N
    // but none matched a fleet VIN/registration".
    return {
      ok: true,
      provider: this.provider,
      samples,
      fetchedVehicleCount: statuses.length,
    };
  }

  /**
   * Resolve the Verizon Connect account id (the connection handle the DB CHECK
   * requires for a `connected` row) from a decrypted access token via the Reveal
   * account endpoint. The OAuth callback query does NOT carry the account id, so
   * this authenticated call is how a `connected` row earns its handle — mirroring
   * the Samsara `GET /me` resolver. DARK GUARD FIRST — no network without
   * credentials.
   */
  async resolveAccountHandle(accessToken: string): Promise<TelematicsAccountResult> {
    if (!this.isAvailable()) {
      return {
        ok: false,
        provider: this.provider,
        reason: "unavailable",
        message:
          "Verizon Connect telematics feed is not connected; no account handle to resolve.",
      };
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    const built = vettedRevealUrl("/rad/v1/account");
    if (!built.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Verizon Connect API host is not permitted (${built.reason})`,
      };
    }

    let res: Response;
    try {
      res = await fetch(built.url, {
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
        message: `Verizon Connect account lookup failed: ${e instanceof Error ? e.message : "network error"}`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Verizon Connect account lookup returned ${res.status}`,
      };
    }

    const json = (await res.json()) as
      | {
          Account?: {
            AccountId?: string | number | null;
            Id?: string | number | null;
            AccountName?: string | null;
            Name?: string | null;
          } | null;
          AccountId?: string | number | null;
          Id?: string | number | null;
        }
      | null;
    // Bind the external-API field to a local BEFORE coalescing so the loud-read
    // shape ledger does not false-positive on a response field named `Account` —
    // this is a Reveal HTTP response, not a Supabase read.
    const acct = json?.Account ?? null;
    const raw =
      acct?.AccountId ??
      acct?.Id ??
      acct?.AccountName ??
      acct?.Name ??
      json?.AccountId ??
      json?.Id ??
      null;
    const handle = raw === null || raw === undefined ? "" : String(raw).trim();
    if (handle.length === 0) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "Verizon Connect account lookup returned no account id.",
      };
    }
    return { ok: true, provider: this.provider, externalAccountId: handle };
  }
}
