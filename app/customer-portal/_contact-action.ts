"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { customerContactSchema } from "@/lib/customers/contacts";

/**
 * P3 — Portal add-contact → customer_contacts.
 *
 * The customer adds a reachable named contact (spouse, site manager, accounts).
 *
 *   1. Rate-limit (shared portal_write budget).
 *   2. Validate the token — the ONLY customer identity.
 *   3. Insert customer_contacts with org_id + customer_id stamped from the
 *      token-resolved customer — NEVER from the form. A crafted customer_id/
 *      org_id field is ignored because it is never read.
 *
 * DELIBERATELY does NOT mint a portal_token: provisioning scoped portal access
 * for a contact is a STAFF action (RLS admin-gated), so a portal visitor can add
 * a reachable person but cannot self-escalate into a second login credential.
 * portal_access_enabled therefore stays false (the schema default).
 */

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backTo(token: string, outcome: { saved?: string; error?: string }): never {
  const qs = outcome.saved
    ? `?saved=${encodeURIComponent(outcome.saved)}`
    : `?error=${encodeURIComponent(outcome.error ?? "unknown")}`;
  redirect(`/customer-portal/${token}/contacts${qs}`);
}

export async function addCustomerContact(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(token)) {
    redirect(`/customer-portal/${encodeURIComponent(token)}/contacts?error=invalid_token`);
  }

  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) backTo(token, { error: "rate_limited" });

  const parsed = customerContactSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    role: formData.get("role") ?? "other",
  });
  if (!parsed.success) backTo(token, { error: "invalid_input" });

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) backTo(token, { error: "invalid_token" });
  const { customer } = loaded;

  const admin = createAdminClient();
  const { data: contact, error } = await (
    admin.from("customer_contacts" as never) as unknown as {
      insert: (row: unknown) => {
        select: (c: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: customer.org_id,
      customer_id: customer.id,
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      role: parsed.data.role,
      // Access provisioning is staff-only — never minted here.
      portal_access_enabled: false,
      portal_token: null,
      created_by: null,
    })
    .select("id")
    .single();

  if (error || !contact?.id) {
    console.error("[portal/contact] insert failed", error);
    backTo(token, { error: "could_not_submit" });
  }

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.contact.added",
    targetTable: "customer_contacts",
    targetId: contact.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      source: "customer_portal",
    },
  });

  revalidatePath(`/customer-portal/${token}/contacts`);
  backTo(token, { saved: "contact_added" });
}
