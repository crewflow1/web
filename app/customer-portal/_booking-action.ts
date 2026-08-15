"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { listPortalWarranties } from "./_warranties";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { serviceBookingSchema } from "@/lib/maintenance/booking";

/**
 * P3 — Portal service booking → service_bookings.
 *
 *   1. Rate-limit (shared portal_write budget).
 *   2. Validate the token — the ONLY customer identity.
 *   3. If a warranty_id is supplied, VERIFY it is one of the customer's OWN
 *      visible warranties (listPortalWarranties is job-scoped to the customer);
 *      a crafted warranty_id is simply absent → rejected.
 *   4. Insert service_bookings with org_id + customer_id stamped from the
 *      token-resolved customer, and the contact_* fields COPIED FROM THE CUSTOMER
 *      RECORD (never typed by the requester). The slot's org-binding composite FK
 *      + the capacity trigger reject a foreign or full slot at the DB.
 */

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backTo(token: string, outcome: { saved?: string; error?: string }): never {
  const qs = outcome.saved
    ? `?saved=${encodeURIComponent(outcome.saved)}`
    : `?error=${encodeURIComponent(outcome.error ?? "unknown")}`;
  redirect(`/customer-portal/${token}/servicing${qs}`);
}

export async function bookServiceSlot(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(token)) {
    redirect(`/customer-portal/${encodeURIComponent(token)}/servicing?error=invalid_token`);
  }

  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) backTo(token, { error: "rate_limited" });

  const parsed = serviceBookingSchema.safeParse({
    slot_id: formData.get("slot_id"),
    warranty_id: formData.get("warranty_id"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) backTo(token, { error: "invalid_input" });

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) backTo(token, { error: "invalid_token" });
  const { customer } = loaded;

  // OWNERSHIP: a supplied warranty must be one of the customer's own.
  let warrantyId: string | null = null;
  if (parsed.data.warranty_id) {
    const warranties = await listPortalWarranties(customer.id, customer.org_id);
    const owned = warranties.find((w) => w.id === parsed.data.warranty_id);
    if (!owned) backTo(token, { error: "warranty_not_found" });
    warrantyId = owned.id;
  }

  const admin = createAdminClient();
  const { data: booking, error } = await (
    admin.from("service_bookings" as never) as unknown as {
      insert: (row: unknown) => {
        select: (c: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string; code?: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: customer.org_id,
      customer_id: customer.id,
      slot_id: parsed.data.slot_id,
      warranty_id: warrantyId,
      status: "requested",
      notes: parsed.data.notes ?? null,
      // Copied from the customer record — never typed by the requester.
      contact_name: customer.name,
      contact_email: customer.email,
      contact_phone: customer.phone,
    })
    .select("id")
    .single();

  if (error || !booking?.id) {
    // The capacity / org-binding trigger raises check_violation (23514) for a
    // full, withdrawn, or foreign slot; the composite FK raises 23503 for a slot
    // not in this org. Both mean the same thing to the customer: not bookable.
    console.error("[portal/booking] insert failed", error);
    const code = error?.code;
    backTo(token, {
      error: code === "23514" || code === "23503" ? "slot_unavailable" : "could_not_submit",
    });
  }

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.service_booking.requested",
    targetTable: "service_bookings",
    targetId: booking.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      slot_id: parsed.data.slot_id,
      warranty_id: warrantyId,
      source: "customer_portal",
    },
  });

  revalidatePath(`/customer-portal/${token}/servicing`);
  backTo(token, { saved: "booked" });
}
