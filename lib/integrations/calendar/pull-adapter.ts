import "server-only";

import {
  isCalendarProviderConnectable,
  refreshAccessToken,
  type CalendarProvider,
} from "./oauth";

/**
 * Calendar event-PULL adapter — the provider HTTP half of the inbound sync.
 *
 * This is the mirror of push-adapter.ts for the OTHER direction. Where the push
 * adapter serialises a CrewFlow entity into a provider event and POST/PATCHes it,
 * this adapter FETCHES provider events (Google events.list / Microsoft
 * calendarView) and NORMALISES them into one internal representation
 * (`PulledEvent`), plus a free-busy read for scheduling awareness. It writes
 * nothing to the DB — the composer (server/services/calendar-pull.ts) owns
 * persistence and dedup; this module is pure fetch + deterministic normalisation.
 *
 * ── DARK BY DEFAULT (identical to push-adapter) ─────────────────────────────
 * Every network function REFUSES (returns { reason:'not_configured' }, NO
 * `fetch`) when the provider is not connectable — no client credentials +
 * FEATURE_CALENDAR_CONNECT. Every `fetch` lives strictly AFTER that guard, so
 * the provider call is structurally unreachable dark. No token is ever logged.
 *
 * ── 401 → REFRESH → RETRY-ONCE (identical to push-adapter) ───────────────────
 * A 401 on the first request refreshes the access token with the stored refresh
 * token and retries ONCE; the refreshed tokens are returned so the caller
 * persists them. On a paged pull the refreshed token is threaded across pages.
 *
 * ── F-1 PAGINATION ──────────────────────────────────────────────────────────
 * A provider events list is paginated (Google nextPageToken / Microsoft
 * @odata.nextLink). A single-page read would SILENTLY import only the first page
 * — the same truncation class the DB-side F-1 guard exists to stop. `pullEvents`
 * follows the provider cursor to completion, bounded by MAX_PULL_PAGES so a
 * runaway cursor cannot spin forever.
 *
 * ── DETERMINISTIC NORMALISATION ─────────────────────────────────────────────
 * All timestamps are normalised to absolute UTC instants; provider-native fields
 * map onto a fixed `PulledEvent` shape; the output is sorted on (startsAt,
 * externalEventId) so the same provider payload always yields the same rows.
 */

/** A provider calendar event, normalised into CrewFlow's internal representation. */
export type PulledEvent = {
  /** The provider-side event handle (Google event id / Microsoft event id). */
  externalEventId: string;
  /** Provider stable cross-instance id (Google iCalUID / Microsoft iCalUId), if any. */
  icalUid: string | null;
  summary: string | null;
  location: string | null;
  /** Absolute UTC instant (ISO). Null for an all-day / date-only bound. */
  startsAt: string | null;
  endsAt: string | null;
  isAllDay: boolean;
  /** Provider status: "confirmed" | "tentative" | "cancelled" (best-effort passthrough). */
  status: string | null;
  /** Does this event BLOCK time? (Google transparency / Microsoft showAs.) */
  isBusy: boolean;
  /**
   * True when this event carries the CrewFlow marker in its body — i.e. it is an
   * event CrewFlow itself pushed. The composer OR-s this with a stored-external-id
   * match for the authoritative dedup decision. Detected purely from the provider
   * payload so the adapter needs no DB access.
   */
  isCrewflowOrigin: boolean;
  etag: string | null;
  /** Provider last-modified instant (ISO UTC), for change detection. */
  providerUpdatedAt: string | null;
};

/** A busy interval from a free-busy read (absolute UTC instants). */
export type FreeBusyInterval = { start: string; end: string };

/**
 * The marker the push adapter writes into every pushed event's description /
 * body ("CrewFlow job <uuid>" / "CrewFlow rota shift <uuid>"). Matching it lets
 * the pull path recognise an event CrewFlow itself pushed even before the stored
 * external-id lookup — a second, body-level dedup signal.
 */
export const CREWFLOW_EVENT_MARKER = /CrewFlow (?:job|rota shift) [0-9a-fA-F-]{36}/;

/** True when `text` carries the CrewFlow pushed-event marker. */
export function hasCrewflowMarker(text: string | null | undefined): boolean {
  return typeof text === "string" && CREWFLOW_EVENT_MARKER.test(text);
}

/** Parse any provider timestamp to an absolute UTC ISO instant, or null. */
function toUtcIso(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Microsoft Graph returns { dateTime, timeZone } where dateTime has NO offset
 * (e.g. "2026-09-01T08:00:00.0000000"); we request Prefer: outlook.timezone="UTC"
 * so it is UTC wall-clock. Append 'Z' when the string carries no offset so it is
 * parsed as UTC rather than the server's local zone.
 */
function msDateTimeToIso(dt: { dateTime?: string; timeZone?: string } | null | undefined): string | null {
  const raw = dt?.dateTime;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(raw);
  return toUtcIso(hasTz ? raw : `${raw}Z`);
}

/** Normalise a Google Calendar events.list item. Returns null when it has no id. */
export function normalizeGoogleEvent(raw: unknown): PulledEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === "string" ? e.id : null;
  if (!id) return null;

  const start = (e.start ?? null) as { dateTime?: string; date?: string } | null;
  const end = (e.end ?? null) as { dateTime?: string; date?: string } | null;
  const isAllDay = !!start?.date && !start?.dateTime;
  const startsAt = start?.dateTime
    ? toUtcIso(start.dateTime)
    : start?.date
      ? toUtcIso(`${start.date}T00:00:00Z`)
      : null;
  const endsAt = end?.dateTime
    ? toUtcIso(end.dateTime)
    : end?.date
      ? toUtcIso(`${end.date}T00:00:00Z`)
      : null;

  const status = typeof e.status === "string" ? e.status : null;
  const cancelled = status === "cancelled";
  // Google `transparency`: "transparent" = free, otherwise (default absent) busy.
  const transparent = e.transparency === "transparent";
  const description = typeof e.description === "string" ? e.description : null;
  const summary = typeof e.summary === "string" ? e.summary : null;

  return {
    externalEventId: id,
    icalUid: typeof e.iCalUID === "string" ? e.iCalUID : null,
    summary,
    location: typeof e.location === "string" ? e.location : null,
    startsAt,
    endsAt,
    isAllDay,
    status,
    isBusy: !cancelled && !transparent,
    isCrewflowOrigin: hasCrewflowMarker(description) || hasCrewflowMarker(summary),
    etag: typeof e.etag === "string" ? e.etag : null,
    providerUpdatedAt: toUtcIso(typeof e.updated === "string" ? e.updated : null),
  };
}

/** Normalise a Microsoft Graph calendarView item. Returns null when it has no id. */
export function normalizeMicrosoftEvent(raw: unknown): PulledEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === "string" ? e.id : null;
  if (!id) return null;

  const isAllDay = e.isAllDay === true;
  const startsAt = msDateTimeToIso(e.start as { dateTime?: string; timeZone?: string } | null);
  const endsAt = msDateTimeToIso(e.end as { dateTime?: string; timeZone?: string } | null);

  const cancelled = e.isCancelled === true;
  // Microsoft `showAs`: "free" | "tentative" | "busy" | "oof" | "workingElsewhere".
  const showAs = typeof e.showAs === "string" ? e.showAs : "busy";
  const isBusy = !cancelled && showAs !== "free" && showAs !== "workingElsewhere";
  const status = cancelled ? "cancelled" : showAs === "tentative" ? "tentative" : "confirmed";

  const location = (e.location ?? null) as { displayName?: string } | null;
  const body = (e.body ?? null) as { content?: string } | null;
  const bodyText =
    (typeof body?.content === "string" ? body.content : null) ??
    (typeof e.bodyPreview === "string" ? e.bodyPreview : null);
  const subject = typeof e.subject === "string" ? e.subject : null;

  return {
    externalEventId: id,
    icalUid: typeof e.iCalUId === "string" ? e.iCalUId : null,
    summary: subject,
    location: typeof location?.displayName === "string" ? location.displayName : null,
    startsAt,
    endsAt,
    isAllDay,
    status,
    isBusy,
    isCrewflowOrigin: hasCrewflowMarker(bodyText) || hasCrewflowMarker(subject),
    etag: typeof e["@odata.etag"] === "string" ? (e["@odata.etag"] as string) : null,
    providerUpdatedAt: toUtcIso(
      typeof e.lastModifiedDateTime === "string" ? e.lastModifiedDateTime : null,
    ),
  };
}

type ProviderPullApi = {
  /** Build the FIRST page URL for the events window (or an incremental sync). */
  buildListUrl: (opts: {
    timeMin: string;
    timeMax: string;
    syncToken: string | null;
    pageSize: number;
  }) => string;
  /** Extra request headers (e.g. Microsoft's UTC timezone preference). */
  headers: Record<string, string>;
  readItems: (json: Record<string, unknown>) => unknown[];
  /** The URL of the next page, or null when the last page is reached. */
  nextPageUrl: (json: Record<string, unknown>, currentUrl: string) => string | null;
  /** The incremental cursor to persist for the next pull (Google), else null. */
  readSyncToken: (json: Record<string, unknown>) => string | null;
  normalize: (raw: unknown) => PulledEvent | null;
  /** Free-busy request (URL, body) for this provider. `account` is the connection handle. */
  freeBusyRequest: (opts: {
    timeMin: string;
    timeMax: string;
    account: string | null;
  }) => { url: string; body: Record<string, unknown> } | null;
  readFreeBusy: (json: Record<string, unknown>) => FreeBusyInterval[];
};

/** Set (or replace) one query param on an absolute URL, returning the new string. */
function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

const PULL_API: Record<CalendarProvider, ProviderPullApi> = {
  google: {
    buildListUrl: ({ timeMin, timeMax, syncToken, pageSize }) => {
      const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("maxResults", String(pageSize));
      // Deleted events must propagate so a cancellation is reflected internally.
      u.searchParams.set("showDeleted", "true");
      if (syncToken) {
        // syncToken is mutually exclusive with a time window / most filters.
        u.searchParams.set("syncToken", syncToken);
      } else {
        u.searchParams.set("timeMin", timeMin);
        u.searchParams.set("timeMax", timeMax);
      }
      return u.toString();
    },
    headers: {},
    readItems: (j) => (Array.isArray(j.items) ? (j.items as unknown[]) : []),
    nextPageUrl: (j, currentUrl) =>
      typeof j.nextPageToken === "string"
        ? withParam(currentUrl, "pageToken", j.nextPageToken)
        : null,
    readSyncToken: (j) => (typeof j.nextSyncToken === "string" ? j.nextSyncToken : null),
    normalize: normalizeGoogleEvent,
    freeBusyRequest: ({ timeMin, timeMax }) => ({
      url: "https://www.googleapis.com/calendar/v3/freeBusy",
      body: { timeMin, timeMax, items: [{ id: "primary" }] },
    }),
    readFreeBusy: (j) => {
      const calendars = (j.calendars ?? null) as Record<string, { busy?: unknown }> | null;
      const primary = calendars?.primary ?? null;
      const busy = Array.isArray(primary?.busy) ? (primary!.busy as unknown[]) : [];
      return busy
        .map((b) => {
          const iv = b as { start?: string; end?: string };
          const start = toUtcIso(iv.start);
          const end = toUtcIso(iv.end);
          return start && end ? { start, end } : null;
        })
        .filter((x): x is FreeBusyInterval => x !== null);
    },
  },
  microsoft: {
    buildListUrl: ({ timeMin, timeMax, pageSize }) => {
      const u = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
      u.searchParams.set("startDateTime", timeMin);
      u.searchParams.set("endDateTime", timeMax);
      u.searchParams.set("$top", String(pageSize));
      return u.toString();
    },
    // Return all times as UTC wall-clock so msDateTimeToIso can treat them as UTC.
    headers: { Prefer: 'outlook.timezone="UTC"' },
    readItems: (j) => (Array.isArray(j.value) ? (j.value as unknown[]) : []),
    nextPageUrl: (j) =>
      typeof j["@odata.nextLink"] === "string" ? (j["@odata.nextLink"] as string) : null,
    // calendarView is a windowed snapshot, not a delta stream — no sync token.
    readSyncToken: () => null,
    normalize: normalizeMicrosoftEvent,
    freeBusyRequest: ({ timeMin, timeMax, account }) =>
      account
        ? {
            url: "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
            body: {
              schedules: [account],
              startTime: { dateTime: timeMin, timeZone: "UTC" },
              endTime: { dateTime: timeMax, timeZone: "UTC" },
              availabilityViewInterval: 30,
            },
          }
        : null,
    readFreeBusy: (j) => {
      const value = Array.isArray(j.value) ? (j.value as unknown[]) : [];
      const first = (value[0] ?? null) as { scheduleItems?: unknown } | null;
      const items = Array.isArray(first?.scheduleItems) ? (first!.scheduleItems as unknown[]) : [];
      return items
        .map((it) => {
          const s = it as { status?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
          if (s.status === "free") return null;
          const start = msDateTimeToIso(s.start);
          const end = msDateTimeToIso(s.end);
          return start && end ? { start, end } : null;
        })
        .filter((x): x is FreeBusyInterval => x !== null);
    },
  },
};

/** Google event-API `reason` codes that are TRANSIENT rate limits (mirrors push-adapter). */
const GOOGLE_TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
]);

function googleErrorReasons(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return [];
  const errors = (err as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => (e && typeof e === "object" ? (e as { reason?: unknown }).reason : null))
    .filter((r): r is string => typeof r === "string");
}

function googleErrorStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

/**
 * Classify a still-failing pull/free-busy response as TERMINAL (dead grant /
 * genuine authz denial → caller flips status='error') or TRANSIENT (throttle /
 * blip → connection self-heals). Mirrors push-adapter's classifier exactly: 401
 * is terminal; a 403 is terminal UNLESS the body carries a Google rate-limit
 * signal; anything else (5xx / 429 / 410) is transient.
 */
async function classifyPullFailure(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return true; // unreadable 403 → assume authz denial (terminal)
  }
  if (googleErrorStatus(body) === "RESOURCE_EXHAUSTED") return false;
  if (googleErrorReasons(body).some((r) => GOOGLE_TRANSIENT_REASONS.has(r))) return false;
  return true;
}

type Tokens = { accessToken: string; refreshToken: string | null };
type Refreshed = { accessToken: string; refreshToken: string | null; expiresAt: string | null };

export type PullResult =
  | { ok: true; events: PulledEvent[]; nextSyncToken: string | null; refreshed?: Refreshed }
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      terminal?: boolean;
      refreshed?: Refreshed;
    };

export type FreeBusyResult =
  | { ok: true; busy: FreeBusyInterval[]; refreshed?: Refreshed }
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      terminal?: boolean;
      refreshed?: Refreshed;
    };

/** Page-count ceiling so a runaway provider cursor cannot spin forever. */
export const MAX_PULL_PAGES = 20;
/** Per-page event count — bounded well under any single-org window volume. */
export const PULL_PAGE_SIZE = 250;
/** Default look-back / look-ahead window (days) when the caller passes none. */
export const DEFAULT_PULL_WINDOW_DAYS = 90;

/**
 * A GET that refreshes-then-retries on a single 401. Returns the response plus
 * any refreshed tokens (so the caller both threads them to later pages and
 * persists them). A refresh failure is surfaced as a synthetic terminal/transient
 * signal via `refreshError`.
 */
async function authedGet(
  provider: CalendarProvider,
  url: string,
  tokens: Tokens,
  extraHeaders: Record<string, string>,
): Promise<
  | { kind: "res"; res: Response; refreshed?: Refreshed }
  | { kind: "refresh_failed"; message: string; terminal: boolean }
> {
  const doFetch = (accessToken: string) =>
    fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...extraHeaders,
      },
    });

  let res = await doFetch(tokens.accessToken);
  if (res.status === 401 && tokens.refreshToken) {
    const r = await refreshAccessToken({ provider, refreshToken: tokens.refreshToken });
    if (!r.ok) {
      return { kind: "refresh_failed", message: r.message, terminal: r.terminal === true };
    }
    res = await doFetch(r.tokens.accessToken);
    return { kind: "res", res, refreshed: r.tokens };
  }
  return { kind: "res", res };
}

/**
 * Fetch + normalise provider events across the whole window, following the
 * provider pagination cursor to completion (bounded by MAX_PULL_PAGES). REFUSES
 * (no `fetch`) when the provider is not connectable — structurally dark.
 *
 * `syncToken` (Google) requests an incremental pull since the last sync; when the
 * provider rejects it as expired (410) the caller should retry with a null token
 * for a full-window pull.
 */
export async function pullEvents(params: {
  provider: CalendarProvider;
  tokens: Tokens;
  timeMin: string;
  timeMax: string;
  syncToken?: string | null;
  pageSize?: number;
}): Promise<PullResult> {
  const { provider, tokens, timeMin, timeMax } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  if (!isCalendarProviderConnectable(provider)) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} calendar is not configured; nothing was pulled.`,
    };
  }

  const api = PULL_API[provider];
  const pageSize = params.pageSize ?? PULL_PAGE_SIZE;
  let url: string | null = api.buildListUrl({
    timeMin,
    timeMax,
    syncToken: params.syncToken ?? null,
    pageSize,
  });

  const events: PulledEvent[] = [];
  const seen = new Set<string>();
  let nextSyncToken: string | null = null;
  let currentTokens: Tokens = tokens;
  let refreshed: Refreshed | undefined;

  for (let page = 0; page < MAX_PULL_PAGES && url; page++) {
    let attempt: Awaited<ReturnType<typeof authedGet>>;
    try {
      attempt = await authedGet(provider, url, currentTokens, api.headers);
    } catch (e) {
      return {
        ok: false,
        reason: "error",
        message: `event pull request failed: ${e instanceof Error ? e.message : "network error"}`,
        ...(refreshed ? { refreshed } : {}),
      };
    }

    if (attempt.kind === "refresh_failed") {
      return {
        ok: false,
        reason: "error",
        message: `token refresh failed: ${attempt.message}`,
        terminal: attempt.terminal,
        ...(refreshed ? { refreshed } : {}),
      };
    }

    if (attempt.refreshed) {
      refreshed = attempt.refreshed;
      currentTokens = {
        accessToken: attempt.refreshed.accessToken,
        refreshToken: attempt.refreshed.refreshToken ?? currentTokens.refreshToken,
      };
    }

    const res = attempt.res;
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message: `event pull returned ${res.status}`,
        terminal: await classifyPullFailure(res),
        ...(refreshed ? { refreshed } : {}),
      };
    }

    const json = (await res.json()) as Record<string, unknown>;
    for (const raw of api.readItems(json)) {
      const norm = api.normalize(raw);
      if (norm && !seen.has(norm.externalEventId)) {
        seen.add(norm.externalEventId);
        events.push(norm);
      }
    }
    const st = api.readSyncToken(json);
    if (st) nextSyncToken = st;
    url = api.nextPageUrl(json, url);
  }

  // Deterministic order: by start instant, then external id (stable tiebreaker).
  events.sort((a, b) => {
    const as = a.startsAt ?? "";
    const bs = b.startsAt ?? "";
    if (as !== bs) return as < bs ? -1 : 1;
    return a.externalEventId < b.externalEventId ? -1 : a.externalEventId > b.externalEventId ? 1 : 0;
  });

  return { ok: true, events, nextSyncToken, ...(refreshed ? { refreshed } : {}) };
}

/**
 * Fetch busy intervals for scheduling awareness (Google freeBusy / Microsoft
 * getSchedule). REFUSES (no `fetch`) when the provider is not connectable —
 * structurally dark. Same 401→refresh→retry-once as the event pull.
 */
export async function pullFreeBusy(params: {
  provider: CalendarProvider;
  tokens: Tokens;
  timeMin: string;
  timeMax: string;
  /** Microsoft getSchedule needs the account handle; Google uses "primary". */
  account?: string | null;
}): Promise<FreeBusyResult> {
  const { provider, tokens, timeMin, timeMax } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  if (!isCalendarProviderConnectable(provider)) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} calendar is not configured; no free-busy was read.`,
    };
  }

  const api = PULL_API[provider];
  const request = api.freeBusyRequest({ timeMin, timeMax, account: params.account ?? null });
  if (!request) {
    return {
      ok: false,
      reason: "error",
      message: `${provider} free-busy needs an account handle that is not available.`,
    };
  }

  const doPost = (accessToken: string) =>
    fetch(request.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        ...api.headers,
      },
      body: JSON.stringify(request.body),
    });

  let refreshed: Refreshed | undefined;
  let res: Response;
  try {
    res = await doPost(tokens.accessToken);
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
      res = await doPost(r.tokens.accessToken);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: `free-busy request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: "error",
      message: `free-busy returned ${res.status}`,
      terminal: await classifyPullFailure(res),
      ...(refreshed ? { refreshed } : {}),
    };
  }

  const json = (await res.json()) as Record<string, unknown>;
  return { ok: true, busy: api.readFreeBusy(json), ...(refreshed ? { refreshed } : {}) };
}
