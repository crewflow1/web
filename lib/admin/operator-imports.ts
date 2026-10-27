import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireHqPage } from "@/server/auth/hq";

/**
 * Operator (super-admin) Migration OS — READ surface data layer.
 *
 * The customer import wizard (`app/(app)/imports`) operates on the CALLER's own
 * active org via `requireOrgContext()` + RLS. An operator needs to see ANOTHER
 * org's imports, which means the service-role admin client (RLS bypassed) — so
 * tenant isolation here is NOT enforced by the database; it is enforced by this
 * module, and only by this module. Two invariants, on every function:
 *
 *   1. AUTHORISATION — `requireHqPage()` is the FIRST act. A non-allowlisted
 *      caller 404s before any data is read (the super-admin env allowlist is the
 *      operator gate; see server/auth/hq.ts).
 *   2. EXPLICIT ORG PIN — every query is pinned to the caller-supplied
 *      `targetOrgId` with `.eq("org_id", targetOrgId)`. There is no implicit
 *      active org; an operator only ever sees the org they explicitly named, and
 *      a detail read requires BOTH the org id AND the row id to match, so a row
 *      from another org can never be reached by guessing its id.
 *
 * READ-ONLY by design. The operator WRITE path (remap / commit / rollback
 * against a target org) is a separate, scoped change — the customer write
 * pipeline is hardwired to `requireOrgContext()`/`ctx.org.id`, so threading an
 * operator target org through it safely is its own reviewed PR. See
 * docs/migration/MIGRATION-OS-OPERATOR-RUNBOOK.md.
 */

export type OperatorOrg = { id: string; org_name: string };

export type OperatorImport = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  committed_at: string | null;
  rolled_back_at: string | null;
  created_by: string | null;
};

const IMPORT_COLUMNS = "id, name, status, created_at, committed_at, rolled_back_at, created_by";

/** Orgs the operator can target. Super-admin only; read-only. */
export async function listOperatorOrgs(): Promise<OperatorOrg[]> {
  await requireHqPage();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(200);
  if (error) throw readFailure("operator-imports: organizations", error);
  return (data ?? []).map((o) => ({ id: o.id as string, org_name: (o.name as string) ?? "—" }));
}

/** List one target org's imports. Super-admin only; pinned to targetOrgId. */
export async function listOperatorImports(targetOrgId: string): Promise<OperatorImport[]> {
  await requireHqPage();
  const orgId = targetOrgId?.trim();
  if (!orgId) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("imports")
    .select(IMPORT_COLUMNS)
    .eq("org_id", orgId) // EXPLICIT org pin — the only isolation barrier (RLS bypassed).
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw readFailure("operator-imports: list", error);
  return (data ?? []) as OperatorImport[];
}

/**
 * One import of one target org. Requires BOTH the org id AND the row id to
 * match, so an operator viewing org A can never reach org B's row by id.
 * Returns null when no row matches within the target org.
 */
export async function getOperatorImport(
  targetOrgId: string,
  importId: string,
): Promise<OperatorImport | null> {
  await requireHqPage();
  const orgId = targetOrgId?.trim();
  const id = importId?.trim();
  if (!orgId || !id) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("imports")
    .select(IMPORT_COLUMNS)
    .eq("org_id", orgId) // org pin FIRST …
    .eq("id", id) // … then the row id, within that org.
    .maybeSingle();
  if (error) throw readFailure("operator-imports: detail", error);
  return (data ?? null) as OperatorImport | null;
}
