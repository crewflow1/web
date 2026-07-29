import "server-only";

/**
 * Suppliers — the read layer behind /suppliers, its detail routes, and the
 * supplier pickers embedded in other domains.
 *
 * Every read here is PINNED to the active org as well as running under RLS.
 * `current_org_ids()` returns EVERY org the viewer belongs to (see the
 * `suppliers_select` policy in 20260623000000_final_additions.sql), so an
 * RLS-only read blends orgs for a dual-org member: the address book lists the
 * other company's suppliers, a `/suppliers/[id]` link opens the other
 * company's supplier inside THIS org's shell, and the expense/PO pickers offer
 * a supplier that the write side will then refuse. Same class as the job-domain
 * fixes in #456, the finance writes in #459 and the rota in #461.
 *
 * This is a correctness / data-integrity defect, not a cross-tenant breach —
 * the viewer is a legitimate member of both orgs. RLS remains the outer
 * boundary and is untouched by anything in this file.
 *
 * A row in a non-active org is deliberately INDISTINGUISHABLE from one that
 * does not exist: `loadSupplierForOrg` returns null and callers `notFound()`
 * exactly as they already did for a genuinely missing supplier. Note this
 * deliberately does NOT switch the viewer's active org to match the URL —
 * whether opening another org's link should offer to switch is a product
 * decision, not something a scoping fix may assume.
 *
 * These functions take the Supabase client as an argument (mirrors
 * server/services/rota.ts) so the integration suite can drive the EXACT same
 * queries with a real multi-org user's JWT against real Postgres — removing a
 * pin here goes red in __tests__/integration/rls/supplier-active-org.test.ts,
 * not just in review.
 *
 * `suppliers` is not in the generated Supabase types, so the client is accessed
 * through the loose shape below — the same cast style the call sites already
 * used for this table.
 */

import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

type Row = Record<string, unknown>;

export type SuppliersClient = { from: (t: string) => SuppliersBuilder };

type SuppliersBuilder = PromiseLike<{ data: Row[] | null; error: SupabaseReadError | null }> & {
  select: (c: string) => SuppliersBuilder;
  eq: (k: string, v: unknown) => SuppliersBuilder;
  order: (k: string, o: { ascending: boolean }) => SuppliersBuilder;
  limit: (n: number) => SuppliersBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: SupabaseReadError | null }>;
};

/** How many suppliers the address book and the pickers read at most. */
export const SUPPLIER_LIST_LIMIT = 500;

/**
 * Load one supplier by id, constrained to `orgId` (the ACTIVE org).
 *
 * Returns null when the supplier does not exist OR belongs to another org —
 * the two cases are deliberately indistinguishable to the caller.
 */
export async function loadSupplierForOrg<T = { id: string }>(
  db: SuppliersClient,
  orgId: string,
  supplierId: string,
  columns: string = "id",
): Promise<T | null> {
  const { data, error } = await db
    .from("suppliers")
    .select(columns)
    .eq("id", supplierId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("suppliers: supplier by id", error);
  return (data as T | null) ?? null;
}

/**
 * List suppliers for `orgId` (the ACTIVE org) — the address book and every
 * supplier picker. Without the org pin a dual-org member is offered the other
 * company's suppliers, which leaks their names into this org's shell and
 * produces a selection the org-scoped write side cannot honour.
 */
export async function listSuppliersForOrg<T = { id: string; name: string }>(
  db: SuppliersClient,
  orgId: string,
  opts: {
    columns?: string;
    orderBy?: string;
    ascending?: boolean;
    limit?: number;
  } = {},
): Promise<T[]> {
  const { data, error } = await db
    .from("suppliers")
    .select(opts.columns ?? "id, name")
    .eq("org_id", orgId)
    .order(opts.orderBy ?? "name", { ascending: opts.ascending ?? true })
    .limit(opts.limit ?? SUPPLIER_LIST_LIMIT);
  if (error) throw readFailure("suppliers: supplier list", error);
  return (data ?? []) as unknown as T[];
}
