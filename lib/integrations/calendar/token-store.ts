import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/integrations/token-crypto";

import type { CalendarProvider } from "./oauth";

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

/** Update last_sync_at (+ clear last_error) after a successful push. Org + provider pinned. */
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
    .update({ last_sync_at: new Date().toISOString(), last_error: null })
    .eq("org_id", orgId)
    .eq("provider", provider);
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
