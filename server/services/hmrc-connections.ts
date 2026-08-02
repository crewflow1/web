import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * HMRC connections service — org-pinned, token-FREE read over hmrc_connections.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. The query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected" — reporting HMRC as not-connected when the read merely
 * errored is the precise lie loud reads exist to stop.
 *
 * TOKEN-FREE. The token columns are NEVER selected here (they are also stripped
 * from the authenticated read surface by a column privilege in 20261099). Only
 * the connection state the UI needs is returned.
 *
 * DARK. This service never writes a token or a `connected` status — that only
 * happens after a real OAuth exchange in the callback route, which is unreachable
 * without HMRC client credentials + the feature flag.
 */

export type HmrcConnection = {
  status: "disconnected" | "connecting" | "connected" | "error";
  vrn: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

const SELECT_COLUMNS = "status, hmrc_vrn, connected_at, last_sync_at, last_error";

type ConnectionRow = {
  status: string;
  hmrc_vrn: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};

/** The single HMRC connection state for one org, defaulting to disconnected when absent. Org-pinned, loud. */
export async function getHmrcConnection(orgId: string): Promise<HmrcConnection> {
  const supabase = await createClient();
  // hmrc_connections post-dates the generated types.ts; cast to a minimal
  // select builder (the accounting_connections idiom).
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => PromiseLike<{
            data: ConnectionRow | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
  const { data, error } = await loose
    .from("hmrc_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("hmrc connection: get", error);

  if (!data) {
    return { status: "disconnected", vrn: null, connectedAt: null, lastSyncAt: null, lastError: null };
  }
  return {
    status: data.status as HmrcConnection["status"],
    vrn: data.hmrc_vrn,
    connectedAt: data.connected_at,
    lastSyncAt: data.last_sync_at,
    lastError: data.last_error,
  };
}
