import "server-only";

import {
  isCalendarProviderConnectable,
  refreshAccessToken,
  type CalendarProvider,
} from "./oauth";
import { isPrivateHost } from "@/lib/webhooks/ssrf";

/**
 * Calendar WATCH-CHANNEL adapter — the provider webhook-registration half of the
 * inbound sync. Google `events.watch` opens a push channel; Microsoft
 * `POST /subscriptions` opens a change subscription. Both call BACK to a
 * CrewFlow webhook URL when the tenant's calendar changes, so CrewFlow can pull
 * the delta instead of polling. `stopWatchChannel` tears the channel down.
 *
 * ── DARK BY DEFAULT (identical to push/pull adapters) ───────────────────────
 * Every network function REFUSES (returns { reason:'not_configured' }, NO
 * `fetch`) when the provider is not connectable. The registration `fetch` lives
 * strictly AFTER that guard, so it is structurally unreachable dark. No token or
 * verification secret is ever logged.
 *
 * ── THE NOTIFICATION URL IS VALIDATED ───────────────────────────────────────
 * The notificationUrl is the CrewFlow endpoint the provider posts to. It must be
 * a public HTTPS URL — a misconfiguration to http:// or a private/loopback host
 * would either leak nothing (providers refuse non-https) or, worse, register a
 * channel the provider cannot reach. We refuse a non-https or private-host
 * notificationUrl before the registration call, reusing the SSRF classifier.
 *
 * ── THE VERIFICATION TOKEN ──────────────────────────────────────────────────
 * The caller mints a per-channel secret and passes it here; we hand it to the
 * provider (Google channel `token` / Microsoft `clientState`). The provider then
 * echoes it on every inbound notification, so the webhook receiver can
 * constant-time compare it against the stored secret and reject a forged call.
 */

/** A registered watch channel, as the provider confirmed it. */
export type RegisteredWatch = {
  /** The provider channel handle (Google channel id we minted; Microsoft subscription id). */
  channelId: string;
  /** Google resourceId (required to stop the channel); null for Microsoft. */
  resourceId: string | null;
  /** Channel expiry (ISO UTC), or null when the provider returned none. */
  expiration: string | null;
};

type Tokens = { accessToken: string; refreshToken: string | null };
type Refreshed = { accessToken: string; refreshToken: string | null; expiresAt: string | null };

export type WatchResult =
  | { ok: true; watch: RegisteredWatch; refreshed?: Refreshed }
  | {
      ok: false;
      reason: "not_configured" | "invalid_url" | "error";
      message: string;
      terminal?: boolean;
      refreshed?: Refreshed;
    };

export type StopWatchResult =
  | { ok: true; refreshed?: Refreshed }
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      terminal?: boolean;
      refreshed?: Refreshed;
    };

/** A notificationUrl must be a public HTTPS endpoint the provider can reach. */
function isValidNotificationUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (isPrivateHost(u.hostname)) return false;
  return true;
}

/** Terminal classification for a still-failing registration (mirrors the other adapters). */
function classifyTerminal(status: number): boolean {
  // 401 / 403 on a subscription/watch write is an authz failure; a 5xx / 429 is a blip.
  return status === 401 || status === 403;
}

/**
 * Register a provider watch channel. REFUSES (no `fetch`) when the provider is
 * not connectable — structurally dark — and refuses a non-public notificationUrl
 * before any network call. On a 401 the token is refreshed and the request is
 * retried once.
 */
export async function registerWatchChannel(params: {
  provider: CalendarProvider;
  tokens: Tokens;
  notificationUrl: string;
  /** The per-channel verification secret (Google token / Microsoft clientState). */
  verificationToken: string;
  /** The channel id to mint (Google). Ignored by Microsoft, which assigns its own. */
  channelId: string;
  /** Requested channel lifetime in milliseconds. */
  ttlMs: number;
}): Promise<WatchResult> {
  const { provider, tokens, notificationUrl, verificationToken, channelId, ttlMs } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  if (!isCalendarProviderConnectable(provider)) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} calendar is not configured; no watch channel was registered.`,
    };
  }

  if (!isValidNotificationUrl(notificationUrl)) {
    return {
      ok: false,
      reason: "invalid_url",
      message: "notification URL must be a public https endpoint.",
    };
  }

  const expirationIso = new Date(Date.now() + ttlMs).toISOString();
  const request =
    provider === "google"
      ? {
          url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
          body: {
            id: channelId,
            type: "web_hook",
            address: notificationUrl,
            token: verificationToken,
            params: { ttl: String(Math.floor(ttlMs / 1000)) },
          },
        }
      : {
          url: "https://graph.microsoft.com/v1.0/subscriptions",
          body: {
            changeType: "created,updated,deleted",
            notificationUrl,
            resource: "me/events",
            expirationDateTime: expirationIso,
            clientState: verificationToken,
          },
        };

  const doFetch = (accessToken: string) =>
    fetch(request.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(request.body),
    });

  let refreshed: Refreshed | undefined;
  let res: Response;
  try {
    res = await doFetch(tokens.accessToken);
    if (res.status === 401 && tokens.refreshToken) {
      const r = await refreshAccessToken({ provider, refreshToken: tokens.refreshToken });
      if (!r.ok) {
        return {
          ok: false,
          reason: "error",
          message: `token refresh failed: ${r.message}`,
          terminal: r.terminal === true,
        };
      }
      refreshed = r.tokens;
      res = await doFetch(r.tokens.accessToken);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: `watch registration failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: "error",
      message: `watch registration returned ${res.status}`,
      terminal: classifyTerminal(res.status),
      ...(refreshed ? { refreshed } : {}),
    };
  }

  const json = (await res.json()) as Record<string, unknown>;
  const watch = readRegisteredWatch(provider, json, channelId, expirationIso);
  if (!watch) {
    return {
      ok: false,
      reason: "error",
      message: "watch registration returned no channel id",
      ...(refreshed ? { refreshed } : {}),
    };
  }
  return { ok: true, watch, ...(refreshed ? { refreshed } : {}) };
}

/** Map a provider watch/subscription response onto the neutral RegisteredWatch. */
function readRegisteredWatch(
  provider: CalendarProvider,
  json: Record<string, unknown>,
  mintedChannelId: string,
  fallbackExpiration: string,
): RegisteredWatch | null {
  if (provider === "google") {
    // Google echoes the channel id we minted and returns a resourceId + a ms-epoch expiration.
    const id = typeof json.id === "string" ? json.id : mintedChannelId;
    const resourceId = typeof json.resourceId === "string" ? json.resourceId : null;
    let expiration: string | null = null;
    if (typeof json.expiration === "string" || typeof json.expiration === "number") {
      const ms = Number(json.expiration);
      expiration = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    if (!id) return null;
    return { channelId: id, resourceId, expiration: expiration ?? fallbackExpiration };
  }
  // Microsoft assigns the subscription id; expirationDateTime is ISO.
  const id = typeof json.id === "string" ? json.id : null;
  if (!id) return null;
  const expiration =
    typeof json.expirationDateTime === "string" ? json.expirationDateTime : fallbackExpiration;
  return { channelId: id, resourceId: null, expiration };
}

/**
 * Stop a provider watch channel. Google `POST channels/stop` (needs the channel
 * id + resourceId); Microsoft `DELETE /subscriptions/{id}`. REFUSES (no `fetch`)
 * when not connectable. 404/410 is tolerated as success (already gone). On a 401
 * the token is refreshed and the request retried once.
 */
export async function stopWatchChannel(params: {
  provider: CalendarProvider;
  tokens: Tokens;
  channelId: string;
  resourceId: string | null;
}): Promise<StopWatchResult> {
  const { provider, tokens, channelId, resourceId } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  if (!isCalendarProviderConnectable(provider)) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} calendar is not configured; no watch channel was stopped.`,
    };
  }

  const request =
    provider === "google"
      ? {
          url: "https://www.googleapis.com/calendar/v3/channels/stop",
          method: "POST" as const,
          body: JSON.stringify({ id: channelId, resourceId }),
        }
      : {
          url: `https://graph.microsoft.com/v1.0/subscriptions/${channelId}`,
          method: "DELETE" as const,
          body: undefined as string | undefined,
        };

  const doFetch = (accessToken: string) =>
    fetch(request.url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
      ...(request.body ? { body: request.body } : {}),
    });

  let refreshed: Refreshed | undefined;
  let res: Response;
  try {
    res = await doFetch(tokens.accessToken);
    if (res.status === 401 && tokens.refreshToken) {
      const r = await refreshAccessToken({ provider, refreshToken: tokens.refreshToken });
      if (!r.ok) {
        return {
          ok: false,
          reason: "error",
          message: `token refresh failed: ${r.message}`,
          terminal: r.terminal === true,
        };
      }
      refreshed = r.tokens;
      res = await doFetch(r.tokens.accessToken);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: `watch stop failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  // Success or already-gone (404/410) — the channel is absent either way.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    return {
      ok: false,
      reason: "error",
      message: `watch stop returned ${res.status}`,
      terminal: classifyTerminal(res.status),
      ...(refreshed ? { refreshed } : {}),
    };
  }

  return { ok: true, ...(refreshed ? { refreshed } : {}) };
}
