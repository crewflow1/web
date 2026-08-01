import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type { TemplateItemRow, TemplateRow } from "@/lib/quality/schema";

/**
 * Works Quality — ITP template read layer (M2).
 *
 * Same discipline as app/(app)/quality/_data.ts: tenant (user-JWT) client
 * only; every read carries its own `.eq("org_id", orgId)` ACTIVE-org pin
 * (#456/#463/#468); every rejected query THROWS via read-failure so a failed
 * read never renders as an empty library.
 */

const TEMPLATE_COLUMNS =
  "id, org_id, name, version, description, status, created_by, published_by, published_at, supersedes_id, created_at, updated_at";

const TEMPLATE_ITEM_COLUMNS =
  "id, org_id, template_id, item_number, title, acceptance_criteria, inspection_method, specification_ref, control_point, is_hold_point, required, created_at";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFrom = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; unbound it throws on first use.
const tbl = (c: unknown) => (c as AnyFrom).from.bind(c);
/* eslint-enable @typescript-eslint/no-explicit-any */

export type TemplateListItem = TemplateRow & { itemCount: number };

/** The org's template library, grouped by name in the UI. Two bounded reads. */
export async function listTemplates(orgId: string): Promise<TemplateListItem[]> {
  const supabase = await createClient();

  const { data, error } = await tbl(supabase)("inspection_plan_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("org_id", orgId)
    .order("name", { ascending: true })
    .order("version", { ascending: false })
    .limit(500);
  if (error) throw readFailure("quality: template library", error as SupabaseReadError);
  const rows = (data ?? []) as TemplateRow[];
  if (rows.length === 0) return [];

  const { data: items, error: itemsError } = await tbl(supabase)("inspection_plan_template_items")
    .select("id, template_id")
    .eq("org_id", orgId)
    .in("template_id", rows.map((r) => r.id));
  if (itemsError) throw readFailure("quality: template item counts", itemsError as SupabaseReadError);
  const counts = new Map<string, number>();
  for (const i of (items ?? []) as Array<{ template_id: string }>) {
    counts.set(i.template_id, (counts.get(i.template_id) ?? 0) + 1);
  }

  return rows.map((r) => ({ ...r, itemCount: counts.get(r.id) ?? 0 }));
}

/**
 * One template version + its items, ACTIVE-org pinned. A template in a
 * non-active org is INDISTINGUISHABLE from a missing one.
 */
export async function getTemplate(
  orgId: string,
  id: string,
): Promise<{ template: TemplateRow; items: TemplateItemRow[] } | null> {
  const supabase = await createClient();

  const { data, error } = await tbl(supabase)("inspection_plan_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("quality: template", error as SupabaseReadError);
  if (!data) return null;

  const { data: items, error: itemsError } = await tbl(supabase)("inspection_plan_template_items")
    .select(TEMPLATE_ITEM_COLUMNS)
    .eq("template_id", id)
    .eq("org_id", orgId)
    .order("item_number", { ascending: true });
  if (itemsError) throw readFailure("quality: template items", itemsError as SupabaseReadError);

  return {
    template: data as TemplateRow,
    items: (items ?? []) as TemplateItemRow[],
  };
}
