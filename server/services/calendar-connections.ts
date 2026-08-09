import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  isCalendarProviderConnectable,
  calendarConnectFeatureEnabled,
  decryptStoredTokens,
  CALENDAR_PROVIDERS,
  type CalendarProvider,
} from "@/lib/integrations/calendar/oauth";
import {
  buildEventPayload,
  buildRotaEventPayload,
  pushEventToProvider,
  deleteEventFromProvider,
} from "@/lib/integrations/calendar/push-adapter";
import {
  readConnectionTokens,
  persistRefreshedTokens,
  markConnectionSynced,
  markConnectionError,
  findEventLink,
  upsertEventLink,
  deleteEventLink,
  deleteEventLinksForConnection,
} from "@/lib/integrations/calendar/token-store";

/**
 * Calendar connections service — org-pinned reads + admin writes over the
 * calendar_connections table, and the one-way push composition that maps a job /
 * rota entry into an external calendar event.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. Every query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected" — reporting a provider as not-connected when the read
 * merely errored is the precise lie loud reads exist to stop.
 *
 * ADMIN WRITES ARE DB-ENFORCED. Every write runs under the caller's JWT, so the
 * admin-write RLS on calendar_connections (20261097) is the real authorisation —
 * a non-admin's write is refused by the database, not merely by app code.
 *
 * DARK. This service never writes a token or a `connected` status: that only
 * happens after a real OAuth exchange in the callback route, which is unreachable
 * without provider client credentials + FEATURE_CALENDAR_CONNECT.
 * `pushJobToCalendar` composes the local entity → event mapping with the
 * (credential-gated) adapter and returns `skipped_dark` when no live provider is
 * reachable. Two-way pull / webhook watch channels are a documented follow-up and
 * are deliberately NOT built here.
 */

export type CalendarConnection = {
  provider: CalendarProvider;
  status: "disconnected" | "connecting" | "connected" | "error";
  externalAccountId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

const PROVIDERS: readonly CalendarProvider[] = CALENDAR_PROVIDERS;

/**
 * A minimal, token-FREE projection of the connection row. The token columns are
 * deliberately NEVER selected here — no tenant surface reads them back (the
 * accounting-connections idiom). Only the connection state the UI needs.
 */
const SELECT_COLUMNS =
  "provider, status, external_account_id, connected_at, last_sync_at, last_error";

type ConnectionRow = {
  provider: string;
  status: string;
  external_account_id: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};

function toConnection(row: ConnectionRow): CalendarConnection {
  return {
    provider: row.provider as CalendarProvider,
    status: row.status as CalendarConnection["status"],
    externalAccountId: row.external_account_id,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  };
}

/**
 * List every provider's connection state for one org, defaulting a provider with
 * no row yet to `disconnected`. Org-pinned, loud.
 */
export async function listCalendarConnections(
  orgId: string,
): Promise<CalendarConnection[]> {
  const supabase = await createClient();
  // calendar_connections post-dates the generated types.ts (the expense_budgets
  // idiom); cast to a minimal select builder.
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          col: string,
          val: string,
        ) => PromiseLike<{ data: ConnectionRow[] | null; error: { message: string } | null }>;
      };
    };
  };
  const { data, error } = await loose
    .from("calendar_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId);
  if (error) throw readFailure("calendar connections: list", error);

  const byProvider = new Map<string, ConnectionRow>();
  for (const row of data ?? []) byProvider.set(row.provider, row);

  return PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return row
      ? toConnection(row)
      : {
          provider,
          status: "disconnected" as const,
          externalAccountId: null,
          connectedAt: null,
          lastSyncAt: null,
          lastError: null,
        };
  });
}

/** Get a single provider's connection state for one org, or null when absent. Org-pinned, loud. */
export async function getCalendarConnection(
  orgId: string,
  provider: CalendarProvider,
): Promise<CalendarConnection | null> {
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: ConnectionRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("calendar_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw readFailure("calendar connections: get", error);
  return data ? toConnection(data) : null;
}

/**
 * Disconnect a provider: clear the tokens + account handle and set status back
 * to `disconnected`. Admin-gated by RLS (runs under the caller's JWT). Org-pinned.
 * Idempotent — disconnecting an already-disconnected provider is a no-op success.
 *
 * RECLAIMS STALE EVENT LINKS. The callback upsert's onConflict('org_id,provider')
 * REUSES the same connection row id on a later reconnect, so clearing the tokens is
 * not enough: every calendar_event_links row for this connection would survive and,
 * after a reconnect (especially to a DIFFERENT account), PATCH a dead external event
 * id forever. So we resolve the connection id and wipe its event links here, making
 * each entity's first post-reconnect save a fresh INSERT.
 */
export async function disconnectCalendarProvider(
  orgId: string,
  provider: CalendarProvider,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  // Resolve the connection row id first (org + provider pinned, loud) so we can
  // reclaim its event links after the token clear. `id` is NOT a token column, so
  // this stays within the service's token-free-read invariant.
  const idQ = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: { id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data: existing, error: idErr } = await idQ
    .from("calendar_connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (idErr) {
    console.error("[calendar] disconnect id read failed", {
      provider,
      message: idErr.message,
    });
    return { ok: false, error: idErr.message };
  }

  const loose = supabase as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (
            col: string,
            val: string,
          ) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("calendar_connections")
    .update({
      status: "disconnected",
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      external_account_id: null,
      connected_at: null,
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    console.error("[calendar] disconnect failed", { provider, message: error.message });
    return { ok: false, error: error.message };
  }

  // Reclaim the stale event links (service-role) so a subsequent connect — which
  // reuses this same connection row id — starts each entity as a fresh INSERT
  // rather than PATCHing a dead external event id.
  if (existing?.id) {
    try {
      await deleteEventLinksForConnection(orgId, existing.id);
    } catch (e) {
      // The tokens ARE cleared (the connection is disconnected), but the stale
      // links remain — surface it so the caller knows the reclaim did not complete.
      const message = e instanceof Error ? e.message : "event-link reclaim failed";
      console.error("[calendar] disconnect link reclaim failed", { provider, message });
      return { ok: false, error: message };
    }
  }
  return { ok: true };
}

export type PushResult = {
  ok: boolean;
  status: "pushed" | "skipped_dark" | "not_found" | "error";
  provider: CalendarProvider | null;
  externalEventId: string | null;
  message: string;
};

type JobRow = {
  id: string;
  org_id: string;
  status: string;
  scheduled_date: string | null;
  notes: string | null;
  assigned_to: string | null;
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
};

const JOB_PUSH_COLUMNS =
  "id, org_id, status, scheduled_date, notes, assigned_to, " +
  "site_address_line1, site_address_line2, site_city, site_county, site_postcode, site_country";

/**
 * One-way push: project a CrewFlow job (and its unified rota shift) into an
 * external calendar event, recording the mapping in calendar_event_links so a
 * re-push updates the same event rather than duplicating it. Org-pinned.
 *
 * DARK. The adapter that actually creates/patches a provider event needs OAuth
 * credentials + the flag; today none exist, so this composer resolves the org's
 * connected provider, sees it is NOT connectable, and returns `skipped_dark`
 * WITHOUT contacting any provider and WITHOUT writing an event link — an honest
 * "nothing was sent because the calendar is not connected", never a fake event.
 * There is no code path from dark to a provider network call or a written link.
 */
export async function pushJobToCalendar(
  orgId: string,
  jobId: string,
): Promise<PushResult> {
  const supabase = await createClient();

  // Read the job, org-pinned + loud. A missing job is a clean not_found, not a
  // silent skip.
  const jobQ = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: JobRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data: job, error: jobErr } = await jobQ
    .from("jobs")
    .select(JOB_PUSH_COLUMNS)
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (jobErr) throw readFailure("calendar push: job", jobErr);
  if (!job) {
    return {
      ok: false,
      status: "not_found",
      provider: null,
      externalEventId: null,
      message: "Job not found in this organisation.",
    };
  }

  // Resolve the org's connected calendar provider (token-free read, loud).
  const connections = await listCalendarConnections(orgId);
  const active = connections.find((c) => c.status === "connected") ?? null;

  // DARK PATH. Either there is no connected provider, or the provider's adapter
  // has no credentials (always, today). Push nothing; write no event link.
  const providerConnectable =
    active !== null && isCalendarProviderConnectable(active.provider);
  if (!active || !providerConnectable) {
    return {
      ok: false,
      status: "skipped_dark",
      provider: active?.provider ?? null,
      externalEventId: null,
      message:
        "No connected calendar with live credentials; nothing was sent. " +
        "Connect a calendar and configure its OAuth credentials to enable push.",
    };
  }

  // ── LIVE PATH (unreachable dark) ────────────────────────────────────────────
  // Compose the event body from the job (+ its unified default rota shift of
  // 08:00–17:00 on scheduled_date, per the job↔rota unification), hand it to the
  // provider adapter (create or patch), then upsert the (connection, 'job', jobId)
  // → external_event_id mapping so a re-push updates rather than duplicates. This
  // build never reaches here because providerConnectable is false while dark.
  const payload = buildEventPayload(job);
  if (!payload) {
    return {
      ok: false,
      status: "error",
      provider: active.provider,
      externalEventId: null,
      message: `Job ${job.id} has no scheduled date to place on a calendar.`,
    };
  }

  // Service-role read of the (encrypted) stored tokens — the only reader of the
  // token columns. Decrypted on use, immediately before the provider call.
  const stored = await readConnectionTokens(orgId, active.provider);
  if (!stored) {
    return {
      ok: false,
      status: "error",
      provider: active.provider,
      externalEventId: null,
      message: "The connected calendar has no stored credentials to push with.",
    };
  }
  const tokens = decryptStoredTokens({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  });

  // Existing mapping → PATCH that event; none → INSERT a new one (idempotent).
  const existingEventId = await findEventLink(orgId, stored.connectionId, "job", jobId);

  let pushed = await pushEventToProvider({
    provider: active.provider,
    tokens,
    payload,
    externalEventId: existingEventId,
  });

  // STALE LINK → DROP + RE-INSERT. The mapped event was deleted provider-side (a
  // disconnect/reconnect reusing the connection id, or a user manually removing the
  // CrewFlow event), so a PATCH 404/410s forever. Drop the dead mapping and retry
  // as a fresh INSERT so the job actually lands, instead of looping on the dead id.
  // A genuine transient (5xx/429/network) is NOT stale — it keeps the same id and
  // self-heals — and terminal auth (401/403) still flips status='error' below.
  if (!pushed.ok && pushed.stale && existingEventId) {
    // Persist any token refreshed during the failed PATCH so the re-INSERT (and the
    // store) use the live access token rather than repeating the refresh.
    if (pushed.refreshed) {
      await persistRefreshedTokens(orgId, active.provider, pushed.refreshed);
    }
    await deleteEventLink(orgId, stored.connectionId, "job", jobId);
    const retryTokens = pushed.refreshed
      ? { accessToken: pushed.refreshed.accessToken, refreshToken: pushed.refreshed.refreshToken }
      : tokens;
    pushed = await pushEventToProvider({
      provider: active.provider,
      tokens: retryTokens,
      payload,
      externalEventId: null,
    });
  }

  if (!pushed.ok) {
    // TERMINAL failure (dead grant — refresh token revoked/expired) ⇒ persist
    // status='error' so the admin sees "reconnect required" and pushes stop
    // silently failing forever; re-consent (the callback upsert) clears it. A
    // TRANSIENT failure (5xx / network / contract) leaves status='connected' so
    // the next job save self-heals — never strand a live connection on one blip.
    if (pushed.terminal) {
      await markConnectionError(orgId, active.provider, pushed.message);
    }
    return {
      ok: false,
      status: "error",
      provider: active.provider,
      externalEventId: existingEventId,
      message: `Calendar push failed: ${pushed.message}`,
    };
  }

  // A 401 forced a silent refresh — persist the renewed (encrypted) tokens.
  if (pushed.refreshed) {
    await persistRefreshedTokens(orgId, active.provider, pushed.refreshed);
  }

  // Record the mapping (upsert) so the next push updates this same event.
  await upsertEventLink({
    orgId,
    connectionId: stored.connectionId,
    localKind: "job",
    localId: jobId,
    externalEventId: pushed.externalEventId,
    etag: pushed.etag,
  });
  await markConnectionSynced(orgId, active.provider);

  return {
    ok: true,
    status: "pushed",
    provider: active.provider,
    externalEventId: pushed.externalEventId,
    message: `Job ${job.id} pushed to the ${active.provider} calendar.`,
  };
}

/**
 * Best-effort calendar push for a job save. This is the CALLER seam wired into
 * the job create/update actions.
 *
 * DARK GATE FIRST. When the calendar-connect feature flag is off (ALWAYS, today)
 * this returns immediately — NO database read, NO network — so a job save while
 * dark pays nothing and touches no calendar code path. Once live it delegates to
 * pushJobToCalendar and SWALLOWS every failure: a calendar hiccup must never fail
 * or block the primary job save. Failures are logged (coarse, no secret), not
 * thrown.
 */
export async function bestEffortPushJob(
  orgId: string,
  jobId: string,
): Promise<{ status: PushResult["status"] }> {
  if (!calendarConnectFeatureEnabled()) {
    return { status: "skipped_dark" };
  }
  try {
    const result = await pushJobToCalendar(orgId, jobId);
    if (!result.ok && result.status === "error") {
      console.error("[calendar] best-effort job push error", {
        jobId,
        provider: result.provider,
        message: result.message,
      });
    }
    return { status: result.status };
  } catch (e) {
    console.error("[calendar] best-effort job push threw", {
      jobId,
      message: e instanceof Error ? e.message : "unknown error",
    });
    return { status: "error" };
  }
}

type RotaRow = {
  id: string;
  org_id: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  // A to-one join; supabase-js may hand it back as an object or a 1-element array.
  user: { full_name: string | null; email: string | null } | { full_name: string | null; email: string | null }[] | null;
};

// rota_entries has TWO FKs to users (user_id, created_by); embed MUST name the
// constraint or PostgREST rejects the whole query (PGRST201). The shift's assigned
// staff member is user_id.
const ROTA_PUSH_COLUMNS =
  "id, org_id, starts_at, ends_at, notes, user:users!rota_entries_user_id_fkey ( full_name, email )";

/**
 * One-way push: project a CrewFlow rota SHIFT into an external calendar event,
 * recording the mapping in calendar_event_links (local_kind 'rota') so a re-push
 * updates the same event rather than duplicating it. Org-pinned.
 *
 * This is the standalone-shift half of the push: a rota entry with no backing job
 * (job_id null) is never covered by pushJobToCalendar, and even a job-backed shift
 * spans its OWN starts_at/ends_at rather than the job's synthesised 08:00–17:00.
 *
 * DARK. Exactly like pushJobToCalendar: resolves the org's connected provider,
 * sees it is NOT connectable (always, today), and returns `skipped_dark` WITHOUT
 * contacting any provider and WITHOUT writing an event link. There is no code path
 * from dark to a provider network call or a written link.
 */
export async function pushRotaToCalendar(
  orgId: string,
  rotaId: string,
): Promise<PushResult> {
  const supabase = await createClient();

  // Read the rota entry, org-pinned + loud. A missing entry is a clean not_found.
  const rotaQ = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: RotaRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data: rota, error: rotaErr } = await rotaQ
    .from("rota_entries")
    .select(ROTA_PUSH_COLUMNS)
    .eq("id", rotaId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (rotaErr) throw readFailure("calendar push: rota", rotaErr);
  if (!rota) {
    return {
      ok: false,
      status: "not_found",
      provider: null,
      externalEventId: null,
      message: "Rota shift not found in this organisation.",
    };
  }

  // Resolve the org's connected calendar provider (token-free read, loud).
  const connections = await listCalendarConnections(orgId);
  const active = connections.find((c) => c.status === "connected") ?? null;

  // DARK PATH. Either there is no connected provider, or the provider's adapter
  // has no credentials (always, today). Push nothing; write no event link.
  const providerConnectable =
    active !== null && isCalendarProviderConnectable(active.provider);
  if (!active || !providerConnectable) {
    return {
      ok: false,
      status: "skipped_dark",
      provider: active?.provider ?? null,
      externalEventId: null,
      message:
        "No connected calendar with live credentials; nothing was sent. " +
        "Connect a calendar and configure its OAuth credentials to enable push.",
    };
  }

  // ── LIVE PATH (unreachable dark) ────────────────────────────────────────────
  const staff = Array.isArray(rota.user) ? rota.user[0] ?? null : rota.user;
  const payload = buildRotaEventPayload({
    id: rota.id,
    starts_at: rota.starts_at,
    ends_at: rota.ends_at,
    notes: rota.notes,
    staffName: staff?.full_name ?? staff?.email ?? null,
  });
  if (!payload) {
    return {
      ok: false,
      status: "error",
      provider: active.provider,
      externalEventId: null,
      message: `Rota shift ${rota.id} has no usable start/end to place on a calendar.`,
    };
  }

  // Service-role read of the (encrypted) stored tokens — the only reader of the
  // token columns. Decrypted on use, immediately before the provider call.
  const stored = await readConnectionTokens(orgId, active.provider);
  if (!stored) {
    return {
      ok: false,
      status: "error",
      provider: active.provider,
      externalEventId: null,
      message: "The connected calendar has no stored credentials to push with.",
    };
  }
  const tokens = decryptStoredTokens({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  });

  // Existing mapping → PATCH that event; none → INSERT a new one (idempotent).
  const existingEventId = await findEventLink(orgId, stored.connectionId, "rota", rotaId);

  let pushed = await pushEventToProvider({
    provider: active.provider,
    tokens,
    payload,
    externalEventId: existingEventId,
  });

  // STALE LINK → DROP + RE-INSERT (mirrors pushJobToCalendar). A PATCH of a
  // provider-deleted event 404/410s forever; drop the dead mapping and re-INSERT so
  // the shift lands. Transient blips keep the same id and self-heal; terminal auth
  // still flips status='error' below.
  if (!pushed.ok && pushed.stale && existingEventId) {
    if (pushed.refreshed) {
      await persistRefreshedTokens(orgId, active.provider, pushed.refreshed);
    }
    await deleteEventLink(orgId, stored.connectionId, "rota", rotaId);
    const retryTokens = pushed.refreshed
      ? { accessToken: pushed.refreshed.accessToken, refreshToken: pushed.refreshed.refreshToken }
      : tokens;
    pushed = await pushEventToProvider({
      provider: active.provider,
      tokens: retryTokens,
      payload,
      externalEventId: null,
    });
  }

  if (!pushed.ok) {
    // TERMINAL failure (dead grant — refresh token revoked/expired) ⇒ persist
    // status='error' so the admin sees "reconnect required" and pushes stop
    // silently failing forever; re-consent (the callback upsert) clears it. A
    // TRANSIENT failure (5xx / network / contract) leaves status='connected' so
    // the next job save self-heals — never strand a live connection on one blip.
    if (pushed.terminal) {
      await markConnectionError(orgId, active.provider, pushed.message);
    }
    return {
      ok: false,
      status: "error",
      provider: active.provider,
      externalEventId: existingEventId,
      message: `Calendar push failed: ${pushed.message}`,
    };
  }

  // A 401 forced a silent refresh — persist the renewed (encrypted) tokens.
  if (pushed.refreshed) {
    await persistRefreshedTokens(orgId, active.provider, pushed.refreshed);
  }

  // Record the mapping (upsert) so the next push updates this same event.
  await upsertEventLink({
    orgId,
    connectionId: stored.connectionId,
    localKind: "rota",
    localId: rotaId,
    externalEventId: pushed.externalEventId,
    etag: pushed.etag,
  });
  await markConnectionSynced(orgId, active.provider);

  return {
    ok: true,
    status: "pushed",
    provider: active.provider,
    externalEventId: pushed.externalEventId,
    message: `Rota shift ${rota.id} pushed to the ${active.provider} calendar.`,
  };
}

/**
 * Best-effort calendar push for a rota-shift save — the CALLER seam wired into
 * createRotaEntry. Mirrors bestEffortPushJob exactly: a DARK gate first (no
 * DB/network while the feature flag is off, ALWAYS today), then delegate to
 * pushRotaToCalendar and SWALLOW every failure so a calendar hiccup never fails or
 * blocks the primary shift save.
 */
export async function bestEffortPushRota(
  orgId: string,
  rotaId: string,
): Promise<{ status: PushResult["status"] }> {
  if (!calendarConnectFeatureEnabled()) {
    return { status: "skipped_dark" };
  }
  try {
    const result = await pushRotaToCalendar(orgId, rotaId);
    if (!result.ok && result.status === "error") {
      console.error("[calendar] best-effort rota push error", {
        rotaId,
        provider: result.provider,
        message: result.message,
      });
    }
    return { status: result.status };
  } catch (e) {
    console.error("[calendar] best-effort rota push threw", {
      rotaId,
      message: e instanceof Error ? e.message : "unknown error",
    });
    return { status: "error" };
  }
}

export type DeleteResult = {
  ok: boolean;
  status: "deleted" | "skipped_dark" | "no_link" | "error";
  provider: CalendarProvider | null;
  message: string;
};

/**
 * The removal half of the one-way push: when a local entity that was projected
 * onto a calendar goes away (a job/rota shift is deleted, or a job's
 * scheduled_date is cleared), remove its external event so the calendar does not
 * strand an orphan forever (crew dispatched to a cancelled job on activation).
 *
 * Resolves the org's connected provider + connection, looks up the
 * calendar_event_links row for this local entity, DELETEs the provider event
 * (404/410-tolerant — already-gone is success), then removes the link row so a
 * re-created entity of the same id becomes a fresh INSERT. Org-pinned.
 *
 * DARK. Exactly like pushJobToCalendar: with no connected+connectable provider it
 * returns `skipped_dark` WITHOUT contacting any provider and WITHOUT touching a
 * link. With no link row it returns `no_link` — a no-op success, so a clear/delete
 * for an entity that was never pushed costs one org-pinned read and nothing more.
 */
async function deleteEventForLocalEntity(
  orgId: string,
  localKind: "job" | "rota",
  localId: string,
): Promise<DeleteResult> {
  // Resolve the org's connected calendar provider (token-free read, loud).
  const connections = await listCalendarConnections(orgId);
  const active = connections.find((c) => c.status === "connected") ?? null;

  // DARK PATH. No connected+connectable provider → delete nothing, touch no link.
  const providerConnectable =
    active !== null && isCalendarProviderConnectable(active.provider);
  if (!active || !providerConnectable) {
    return {
      ok: true,
      status: "skipped_dark",
      provider: active?.provider ?? null,
      message: "No connected calendar with live credentials; nothing was deleted.",
    };
  }

  // ── LIVE PATH (unreachable dark) ────────────────────────────────────────────
  // Service-role read of the (encrypted) stored tokens + the connection id.
  const stored = await readConnectionTokens(orgId, active.provider);
  if (!stored) {
    return {
      ok: true,
      status: "skipped_dark",
      provider: active.provider,
      message: "The connected calendar has no stored credentials.",
    };
  }

  // No mapping → nothing was ever pushed for this entity; a clean no-op success.
  const externalEventId = await findEventLink(
    orgId,
    stored.connectionId,
    localKind,
    localId,
  );
  if (!externalEventId) {
    return {
      ok: true,
      status: "no_link",
      provider: active.provider,
      message: `No calendar event is mapped to this ${localKind}; nothing to delete.`,
    };
  }

  const tokens = decryptStoredTokens({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  });

  const deleted = await deleteEventFromProvider({
    provider: active.provider,
    tokens,
    externalEventId,
  });
  if (!deleted.ok) {
    // TERMINAL failure (dead grant) ⇒ persist status='error' (reconnect required);
    // TRANSIENT ⇒ leave status='connected' so a later event self-heals. Either way
    // leave the link row in place so a later retry can still find + remove it.
    if (deleted.terminal) {
      await markConnectionError(orgId, active.provider, deleted.message);
    }
    return {
      ok: false,
      status: "error",
      provider: active.provider,
      message: `Calendar delete failed: ${deleted.message}`,
    };
  }

  // A 401 forced a silent refresh — persist the renewed (encrypted) tokens.
  if (deleted.refreshed) {
    await persistRefreshedTokens(orgId, active.provider, deleted.refreshed);
  }

  // The external event is gone (deleted or already-absent) — drop the mapping.
  await deleteEventLink(orgId, stored.connectionId, localKind, localId);
  await markConnectionSynced(orgId, active.provider);

  return {
    ok: true,
    status: "deleted",
    provider: active.provider,
    message: `Calendar event for ${localKind} ${localId} deleted.`,
  };
}

/**
 * Best-effort calendar-event delete for a job that is being deleted or having its
 * scheduled_date cleared — the CALLER seam wired into deleteJob / updateJob.
 * Mirrors bestEffortPushJob: a DARK gate first (no DB/network while the flag is
 * off, ALWAYS today), then delegate and SWALLOW every failure so a calendar hiccup
 * never fails or blocks the primary delete/update.
 */
export async function bestEffortDeleteJobEvent(
  orgId: string,
  jobId: string,
): Promise<{ status: DeleteResult["status"] }> {
  if (!calendarConnectFeatureEnabled()) {
    return { status: "skipped_dark" };
  }
  try {
    const result = await deleteEventForLocalEntity(orgId, "job", jobId);
    if (!result.ok && result.status === "error") {
      console.error("[calendar] best-effort job delete error", {
        jobId,
        provider: result.provider,
        message: result.message,
      });
    }
    return { status: result.status };
  } catch (e) {
    console.error("[calendar] best-effort job delete threw", {
      jobId,
      message: e instanceof Error ? e.message : "unknown error",
    });
    return { status: "error" };
  }
}

/**
 * Best-effort calendar-event delete for a rota shift being deleted — the CALLER
 * seam wired into deleteRotaEntry. Mirrors bestEffortDeleteJobEvent exactly.
 */
export async function bestEffortDeleteRotaEvent(
  orgId: string,
  rotaId: string,
): Promise<{ status: DeleteResult["status"] }> {
  if (!calendarConnectFeatureEnabled()) {
    return { status: "skipped_dark" };
  }
  try {
    const result = await deleteEventForLocalEntity(orgId, "rota", rotaId);
    if (!result.ok && result.status === "error") {
      console.error("[calendar] best-effort rota delete error", {
        rotaId,
        provider: result.provider,
        message: result.message,
      });
    }
    return { status: result.status };
  } catch (e) {
    console.error("[calendar] best-effort rota delete threw", {
      rotaId,
      message: e instanceof Error ? e.message : "unknown error",
    });
    return { status: "error" };
  }
}
