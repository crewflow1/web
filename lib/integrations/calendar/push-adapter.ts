import "server-only";

import {
  isCalendarProviderConnectable,
  refreshAccessToken,
  type CalendarProvider,
} from "./oauth";

/**
 * Calendar event-push adapter — the provider HTTP half of the one-way push.
 *
 * `buildEventPayload` maps a CrewFlow job (with its unified default rota shift of
 * 08:00–17:00 on the scheduled date, per the job↔rota unification) into a
 * provider-neutral event shape. `pushEventToProvider` serialises that shape for
 * the target provider and creates (POST) or patches (PATCH) the event via the
 * Google Calendar / Microsoft Graph event APIs, refreshing the access token on a
 * 401 and retrying once.
 *
 * ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
 * `pushEventToProvider` REFUSES (returns not_configured, NO `fetch`) when the
 * provider is not connectable — the network call is structurally unreachable
 * without client credentials + FEATURE_CALENDAR_CONNECT. The only `fetch` lives
 * strictly AFTER that guard. No token is ever logged.
 */

/** A provider-neutral calendar event. Serialised per-provider before the write. */
export type CalendarEventPayload = {
  summary: string;
  description: string;
  location: string | null;
  /** Local wall-clock start, ISO without offset (paired with `timeZone`). */
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
};

/** The subset of a job row this adapter maps into an event. */
export type JobForEvent = {
  id: string;
  status: string;
  scheduled_date: string | null;
  notes: string | null;
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
};

/** The unified default rota shift a scheduled job occupies when no explicit time exists. */
const DEFAULT_SHIFT_START = "08:00:00";
const DEFAULT_SHIFT_END = "17:00:00";
const DEFAULT_TIME_ZONE = "Europe/London";

/**
 * Map a job into a provider-neutral event payload, or null when the job has no
 * scheduled date (nothing to place on a calendar). Pure — no I/O.
 */
export function buildEventPayload(job: JobForEvent): CalendarEventPayload | null {
  if (!job.scheduled_date) return null;

  const firstNoteLine = (job.notes ?? "").split("\n")[0]?.trim() ?? "";
  const summary =
    firstNoteLine.length > 0
      ? firstNoteLine.slice(0, 120)
      : `Scheduled job (${job.status})`;

  const location =
    [
      job.site_address_line1,
      job.site_address_line2,
      job.site_city,
      job.site_county,
      job.site_postcode,
      job.site_country,
    ]
      .map((p) => (p ?? "").trim())
      .filter((p) => p.length > 0)
      .join(", ") || null;

  const description = [`CrewFlow job ${job.id}`, `Status: ${job.status}`, job.notes ?? ""]
    .filter((l) => l.trim().length > 0)
    .join("\n");

  return {
    summary,
    description,
    location,
    startDateTime: `${job.scheduled_date}T${DEFAULT_SHIFT_START}`,
    endDateTime: `${job.scheduled_date}T${DEFAULT_SHIFT_END}`,
    timeZone: DEFAULT_TIME_ZONE,
  };
}

type ProviderEventApi = {
  base: string;
  serialize: (p: CalendarEventPayload) => Record<string, unknown>;
  readId: (json: Record<string, unknown>) => string | null;
  readEtag: (json: Record<string, unknown>) => string | null;
};

const EVENT_API: Record<CalendarProvider, ProviderEventApi> = {
  google: {
    // The tenant's PRIMARY calendar; its id is the connected account.
    base: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    serialize: (p) => ({
      summary: p.summary,
      description: p.description,
      ...(p.location ? { location: p.location } : {}),
      start: { dateTime: p.startDateTime, timeZone: p.timeZone },
      end: { dateTime: p.endDateTime, timeZone: p.timeZone },
    }),
    readId: (j) => (typeof j.id === "string" ? j.id : null),
    readEtag: (j) => (typeof j.etag === "string" ? j.etag : null),
  },
  microsoft: {
    base: "https://graph.microsoft.com/v1.0/me/events",
    serialize: (p) => ({
      subject: p.summary,
      body: { contentType: "text", content: p.description },
      ...(p.location ? { location: { displayName: p.location } } : {}),
      start: { dateTime: p.startDateTime, timeZone: p.timeZone },
      end: { dateTime: p.endDateTime, timeZone: p.timeZone },
    }),
    readId: (j) => (typeof j.id === "string" ? j.id : null),
    readEtag: (j) =>
      typeof j["@odata.etag"] === "string" ? (j["@odata.etag"] as string) : null,
  },
};

export type PushAdapterResult =
  | {
      ok: true;
      externalEventId: string;
      etag: string | null;
      /** Present only when a 401 forced a refresh; the caller must persist these. */
      refreshed?: { accessToken: string; refreshToken: string | null; expiresAt: string | null };
    }
  | { ok: false; reason: "not_configured" | "error"; message: string };

/**
 * Create or patch a provider calendar event. `externalEventId` null → INSERT
 * (POST); non-null → UPDATE (PATCH) the existing event, so a re-push updates
 * rather than duplicates. On a 401 the stored refresh token is used to renew the
 * access token and the request is retried once; the refreshed tokens are returned
 * so the caller can persist them.
 *
 * REFUSES (no `fetch`) when the provider is not connectable — structurally dark.
 */
export async function pushEventToProvider(params: {
  provider: CalendarProvider;
  tokens: { accessToken: string; refreshToken: string | null };
  payload: CalendarEventPayload;
  externalEventId: string | null;
}): Promise<PushAdapterResult> {
  const { provider, tokens, payload, externalEventId } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  if (!isCalendarProviderConnectable(provider)) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} calendar is not configured; nothing was pushed.`,
    };
  }

  const api = EVENT_API[provider];
  const url = externalEventId ? `${api.base}/${externalEventId}` : api.base;
  const method = externalEventId ? "PATCH" : "POST";
  const bodyJson = JSON.stringify(api.serialize(payload));

  const doFetch = (accessToken: string) =>
    fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: bodyJson,
    });

  let refreshed:
    | { accessToken: string; refreshToken: string | null; expiresAt: string | null }
    | undefined;
  let res: Response;
  try {
    res = await doFetch(tokens.accessToken);

    // 401 → refresh the access token and retry ONCE.
    if (res.status === 401 && tokens.refreshToken) {
      const r = await refreshAccessToken({ provider, refreshToken: tokens.refreshToken });
      if (!r.ok) {
        return { ok: false, reason: "error", message: `token refresh failed: ${r.message}` };
      }
      refreshed = r.tokens;
      res = await doFetch(r.tokens.accessToken);
    }
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: `event push request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  if (!res.ok) {
    return { ok: false, reason: "error", message: `event push returned ${res.status}` };
  }

  const json = (await res.json()) as Record<string, unknown>;
  const id = api.readId(json);
  if (!id) {
    return { ok: false, reason: "error", message: "event push returned no event id" };
  }

  return {
    ok: true,
    externalEventId: id,
    etag: api.readEtag(json),
    ...(refreshed ? { refreshed } : {}),
  };
}
