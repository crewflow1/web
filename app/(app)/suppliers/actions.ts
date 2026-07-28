"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { supplierFormSchema } from "@/lib/suppliers/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Phase D — Supplier CRUD.
 *
 * Suppliers are the "who you pay" side of the books. They get linked
 * to finances rows (cost side) via finances.supplier_id.
 */

type SupplierValues = Record<string, unknown>;
const idSchema = z.string().uuid();

export async function createSupplier(
  _prev: FormState<SupplierValues>,
  formData: FormData,
): Promise<FormState<SupplierValues>> {
  const { ctx, user } = await requireOrgContext();
  const result = validateFormData(formData, supplierFormSchema);
  if (!result.ok) return result.state as FormState<SupplierValues>;

  const supabase = await createClient();
  const { data, error } = await (
    supabase.from("suppliers" as never) as unknown as {
      insert: (row: unknown) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: ctx.org.id,
      name: result.data.name,
      phone: result.data.phone ?? null,
      email: result.data.email ?? null,
      category: result.data.category ?? null,
      notes: result.data.notes ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[suppliers] create failed", error);
    return formError("Couldn't save the supplier. Try again.", result.data as SupplierValues);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "supplier.created",
    targetTable: "suppliers",
    targetId: data.id,
    metadata: { name: result.data.name },
  });

  revalidatePath("/suppliers");
  return formSuccess({
    successMessage: "Supplier added.",
    redirectTo: "/suppliers",
  });
}

export async function updateSupplier(
  id: string,
  _prev: FormState<SupplierValues>,
  formData: FormData,
): Promise<FormState<SupplierValues>> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) return formError("Invalid supplier id.");

  const result = validateFormData(formData, supplierFormSchema);
  if (!result.ok) return result.state as FormState<SupplierValues>;

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("suppliers" as never) as unknown as {
      update: (
        row: unknown,
        opts: { count: "exact" },
      ) => {
        eq: (k: string, v: unknown) => {
          eq: (
            k: string,
            v: unknown,
          ) => Promise<{ error: { message: string } | null; count: number | null }>;
        };
      };
    }
  )
    .update(
      {
        name: result.data.name,
        phone: result.data.phone ?? null,
        email: result.data.email ?? null,
        category: result.data.category ?? null,
        notes: result.data.notes ?? null,
        updated_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .eq("id", id)
    // Active-org scope. `suppliers_update` only proves the caller is a member
    // of the supplier's OWN org — for a user who belongs to two orgs that
    // passes for BOTH, so without this predicate a write issued while working
    // in org A could land on an org B supplier. See server/services/suppliers.
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[suppliers] update failed", error);
    return formError("Couldn't save changes.", result.data as SupplierValues);
  }
  if (count === 0) {
    // Not in the ACTIVE org (or gone). Identical wording either way — a
    // non-active org's supplier must be indistinguishable from a missing one.
    return formError(
      "That supplier isn't in this organisation any more.",
      result.data as SupplierValues,
    );
  }

  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/${id}`);
  return formSuccess({ successMessage: "Supplier updated." });
}

export async function deleteSupplier(id: string) {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/suppliers?error=bad_id");

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("suppliers" as never) as unknown as {
      delete: (opts: { count: "exact" }) => {
        eq: (k: string, v: unknown) => {
          eq: (
            k: string,
            v: unknown,
          ) => Promise<{ error: { message: string } | null; count: number | null }>;
        };
      };
    }
  )
    .delete({ count: "exact" })
    .eq("id", id)
    // Active-org scope — see the note in updateSupplier. A delete is
    // irreversible, so this is the single most important predicate in this
    // file: `suppliers_delete` is `is_org_admin(org_id)`, which an owner of
    // two orgs satisfies for both.
    .eq("org_id", ctx.org.id);

  if (error) {
    // Kept: a supplier you have PAID cannot be deleted (supplier_payments
    // holds a NO ACTION FK). That 409-shaped refusal must keep its message.
    console.error("[suppliers] delete failed", error);
    redirect(`/suppliers/${id}?error=delete_failed`);
  }
  if (count === 0) {
    // Nothing matched. Two causes, deliberately treated alike: the caller is
    // not an admin of this org (`suppliers_delete` refused), or the supplier
    // belongs to a DIFFERENT org the caller happens to belong to. The detail
    // page explains the first and 404s on the second, because after the read
    // fix above it cannot load another org's supplier either.
    redirect(`/suppliers/${id}?error=delete_denied`);
  }

  revalidatePath("/suppliers");
  redirect("/suppliers");
}
