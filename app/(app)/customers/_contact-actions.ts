"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure } from "@/lib/supabase/read-failure";
import { staffCustomerContactSchema } from "@/lib/customers/contacts";

/**
 * Staff-side customer_contacts CRUD (table: 20261141000000).
 *
 * The customer PORTAL can already add a reachable contact
 * (app/customer-portal/_contact-action.ts); this is the STAFF surface — full
 * create / edit / delete / set-primary, run on the caller's RLS-scoped user-JWT
 * client. Contacts are member-writable (RLS: members select/insert/update,
 * admins delete); every by-id write is ADDITIONALLY ACTIVE-org pinned
 * (`.eq("org_id", ctx.org.id)`) because `current_org_ids()` admits every org the
 * caller belongs to — the pin is the real inner scope, and a foreign contact is
 * then indistinguishable from a missing one.
 *
 * portal_token / portal_access_enabled are NEVER touched here: provisioning a
 * contact login is a separate, deliberate action, so this CRUD can add a
 * reachable person without ever minting a credential (the schema keeps the two
 * in lockstep via customer_contacts_token_access_agree).
 *
 * customer_contacts isn't in the generated Supabase types yet — the established
 * `as never` cast idiom (see notifications-service / _job-checklist).
 *
 * Returns plain `{ ok, error }`; the client calls inside a transition and
 * router.refresh()es, so there is no redirect()/router.push and no deep-swap
 * commit race.
 */

export type ContactResult = { ok: boolean; error?: string };

const idSchema = z.string().uuid();

/* eslint-disable @typescript-eslint/no-explicit-any */
const tbl = (c: unknown) => (c as { from: (t: string) => any }).from.bind(c);
/* eslint-enable @typescript-eslint/no-explicit-any */

function parseContact(formData: FormData) {
  return staffCustomerContactSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    role: formData.get("role") ?? "other",
    notes: formData.get("notes"),
  });
}

/** The customer must be in the caller's active org before we attach a contact. */
async function customerInOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  customerId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("customer contacts: customer in org", error);
  return Boolean(data);
}

export async function addCustomerContact(
  customerId: string,
  formData: FormData,
): Promise<ContactResult> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(customerId).success) return { ok: false, error: "Bad customer." };
  const parsed = parseContact(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  }

  const supabase = await createClient();
  if (!(await customerInOrg(supabase, ctx.org.id, customerId))) {
    return { ok: false, error: "That customer isn't in this workspace." };
  }

  const { error } = await tbl(supabase)("customer_contacts").insert({
    org_id: ctx.org.id,
    customer_id: customerId,
    name: parsed.data.name,
    email: parsed.data.email ?? null,
    phone: parsed.data.phone ?? null,
    role: parsed.data.role,
    notes: parsed.data.notes ?? null,
    // Access provisioning is a separate deliberate action — never minted here.
    portal_access_enabled: false,
    portal_token: null,
    created_by: user.id,
  });
  if (error) {
    console.error("[customer-contacts] add failed", error);
    return { ok: false, error: "Couldn't add the contact. Try again." };
  }
  revalidatePath(`/customers/${customerId}`);
  return { ok: true };
}

export async function updateCustomerContact(
  contactId: string,
  formData: FormData,
): Promise<ContactResult> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(contactId).success) return { ok: false, error: "Bad contact." };
  const parsed = parseContact(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  }

  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("customer_contacts")
    .update(
      {
        name: parsed.data.name,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        role: parsed.data.role,
        notes: parsed.data.notes ?? null,
      },
      { count: "exact" },
    )
    .eq("id", contactId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[customer-contacts] update failed", error);
    return { ok: false, error: "Couldn't save the contact. Try again." };
  }
  if (count === 0) return { ok: false, error: "That contact isn't in this workspace." };
  revalidatePath("/customers", "layout");
  return { ok: true };
}

export async function deleteCustomerContact(contactId: string): Promise<ContactResult> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(contactId).success) return { ok: false, error: "Bad contact." };

  const supabase = await createClient();
  // RLS allows DELETE only for admins/owners; a non-admin gets a no-op (count 0).
  const { error, count } = await tbl(supabase)("customer_contacts")
    .delete({ count: "exact" })
    .eq("id", contactId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[customer-contacts] delete failed", error);
    return { ok: false, error: "Couldn't remove the contact. Try again." };
  }
  if (count === 0) {
    return { ok: false, error: "You don't have permission to remove this contact." };
  }
  revalidatePath("/customers", "layout");
  return { ok: true };
}

/**
 * Make ONE contact the customer's primary. Roles are a small vocabulary (there
 * is no separate is_primary flag), so "primary" is a role: we demote any current
 * primary(ies) for this customer to 'other', then promote the target. Both
 * writes are org + customer pinned so exactly one primary can exist per customer
 * and neither write can reach another org's rows.
 */
export async function setPrimaryCustomerContact(
  customerId: string,
  contactId: string,
): Promise<ContactResult> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(customerId).success) return { ok: false, error: "Bad customer." };
  if (!idSchema.safeParse(contactId).success) return { ok: false, error: "Bad contact." };

  const supabase = await createClient();

  // Demote existing primaries for this customer (excluding the target). Best of
  // both: even a legacy multi-primary state collapses to one after this runs.
  const { error: demoteError } = await tbl(supabase)("customer_contacts")
    .update({ role: "other" })
    .eq("org_id", ctx.org.id)
    .eq("customer_id", customerId)
    .eq("role", "primary")
    .neq("id", contactId);
  if (demoteError) {
    console.error("[customer-contacts] set-primary demote failed", demoteError);
    return { ok: false, error: "Couldn't update the primary contact. Try again." };
  }

  const { error, count } = await tbl(supabase)("customer_contacts")
    .update({ role: "primary" }, { count: "exact" })
    .eq("id", contactId)
    .eq("org_id", ctx.org.id)
    .eq("customer_id", customerId);
  if (error) {
    console.error("[customer-contacts] set-primary promote failed", error);
    return { ok: false, error: "Couldn't update the primary contact. Try again." };
  }
  if (count === 0) return { ok: false, error: "That contact isn't in this workspace." };
  revalidatePath(`/customers/${customerId}`);
  return { ok: true };
}
