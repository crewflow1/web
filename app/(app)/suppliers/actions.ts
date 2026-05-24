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
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) return formError("Invalid supplier id.");

  const result = validateFormData(formData, supplierFormSchema);
  if (!result.ok) return result.state as FormState<SupplierValues>;

  const supabase = await createClient();
  const { error } = await (
    supabase.from("suppliers" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    }
  )
    .update({
      name: result.data.name,
      phone: result.data.phone ?? null,
      email: result.data.email ?? null,
      category: result.data.category ?? null,
      notes: result.data.notes ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("[suppliers] update failed", error);
    return formError("Couldn't save changes.", result.data as SupplierValues);
  }

  revalidatePath("/suppliers");
  revalidatePath(`/suppliers/${id}`);
  return formSuccess({ successMessage: "Saved." });
}

export async function deleteSupplier(id: string) {
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/suppliers?error=bad_id");

  const supabase = await createClient();
  const { error } = await (
    supabase.from("suppliers" as never) as unknown as {
      delete: () => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    }
  )
    .delete()
    .eq("id", id);

  if (error) {
    console.error("[suppliers] delete failed", error);
    redirect(`/suppliers/${id}?error=delete_failed`);
  }

  revalidatePath("/suppliers");
  redirect("/suppliers");
}
