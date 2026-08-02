/**
 * HMRC fraud-prevention headers (Gov-Client / Gov-Vendor) — pure builder. DARK.
 *
 * HMRC MANDATES a set of "fraud prevention" HTTP headers on EVERY MTD API call
 * (https://developer.service.hmrc.gov.uk/guides/fraud-prevention/). They describe
 * the device and connection the request originates from. This module assembles
 * those headers from already-collected request/session context. It is PURE — no
 * network, no `server-only`, no I/O — so it is unit-testable and cannot itself
 * reach HMRC. The substrate is dark; nothing calls HMRC, so these headers are
 * only ever composed for the (dark) prepared payload's provenance, never sent.
 *
 * ── LEGAL / RECOGNITION BOUNDARY ────────────────────────────────────────────
 * Header CONFORMANCE is part of HMRC's software-recognition gate: a submission
 * is rejected unless these headers are present, correctly formatted, and pass
 * HMRC's validator. Because this build never submits, the builder exists to make
 * the header contract explicit and reviewable ahead of recognition — it does not
 * (and cannot) file anything.
 *
 * ── WHAT IS AND ISN'T A SECRET ──────────────────────────────────────────────
 * These are device/connection IDENTIFIERS (device id, timezone, screen metadata,
 * IPs, user-agent) — not credentials. They are the same class of value stored in
 * hmrc_connections.gov_client_ids (member-readable). No OAuth token or client
 * secret is ever placed in a fraud-prevention header.
 */

/** The connection method — how the end user reached CrewFlow. HMRC's enum. */
export type GovClientConnectionMethod =
  | "WEB_APP_VIA_SERVER"
  | "DESKTOP_APP_VIA_SERVER"
  | "MOBILE_APP_VIA_SERVER"
  | "BATCH_PROCESS_DIRECT"
  | "OTHER_DIRECT";

/**
 * The context a caller collects (server-side, from the inbound request + the
 * connected user's session) to build the headers. Every field is optional so a
 * partial context still yields the headers it can — the builder never invents a
 * value it was not given.
 */
export type FraudHeaderContext = {
  /** How the user connected. Defaults to WEB_APP_VIA_SERVER (CrewFlow is a web app). */
  connectionMethod?: GovClientConnectionMethod;
  /** A stable per-device UUID (persisted client-side, mirrored into gov_client_ids). */
  deviceId?: string;
  /** The authenticated user's opaque id, for Gov-Client-User-IDs (os=<id>). */
  userId?: string;
  /** IANA timezone of the end user's device, e.g. "Europe/London". */
  timezone?: string;
  /** The end user's public IP(s), left-to-right as seen by CrewFlow. */
  publicIps?: string[];
  /** Timestamp (ISO 8601) the public IP was observed. */
  publicIpTimestamp?: string;
  /** The originating browser user-agent string. */
  userAgent?: string;
  /** Screen metadata: width x height, scaling, colour depth. */
  screen?: { widthPx?: number; heightPx?: number; scalingFactor?: number; colourDepth?: number };
  /** Browser window size, in CSS pixels. */
  window?: { widthPx?: number; heightPx?: number };
  /** Whether the CrewFlow user completed MFA, and when (ISO 8601). */
  multiFactor?: { type: string; timestamp: string }[];
  /** The full chain of forwarding hops (Gov-Client-Public-IP-Address-Chain / Gov-Vendor-Forwarded). */
  forwarded?: { by: string; for: string }[];
};

/** CrewFlow's vendor identity, sent on the Gov-Vendor-* headers. */
export type VendorContext = {
  productName?: string;
  productVersion?: string;
  /** Licence ids of any third-party libraries HMRC requires disclosed. */
  licenseIds?: Record<string, string>;
};

const DEFAULT_VENDOR: Required<Pick<VendorContext, "productName">> = {
  productName: "CrewFlow",
};

/** RFC-3986-ish percent-encode of a header sub-value (key=value pairs are &-joined). */
function enc(v: string): string {
  return encodeURIComponent(v);
}

function pxPair(a?: number, b?: number, extra?: string): string | null {
  if (typeof a !== "number" || typeof b !== "number") return null;
  const base = `width=${Math.round(a)}&height=${Math.round(b)}`;
  return extra ? `${base}&${extra}` : base;
}

/**
 * Build the HMRC fraud-prevention header map from the collected context. Returns
 * ONLY the headers whose inputs are present — an absent input yields an absent
 * header rather than a fabricated one, because HMRC's validator penalises an
 * incorrectly-guessed value more than a legitimately-absent optional one.
 *
 * PURE: no network, no environment reads, no clock. Deterministic for a given
 * context, so it is fully unit-testable.
 */
export function buildFraudPreventionHeaders(
  ctx: FraudHeaderContext = {},
  vendor: VendorContext = {},
): Record<string, string> {
  const headers: Record<string, string> = {};

  headers["Gov-Client-Connection-Method"] = ctx.connectionMethod ?? "WEB_APP_VIA_SERVER";

  if (ctx.deviceId) headers["Gov-Client-Device-ID"] = ctx.deviceId;

  if (ctx.userId) {
    // Gov-Client-User-IDs is a key=value list; CrewFlow's own user id is keyed "os".
    headers["Gov-Client-User-IDs"] = `crewflow=${enc(ctx.userId)}`;
  }

  if (ctx.timezone) headers["Gov-Client-Timezone"] = ctx.timezone;

  if (ctx.publicIps && ctx.publicIps.length > 0) {
    headers["Gov-Client-Public-IP"] = ctx.publicIps[0]!;
    if (ctx.publicIpTimestamp) {
      headers["Gov-Client-Public-IP-Timestamp"] = ctx.publicIpTimestamp;
    }
  }

  if (ctx.userAgent) {
    headers["Gov-Client-User-Agent"] = ctx.userAgent;
  }

  if (ctx.screen) {
    const s = pxPair(
      ctx.screen.widthPx,
      ctx.screen.heightPx,
      [
        typeof ctx.screen.scalingFactor === "number"
          ? `scaling-factor=${ctx.screen.scalingFactor}`
          : null,
        typeof ctx.screen.colourDepth === "number"
          ? `colour-depth=${ctx.screen.colourDepth}`
          : null,
      ]
        .filter(Boolean)
        .join("&"),
    );
    if (s) headers["Gov-Client-Screens"] = s;
  }

  if (ctx.window) {
    const w = pxPair(ctx.window.widthPx, ctx.window.heightPx);
    if (w) headers["Gov-Client-Window-Size"] = w;
  }

  if (ctx.multiFactor && ctx.multiFactor.length > 0) {
    headers["Gov-Client-Multi-Factor"] = ctx.multiFactor
      .map((m) => `type=${enc(m.type)}&timestamp=${enc(m.timestamp)}`)
      .join(",");
  }

  if (ctx.forwarded && ctx.forwarded.length > 0) {
    headers["Gov-Vendor-Forwarded"] = ctx.forwarded
      .map((f) => `by=${enc(f.by)}&for=${enc(f.for)}`)
      .join(",");
  }

  const productName = vendor.productName ?? DEFAULT_VENDOR.productName;
  headers["Gov-Vendor-Product-Name"] = enc(productName);
  if (vendor.productVersion) {
    headers["Gov-Vendor-Version"] = `${enc(productName)}=${enc(vendor.productVersion)}`;
  }
  if (vendor.licenseIds && Object.keys(vendor.licenseIds).length > 0) {
    headers["Gov-Vendor-License-IDs"] = Object.entries(vendor.licenseIds)
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join("&");
  }

  return headers;
}
