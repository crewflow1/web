import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  ERASE_ANONYMISE_TABLES,
  ERASE_HARD_DELETE_TABLES,
  ERASE_RETAIN_TABLES,
  ERASE_STORAGE_BUCKETS,
} from "@/lib/gdpr/erase-tables";

/**
 * GDPR right-to-erasure (Art. 17) SERVICE — the orchestrator behind the gated
 * erasure route.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES (and the order, which is load-bearing).
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. STORAGE cleanup FIRST — remove every object under `<org_id>/…` across the
 *    tenant buckets via the Storage API (NOT SQL: deleting a `storage.objects`
 *    row leaves the S3 bytes orphaned; the Storage API removes both). Doing this
 *    first means that if the DB step later rolls back, the operation is simply
 *    re-runnable to completion — storage is already empty (0 removed) and the DB
 *    erasure proceeds. Idempotent.
 * 2. DB erasure SECOND — one call to the single-transaction, service_role-only,
 *    confirmation-gated `gdpr_erase_org` primitive, handing it the deterministic
 *    disposition sets from lib/gdpr/erase-tables.ts (the single source of truth —
 *    SQL never holds a second copy) plus the storage count for the audit row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SERVICE-ROLE CLIENT.
 * ─────────────────────────────────────────────────────────────────────────────
 * The erasure primitive is service_role-only (a destructive function must be
 * unreachable with the public anon key), and post-erasure the org has no
 * memberships, so no user-JWT could complete the cascade under RLS. The AUTHZ
 * boundary is therefore the ROUTE (owner/super-admin + feature flag + confirm
 * token), not RLS — exactly the posture the admin-client doc mandates: elevated
 * privilege, strict validation upstream. The DB primitive independently
 * re-checks service_role AND the confirmation token as defence in depth.
 */

/** Server-only erasure feature flag. DEFAULTS OFF. */
export function gdprErasureEnabled(): boolean {
  return process.env.FEATURE_GDPR_ERASURE === "true";
}

export type ErasureSummary = {
  orgId: string;
  status: "erased";
  anonymisedTables: number;
  anonymisedRows: number;
  deletedTables: number;
  deletedRows: number;
  storageObjectsDeleted: number;
};

type StorageListItem = { name: string; id: string | null };
type StorageApi = {
  from(bucket: string): {
    list(
      path: string,
      opts: { limit: number; offset: number },
    ): PromiseLike<{ data: StorageListItem[] | null; error: { message: string } | null }>;
    remove(
      paths: string[],
    ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
};

/** A "bucket does not exist in this environment" shape difference — benign. */
function isMissingBucket(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("not found") || m.includes("does not exist");
}

const STORAGE_PAGE = 1000;

/**
 * Recursively enumerate every object path under `prefix` in `bucket`. Supabase's
 * `list` is one folder level deep (folders come back with `id === null`), so we
 * recurse. Loud: a real list error throws; a missing bucket returns [].
 */
async function listAllObjectPaths(
  storage: StorageApi,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const out: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await storage
      .from(bucket)
      .list(prefix, { limit: STORAGE_PAGE, offset });
    if (error) {
      if (isMissingBucket(error.message)) return [];
      throw new Error(`gdpr erase: storage list ${bucket}/${prefix}: ${error.message}`);
    }
    const items = data ?? [];
    for (const item of items) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) {
        // A folder — recurse.
        const nested = await listAllObjectPaths(storage, bucket, full);
        out.push(...nested);
      } else {
        out.push(full);
      }
    }
    if (items.length < STORAGE_PAGE) break;
    offset += STORAGE_PAGE;
  }
  return out;
}

/**
 * Remove every storage object owned by `orgId` across the tenant buckets. Files
 * are stored org-prefixed (`<org_id>/…`), matching the storage RLS policies
 * (`split_part(name,'/',1) = org_id`). Returns the number of objects removed.
 * Loud + idempotent: re-running after a partial run simply removes whatever
 * remains (0 if already clean).
 */
async function cleanupOrgStorage(
  storage: StorageApi,
  orgId: string,
): Promise<number> {
  let removed = 0;
  for (const bucket of ERASE_STORAGE_BUCKETS) {
    const paths = await listAllObjectPaths(storage, bucket, orgId);
    for (let i = 0; i < paths.length; i += STORAGE_PAGE) {
      const batch = paths.slice(i, i + STORAGE_PAGE);
      if (batch.length === 0) continue;
      const { error } = await storage.from(bucket).remove(batch);
      if (error) {
        throw new Error(`gdpr erase: storage remove ${bucket}: ${error.message}`);
      }
      removed += batch.length;
    }
  }
  return removed;
}

/**
 * Erase one organisation's personal data (GDPR Art. 17). Storage first, then the
 * transactional DB primitive. The caller (the route) is responsible for the
 * feature-flag + owner/super-admin + confirmation-token gates BEFORE calling.
 *
 * `confirm` MUST equal the org slug — passed through to the DB primitive, which
 * re-verifies it (belt-and-braces anti-misfire). A mismatch raises there and
 * nothing is destroyed.
 */
export async function eraseOrg(params: {
  orgId: string;
  confirm: string;
  requestedBy: string | null;
}): Promise<ErasureSummary> {
  const { orgId, confirm, requestedBy } = params;
  const admin = createAdminClient();

  // 1. Storage bytes (idempotent, loud).
  const storageObjectsDeleted = await cleanupOrgStorage(
    admin.storage as unknown as StorageApi,
    orgId,
  );

  // 2. DB erasure — one transaction, classification from the single source of
  // truth. types.ts predates this RPC; call through a loose cast (the export
  // service uses the same idiom for gdpr_export_log).
  const rpc = admin as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await rpc.rpc("gdpr_erase_org", {
    p_org_id: orgId,
    p_confirm: confirm,
    p_anonymise: [...ERASE_ANONYMISE_TABLES],
    p_hard_delete: [...ERASE_HARD_DELETE_TABLES],
    p_retain: [...ERASE_RETAIN_TABLES],
    p_storage_objects_deleted: storageObjectsDeleted,
    p_requested_by: requestedBy,
  });
  if (error) {
    throw new Error(`gdpr erase: ${error.message}`);
  }

  const summary = (data ?? {}) as Record<string, unknown>;
  return {
    orgId,
    status: "erased",
    anonymisedTables: Number(summary.anonymised_tables ?? 0),
    anonymisedRows: Number(summary.anonymised_rows ?? 0),
    deletedTables: Number(summary.deleted_tables ?? 0),
    deletedRows: Number(summary.deleted_rows ?? 0),
    storageObjectsDeleted,
  };
}
