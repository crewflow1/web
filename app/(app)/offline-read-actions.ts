"use server";

import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  OFFLINE_READ_KINDS,
  offlineReadEntity,
  type OfflineReadKind,
} from "@/lib/offline/read-cache-registry";

/**
 * The server half of the OFFLINE READ CACHE.
 *
 * It builds the snapshots the client stores for offline viewing, and every read
 * here is exactly as privileged as the online list page it mirrors: it runs under
 * the caller's own session (`requireOrgContext()`), through the TENANT (user-JWT)
 * Supabase client, under the SAME RLS the online pages obey. There is no
 * service-role path and no way for the caller to name another org — the org comes
 * from the session, and every query is additionally PINNED to it in code (a
 * multi-org member's RLS would admit every org they belong to; the explicit
 * `.eq("org_id", …)` is what keeps a snapshot single-org, the #468 loud-reads seam).
 *
 * Each read is PAGED (registry pageLimit), ORDER-STABLE (registry orderBy, newest
 * first), and PROJECTED to the registry's safe-column allowlist — so nothing
 * sensitive or unbounded is ever handed to the device. Each read BINDS its own
 * error and is independent: one kind failing (a table a plan doesn't expose, a
 * transient blip) skips that kind and still returns the rest, so a partial cache
 * beats no cache. The caller is trusted only to STORE what it is given under its
 * own partition (lib/offline/read-cache.ts).
 */

export type OfflineReadSnapshot = {
  kind: OfflineReadKind;
  rows: Record<string, unknown>[];
  /** Whether the server saw a full page (so the client marks the cache partial). */
  full: boolean;
};

type SelectChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      order: (
        col: string,
        opts: { ascending: boolean },
      ) => {
        limit: (
          n: number,
        ) => Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>;
      };
    };
  };
};

/**
 * Read every cacheable entity for the active org, one paged+pinned+projected
 * query per kind. Returns only the kinds that read cleanly.
 */
export async function fetchOfflineReadSnapshots(): Promise<
  OfflineReadSnapshot[]
> {
  const { ctx } = await requireOrgContext();
  const orgId = ctx.org.id;
  const tenant = await createClient();

  const out: OfflineReadSnapshot[] = [];
  for (const kind of OFFLINE_READ_KINDS) {
    const entity = offlineReadEntity(kind);
    const { data, error } = await (
      tenant.from(entity.table as never) as unknown as SelectChain
    )
      .select(entity.columns.join(", "))
      // ORG PIN — never left to RLS to widen for a multi-org member.
      .eq("org_id", orgId)
      .order(entity.orderBy, { ascending: false })
      // PAGED — one row over the limit tells us there is more to come. Clamped with
      // Math.min so the F-1 guard can statically prove it is <= PostgREST max_rows;
      // every registry pageLimit is far under that, this is belt-and-braces.
      .limit(Math.min(entity.pageLimit + 1, 1000));

    // LOUD: bind the error, skip this kind, keep the rest. A failed read is never
    // silently reported as an empty entity.
    if (error) {
      console.error(`[offline-read] snapshot for ${kind} failed`, error);
      continue;
    }
    const rows = data ?? [];
    out.push({
      kind,
      rows: rows.slice(0, entity.pageLimit),
      full: rows.length > entity.pageLimit,
    });
  }

  return out;
}
