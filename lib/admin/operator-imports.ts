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
import { insertOne, skipReason, tableFor } from "@/lib/imports/commit";
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

// ---------------------------------------------------------------------------
// WRITE — operator commit + rollback (HIGH CONSEQUENCE).
//
// commit bulk-INSERTs staged rows into LIVE business tables; rollback bulk-
// DELETEs across 8 live tables. Both run via the service-role admin client
// (RLS bypassed), so the EXPLICIT targetOrgId pin on every read, insert, audit
// write and delete is the ONLY tenant barrier. Same insert implementation as
// the customer wizard (lib/imports/commit.ts) so the two paths cannot drift;
// the operator path differs only in that it authorises an EXPLICIT target org
// (never an active org) and does not fire the org's import.completed automation.
// ---------------------------------------------------------------------------

// Insert parents before children (customer before the job/quote/invoice that
// names it); mirrors the customer commit's ORDER.
const COMMIT_ORDER: readonly EntityType[] = [
  "customer",
  "supplier",
  "staff",
  "lead",
  "invoice",
  "cost",
  "quote",
  "job",
  "payment",
];

// Delete children before parents; mirrors the customer rollback's REVERSE_ORDER.
const ROLLBACK_ORDER: readonly string[] = [
  "invoice_payments",
  "jobs",
  "quotes",
  "invoices",
  "finances",
  "leads",
  "memberships",
  "customers",
];

export type OperatorCommitResult =
  | { ok: true; imported: number; skipped: number }
  | { ok: false; error: string };

/**
 * Commit a target org's import: insert its `pending`, confident rows into the
 * live business tables AS THAT ORG'S DATA. Every read, insert, audit row, and
 * status flip is pinned to `targetOrgId`; insertOne stamps `targetOrgId` on each
 * insert. A per-row failure marks that row and continues (partial success),
 * exactly as the customer path. Status-gated to "detected".
 */
export async function operatorCommitImport(
  targetOrgId: string,
  importId: string,
): Promise<OperatorCommitResult> {
  await requireHqPage();
  const orgId = targetOrgId?.trim();
  const id = importId?.trim();
  if (!orgId || !id) return { ok: false, error: "invalid_input" };
  if (!UUID_RE.test(id)) return { ok: false, error: "bad_id" };

  const admin = createAdminClient();
  const { data: imp, error: impErr } = await admin
    .from("imports")
    .select("id, status")
    .eq("id", id)
    .eq("org_id", orgId) // org pin FIRST.
    .maybeSingle();
  if (impErr) throw readFailure("operator-imports: commit guard", impErr);
  if (!imp) return { ok: false, error: "not_found" };
  if (imp.status !== "detected") return { ok: false, error: "not_ready" };

  const { data: rows, error: rowsErr } = await fetchAllRows<{
    id: string;
    entity_type: string | null;
    mapped: Json;
  }>((from, to) =>
    admin
      .from("import_rows")
      .select("id, entity_type, mapped, confidence, status")
      .eq("import_id", id)
      .eq("org_id", orgId) // EXPLICIT org pin — stops another org's row reaching insertOne.
      .in("status", ["pending"])
      .gte("confidence", 50)
      .range(from, to),
  );
  if (rowsErr) throw readFailure("operator-imports: commit rows", rowsErr);

  const byEntity = new Map<string, Array<{ id: string; mapped: Record<string, unknown> }>>();
  for (const r of rows ?? []) {
    const k = r.entity_type ?? "unknown";
    const arr = byEntity.get(k) ?? [];
    arr.push({ id: r.id, mapped: (r.mapped ?? {}) as Record<string, unknown> });
    byEntity.set(k, arr);
  }

  let imported = 0;
  let skipped = 0;
  for (const entity of COMMIT_ORDER) {
    for (const r of byEntity.get(entity) ?? []) {
      try {
        const targetId = await insertOne(entity, r.mapped, orgId, admin);
        if (!targetId) {
          skipped++;
          await admin
            .from("import_rows")
            .update({ status: "skipped", error_message: skipReason(entity) })
            .eq("id", r.id)
            .eq("org_id", orgId);
          continue;
        }
        await admin.from("import_audit").insert({
          org_id: orgId,
          import_id: id,
          import_row_id: r.id,
          target_table: tableFor(entity),
          target_id: targetId,
        });
        await admin
          .from("import_rows")
          .update({ status: "imported", target_table: tableFor(entity), target_id: targetId })
          .eq("id", r.id)
          .eq("org_id", orgId);
        imported++;
      } catch (e) {
        skipped++;
        await admin
          .from("import_rows")
          .update({ status: "error", error_message: (e as Error).message ?? "unknown" })
          .eq("id", r.id)
          .eq("org_id", orgId);
      }
    }
  }

  await admin
    .from("imports")
    .update({ status: "committed", committed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);

  return { ok: true, imported, skipped };
}

export type OperatorRollbackResult = { ok: true } | { ok: false; error: string };

/**
 * Roll a target org's committed import back: delete every audited target row and
 * mark the session rolled_back. Children before parents. Every DELETE carries
 * `.eq("org_id", targetOrgId)` as the last barrier on a service-role delete
 * across 8 live tables. Status-gated to "committed".
 */
export async function operatorRollbackImport(
  targetOrgId: string,
  importId: string,
): Promise<OperatorRollbackResult> {
  await requireHqPage();
  const orgId = targetOrgId?.trim();
  const id = importId?.trim();
  if (!orgId || !id) return { ok: false, error: "invalid_input" };
  if (!UUID_RE.test(id)) return { ok: false, error: "bad_id" };

  const admin = createAdminClient();
  const { data: imp, error: impErr } = await admin
    .from("imports")
    .select("id, status")
    .eq("id", id)
    .eq("org_id", orgId) // org pin FIRST.
    .maybeSingle();
  if (impErr) throw readFailure("operator-imports: rollback guard", impErr);
  if (!imp) return { ok: false, error: "not_found" };
  if (imp.status !== "committed") return { ok: false, error: "not_committed" };

  const { data: audit, error: auditErr } = await fetchAllRows<{ target_table: string; target_id: string }>(
    (from, to) =>
      admin
        .from("import_audit")
        .select("target_table, target_id")
        .eq("import_id", id)
        .eq("org_id", orgId) // pinned — the id list fed to the DELETEs can only be this org's.
        .range(from, to),
  );
  if (auditErr) throw readFailure("operator-imports: rollback audit", auditErr);

  const grouped = new Map<string, string[]>();
  for (const a of audit ?? []) {
    const arr = grouped.get(a.target_table) ?? [];
    arr.push(a.target_id);
    grouped.set(a.target_table, arr);
  }
  for (const table of ROLLBACK_ORDER) {
    const ids = grouped.get(table);
    if (!ids || ids.length === 0) continue;
    // Last line of defence on a service-role DELETE: every table carries org_id.
    const { error: delErr } = await admin
      .from(table as never)
      .delete()
      .in("id", ids)
      .eq("org_id" as never, orgId as never);
    if (delErr) throw readFailure(`operator-imports: rollback delete ${table}`, delErr);
  }
  await admin.from("import_audit").delete().eq("import_id", id).eq("org_id", orgId);
  await admin
    .from("import_rows")
    .update({ status: "skipped", target_id: null, target_table: null })
    .eq("import_id", id)
    .eq("org_id", orgId)
    .eq("status", "imported");
  await admin
    .from("imports")
    .update({ status: "rolled_back", rolled_back_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);

  return { ok: true };
}
