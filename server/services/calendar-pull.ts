import "server-only";
import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  isCalendarProviderConnectable,
  calendarConnectFeatureEnabled,
  decryptStoredTokens,
  type CalendarProvider,
} from "@/lib/integrations/calendar/oauth";
import { decryptToken } from "@/lib/integrations/token-crypto";
import {
  pullEvents,
  pullFreeBusy,
  hasCrewflowMarker,
  DEFAULT_PULL_WINDOW_DAYS,
  type PulledEvent,
  type FreeBusyInterval,
} from "@/lib/integrations/calendar/pull-adapter";
import {
  registerWatchChannel,
  stopWatchChannel,
} from "@/lib/integrations/calendar/watch-adapter";
import {
  readConnectionTokens,
  persistRefreshedTokens,
  markConnectionSynced,
  markConnectionError,
  listPushedExternalEventIds,
  listConnectedCalendarConnections,
  listOrgCalendarConnectionStates,
  upsertPulledEvents,
  findWatchChannelByChannelId,
  readWatchChannel,
  upsertWatchChannel,
  updateWatchSyncState,
  markWatchNotified,
  deleteWatchChannel,
} from "@/lib/integrations/calendar/token-store";

/**
 * Calendar two-way sync — the PULL composer. The inbound mirror of the push
 * composition in server/services/calendar-connections.ts (which handles the
 * outbound job/rota → event push). This module:
 *
 *   1. INBOUND PULL — fetch a window of provider events, DEDUP against events
 *      CrewFlow itself pushed (stored external id OR body marker), and upsert the
 *      survivors into calendar_pulled_events (the internal representation).
 *   2. FREE-BUSY — a scheduling-awareness read of busy intervals (no persistence).
 *   3. WATCH CHANNELS — register / stop a provider push-notification channel, and
 *      handle a verified inbound notification by triggering an incremental pull.
 *
 * ── DARK, EXACTLY LIKE THE PUSH COMPOSER ────────────────────────────────────
 * Every entry point gates on the feature flag / connectability FIRST and returns
 * `skipped_dark` WITHOUT any provider network call or DB write when no live
 * provider is reachable — the same two-switch + refuse-before-fetch posture the
 * push side uses. The token columns are read only via the service-role store
 * (this tenant-facing module never selects a token column), decrypted on use
 * immediately before the provider call.
 *
 * ── DEDUP IS AUTHORITATIVE ──────────────────────────────────────────────────
 * An event is treated as CrewFlow-origin when its external id is in the pushed
 * set (calendar_event_links) OR its body carries the CrewFlow marker. It is still
 * recorded (with is_crewflow_origin=true) so the mirror is faithful, but
 * scheduling ignores those rows — a pushed job is never re-imported as an external
 * commitment.
 */

export type PullSummary = {
  ok: boolean;
  status: "pulled" | "skipped_dark" | "not_connected" | "error";
  provider: CalendarProvider | null;
  /** Total events fetched from the provider in the window. */
  fetched: number;
  /** How many were recognised as CrewFlow-origin (deduped). */
  deduped: number;
  /** How many rows were upserted (fetched — cancellations handled as upserts). */
  imported: number;
  message: string;
};

/**
 * Resolve the org's single connected + connectable provider, or a dark/absent
 * reason. SERVICE-ROLE (token-free, org-pinned): the composer's entry points run
 * with NO user session (the provider webhook, the cron tick), where a tenant
 * read would see zero rows under RLS and misreport "not connected" — the exact
 * failure that previously broke the webhook → pull path end to end.
 */
async function resolveLiveProvider(
  orgId: string,
): Promise<
  | { ok: true; provider: CalendarProvider }
  | { ok: false; provider: CalendarProvider | null; reason: "not_connected" | "skipped_dark" }
> {
  const connections = await listOrgCalendarConnectionStates(orgId);
  const active = connections.find((c) => c.status === "connected") ?? null;
  if (!active) return { ok: false, provider: null, reason: "not_connected" };
  if (!isCalendarProviderConnectable(active.provider)) {
    return { ok: false, provider: active.provider, reason: "skipped_dark" };
  }
  return { ok: true, provider: active.provider };
}

function windowBounds(days: number): { timeMin: string; timeMax: string } {
  const now = Date.now();
  const span = days * 24 * 60 * 60 * 1000;
  return {
    timeMin: new Date(now - span).toISOString(),
    timeMax: new Date(now + span).toISOString(),
  };
}

/**
 * Pull a window of provider events into calendar_pulled_events, deduped against
 * events CrewFlow pushed. Org-pinned. Returns `skipped_dark` with no provider
 * call while dark. Uses the stored incremental sync token when present.
 */
export async function pullCalendarEvents(
  orgId: string,
  opts?: { windowDays?: number },
): Promise<PullSummary> {
  const resolved = await resolveLiveProvider(orgId);
  if (!resolved.ok) {
    return {
      ok: resolved.reason === "skipped_dark",
      status: resolved.reason,
      provider: resolved.provider,
      fetched: 0,
      deduped: 0,
      imported: 0,
      message:
        resolved.reason === "skipped_dark"
          ? "No connected calendar with live credentials; nothing was pulled."
          : "No connected calendar to pull from.",
    };
  }
  const provider = resolved.provider;

  const stored = await readConnectionTokens(orgId, provider);
  if (!stored) {
    return {
      ok: false,
      status: "error",
      provider,
      fetched: 0,
      deduped: 0,
      imported: 0,
      message: "The connected calendar has no stored credentials to pull with.",
    };
  }
  const tokens = decryptStoredTokens({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  });

  const watch = await readWatchChannel(orgId, stored.connectionId);
  const { timeMin, timeMax } = windowBounds(opts?.windowDays ?? DEFAULT_PULL_WINDOW_DAYS);

  const result = await pullEvents({
    provider,
    tokens,
    timeMin,
    timeMax,
    syncToken: watch?.syncToken ?? null,
  });

  // Persist any token the pull refreshed, regardless of outcome.
  if (result.refreshed) {
    await persistRefreshedTokens(orgId, provider, result.refreshed);
  }

  if (!result.ok) {
    if (result.terminal) {
      await markConnectionError(orgId, provider, result.message);
    }
    return {
      ok: false,
      status: "error",
      provider,
      fetched: 0,
      deduped: 0,
      imported: 0,
      message: `Calendar pull failed: ${result.message}`,
    };
  }

  // DEDUP. An event whose external id was pushed by CrewFlow, or whose body
  // carries the CrewFlow marker, is our own — flag it so scheduling ignores it.
  const pushedIds = await listPushedExternalEventIds(orgId, stored.connectionId);
  let deduped = 0;
  const decorated = result.events.map((e: PulledEvent) => {
    const isCrewflowOrigin =
      e.isCrewflowOrigin || pushedIds.has(e.externalEventId) || hasCrewflowMarker(e.summary);
    if (isCrewflowOrigin) deduped += 1;
    return { ...e, isCrewflowOrigin };
  });

  await upsertPulledEvents(orgId, stored.connectionId, decorated);

  // Persist the incremental cursor for the next pull (Google) + mark healthy.
  if (watch) {
    await updateWatchSyncState(orgId, stored.connectionId, {
      syncToken: result.nextSyncToken,
      status: "active",
      lastError: null,
    });
  }
  await markConnectionSynced(orgId, provider);

  return {
    ok: true,
    status: "pulled",
    provider,
    fetched: result.events.length,
    deduped,
    imported: decorated.length,
    message: `Pulled ${decorated.length} events from the ${provider} calendar (${deduped} CrewFlow-origin skipped for scheduling).`,
  };
}

export type FreeBusySummary =
  | { ok: true; status: "ok"; provider: CalendarProvider; busy: FreeBusyInterval[] }
  | {
      ok: boolean;
      status: "skipped_dark" | "not_connected" | "error";
      provider: CalendarProvider | null;
      busy: FreeBusyInterval[];
      message: string;
    };

/** Read busy intervals for scheduling awareness. Org-pinned; skipped_dark while dark. */
export async function getCalendarFreeBusy(
  orgId: string,
  timeMin: string,
  timeMax: string,
): Promise<FreeBusySummary> {
  const resolved = await resolveLiveProvider(orgId);
  if (!resolved.ok) {
    return {
      ok: resolved.reason === "skipped_dark",
      status: resolved.reason,
      provider: resolved.provider,
      busy: [],
      message:
        resolved.reason === "skipped_dark"
          ? "No connected calendar with live credentials; no free-busy was read."
          : "No connected calendar to read free-busy from.",
    };
  }
  const provider = resolved.provider;

  const stored = await readConnectionTokens(orgId, provider);
  if (!stored) {
    return {
      ok: false,
      status: "error",
      provider,
      busy: [],
      message: "The connected calendar has no stored credentials.",
    };
  }
  const tokens = decryptStoredTokens({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  });

  // Microsoft getSchedule needs the account handle; Google ignores it. Read it
  // through the service-role token-free projection — this path may also run
  // without a user session (see resolveLiveProvider).
  const connections = await listOrgCalendarConnectionStates(orgId);
  const account = connections.find((c) => c.provider === provider)?.externalAccountId ?? null;

  const result = await pullFreeBusy({ provider, tokens, timeMin, timeMax, account });
  if (result.refreshed) {
    await persistRefreshedTokens(orgId, provider, result.refreshed);
  }
  if (!result.ok) {
    if (result.terminal) {
      await markConnectionError(orgId, provider, result.message);
    }
    return {
      ok: false,
      status: "error",
      provider,
      busy: [],
      message: `Free-busy read failed: ${result.message}`,
    };
  }
  return { ok: true, status: "ok", provider, busy: result.busy };
}

/** How long a registered watch channel should live (ms). Providers cap this; we re-register on renewal. */
const WATCH_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days (Microsoft's event ceiling)

export type WatchSummary = {
  ok: boolean;
  status: "registered" | "skipped_dark" | "not_connected" | "error";
  provider: CalendarProvider | null;
  channelId: string | null;
  message: string;
};

/**
 * Register a provider push-notification channel for the org's connected calendar,
 * pointing at the CrewFlow webhook receiver. Org-pinned; skipped_dark while dark
 * (no provider call). Mints a per-channel verification secret, hands it to the
 * provider, and stores it (encrypted) so an inbound notification can be verified.
 */
export async function registerCalendarWatch(
  orgId: string,
  appOrigin: string,
): Promise<WatchSummary> {
  const resolved = await resolveLiveProvider(orgId);
  if (!resolved.ok) {
    return {
      ok: resolved.reason === "skipped_dark",
      status: resolved.reason,
      provider: resolved.provider,
      channelId: null,
      message:
        resolved.reason === "skipped_dark"
          ? "No connected calendar with live credentials; no watch channel was registered."
          : "No connected calendar to watch.",
    };
  }
  const provider = resolved.provider;

  const stored = await readConnectionTokens(orgId, provider);
  if (!stored) {
    return {
      ok: false,
      status: "error",
      provider,
      channelId: null,
      message: "The connected calendar has no stored credentials.",
    };
  }
  const tokens = decryptStoredTokens({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  });

  const channelId = randomUUID();
  const verificationToken = randomUUID();
  const notificationUrl = `${appOrigin.replace(/\/$/, "")}/api/integrations/calendar/${provider}/webhook`;

  const result = await registerWatchChannel({
    provider,
    tokens,
    notificationUrl,
    verificationToken,
    channelId,
    ttlMs: WATCH_TTL_MS,
  });
  if (result.refreshed) {
    await persistRefreshedTokens(orgId, provider, result.refreshed);
  }
  if (!result.ok) {
    if (result.terminal) {
      await markConnectionError(orgId, provider, result.message);
    }
    return {
      ok: false,
      status: "error",
      provider,
      channelId: null,
      message: `Watch registration failed: ${result.message}`,
    };
  }

  await upsertWatchChannel({
    orgId,
    connectionId: stored.connectionId,
    provider,
    channelId: result.watch.channelId,
    resourceId: result.watch.resourceId,
    verificationToken,
    expiration: result.watch.expiration,
    syncToken: null,
  });

  return {
    ok: true,
    status: "registered",
    provider,
    channelId: result.watch.channelId,
    message: `Registered a ${provider} calendar watch channel.`,
  };
}

/** Stop the org's watch channel (provider teardown + row delete). Org-pinned; skipped_dark while dark. */
export async function stopCalendarWatch(orgId: string): Promise<WatchSummary> {
  const resolved = await resolveLiveProvider(orgId);
  if (!resolved.ok) {
    return {
      ok: resolved.reason === "skipped_dark",
      status: resolved.reason,
      provider: resolved.provider,
      channelId: null,
      message: "No live provider; nothing to stop.",
    };
  }
  const provider = resolved.provider;
  const stored = await readConnectionTokens(orgId, provider);
  if (!stored) {
    return { ok: false, status: "error", provider, channelId: null, message: "No stored credentials." };
  }
  const watch = await readWatchChannel(orgId, stored.connectionId);
  if (!watch) {
    return { ok: true, status: "registered", provider, channelId: null, message: "No watch channel to stop." };
  }
  const tokens = decryptStoredTokens({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  });
  const result = await stopWatchChannel({
    provider,
    tokens,
    channelId: watch.channelId,
    resourceId: watch.resourceId,
  });
  if (result.refreshed) {
    await persistRefreshedTokens(orgId, provider, result.refreshed);
  }
  if (!result.ok) {
    return { ok: false, status: "error", provider, channelId: watch.channelId, message: result.message };
  }
  await deleteWatchChannel(orgId, stored.connectionId);
  return { ok: true, status: "registered", provider, channelId: watch.channelId, message: "Watch channel stopped." };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON TICK — watch renewal + bounded periodic pull reconciliation.
// ─────────────────────────────────────────────────────────────────────────────

/** Renew a watch channel this close to (or past) its expiry. Providers cap TTLs
 * (Microsoft ~3 days), so a 6-hourly tick with a 24h renewal window re-registers
 * every channel comfortably before it lapses. */
const WATCH_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The most connections one tick processes — bounded fan-out; the oldest-synced
 * rows go first, so a backlog larger than this drains across ticks. */
const MAX_CONNECTIONS_PER_TICK = 100;

/**
 * Wall-clock PASS BUDGET (the bank-sync/telematics fairness pattern). The cron
 * route's maxDuration is 60s; stopping at 45s leaves headroom to return the
 * summary. Combined with the oldest-synced-first cursor (the lister orders by
 * last_sync_at ASC NULLS FIRST, and a successful pull advances last_sync_at,
 * rotating the connection to the back), a truncated pass resumes from the tail
 * next tick instead of re-servicing the same head forever.
 */
export const PASS_BUDGET_MS = 45_000;

/** Stop BEFORE starting a connection the pass cannot finish inside the budget. */
const PER_CONNECTION_BUDGET_MS = 10_000;

export type CalendarSyncOrgOutcome = {
  orgId: string;
  provider: CalendarProvider;
  /** What happened to the watch channel this tick. */
  watch: "kept" | "registered" | "skipped_dark" | "error";
  /** What happened to the pull this tick. */
  pull: PullSummary["status"];
  ok: boolean;
  message: string;
};

export type CalendarSyncTickSummary = {
  ran: boolean;
  status: "ok" | "skipped_dark";
  connections: number;
  outcomes: CalendarSyncOrgOutcome[];
};

/**
 * One scheduled calendar-sync tick: for every org with a `connected` calendar
 * (bounded, oldest-synced first), (a) RENEW the provider watch channel when it is
 * missing or expiring inside the renewal window — provider watches are
 * short-lived by design, so without this the push-notification path silently
 * dies days after connect — and (b) run a PULL reconciliation, which both drains
 * anything a lost notification skipped and advances the incremental sync cursor.
 *
 * DARK-SAFE. The feature flag short-circuit comes FIRST (no DB read at all while
 * the integration is dark — ALWAYS today); per-connection, a provider that is no
 * longer connectable is skipped before any provider call (the same guard every
 * entry point here uses). Zero connected calendars ⇒ `ran: true` with zero
 * outcomes, which the cron route reports as a cheap no-op.
 *
 * NEVER THROWS per org: one org's dead grant must not starve the rest of the
 * tick. Idempotent: pulls upsert on (connection, external event id) and watch
 * registration upserts the single per-connection channel row.
 */
export async function runCalendarSyncTick(
  appOrigin: string,
  opts: { now?: () => number; passBudgetMs?: number; perConnectionBudgetMs?: number } = {},
): Promise<CalendarSyncTickSummary> {
  // DARK GUARD FIRST — no DB access while the integration is dark.
  if (!calendarConnectFeatureEnabled()) {
    return { ran: false, status: "skipped_dark", connections: 0, outcomes: [] };
  }

  const now = opts.now ?? Date.now;
  const passBudgetMs = opts.passBudgetMs ?? PASS_BUDGET_MS;
  const perConnectionBudgetMs = opts.perConnectionBudgetMs ?? PER_CONNECTION_BUDGET_MS;
  const startedAt = now();

  const connections = await listConnectedCalendarConnections(MAX_CONNECTIONS_PER_TICK);
  const outcomes: CalendarSyncOrgOutcome[] = [];
  // The composer's org-level semantics (resolveLiveProvider) service ONE live
  // provider per org, so an org that somehow holds two connected rows is
  // processed once per tick, not twice against the same provider.
  const seenOrgs = new Set<string>();

  for (const conn of connections) {
    if (seenOrgs.has(conn.orgId)) continue;
    seenOrgs.add(conn.orgId);
    // WALL-CLOCK PASS BUDGET: never BEGIN a connection the pass cannot finish.
    // The fairness cursor (oldest-synced first; a pull advances last_sync_at)
    // means the connections left behind lead the next pass.
    if (now() - startedAt + perConnectionBudgetMs > passBudgetMs) break;
    // Per-connection dark guard — a provider whose credentials were pulled since
    // connect is skipped without any provider work.
    if (!isCalendarProviderConnectable(conn.provider)) {
      outcomes.push({
        orgId: conn.orgId,
        provider: conn.provider,
        watch: "skipped_dark",
        pull: "skipped_dark",
        ok: true,
        message: "provider no longer connectable; skipped",
      });
      continue;
    }

    let watchOutcome: CalendarSyncOrgOutcome["watch"] = "kept";
    let pullOutcome: PullSummary["status"] = "error";
    let ok = true;
    let message = "";

    // (a) WATCH RENEWAL — register when absent or expiring within the window.
    try {
      const watch = await readWatchChannel(conn.orgId, conn.connectionId);
      const expiresAtMs = watch?.expiration ? Date.parse(watch.expiration) : NaN;
      const needsRenewal =
        !watch ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs - Date.now() <= WATCH_RENEW_WINDOW_MS;
      if (needsRenewal) {
        const registered = await registerCalendarWatch(conn.orgId, appOrigin);
        watchOutcome = registered.ok && registered.status === "registered" ? "registered" : "error";
        if (!registered.ok) {
          ok = false;
          message = registered.message;
        }
      }
    } catch (e) {
      watchOutcome = "error";
      ok = false;
      message = e instanceof Error ? e.message : "watch renewal failed";
    }

    // (b) PULL RECONCILIATION — drains missed notifications, advances the cursor.
    try {
      const pulled = await pullCalendarEvents(conn.orgId);
      pullOutcome = pulled.status;
      if (!pulled.ok) {
        ok = false;
        message = message || pulled.message;
      } else if (!message) {
        message = pulled.message;
      }
    } catch (e) {
      pullOutcome = "error";
      ok = false;
      message = message || (e instanceof Error ? e.message : "pull failed");
    }

    outcomes.push({
      orgId: conn.orgId,
      provider: conn.provider,
      watch: watchOutcome,
      pull: pullOutcome,
      ok,
      message,
    });
  }

  return { ran: true, status: "ok", connections: connections.length, outcomes };
}

export type InboundResult = {
  ok: boolean;
  verified: boolean;
  status: "synced" | "unknown_channel" | "invalid_token" | "skipped_dark" | "error";
};

/** Constant-time compare of two secrets — never a bare string `===` on a token. */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Handle a verified inbound provider notification: resolve the watch channel by
 * its (unauthenticated) channel id, CONSTANT-TIME verify the echoed token against
 * the stored secret, then trigger an incremental pull for that org. Refuses before
 * any provider fetch while dark. This is the ONLY path a webhook may take to
 * cross the trust boundary from an unauthenticated request into an org's data.
 */
export async function handleInboundNotification(params: {
  provider: CalendarProvider;
  channelId: string;
  providedToken: string | null;
}): Promise<InboundResult> {
  const { provider, channelId, providedToken } = params;

  // DARK GUARD FIRST. Not connectable → no provider work at all.
  if (!isCalendarProviderConnectable(provider)) {
    return { ok: true, verified: false, status: "skipped_dark" };
  }

  const watch = await findWatchChannelByChannelId(channelId);
  // An unknown channel, a provider mismatch, or a missing stored secret cannot be
  // verified — treat as an unrecognised (but non-fatal) notification.
  if (!watch || watch.provider !== provider || !watch.verificationToken) {
    return { ok: true, verified: false, status: "unknown_channel" };
  }

  const expected = decryptToken(watch.verificationToken);
  if (!providedToken || !secretsMatch(providedToken, expected)) {
    return { ok: true, verified: false, status: "invalid_token" };
  }

  await markWatchNotified(watch.orgId, watch.connectionId);
  const pulled = await pullCalendarEvents(watch.orgId);
  return {
    ok: pulled.ok,
    verified: true,
    status: pulled.ok ? "synced" : "error",
  };
}

/**
 * Best-effort inbound handler for the webhook route: a DARK gate first (no
 * DB/network while the feature flag is off, ALWAYS today), then delegate and
 * SWALLOW every failure so a provider notification never 500s the receiver.
 */
export async function bestEffortHandleInbound(params: {
  provider: CalendarProvider;
  channelId: string;
  providedToken: string | null;
}): Promise<InboundResult> {
  if (!calendarConnectFeatureEnabled()) {
    return { ok: true, verified: false, status: "skipped_dark" };
  }
  try {
    return await handleInboundNotification(params);
  } catch (e) {
    console.error("[calendar] inbound notification handling threw", {
      provider: params.provider,
      message: e instanceof Error ? e.message : "unknown error",
    });
    return { ok: false, verified: false, status: "error" };
  }
}
