"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { FINANCE_CATEGORIES } from "@/lib/finances/schema";

/**
 * Expense budget actions — set/edit and remove an org/category standing target
 * (20261089). This is CRUD on the PLAN table only; it never touches expense
 * approval, the receipt-draft flow, or any money arithmetic on `finances` (the
 * budget-vs-actual figures are a pure READ overlay, lib/expenses/budget.ts).
 *
 * AUTHORISATION IS DOUBLED. The role check here produces a sentence for the
 * operator; the DB policies (`is_org_admin` on expense_budgets insert/update/
 * delete, and set_expense_budget running SECURITY INVOKER under them) are the
 * real boundary. Both write paths PIN `org_id`.
 *
 * Route depth is 2 (`/expenses/budgets`), so a plain server-action `redirect()`
 * is safe — this is NOT the deep-swap (≥4 segments) navigation trap.
 */

function isManager(role: string): boolean {
  return role === "owner" || role === "admin";
}

const setSchema = z.object({
  category: z.enum(FINANCE_CATEGORIES),
  // The operator types POUNDS; we store integer pence. Round at the boundary.
  amount: z.coerce
    .number({ invalid_type_error: "Enter an amount" })
    .finite()
    .positive("Budget must be more than £0")
    .max(9_999_999.99, "Amount is too large"),
  period_type: z.enum(["monthly", "quarterly", "annual"]),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const deleteSchema = z.object({ category: z.enum(FINANCE_CATEGORIES) });

export async function setExpenseBudget(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/expenses/budgets?error=forbidden");
  }

  const parsed = setSchema.safeParse({
    category: formData.get("category") ?? "",
    amount: formData.get("amount") ?? "",
    period_type: formData.get("period_type") ?? "monthly",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    redirect("/expenses/budgets?error=validation");
  }

  const amountPence = Math.round(parsed.data.amount * 100);
  const supabase = await createClient();
  const rpc = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
  };
  const { error } = await rpc.rpc("set_expense_budget", {
    p_org_id: ctx.org.id,
    p_category: parsed.data.category,
    p_amount_pence: amountPence,
    p_period_type: parsed.data.period_type,
    p_note: parsed.data.note ?? null,
  });
  if (error) {
    console.error("[expense-budgets] set failed", error);
    redirect("/expenses/budgets?error=save_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "expense_budget.set",
    targetTable: "expense_budgets",
    targetId: parsed.data.category,
    metadata: {
      category: parsed.data.category,
      amount_pence: amountPence,
      period_type: parsed.data.period_type,
    },
  });

  revalidatePath("/expenses/budgets");
  redirect("/expenses/budgets?saved=set");
}

export async function deleteExpenseBudget(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/expenses/budgets?error=forbidden");
  }

  const parsed = deleteSchema.safeParse({ category: formData.get("category") ?? "" });
  if (!parsed.success) {
    redirect("/expenses/budgets?error=validation");
  }

  // Tenant client: the expense_budgets admin DELETE policy is the boundary. Pin
  // org_id anyway — `current_org_ids()` spans every org the viewer belongs to,
  // so RLS alone would let a dual-org admin delete the wrong org's target.
  const supabase = await createClient();
  const { error } = await (
    supabase.from("expense_budgets" as never) as unknown as {
      delete: () => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
        };
      };
    }
  )
    .delete()
    .eq("org_id", ctx.org.id)
    .eq("category", parsed.data.category);
  if (error) {
    console.error("[expense-budgets] delete failed", error);
    redirect("/expenses/budgets?error=delete_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "expense_budget.deleted",
    targetTable: "expense_budgets",
    targetId: parsed.data.category,
    metadata: { category: parsed.data.category },
  });

  revalidatePath("/expenses/budgets");
  redirect("/expenses/budgets?saved=deleted");
}
