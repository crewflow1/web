import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { penceToPounds } from "@/lib/money";
import type {
  PriceBookPickerItem,
  QuoteTemplateApplyOption,
} from "@/lib/pricing/schema";

/**
 * Server-only reads for the estimating price-book + saved quote templates.
 *
 * These three tables (price_book_items, quote_templates, quote_template_lines)
 * are additive and not yet in the generated Supabase types (a types.ts regen is
 * deliberately avoided — it has historically tripped the security gate). So the
 * reads go through a small, locally-typed accessor `q()` — the same
 * untyped-client idiom the AI quote writer uses (server/services/ai-quote-writer
 * `table()`). Row shapes are pinned by the return types below.
 *
 * Every read:
 *   - is ORG-PINNED to the caller-supplied active org (the #456 convention) —
 *     RLS's current_org_ids() is the outer boundary, not the scope;
 *   - pages via fetchAllRows with a STABLE (…, id) order so nothing is silently
 *     truncated at the PostgREST 1000-row cap (F-1);
 *   - is LOUD: a failed page throws readFailure, never a silent partial list.
 */

type PageChain<Row> = {
  select: (cols: string) => {
    eq: (c: string, v: unknown) => {
      order: (
        c: string,
        o: { ascending: boolean },
      ) => {
        order: (
          c: string,
          o: { ascending: boolean },
        ) => {
          range: (
            from: number,
            to: number,
          ) => PromiseLike<{ data: Row[] | null; error: unknown }>;
        };
      };
    };
  };
};

type SingleChain<Row> = {
  select: (cols: string) => {
    eq: (c: string, v: unknown) => {
      eq: (c: string, v: unknown) => {
        maybeSingle: () => PromiseLike<{ data: Row | null; error: unknown }>;
      };
    };
  };
};

async function client(): Promise<{ from: (t: string) => unknown }> {
  return (await createClient()) as unknown as { from: (t: string) => unknown };
}

export type PriceBookItemRow = {
  id: string;
  code: string | null;
  description: string;
  unit: string;
  /** INTEGER PENCE as stored. */
  unit_price: number;
  category: string | null;
  vat_rate: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * The full rate library for the management list. Active first, then archived,
 * each alphabetical by description (id tiebreak for stable paging).
 */
export async function listPriceBookItems(
  orgId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<PriceBookItemRow[]> {
  const db = await client();
  const { data, error } = await fetchAllRows<PriceBookItemRow>((from, to) =>
    (db.from("price_book_items") as PageChain<PriceBookItemRow>)
      .select("id, code, description, unit, unit_price, category, vat_rate, active, created_at, updated_at")
      .eq("org_id", orgId)
      .order("description", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("price book: items", error);
  const rows = data ?? [];
  return opts.includeArchived ? rows : rows.filter((r) => r.active);
}

/**
 * Active items only, money converted to POUNDS, for the quote-builder picker.
 */
export async function listPriceBookForPicker(
  orgId: string,
): Promise<PriceBookPickerItem[]> {
  const items = await listPriceBookItems(orgId, { includeArchived: false });
  return items.map((r) => ({
    id: r.id,
    code: r.code ?? null,
    description: r.description,
    unit: r.unit,
    unit_price: penceToPounds(r.unit_price),
    vat_rate: r.vat_rate,
    category: r.category ?? null,
  }));
}

export async function getPriceBookItem(
  orgId: string,
  id: string,
): Promise<PriceBookItemRow | null> {
  const db = await client();
  const { data, error } = await (
    db.from("price_book_items") as SingleChain<PriceBookItemRow>
  )
    .select("id, code, description, unit, unit_price, category, vat_rate, active, created_at, updated_at")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("price book: item", error);
  return data ?? null;
}

export type QuoteTemplateRow = {
  id: string;
  name: string;
  job_type: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type TemplateLineRow = {
  id: string;
  template_id: string;
  description: string;
  qty: number;
  unit: string;
  unit_price: number;
  vat_rate: number;
  sort_order: number;
};

export type QuoteTemplateSummary = QuoteTemplateRow & { line_count: number };

async function readTemplateRows(orgId: string): Promise<QuoteTemplateRow[]> {
  const db = await client();
  const { data, error } = await fetchAllRows<QuoteTemplateRow>((from, to) =>
    (db.from("quote_templates") as PageChain<QuoteTemplateRow>)
      .select("id, name, job_type, notes, created_at, updated_at")
      .eq("org_id", orgId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("quote templates", error);
  return data ?? [];
}

async function readTemplateLines(orgId: string): Promise<TemplateLineRow[]> {
  const db = await client();
  const { data, error } = await fetchAllRows<TemplateLineRow>((from, to) =>
    (db.from("quote_template_lines") as PageChain<TemplateLineRow>)
      .select("id, template_id, description, qty, unit, unit_price, vat_rate, sort_order")
      .eq("org_id", orgId)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("quote template lines", error);
  return data ?? [];
}

/** Template summaries with a line count, for the management list. */
export async function listQuoteTemplates(
  orgId: string,
): Promise<QuoteTemplateSummary[]> {
  const [templates, lines] = await Promise.all([
    readTemplateRows(orgId),
    readTemplateLines(orgId),
  ]);
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.template_id, (counts.get(l.template_id) ?? 0) + 1);
  return templates.map((t) => ({ ...t, line_count: counts.get(t.id) ?? 0 }));
}

/**
 * Templates with their lines, money converted to POUNDS, for the quote-builder
 * "apply template" control. Lines are grouped by template and ordered by
 * sort_order so an applied scope reads in the order it was saved.
 */
export async function listQuoteTemplatesForBuilder(
  orgId: string,
): Promise<QuoteTemplateApplyOption[]> {
  const [templates, lines] = await Promise.all([
    readTemplateRows(orgId),
    readTemplateLines(orgId),
  ]);
  const byTemplate = new Map<string, TemplateLineRow[]>();
  for (const l of lines) {
    const arr = byTemplate.get(l.template_id) ?? [];
    arr.push(l);
    byTemplate.set(l.template_id, arr);
  }
  return templates
    .map((t) => ({
      id: t.id,
      name: t.name,
      job_type: t.job_type ?? null,
      lines: (byTemplate.get(t.id) ?? [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
        .map((l) => ({
          description: l.description,
          qty: Number(l.qty) || 1,
          unit: l.unit || "ea",
          unit_price: penceToPounds(l.unit_price),
          vat_rate: l.vat_rate,
        })),
    }))
    // A template with no lines can't populate a quote — hide it from Apply.
    .filter((t) => t.lines.length > 0);
}
