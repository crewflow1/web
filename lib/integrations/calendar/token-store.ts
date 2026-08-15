import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/integrations/token-crypto";

import type { CalendarProvider } from "./oauth";
import type { PulledEvent } from "./pull-adapter";

/**
 * Calendar token + event-link STORE — the service-role (RLS-bypass) DB seam for
 * the live push path.
 *
 * WHY SERVICE ROLE. The token columns (access_token / refresh_token /
 * token_expires_at) are stripped from the authenticated read surface by a
 * column-level privilege (20261097), so a tenant JWT can NEVER read them back;
 * only service_role can. The push runs as a best-effort background side-effect of
 * a job save, so it reads/writes here under the admin client. Every query is
 * nonetheless ORG-PINNED in code (`.eq("org_id", …)`) — the composite FK on
 * calendar_event_links additionally makes a cross-org link structurally
 * impossible at the database.
 *
 * This module is deliberately SEPARATE from server/services/calendar-connections.ts
 * so the tenant-facing service never contains a token-column select (its
 * token-free-reads invariant is proven by the security suite).
 *
 * DARK. Nothing here runs while the integration is dark: the caller
 * (bestEffortPushJob) short-circuits on the feature flag, and pushJobToCalendar
 * only reaches this store on the connectable live path.
 */

export type StoredConnectionTokens = {
  connectionId: string;
  /** Ciphertext, as stored — decrypt with decryptStoredTokens before use. */
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
};

type TokenRow = {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
};

/**
 * Read the stored (encrypted) tokens for one org's provider connection. Returns
 * null when there is no connection or no stored access token. Org + provider
 * pinned. Service-role — the only reader permitted the token columns.
 */
export async function readConnectionTokens(
  orgId: string,
  provider: CalendarProvider,
): Promise<StoredConnectionTokens | null> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: TokenRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("calendar_connections")
    .select("id, access_token, refresh_token, token_expires_at")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) {
    throw new Error(`calendar token read failed: ${error.message}`);
  }
  if (!data || !data.access_token) return null;
  return {
    connectionId: data.id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.token_expires_at,
  };
}

/**
 * Persist refreshed tokens after a silent renewal. Encrypts application-side
 * before write (never plaintext). A null refresh token means the provider did
 * not rotate it — the existing one is left untouched. Org + provider pinned.
 */
export async function persistRefreshedTokens(
  orgId: string,
  provider: CalendarProvider,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: string | null },
): Promise<void> {
  const admin = createAdminClient();
  const row: Record<string, unknown> = {
    access_token: encryptToken(tokens.accessToken),
    token_expires_at: tokens.expiresAt,
  };
  if (tokens.refreshToken !== null) {
    row.refresh_token = encryptToken(tokens.refreshToken);
  }
  const loose = admin as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("calendar_connections")
    .update(row)
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    throw new Error(`calendar token persist failed: ${error.message}`);
  }
}

/**
 * Update last_sync_at + clear last_error AND restore status='connected' after a
 * successful push/delete. SELF-HEAL: re-asserting 'connected' clears any prior
 * 'error' state so a connection that recovered (e.g. after re-consent) returns to
 * healthy on its own — mirroring the bank-sync engine. Org + provider pinned.
 */
export async function markConnectionSynced(
  orgId: string,
  provider: CalendarProvider,
): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  await loose
    .from("calendar_connections")
    .update({
      status: "connected",
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("provider", provider);
}

/**
 * Flip a connection to status='error' + record last_error after a TERMINAL push
 * failure — a dead OAuth grant (refresh token revoked/expired) that no retry can
 * recover without a fresh re-consent. This is the writer that closes the
 * launch-blocking gap: before it existed, a terminal refresh failure was swallowed
 * in-memory and the row stayed 'connected' forever, so the admin never saw
 * "reconnect required" and every subsequent push failed silently.
 *
 * Called ONLY for terminal failures — a transient blip must NOT reach here (the
 * connection stays 'connected' so the next event self-heals). Service-role, org +
 * provider pinned. Never throws: a secondary DB blip while recording the error
 * must not mask the original failure to the (best-effort) caller.
 */
export async function markConnectionError(
  orgId: string,
  provider: CalendarProvider,
  message: string,
): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("calendar_connections")
    .update({
      status: "error",
      last_error: message,
      last_sync_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    // Coarse signal only — never the token payload or the raw provider body.
    console.error("[calendar] failed to record connection error", {
      provider,
      message: error.message,
    });
  }
}

/**
 * Look up the external event id a local entity is already mapped to (for the
 * current connection), or null when unmapped. Org + connection pinned.
 */
export async function findEventLink(
  orgId: string,
  connectionId: string,
  localKind: "job" | "rota",
  localId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            eq: (col: string, val: string) => {
              eq: (col: string, val: string) => {
                maybeSingle: () => PromiseLike<{
                  data: { external_event_id: string } | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("calendar_event_links")
    .select("external_event_id")
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
    .eq("local_kind", localKind)
    .eq("local_id", localId)
    .maybeSingle();
  if (error) {
    throw new Error(`calendar event-link read failed: ${error.message}`);
  }
  return data?.external_event_id ?? null;
}

/**
 * Upsert the (connection, local entity) → external event mapping so a re-push
 * UPDATES the same row rather than duplicating it (the composite unique
 * constraint calendar_event_links_conn_local_uniq drives the conflict). Carries
 * org_id explicitly — the composite FK binds it to the connection's org.
 */
export async function upsertEventLink(params: {
  orgId: string;
  connectionId: string;
  localKind: "job" | "rota";
  localId: string;
  externalEventId: string;
  etag: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const { error } = await loose.from("calendar_event_links").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      local_kind: params.localKind,
      local_id: params.localId,
      external_event_id: params.externalEventId,
      etag: params.etag,
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: "connection_id,local_kind,local_id" },
  );
  if (error) {
    throw new Error(`calendar event-link upsert failed: ${error.message}`);
  }
}

/**
 * Remove the (connection, local entity) → external event mapping after the
 * external event has been deleted (or was already gone), so a re-created local
 * entity of the same id is treated as a fresh INSERT rather than PATCHing a
 * now-nonexistent event. Org + connection pinned; idempotent (deleting an absent
 * link is a no-op success).
 */
export async function deleteEventLink(
  orgId: string,
  connectionId: string,
  localKind: "job" | "rota",
  localId: string,
): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      delete: () => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            eq: (col: string, val: string) => {
              eq: (
                col: string,
                val: string,
              ) => PromiseLike<{ error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };
  const { error } = await loose
    .from("calendar_event_links")
    .delete()
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
    .eq("local_kind", localKind)
    .eq("local_id", localId);
  if (error) {
    throw new Error(`calendar event-link delete failed: ${error.message}`);
  }
}

/**
 * Delete EVERY event-link row for one connection (all local kinds/ids at once) —
 * the RECLAIM half of a disconnect. disconnectCalendarProvider clears the tokens
 * and flips status back to 'disconnected', but the callback upsert's
 * onConflict('org_id,provider') REUSES the SAME connection row id on a later
 * reconnect. Without this, every stale (connection, entity) → external_event_id
 * mapping SURVIVES the disconnect and, after a reconnect (especially to a
 * DIFFERENT account), resolves to a dead external event id — so the next save
 * PATCHes an event that no longer exists (404 forever). Wiping the links here makes
 * each entity's first post-reconnect save a fresh INSERT. Org + connection pinned;
 * idempotent (removing zero links is a no-op success). Service-role.
 */
export async function deleteEventLinksForConnection(
  orgId: string,
  connectionId: string,
): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      delete: () => {
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
    .from("calendar_event_links")
    .delete()
    .eq("org_id", orgId)
    .eq("connection_id", connectionId);
  if (error) {
    throw new Error(`calendar event-link connection-wide delete failed: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PULL SIDE — watch channels + pulled events (service-role, org-pinned).
//
// These back the INBOUND direction (20261138). Like the token columns above,
// calendar_watch_channels.verification_token is a SECRET: encrypted before write,
// stripped from the authenticated read surface, and only readable here under the
// service role. Every query is org-pinned in code AND bound by the composite FK.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect the external event ids CrewFlow has PUSHED for one connection — the
 * authoritative dedup set. An inbound pulled event whose id is in this set is one
 * CrewFlow itself created, so it must not be re-imported as an external commitment.
 * Paged under the PostgREST cap so a large push history is never silently truncated
 * (F-1). Org + connection pinned.
 */
export async function listPushedExternalEventIds(
  orgId: string,
  connectionId: string,
): Promise<Set<string>> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            range: (from: number, to: number) => PromiseLike<{
              data: { external_event_id: string }[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const PAGE = 500;
  const out = new Set<string>();
  for (let from = 0; from < 500 * 1000; from += PAGE) {
    const { data, error } = await loose
      .from("calendar_event_links")
      .select("external_event_id")
      .eq("org_id", orgId)
      .eq("connection_id", connectionId)
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(`calendar pushed-id read failed: ${error.message}`);
    }
    const batch = data ?? [];
    for (const row of batch) out.add(row.external_event_id);
    if (batch.length < PAGE) break;
  }
  return out;
}

export type StoredWatchChannel = {
  id: string;
  orgId: string;
  connectionId: string;
  provider: CalendarProvider;
  channelId: string;
  resourceId: string | null;
  /** Ciphertext, as stored — decrypt before comparing to an inbound token. */
  verificationToken: string | null;
  syncToken: string | null;
  status: string;
  expiration: string | null;
};

type WatchRow = {
  id: string;
  org_id: string;
  connection_id: string;
  provider: string;
  channel_id: string;
  resource_id: string | null;
  verification_token: string | null;
  sync_token: string | null;
  status: string;
  expiration: string | null;
};

function toStoredWatch(row: WatchRow): StoredWatchChannel {
  return {
    id: row.id,
    orgId: row.org_id,
    connectionId: row.connection_id,
    provider: row.provider as CalendarProvider,
    channelId: row.channel_id,
    resourceId: row.resource_id,
    verificationToken: row.verification_token,
    syncToken: row.sync_token,
    status: row.status,
    expiration: row.expiration,
  };
}

const WATCH_COLUMNS =
  "id, org_id, connection_id, provider, channel_id, resource_id, verification_token, sync_token, status, expiration";

/**
 * Resolve a watch channel by its provider channel id — the UNAUTHENTICATED inbound
 * lookup the webhook receiver uses (it has no org context; the channel id in the
 * notification IS the tenant handle). channel_id is globally unique, so this maps
 * to at most one org. Service-role — the only reader permitted verification_token.
 */
export async function findWatchChannelByChannelId(
  channelId: string,
): Promise<StoredWatchChannel | null> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => PromiseLike<{
            data: WatchRow | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
  const { data, error } = await loose
    .from("calendar_watch_channels")
    .select(WATCH_COLUMNS)
    .eq("channel_id", channelId)
    .maybeSingle();
  if (error) {
    throw new Error(`calendar watch-channel lookup failed: ${error.message}`);
  }
  return data ? toStoredWatch(data) : null;
}

/** Read the watch channel for a connection (for incremental sync / teardown). Org + connection pinned. */
export async function readWatchChannel(
  orgId: string,
  connectionId: string,
): Promise<StoredWatchChannel | null> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: WatchRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("calendar_watch_channels")
    .select(WATCH_COLUMNS)
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) {
    throw new Error(`calendar watch-channel read failed: ${error.message}`);
  }
  return data ? toStoredWatch(data) : null;
}

/**
 * Upsert a registered watch channel. The verification token is ENCRYPTED
 * application-side before write (never plaintext) — it is the secret an inbound
 * notification is authenticated against. Org + connection pinned; one row per
 * connection (onConflict connection_id). Carries org_id explicitly (the composite
 * FK binds it to the connection's org).
 */
export async function upsertWatchChannel(params: {
  orgId: string;
  connectionId: string;
  provider: CalendarProvider;
  channelId: string;
  resourceId: string | null;
  verificationToken: string;
  expiration: string | null;
  syncToken?: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const row: Record<string, unknown> = {
    org_id: params.orgId,
    connection_id: params.connectionId,
    provider: params.provider,
    channel_id: params.channelId,
    resource_id: params.resourceId,
    verification_token: encryptToken(params.verificationToken),
    expiration: params.expiration,
    status: "active",
    updated_at: new Date().toISOString(),
  };
  if (params.syncToken !== undefined) row.sync_token = params.syncToken;
  const { error } = await loose
    .from("calendar_watch_channels")
    .upsert(row, { onConflict: "connection_id" });
  if (error) {
    throw new Error(`calendar watch-channel upsert failed: ${error.message}`);
  }
}

/**
 * Persist the incremental sync cursor + sync outcome after a pull. Org + connection
 * pinned. Never writes verification_token (that is registration-only).
 */
export async function updateWatchSyncState(
  orgId: string,
  connectionId: string,
  patch: { syncToken?: string | null; status?: string; lastError?: string | null },
): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const row: Record<string, unknown> = { last_synced_at: new Date().toISOString() };
  if (patch.syncToken !== undefined) row.sync_token = patch.syncToken;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  const { error } = await loose
    .from("calendar_watch_channels")
    .update(row)
    .eq("org_id", orgId)
    .eq("connection_id", connectionId);
  if (error) {
    throw new Error(`calendar watch sync-state update failed: ${error.message}`);
  }
}

/** Stamp last_notified_at when a verified inbound notification arrives. Org + connection pinned; never throws. */
export async function markWatchNotified(orgId: string, connectionId: string): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("calendar_watch_channels")
    .update({ last_notified_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("connection_id", connectionId);
  if (error) {
    console.error("[calendar] failed to stamp watch notification", { message: error.message });
  }
}

/** Delete the watch channel row after the provider channel is stopped. Org + connection pinned; idempotent. */
export async function deleteWatchChannel(orgId: string, connectionId: string): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      delete: () => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("calendar_watch_channels")
    .delete()
    .eq("org_id", orgId)
    .eq("connection_id", connectionId);
  if (error) {
    throw new Error(`calendar watch-channel delete failed: ${error.message}`);
  }
}

/**
 * Upsert a batch of normalised pulled events, org + connection pinned, one row per
 * (connection, external event) so a re-pull UPDATES rather than duplicates. Carries
 * org_id explicitly on every row (the composite FK binds it to the connection's org).
 * `isCrewflowOrigin` is the caller's final dedup decision (stored-id OR body-marker).
 */
export async function upsertPulledEvents(
  orgId: string,
  connectionId: string,
  events: Array<PulledEvent & { isCrewflowOrigin: boolean }>,
): Promise<void> {
  if (events.length === 0) return;
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      upsert: (
        rows: Record<string, unknown>[],
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const now = new Date().toISOString();
  const rows = events.map((e) => ({
    org_id: orgId,
    connection_id: connectionId,
    external_event_id: e.externalEventId,
    ical_uid: e.icalUid,
    summary: e.summary,
    location: e.location,
    starts_at: e.startsAt,
    ends_at: e.endsAt,
    is_all_day: e.isAllDay,
    status: e.status,
    is_busy: e.isBusy,
    is_crewflow_origin: e.isCrewflowOrigin,
    etag: e.etag,
    provider_updated_at: e.providerUpdatedAt,
    updated_at: now,
  }));
  const { error } = await loose
    .from("calendar_pulled_events")
    .upsert(rows, { onConflict: "connection_id,external_event_id" });
  if (error) {
    throw new Error(`calendar pulled-events upsert failed: ${error.message}`);
  }
}
