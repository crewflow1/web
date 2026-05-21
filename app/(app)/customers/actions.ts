"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  customerFormSchema,
  type CustomerFormInput,
} from "@/lib/customers/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * Customer CRUD server actions.
 *
 * All actions run under the user's JWT (lib/supabase/server) and are
 * therefore gated by the customers RLS policies from migration
 * 20260515150000:
 *   - SELECT / INSERT / UPDATE: any member of the org
 *   - DELETE: admins/owners only
 *
 * org_id on insert is derived from the user's membership context so the
 * caller can't write to another tenant's data even if they construct a
 * malicious form payload.
 */

export async function createCustomer(
  _prevState: FormState<CustomerFormInput>,
  formData: FormData,
): Promise<FormState<CustomerFormInput>> {
  const { ctx } = await requireOrgContext();
  const result = validateFormData(formData, customerFormSchema);
  if (!result.ok) return result.state;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .insert({
      org_id: ctx.org.id,
      name: result.data.name,
      email: result.data.email ?? null,
      phone: result.data.phone ?? null,
      notes: result.data.notes ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[customers] create failed", error);
    return formError(
      "Couldn't save the customer. Try again.",
      result.data,
    );
  }

  revalidatePath("/customers");
  return formSuccess({
    successMessage: "Customer saved.",
    redirectTo: `/customers/${data.id}`,
  });
}

export async function updateCustomer(
  id: string,
  _prevState: FormState<CustomerFormInput>,
  formData: FormData,
): Promise<FormState<CustomerFormInput>> {
  await requireOrgContext();
  const result = validateFormData(formData, customerFormSchema);
  if (!result.ok) return result.state;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("customers")
    .update(
      {
        name: result.data.name,
        email: result.data.email ?? null,
        phone: result.data.phone ?? null,
        notes: result.data.notes ?? null,
      },
      { count: "exact" },
    )
    .eq("id", id);

  if (error) {
    console.error("[customers] update failed", error);
    return formError("Couldn't save changes. Try again.", result.data);
  }
  if (count === 0) {
    return formError(
      "You don't have permission to edit this customer.",
      result.data,
    );
  }

  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  return formSuccess({ successMessage: "Saved." });
}

/**
 * Generate (or rotate) the customer's portal access token.
 *
 * The token is the only credential a customer needs to view their
 * quotes + invoices at /customer-portal/<token>. Re-running this
 * action mints a fresh UUID, which silently invalidates whatever link
 * the customer had — useful if the link was forwarded or leaked.
 *
 * Button-only action — keeps the redirect+querystring pattern because
 * there's no user input to preserve.
 */
export async function rotateCustomerPortalToken(id: string) {
  await requireOrgContext();
  const supabase = await createClient();
  const token = crypto.randomUUID();
  const { error, count } = await supabase
    .from("customers")
    .update({ portal_token: token }, { count: "exact" })
    .eq("id", id);
  if (error) {
    console.error("[customers] rotate portal token failed", error);
    redirect(`/customers/${id}?error=portal_token_failed`);
  }
  if (count === 0) {
    redirect(`/customers/${id}?error=not_allowed`);
  }
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${id}?saved=portal_link`);
}

export async function deleteCustomer(id: string) {
  await requireOrgContext();
  const supabase = await createClient();
  // RLS allows DELETE only for admins/owners. Non-admins get a no-op
  // (zero rows affected) — we still treat it as a redirect.
  const { error } = await supabase.from("customers").delete().eq("id", id);
  if (error) {
    console.error("[customers] delete failed", error);
    redirect(`/customers/${id}?error=delete_failed`);
  }
  revalidatePath("/customers");
  redirect("/customers");
}
