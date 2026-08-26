"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext, requireManagementRole } from "@/server/auth/session";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { poundsToPence } from "@/lib/money";
import {
  priceBookItemSchema,
  quoteTemplateSchema,
  type PriceBookItemInput,
  type QuoteTemplateInput,
} from "@/lib/pricing/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * /pricing server actions — the estimating price-book / rate-library CRUD and
 * saved quote templates.
 *
 * All writes run on the USER client so the org-pinned RLS policies are the real
 * authority; each write ALSO carries `.eq("org_id", ctx.org.id)` (the active
 * org, not "any org I belong to") so a blended dual-org context can never touch
 * another org's row. Money crosses the form in pounds and is stored as integer
 * pence (poundsToPence). Raw Postgres text never reaches the user (house rule) —
 * failures return a generic sentence and log the detail.
 *
 * The three new tables are not in the generated Supabase types (a types.ts regen
 * is deliberately avoided), so writes go through narrow chain casts — the exact
 * `as never` idiom used by /settings/api-keys actions.
 */

const GENERIC_ERROR = "Something went wrong. Try again.";

const idSchema = z.string().uuid();

// ── typed write chains for the untyped-to-tsc new tables ──────────────────────
type InsertChain = {
  insert: (row: Record<string, unknown>) => {
    select: (cols: string) => {
      single: () => PromiseLike<{ data: { id: string } | null; error: { message: string } | null }>;
    };
  } & PromiseLike<{ error: { message: string } | null }>;
};
type BulkInsertChain = {
  insert: (rows: Array<Record<string, unknown>>) => PromiseLike<{ error: { message: string } | null }>;
};
type UpdateChain = {
  update: (row: Record<string, unknown>) => {
    eq: (c: string, v: string) => {
      eq: (c: string, v: string) => {
        select: (cols: string) => PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null }>;
      };
    };
  };
};
type DeleteChain = {
  delete: () => {
    eq: (c: string, v: string) => {
      eq: (c: string, v: string) => {
        select: (cols: string) => PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null }>;
      };
    };
  };
};

function chain<T>(sb: unknown, table: string): T {
  return (sb as { from: (t: never) => unknown }).from(table as never) as unknown as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Price-book items
// ─────────────────────────────────────────────────────────────────────────────

export async function createPriceBookItem(
  _prev: FormState<PriceBookItemInput>,
  formData: FormData,
): Promise<FormState<PriceBookItemInput>> {
  const { user, ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const result = validateFormData(formData, priceBookItemSchema);
  if (!result.ok) return result.state as FormState<PriceBookItemInput>;

  const supabase = await createClient();
  const { error } = await chain<InsertChain>(supabase, "price_book_items").insert({
    org_id: ctx.org.id,
    code: result.data.code ?? null,
    description: result.data.description,
    unit: result.data.unit,
    unit_price: poundsToPence(result.data.unit_price),
    category: result.data.category ?? null,
    vat_rate: result.data.vat_rate,
    active: result.data.active,
    created_by: user.id,
  });
  if (error) {
    console.error("[pricing] create item failed", error.message);
    return formError("Couldn't save the item. Try again.", result.data);
  }
  revalidatePath("/price-book");
  return formSuccess<PriceBookItemInput>({
    successMessage: "Price-book item added.",
    redirectTo: "/price-book",
  });
}

export async function updatePriceBookItem(
  id: string,
  _prev: FormState<PriceBookItemInput>,
  formData: FormData,
): Promise<FormState<PriceBookItemInput>> {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  if (!idSchema.safeParse(id).success) return formError("Bad item reference.");
  const result = validateFormData(formData, priceBookItemSchema);
  if (!result.ok) return result.state as FormState<PriceBookItemInput>;

  const supabase = await createClient();
  const { data, error } = await chain<UpdateChain>(supabase, "price_book_items")
    .update({
      code: result.data.code ?? null,
      description: result.data.description,
      unit: result.data.unit,
      unit_price: poundsToPence(result.data.unit_price),
      category: result.data.category ?? null,
      vat_rate: result.data.vat_rate,
      active: result.data.active,
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .select("id");
  if (error) {
    console.error("[pricing] update item failed", error.message);
    return formError("Couldn't save the changes. Try again.", result.data);
  }
  if (!data || data.length === 0) {
    return formError("That item wasn't found.", result.data);
  }
  revalidatePath("/price-book");
  revalidatePath(`/price-book/${id}`);
  return formSuccess<PriceBookItemInput>({
    successMessage: "Item updated.",
    redirectTo: "/price-book",
  });
}

const setActiveSchema = z.object({
  id: idSchema,
  active: z.preprocess((v) => v === "true" || v === true, z.boolean()),
});

/** Archive (active=false) or restore (active=true) — the everyday retire. */
export async function setPriceBookItemActive(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const parsed = setActiveSchema.safeParse({
    id: formData.get("id"),
    active: formData.get("active"),
  });
  if (!parsed.success) return formError("Bad request.");

  const supabase = await createClient();
  const { data, error } = await chain<UpdateChain>(supabase, "price_book_items")
    .update({ active: parsed.data.active })
    .eq("id", parsed.data.id)
    .eq("org_id", ctx.org.id)
    .select("id");
  if (error) {
    console.error("[pricing] archive toggle failed", error.message);
    return formError(GENERIC_ERROR);
  }
  if (!data || data.length === 0) return formError("That item wasn't found.");
  revalidatePath("/price-book");
  return formSuccess({
    successMessage: parsed.data.active ? "Item restored." : "Item archived.",
  });
}

/** Hard delete — admin only (RLS enforces it too; this is the friendly gate). */
export async function deletePriceBookItem(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return formError("Only owners and admins can delete price-book items. You can archive it instead.");
  }
  const parsed = z.object({ id: idSchema }).safeParse({ id: formData.get("id") });
  if (!parsed.success) return formError("Bad request.");

  const supabase = await createClient();
  const { data, error } = await chain<DeleteChain>(supabase, "price_book_items")
    .delete()
    .eq("id", parsed.data.id)
    .eq("org_id", ctx.org.id)
    .select("id");
  if (error) {
    console.error("[pricing] delete item failed", error.message);
    return formError(GENERIC_ERROR);
  }
  if (!data || data.length === 0) return formError("That item wasn't found.");
  revalidatePath("/price-book");
  return formSuccess({ successMessage: "Item deleted." });
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved quote templates
// ─────────────────────────────────────────────────────────────────────────────

type QuoteLineRow = {
  description: string;
  qty: number;
  unit: string;
  unit_price: number; // numeric pounds on the legacy quote line
  vat_rate: number;
  sort_order: number;
};

/**
 * Save an existing quote's lines as a reusable template. Reads the quote's
 * persisted line items (org-pinned), converts their pounds → integer pence, and
 * writes a quote_templates row + its lines. Called from the quote detail page.
 */
export async function saveQuoteAsTemplate(
  quoteId: string,
  _prev: FormState<QuoteTemplateInput>,
  formData: FormData,
): Promise<FormState<QuoteTemplateInput>> {
  const { user, ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  if (!idSchema.safeParse(quoteId).success) return formError("Bad quote reference.");
  const result = validateFormData(formData, quoteTemplateSchema);
  if (!result.ok) return result.state as FormState<QuoteTemplateInput>;

  const supabase = await createClient();

  // Read the source quote's lines — org-pinned so a forged quoteId from another
  // org reads nothing (RLS is the backstop; the .eq is the scope). PAGED (F-1):
  // quote_line_items is a high-value table clamped at max_rows, so a bare select
  // could truncate a large quote; page on the unique sort_order+id order.
  const { data: lines, error: lineErr } = await fetchAllRows<QuoteLineRow>(
    (from, to) =>
      supabase
        .from("quote_line_items")
        .select("description, qty, unit, unit_price, vat_rate, sort_order")
        .eq("quote_id", quoteId)
        .eq("org_id", ctx.org.id)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: QuoteLineRow[] | null;
        error: unknown;
      }>,
  );
  if (lineErr) {
    console.error("[pricing] read quote lines failed", lineErr);
    return formError("Couldn't read the quote's lines. Try again.", result.data);
  }
  if (!lines || lines.length === 0) {
    return formError("This quote has no line items to save.", result.data);
  }

  const { data: tpl, error: tplErr } = await chain<InsertChain>(supabase, "quote_templates")
    .insert({
      org_id: ctx.org.id,
      name: result.data.name,
      job_type: result.data.job_type ?? null,
      notes: result.data.notes ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (tplErr || !tpl) {
    console.error("[pricing] create template failed", tplErr?.message);
    return formError("Couldn't save the template. Try again.", result.data);
  }

  const lineRows = lines.map((l, idx) => ({
    org_id: ctx.org.id,
    template_id: tpl.id,
    description: l.description,
    qty: l.qty,
    unit: l.unit,
    unit_price: poundsToPence(l.unit_price),
    vat_rate: Number(l.vat_rate),
    sort_order: typeof l.sort_order === "number" ? l.sort_order : idx,
  }));
  const { error: linesErr } = await chain<BulkInsertChain>(
    supabase,
    "quote_template_lines",
  ).insert(lineRows);
  if (linesErr) {
    console.error("[pricing] template lines insert failed", linesErr.message);
    // Best-effort cleanup of the orphaned parent so a half-saved template
    // doesn't linger (its cross-tenant FK cascade covers the reverse).
    await chain<DeleteChain>(supabase, "quote_templates")
      .delete()
      .eq("id", tpl.id)
      .eq("org_id", ctx.org.id)
      .select("id");
    return formError("Couldn't save the template's lines. Try again.", result.data);
  }

  revalidatePath("/price-book");
  return formSuccess<QuoteTemplateInput>({
    successMessage: `Saved "${result.data.name}" as a reusable template.`,
  });
}

export async function renameQuoteTemplate(
  id: string,
  _prev: FormState<QuoteTemplateInput>,
  formData: FormData,
): Promise<FormState<QuoteTemplateInput>> {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  if (!idSchema.safeParse(id).success) return formError("Bad template reference.");
  const result = validateFormData(formData, quoteTemplateSchema);
  if (!result.ok) return result.state as FormState<QuoteTemplateInput>;

  const supabase = await createClient();
  const { data, error } = await chain<UpdateChain>(supabase, "quote_templates")
    .update({
      name: result.data.name,
      job_type: result.data.job_type ?? null,
      notes: result.data.notes ?? null,
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .select("id");
  if (error) {
    console.error("[pricing] rename template failed", error.message);
    return formError("Couldn't save the changes. Try again.", result.data);
  }
  if (!data || data.length === 0) return formError("That template wasn't found.", result.data);
  revalidatePath("/price-book");
  return formSuccess<QuoteTemplateInput>({ successMessage: "Template updated." });
}

export async function deleteQuoteTemplate(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const parsed = z.object({ id: idSchema }).safeParse({ id: formData.get("id") });
  if (!parsed.success) return formError("Bad request.");

  const supabase = await createClient();
  // Lines cascade via the composite FK's `on delete cascade`.
  const { data, error } = await chain<DeleteChain>(supabase, "quote_templates")
    .delete()
    .eq("id", parsed.data.id)
    .eq("org_id", ctx.org.id)
    .select("id");
  if (error) {
    console.error("[pricing] delete template failed", error.message);
    return formError(GENERIC_ERROR);
  }
  if (!data || data.length === 0) return formError("That template wasn't found.");
  revalidatePath("/price-book");
  return formSuccess({ successMessage: "Template deleted." });
}
