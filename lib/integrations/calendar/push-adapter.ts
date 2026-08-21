import "server-only";

import {
  isCalendarProviderConnectable,
  refreshAccessToken,
  type CalendarProvider,
} from "./oauth";
import {
  isValidRecurringPayload,
  MAX_OCCURRENCES,
  type RecurringPattern,
} from "@/lib/schedule/recurring";

/**
 * Calendar event-push adapter — the provider HTTP half of the one-way push.
 *
 * `buildEventPayload` maps a CrewFlow job (with its unified default rota shift of
 * 08:00 to 17:00 on the scheduled date, per the job↔rota unification) into a
 * provider-neutral event shape; `buildRotaEventPayload` maps a standalone rota
 * shift, spanning its OWN starts_at/ends_at rather than a synthesised default, so
 * a shift with no backing job still lands on the calendar. `pushEventToProvider`
 * serialises that shape for
 * the target provider and creates (POST) or patches (PATCH) the event via the
 * Google Calendar / Microsoft Graph event APIs, refreshing the access token on a
 * 401 and retrying once. `deleteEventFromProvider` is the removal half — a DELETE
 * of the provider event (404/410-tolerant) when the local entity that owned it
 * goes away, so a deleted/de-scheduled job or shift does not strand an orphan
 * event forever.
 *
 * ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
 * `pushEventToProvider` / `deleteEventFromProvider` REFUSE (return not_configured,
 * NO `fetch`) when the provider is not connectable — the network call is
 * structurally unreachable without client credentials + FEATURE_CALENDAR_CONNECT.
 * Every `fetch` lives strictly AFTER that guard. No token is ever logged.
 */

/**
 * A provider-neutral recurrence, derived from a job's `recurring` payload + its
 * anchor `scheduled_date`. Serialised per-provider (Google RRULE / Microsoft
 * recurrence object) so an EXTERNAL calendar expands the same series CrewFlow
 * renders internally via `expandRecurring`, instead of the parent landing as a
 * single anchor-only event.
 *
 * The four CrewFlow patterns (weekly/biweekly/monthly/quarterly — see
 * `lib/schedule/recurring.ts`) collapse onto two provider frequencies:
 *   - weekly   → { freq: "WEEKLY",  interval: 1 }
 *   - biweekly → { freq: "WEEKLY",  interval: 2 }
 *   - monthly  → { freq: "MONTHLY", interval: 1 }
 *   - quarterly→ { freq: "MONTHLY", interval: 3 }
 *
 * `until` mirrors `expandRecurring`'s inclusive `end_date`; when the series is
 * open-ended, `count` bounds it at exactly `MAX_OCCURRENCES` — the SAME hard cap
 * `expandRecurring` applies — so neither view runs away unbounded.
 */
export type EventRecurrence = {
  freq: "WEEKLY" | "MONTHLY";
  interval: number;
  /** The anchor date (YYYY-MM-DD) — weekday (weekly) / day-of-month (monthly) source. */
  anchorDate: string;
  /** Inclusive series end (YYYY-MM-DD), or null for an open-ended (count-bounded) series. */
  until: string | null;
  /** Occurrence cap for an open-ended series (null when `until` is set). */
  count: number | null;
};

/** A provider-neutral calendar event. Serialised per-provider before the write. */
export type CalendarEventPayload = {
  summary: string;
  description: string;
  location: string | null;
  /** Local wall-clock start, ISO without offset (paired with `timeZone`). */
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
  /** Provider-neutral recurrence when the source job carries a VALID, expressible recurring payload. */
  recurrence?: EventRecurrence;
  /**
   * Set when the source job IS recurring but its cadence cannot be faithfully
   * expressed as a single provider recurrence rule (see `buildEventRecurrence`).
   * The caller MUST surface this rather than push a misleading anchor-only or
   * approximated event — silently dropping occurrences is the exact defect this
   * change exists to close.
   */
  recurrenceUnsupported?: string;
};

/** The subset of a job row this adapter maps into an event. */
export type JobForEvent = {
  id: string;
  status: string;
  scheduled_date: string | null;
  notes: string | null;
  /** The job's `recurring` jsonb payload ({ pattern, end_date? }) or null; validated before use. */
  recurring: unknown;
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
};

/**
 * Map a job's validated `recurring` payload + its anchor date onto a
 * provider-neutral recurrence, or a reason it is INEXPRESSIBLE.
 *
 *   - null                     → not recurring (or an invalid/foreign payload):
 *                                the job pushes as a single dated event, unchanged.
 *   - EventRecurrence          → an expressible cadence to attach.
 *   - { inexpressible, reason }→ a recurring job whose CrewFlow expansion cannot be
 *                                reproduced by any single provider rule.
 *
 * FAITHFULNESS. `expandRecurring` steps monthly/quarterly with JS `Date`
 * month-arithmetic, which ROLLS FORWARD on day-of-month overflow (e.g. a Jan-31
 * anchor becomes Mar-3, then Apr-3, …). No single Google RRULE / Microsoft
 * recurrence reproduces that roll-forward — they either skip or clamp the missing
 * day. For an anchor on day 1 to 28 (every month has that day) there is NO overflow,
 * so `FREQ=MONTHLY` is byte-faithful; for an anchor on day 29 to 31 the two views
 * would DIVERGE, so we refuse to approximate and return `inexpressible`. Weekly /
 * biweekly are pure day arithmetic and always faithful.
 */
export function buildEventRecurrence(
  recurring: unknown,
  anchorDate: string,
): EventRecurrence | null | { inexpressible: true; reason: string } {
  if (!isValidRecurringPayload(recurring)) return null;
  const { pattern, end_date } = recurring as RecurringPattern;

  const until = end_date ?? null;
  // Open-ended series are bounded by the SAME cap expandRecurring enforces, so the
  // provider never materialises an unbounded series CrewFlow would itself clip.
  const count = until ? null : MAX_OCCURRENCES;

  switch (pattern) {
    case "weekly":
      return { freq: "WEEKLY", interval: 1, anchorDate, until, count };
    case "biweekly":
      return { freq: "WEEKLY", interval: 2, anchorDate, until, count };
    case "monthly":
    case "quarterly": {
      const dayOfMonth = new Date(`${anchorDate}T00:00:00Z`).getUTCDate();
      if (Number.isNaN(dayOfMonth)) {
        return { inexpressible: true, reason: `unparseable anchor date "${anchorDate}"` };
      }
      if (dayOfMonth > 28) {
        return {
          inexpressible: true,
          reason:
            `a ${pattern} series anchored on day ${dayOfMonth} of the month cannot be ` +
            "expressed as provider-native recurrence: expandRecurring rolls month overflow " +
            "forward (JS Date math), which no single RRULE / Microsoft rule reproduces.",
        };
      }
      return { freq: "MONTHLY", interval: pattern === "monthly" ? 1 : 3, anchorDate, until, count };
    }
  }
}

/** RFC-5545 RRULE for Google Calendar. UNTIL is UTC (Z) end-of-day so the inclusive end_date occurrence is kept. */
function toGoogleRrule(r: EventRecurrence): string {
  const parts = [`FREQ=${r.freq}`, `INTERVAL=${r.interval}`];
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}T235959Z`);
  else if (r.count) parts.push(`COUNT=${r.count}`);
  return `RRULE:${parts.join(";")}`;
}

const MS_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Microsoft Graph recurrence object (pattern + range) mirroring the same series. */
function toMicrosoftRecurrence(r: EventRecurrence): Record<string, unknown> {
  const anchor = new Date(`${r.anchorDate}T00:00:00Z`);
  const pattern =
    r.freq === "WEEKLY"
      ? {
          type: "weekly",
          interval: r.interval,
          daysOfWeek: [MS_WEEKDAYS[anchor.getUTCDay()]],
        }
      : {
          type: "absoluteMonthly",
          interval: r.interval,
          dayOfMonth: anchor.getUTCDate(),
        };
  const range = r.until
    ? { type: "endDate", startDate: r.anchorDate, endDate: r.until }
    : { type: "numbered", startDate: r.anchorDate, numberOfOccurrences: r.count };
  return { pattern, range };
}

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

  // Recurrence: a recurring parent is ONE jobs row + one anchor; internally its
  // occurrences exist only via read-time expandRecurring. Emit provider-native
  // recurrence so the external calendar expands the SAME series rather than the
  // parent landing as a single anchor-only event (silently omitting every later
  // occurrence). An inexpressible cadence is flagged, NOT approximated.
  const recurrence = buildEventRecurrence(job.recurring, job.scheduled_date);

  return {
    summary,
    description,
    location,
    startDateTime: `${job.scheduled_date}T${DEFAULT_SHIFT_START}`,
    endDateTime: `${job.scheduled_date}T${DEFAULT_SHIFT_END}`,
    timeZone: DEFAULT_TIME_ZONE,
    ...(recurrence
      ? "inexpressible" in recurrence
        ? { recurrenceUnsupported: recurrence.reason }
        : { recurrence }
      : {}),
  };
}

/** The subset of a rota-entry row (+ its staff member's name) this adapter maps into an event. */
export type RotaForEvent = {
  id: string;
  /** Shift bounds as stored — timestamptz (UTC) strings. */
  starts_at: string;
  ends_at: string;
  notes: string | null;
  /** The assigned staff member's display name (full name, falling back to email). */
  staffName: string | null;
};

/**
 * Convert a timestamptz to a wall-clock ISO string WITHOUT offset (paired with a
 * UTC time zone), e.g. "2026-09-01T08:00:00.000Z" → "2026-09-01T08:00:00". Returns
 * null for an unparseable value.
 */
function toWallClockUtc(ts: string): string | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}

/**
 * Map a rota shift into a provider-neutral event payload. Unlike a job (which
 * synthesises a fixed 08:00 to 17:00 default), a rota entry carries its OWN
 * starts_at / ends_at, so the event spans the real shift — the standalone-shift
 * gap the job-only push left uncovered. The shift is stored as an absolute instant
 * (timestamptz), so it is emitted as UTC wall-clock time. Pure — no I/O. Returns
 * null when either bound is missing or unparseable.
 */
export function buildRotaEventPayload(rota: RotaForEvent): CalendarEventPayload | null {
  const startDateTime = toWallClockUtc(rota.starts_at);
  const endDateTime = toWallClockUtc(rota.ends_at);
  if (!startDateTime || !endDateTime) return null;

  const who = (rota.staffName ?? "").trim();
  const summary = who.length > 0 ? `Shift — ${who}` : "Rota shift";

  const description = [`CrewFlow rota shift ${rota.id}`, rota.notes ?? ""]
    .filter((l) => l.trim().length > 0)
    .join("\n");

  return {
    summary,
    description,
    location: null,
    startDateTime,
    endDateTime,
    timeZone: "UTC",
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
      ...(p.recurrence ? { recurrence: [toGoogleRrule(p.recurrence)] } : {}),
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
      ...(p.recurrence ? { recurrence: toMicrosoftRecurrence(p.recurrence) } : {}),
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
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      /**
       * TERMINAL push failure — the connection's OAuth grant is dead (a token
       * refresh returned invalid_grant, or the provider still answered 401/403
       * with no way to recover). The caller persists status='error' so the admin
       * is prompted to reconnect. Absent/false means the failure is TRANSIENT
       * (5xx / network / a 2xx contract violation) and the connection stays live
       * to self-heal on the next event.
       */
      terminal?: boolean;
      /**
       * STALE MAPPING — a PATCH of an existing external event returned 404/410, so
       * the mapped provider event no longer exists (deleted provider-side when a
       * disconnect/reconnect reused the connection id, or a user manually removed
       * the CrewFlow event). This is NEITHER a transient blip (retrying the SAME
       * dead id would loop forever) NOR an auth failure (the grant is fine). The
       * caller DROPS the dead link and re-INSERTs so the entity actually lands.
       */
      stale?: boolean;
      /**
       * Present when a 401 during the failed attempt forced a refresh; the caller
       * persists these and re-uses them for the re-INSERT so the retry does not
       * repeat the refresh (and cannot trip a rotated-refresh-token dead end).
       */
      refreshed?: { accessToken: string; refreshToken: string | null; expiresAt: string | null };
    };

/**
 * Google Calendar event-API error `reason` codes that are TRANSIENT usage/rate
 * limits — the request was THROTTLED, not the grant rejected. A bulk import or a
 * multi-shift rota save can trip these on an otherwise healthy connection, so they
 * must NEVER strand it. Google returns HTTP 403 for these, the SAME status as a
 * genuine authorization denial — only the response body tells them apart.
 */
const GOOGLE_TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
]);

/** Read `error.errors[].reason` from a Google API error body (defensive; [] when absent/foreign). */
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

/** Read `error.status` (the canonical code, e.g. RESOURCE_EXHAUSTED) from a Google error body. */
function googleErrorStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

/**
 * Classify a still-failing event-API response (AFTER the 401→refresh→retry-once)
 * as TERMINAL — the grant is dead / genuinely unauthorized, so the caller persists
 * status='error' and re-consent is required — or TRANSIENT — a throttle / usage
 * cap / provider blip, so the connection stays 'connected' and self-heals on the
 * next event.
 *
 *   - 401 here ⇒ TERMINAL: the one refresh+retry already had its chance and the
 *     token is still rejected (or there was no refresh token to begin with).
 *   - 403 is the SUBTLE case a C48 regression got wrong: Google Calendar
 *     events.insert/patch returns 403 for TRANSIENT rate-limit / quota errors
 *     (rateLimitExceeded / userRateLimitExceeded / dailyLimitExceeded /
 *     quotaExceeded, canonical status RESOURCE_EXHAUSTED) AS WELL AS for genuine
 *     authorization denials. Treating a BARE 403 as terminal stranded a live
 *     calendar on ONE bulk-import throttle (a 403 never enters the refresh path —
 *     refresh is 401-only — so the only self-heal, a successful push, became
 *     unreachable). We parse the provider error body: a rate-limit signal ⇒
 *     TRANSIENT; anything else (insufficientPermissions / forbidden authz, or an
 *     unreadable body) ⇒ TERMINAL.
 *   - Any other non-ok status (5xx / 429 / ...) ⇒ TRANSIENT.
 *
 * Microsoft Graph surfaces throttling as 429/503 (already transient above) and
 * reserves 403 for genuine authorization failures (ErrorAccessDenied), so a
 * Microsoft 403 carries no rate-limit reason in its body and classifies TERMINAL —
 * the intended behaviour. Reading the body consumes it, so this is only ever called
 * on the !res.ok branch (the ok path reads the body itself).
 */
async function classifyEventApiFailure(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A 403 whose body we cannot read: assume a genuine authz denial (terminal) —
    // the safe default is to prompt re-consent, not silently retry a dead grant.
    return true;
  }
  if (googleErrorStatus(body) === "RESOURCE_EXHAUSTED") return false; // transient
  if (googleErrorReasons(body).some((r) => GOOGLE_TRANSIENT_REASONS.has(r))) return false;
  return true; // authz / unknown 403 → terminal
}

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
        // A dead grant (invalid_grant) propagates as TERMINAL so the caller flips
        // status='error'; a transient refresh blip does not.
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
    // A thrown request is a TRANSIENT network failure — the grant is not proven
    // dead, so the connection stays live to retry on the next event.
    return {
      ok: false,
      reason: "error",
      message: `event push request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  if (!res.ok) {
    // STALE MAPPING FIRST. A PATCH (externalEventId non-null) that 404/410s means
    // the mapped provider event is GONE — deleted provider-side by a
    // disconnect/reconnect that reused the connection id, or by a user manually
    // removing the CrewFlow event. Retrying the SAME dead id would 404 forever, so
    // this is emphatically NOT a transient blip (which classifyEventApiFailure would
    // otherwise report for 404/410, since it is neither 401 nor 403). Surface a
    // DISTINCT `stale` outcome so the caller drops the link and re-INSERTs — mirroring
    // deleteEventFromProvider's existing 404/410 tolerance, closing the push/delete
    // asymmetry. A POST that 404/410s has no mapping to be stale, so this is
    // PATCH-only.
    if (method === "PATCH" && (res.status === 404 || res.status === 410)) {
      return {
        ok: false,
        reason: "error",
        message: `event push target is gone (${res.status}); mapping is stale`,
        stale: true,
        ...(refreshed ? { refreshed } : {}),
      };
    }
    // Classify the still-failing response: a 401 (or an authz 403) after the
    // refresh+retry is TERMINAL; a rate-limit 403 / 5xx / 429 is TRANSIENT so the
    // connection stays 'connected' and self-heals on the next event. Parses the
    // provider error body — a bare event-API 403 is NOT assumed terminal.
    return {
      ok: false,
      reason: "error",
      message: `event push returned ${res.status}`,
      terminal: await classifyEventApiFailure(res),
    };
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

export type DeleteAdapterResult =
  | {
      ok: true;
      /** Present only when a 401 forced a refresh; the caller must persist these. */
      refreshed?: { accessToken: string; refreshToken: string | null; expiresAt: string | null };
    }
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      /** TERMINAL delete failure — a dead grant (see PushAdapterResult.terminal). */
      terminal?: boolean;
    };

/**
 * DELETE a provider calendar event — the removal half of the one-way push. Called
 * when the local entity that owned the event goes away (a job or rota shift is
 * deleted, or a job's scheduled date is cleared) so the external calendar does not
 * strand an orphan event forever. Mirrors pushEventToProvider: same connectable
 * guard, same 401→refresh→retry-once.
 *
 * 404/410-TOLERANT. An already-gone event is a SUCCESS, not an error — a delete
 * that finds nothing to remove has still achieved the goal (idempotent). Google
 * returns 410 Gone for an already-deleted event, Microsoft 404; both count as ok.
 *
 * REFUSES (no `fetch`) when the provider is not connectable — structurally dark.
 */
export async function deleteEventFromProvider(params: {
  provider: CalendarProvider;
  tokens: { accessToken: string; refreshToken: string | null };
  externalEventId: string;
}): Promise<DeleteAdapterResult> {
  const { provider, tokens, externalEventId } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  if (!isCalendarProviderConnectable(provider)) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} calendar is not configured; nothing was deleted.`,
    };
  }

  const api = EVENT_API[provider];
  const url = `${api.base}/${externalEventId}`;

  const doFetch = (accessToken: string) =>
    fetch(url, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
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
        // A dead grant (invalid_grant) propagates as TERMINAL; a transient blip does not.
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
    // A thrown request is a TRANSIENT network failure — the grant is not proven dead.
    return {
      ok: false,
      reason: "error",
      message: `event delete request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  // Success (204/200) OR already-gone (404/410) — either way the event is absent.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    // Classify as for a push: a 401 / authz 403 after the refresh+retry is
    // TERMINAL; a rate-limit 403 / 5xx / 429 is TRANSIENT (stays 'connected').
    return {
      ok: false,
      reason: "error",
      message: `event delete returned ${res.status}`,
      terminal: await classifyEventApiFailure(res),
    };
  }

  return { ok: true, ...(refreshed ? { refreshed } : {}) };
}
