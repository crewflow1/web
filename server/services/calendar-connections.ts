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
  pushEventToProvider,
} from "@/lib/integrations/calendar/push-adapter";
import {
  readConnectionTokens,
  persistRefreshedTokens,
  markConnectionSynced,
  findEventLink,
  upsertEventLink,
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
 */
export async function disconnectCalendarProvider(
  orgId: string,
  provider: CalendarProvider,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
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

  const pushed = await pushEventToProvider({
    provider: active.provider,
    tokens,
    payload,
    externalEventId: existingEventId,
  });
  if (!pushed.ok) {
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
