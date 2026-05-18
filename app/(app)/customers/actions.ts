"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

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

const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z
    .string()
    .trim()
    .max(254)
    .email("Doesn't look like a valid email")
    .or(z.literal("").transform(() => undefined))
    .optional(),
  phone: z.string().trim().max(50).optional().or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(5000).optional().or(z.literal("").transform(() => undefined)),
});

function parseForm(formData: FormData) {
  return customerSchema.safeParse({
    name: formData.get("name") ?? "",
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

export async function createCustomer(formData: FormData) {
  const { ctx } = await requireOrgContext();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/customers/new?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .insert({
      org_id: ctx.org.id,
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      notes: parsed.data.notes ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[customers] create failed", error);
    redirect("/customers/new?error=create_failed");
  }

  revalidatePath("/customers");
  redirect(`/customers/${data.id}`);
}

export async function updateCustomer(id: string, formData: FormData) {
  await requireOrgContext();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/customers/${id}?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("customers")
    .update(
      {
        name: parsed.data.name,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        notes: parsed.data.notes ?? null,
      },
      { count: "exact" },
    )
    .eq("id", id);

  if (error) {
    console.error("[customers] update failed", error);
    redirect(`/customers/${id}?error=update_failed`);
  }
  if (count === 0) {
    redirect(`/customers/${id}?error=update_denied`);
  }

  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${id}?saved=1`);
}

/**
 * Generate (or rotate) the customer's portal access token.
 *
 * The token is the only credential a customer needs to view their
 * quotes + invoices at /customer-portal/<token>. Re-running this
 * action mints a fresh UUID, which silently invalidates whatever link
 * the customer had — useful if the link was forwarded or leaked.
 *
 * Members can rotate (allowed by RLS UPDATE policy). Delete-of-token
 * is reachable via re-rotation only; we never set it back to NULL
 * from the UI to keep "has been generated" a one-way state.
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
