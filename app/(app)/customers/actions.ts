"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext, requireManagementRole } from "@/server/auth/session";
import {
  customerFormSchema,
  type CustomerFormInput,
} from "@/lib/customers/schema";
import { generateCustomerPortalToken } from "@/lib/customers/portal-token";
import { sendCustomerStatementEmail } from "@/lib/email/send-statement";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/** Trim + validate a YYYY-MM-DD statement bound; anything else is open-ended. */
function statementBound(v: FormDataEntryValue | null): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/**
 * Resolve the OPTIONAL parent-business link for a customer write.
 *
 * The composite FK (parent_customer_id, org_id) → customers(id, org_id) already
 * makes a cross-org parent unrepresentable at the DB level. This adds a friendly
 * fail-closed check at the write boundary: we confirm the parent exists in the
 * ACTIVE org (RLS admits every org the caller belongs to, so we pin org_id) and
 * that it is not the record editing itself. On any miss we return an error the
 * form can show, rather than letting the insert fail with a raw FK violation.
 *
 * Returns { id } with the validated parent id (or null to clear the link), or
 * { error } with a user-facing message.
 */
async function resolveParentCustomer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  rawParentId: string | undefined,
  selfId: string | null,
): Promise<{ id: string | null } | { error: string }> {
  if (!rawParentId) return { id: null };
  if (selfId && rawParentId === selfId) {
    return { error: "A customer can't be its own parent business." };
  }
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("id", rawParentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[customers] parent lookup failed", error);
    return { error: "Couldn't verify the parent business. Try again." };
  }
  if (!data) {
    return { error: "That parent business isn't in your customer list." };
  }
  return { id: data.id };
}

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
 *
 * By-id writes additionally carry `.eq("org_id", ctx.org.id)`. RLS is NOT
 * sufficient for that: its `current_org_ids()` helper deliberately returns
 * EVERY org the viewer belongs to (it is the outer boundary), so for a user
 * who belongs to two orgs an update/delete addressed by primary key alone
 * would reach the other org's customer from inside this org's shell. Zero
 * rows affected is reported as the existing "not allowed" outcome, so a
 * foreign id is indistinguishable from a missing one.
 */

export async function createCustomer(
  _prevState: FormState<CustomerFormInput>,
  formData: FormData,
): Promise<FormState<CustomerFormInput>> {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const result = validateFormData(formData, customerFormSchema);
  if (!result.ok) return result.state;

  const supabase = await createClient();
  const parent = await resolveParentCustomer(
    supabase,
    ctx.org.id,
    result.data.parent_customer_id,
    null,
  );
  if ("error" in parent) return formError(parent.error, result.data);

  const { data, error } = await supabase
    .from("customers")
    .insert({
      org_id: ctx.org.id,
      name: result.data.name,
      email: result.data.email ?? null,
      phone: result.data.phone ?? null,
      notes: result.data.notes ?? null,
      customer_type: result.data.customer_type,
      company_number: result.data.company_number ?? null,
      vat_number: result.data.vat_number ?? null,
      parent_customer_id: parent.id,
      address_line1: result.data.address_line1 ?? null,
      address_line2: result.data.address_line2 ?? null,
      city: result.data.city ?? null,
      county: result.data.county ?? null,
      postcode: result.data.postcode ?? null,
      country: result.data.country ?? "United Kingdom",
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
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const result = validateFormData(formData, customerFormSchema);
  if (!result.ok) return result.state;

  const supabase = await createClient();
  const parent = await resolveParentCustomer(
    supabase,
    ctx.org.id,
    result.data.parent_customer_id,
    id,
  );
  if ("error" in parent) return formError(parent.error, result.data);

  const { error, count } = await supabase
    .from("customers")
    .update(
      {
        name: result.data.name,
        email: result.data.email ?? null,
        phone: result.data.phone ?? null,
        notes: result.data.notes ?? null,
        customer_type: result.data.customer_type,
        company_number: result.data.company_number ?? null,
        vat_number: result.data.vat_number ?? null,
        parent_customer_id: parent.id,
        address_line1: result.data.address_line1 ?? null,
        address_line2: result.data.address_line2 ?? null,
        city: result.data.city ?? null,
        county: result.data.county ?? null,
        postcode: result.data.postcode ?? null,
        country: result.data.country ?? "United Kingdom",
      },
      { count: "exact" },
    )
    .eq("id", id)
    // Active-org scope — see the module note.
    .eq("org_id", ctx.org.id);

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
  return formSuccess({ successMessage: "Customer updated." });
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
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const supabase = await createClient();
  // Token shape is owned by lib/customers/portal-token.ts so the
  // rotate action and any future code path stay in lockstep.
  const token = generateCustomerPortalToken();
  // Rotation composes with expiry: the new token starts with a CLEAN expiry
  // state (never-expires) and no stale usage stamp. Overwriting portal_token
  // invalidates the previous value immediately — the loader matches on the
  // exact token, so the old UUID simply no longer resolves. `last_used_at` is
  // cleared so telemetry reflects the NEW link, not the retired one.
  const { error, count } = await supabase
    .from("customers")
    .update(
      {
        portal_token: token,
        portal_token_expires_at: null,
        portal_token_last_used_at: null,
      },
      { count: "exact" },
    )
    // Active-org scope — see the module note. Rotation IMMEDIATELY invalidates
    // whatever portal link the customer already holds, so an unscoped rotate
    // would silently cut off another org's customer from their quotes and
    // invoices, with no trace on the screen that did it.
    .eq("id", id)
    .eq("org_id", ctx.org.id);
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

/**
 * Email a customer their statement of account (PDF attachment).
 *
 * Button-only action (redirect + querystring, no useActionState — the
 * force-dynamic [id] route's known hang pattern). Active-org scope is enforced
 * by sendCustomerStatementEmail via loadCustomerStatement's org pin, so a
 * foreign customer id is indistinguishable from a missing one. DARK-SAFE: with
 * no RESEND_API_KEY the caller is told to configure email rather than silently
 * "succeeding".
 */
export async function sendCustomerStatement(id: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const supabase = await createClient();

  const from = statementBound(formData.get("from"));
  const to = statementBound(formData.get("to"));
  const rawMessage = formData.get("message");
  const message =
    typeof rawMessage === "string" && rawMessage.trim() !== ""
      ? rawMessage.trim().slice(0, 2000)
      : undefined;

  const result = await sendCustomerStatementEmail(supabase, ctx.org.id, id, {
    range: { from, to },
    message,
  });

  if (result.sent) {
    revalidatePath(`/customers/${id}`);
    redirect(`/customers/${id}?saved=statement_sent`);
  }

  const reason =
    result.reason === "no_resend_key"
      ? "statement_email_unconfigured"
      : result.reason === "no_recipient"
        ? "statement_no_recipient"
        : result.reason === "not_found"
          ? "not_allowed"
          : "statement_send_failed";
  redirect(`/customers/${id}?error=${reason}`);
}

export async function deleteCustomer(id: string) {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // Sales/Money mutation (fix 1)
  const supabase = await createClient();
  // RLS allows DELETE only for admins/owners. Non-admins get a no-op
  // (zero rows affected); the exact count lets us tell that apart from a
  // real delete and surface the right message.
  const { error, count } = await supabase
    .from("customers")
    .delete({ count: "exact" })
    .eq("id", id)
    // Active-org scope — see the module note. `is_org_admin()` passes for
    // EVERY org the caller administers, so admin-of-two-orgs was enough to
    // delete the other org's customer from this org's screen.
    .eq("org_id", ctx.org.id);
  if (error) {
    // 23503 = foreign-key violation: the customer still has linked quotes /
    // jobs / invoices (quotes_customer_id_fkey is ON DELETE RESTRICT). Tell
    // the user what to clear instead of a generic failure.
    const code = (error as { code?: string }).code;
    console.error("[customers] delete failed", error);
    redirect(
      `/customers/${id}?error=${code === "23503" ? "customer_has_records" : "delete_failed"}`,
    );
  }
  if (count === 0) {
    // No row deleted: either RLS blocked it (non-admin) or it's already gone.
    redirect(`/customers/${id}?error=not_allowed`);
  }
  revalidatePath("/customers");
  redirect("/customers");
}
