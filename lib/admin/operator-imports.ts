import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireHqPage } from "@/server/auth/hq";
import {
  entityFieldNames,
  remapRawWithColumnMap,
  type EntityType,
} from "@/lib/imports/detect";
import type { Json } from "@/lib/supabase/types";

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

/**
 * Orgs the operator can target. Super-admin only; read-only. Paged in full via
 * fetchAllRows so the operator picker is COMPLETE — never silently drops an org
 * past a flat cap (F-1).
 */
export async function listOperatorOrgs(): Promise<OperatorOrg[]> {
  await requireHqPage();
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<{ id: string; name: string | null }>((from, to) =>
    admin.from("organizations").select("id, name").order("name", { ascending: true }).range(from, to),
  );
  if (error) throw readFailure("operator-imports: organizations", error);
  return (data ?? []).map((o) => ({ id: o.id, org_name: o.name ?? "—" }));
}

/**
 * List one target org's imports. Super-admin only; pinned to targetOrgId and
 * paged in full (fetchAllRows) so an operator sees the COMPLETE set for that org.
 */
export async function listOperatorImports(targetOrgId: string): Promise<OperatorImport[]> {
  await requireHqPage();
  const orgId = targetOrgId?.trim();
  if (!orgId) return [];
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<OperatorImport>((from, to) =>
    admin
      .from("imports")
      .select(IMPORT_COLUMNS)
      .eq("org_id", orgId) // EXPLICIT org pin — the only isolation barrier (RLS bypassed).
      .order("created_at", { ascending: false })
      .range(from, to),
  );
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

// ---------------------------------------------------------------------------
// WRITE — operator column remap (staging-only, reversible).
//
// This is the first operator WRITE op and is deliberately STAGING-ONLY: it
// rewrites `import_rows.mapped` for still-open rows of one entity in one target
// org's import. It NEVER touches live business tables — commit (bulk insert) and
// rollback (bulk delete across 8 business tables) are far higher-consequence and
// are a separate, separately-reviewed slice (see MIGRATION-OS-OPERATOR-RUNBOOK).
// A remap is reversible (remap again), so the blast radius is one import's
// staging rows. Same two invariants as the read layer: requireHqPage() first,
// every query pinned to the caller-supplied targetOrgId.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-row confidence floor — mirrors the customer path's REVIEW_THRESHOLD. */
const REVIEW_THRESHOLD = 50;

/** Entities whose column mapping an operator may override (mirrors the wizard's SHEET_OVERRIDE_ENTITIES). */
const REMAPPABLE_ENTITIES: readonly EntityType[] = [
  "customer",
  "staff",
  "job",
  "quote",
  "invoice",
  "supplier",
  "cost",
  "payment",
];

export type OperatorImportEntity = { entity: string; openRows: number; headers: string[] };

/**
 * Per-entity introspection for the remap form: the still-open row count and the
 * union of raw source headers (so the operator picks a real column, not free
 * text). Super-admin only; pinned to targetOrgId; paged in full.
 */
export async function getOperatorImportEntities(
  targetOrgId: string,
  importId: string,
): Promise<OperatorImportEntity[]> {
  await requireHqPage();
  const orgId = targetOrgId?.trim();
  const id = importId?.trim();
  if (!orgId || !id) return [];
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<{ entity_type: string | null; raw: unknown; status: string }>(
    (from, to) =>
      admin
        .from("import_rows")
        .select("entity_type, raw, status")
        .eq("import_id", id)
        .eq("org_id", orgId) // EXPLICIT org pin.
        .in("status", ["pending", "needs_review"])
        .range(from, to),
  );
  if (error) throw readFailure("operator-imports: entities", error);
  const byEntity = new Map<string, { openRows: number; headers: Set<string> }>();
  for (const r of data ?? []) {
    const e = r.entity_type ?? "unknown";
    const slot = byEntity.get(e) ?? { openRows: 0, headers: new Set<string>() };
    slot.openRows++;
    if (r.raw && typeof r.raw === "object") {
      for (const k of Object.keys(r.raw as Record<string, unknown>)) slot.headers.add(k);
    }
    byEntity.set(e, slot);
  }
  return [...byEntity.entries()].map(([entity, v]) => ({
    entity,
    openRows: v.openRows,
    headers: [...v.headers].sort(),
  }));
}

export type OperatorRemapResult = { ok: true; changed: number } | { ok: false; error: string };

/**
 * Operator column remap: re-materialise `import_rows.mapped` for still-open rows
 * of one entity using operator-chosen field→source-header overrides. The engine
 * (`remapRawWithColumnMap`) re-validates BOTH sides (field must be canonical for
 * the entity; header must be a real column of the row's raw), so a crafted
 * override can never bind an arbitrary field to an arbitrary column. Sub-threshold
 * rows stay `needs_review` — a remap does not verify VALUES. Does not re-check
 * duplicates (advisory; re-run to refresh). Returns a discriminated result; never
 * redirects (the server action owns navigation).
 */
export async function operatorRemapColumns(input: {
  targetOrgId: string;
  importId: string;
  entity: string;
  overrides: Record<string, string>;
}): Promise<OperatorRemapResult> {
  await requireHqPage();
  const orgId = input.targetOrgId?.trim();
  const importId = input.importId?.trim();
  if (!orgId || !importId) return { ok: false, error: "invalid_input" };
  if (!UUID_RE.test(importId)) return { ok: false, error: "bad_id" };

  const entity = REMAPPABLE_ENTITIES.find((e) => e === input.entity);
  if (!entity) return { ok: false, error: "pick_entity_type" };

  // Keep only overrides naming a canonical field of this entity with a non-empty
  // source header — the server-side allow-list (never trust the form shape).
  const allowed = new Set(entityFieldNames(entity));
  const overrides: Record<string, string> = {};
  for (const [field, source] of Object.entries(input.overrides ?? {})) {
    if (allowed.has(field) && typeof source === "string" && source.trim().length > 0) {
      overrides[field] = source.trim();
    }
  }
  if (Object.keys(overrides).length === 0) return { ok: false, error: "pick_column" };

  const admin = createAdminClient();
  const { data: imp, error: impErr } = await admin
    .from("imports")
    .select("id, status")
    .eq("id", importId)
    .eq("org_id", orgId) // org pin FIRST.
    .maybeSingle();
  if (impErr) throw readFailure("operator-imports: remap guard", impErr);
  if (!imp) return { ok: false, error: "not_found" };
  if (imp.status !== "detected") return { ok: false, error: "not_reviewable" };

  const { data: rows, error: rowsErr } = await fetchAllRows<{ id: string; raw: unknown }>((from, to) =>
    admin
      .from("import_rows")
      .select("id, raw")
      .eq("import_id", importId)
      .eq("org_id", orgId) // EXPLICIT org pin on the rows too.
      .eq("entity_type", entity)
      .in("status", ["pending", "needs_review"])
      .range(from, to),
  );
  if (rowsErr) throw readFailure("operator-imports: remap rows", rowsErr);

  let changed = 0;
  for (const r of rows ?? []) {
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    const remapped = remapRawWithColumnMap(raw, entity, overrides);
    const { error: upErr } = await admin
      .from("import_rows")
      .update({
        mapped: remapped.mapped as unknown as Json,
        confidence: remapped.confidence,
        status: remapped.confidence < REVIEW_THRESHOLD ? "needs_review" : "pending",
        error_message: remapped.warnings.length > 0 ? remapped.warnings.join("; ") : null,
      })
      .eq("id", r.id)
      .eq("org_id", orgId); // last-line org pin on the write.
    if (upErr) throw readFailure("operator-imports: remap update", upErr);
    changed++;
  }
  return { ok: true, changed };
}
