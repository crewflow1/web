"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { listPortalWarranties } from "./_warranties";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import {
  warrantyClaimSchema,
  buildClaimSubject,
  buildClaimMessageBody,
} from "@/lib/warranties/claims";

/**
 * P3 — Portal warranty claim → support ticket.
 *
 * The customer reports an issue against a warranty. We create a
 * public.support_tickets row (category 'warranty_claim', warranty_id set) + the
 * first support_messages row, so the claim lives in the support pipeline staff
 * already run and the customer can talk about it on the existing portal thread.
 *
 *   1. Rate-limit (shared portal_write budget).
 *   2. Validate the token — the ONLY customer identity.
 *   3. VERIFY WARRANTY OWNERSHIP — resolve the customer's OWN visible warranties
 *      and require the submitted warranty_id to be one of them. A crafted
 *      warranty_id for another customer/org is simply not in the set → rejected.
 *      This is the cross-customer barrier for the write.
 *   4. Insert the ticket with org_id + customer_id + warranty_id ALL stamped from
 *      the token-resolved customer + the verified warranty — never from the form.
 *   5. First message, audit log, automation dispatch.
 */

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backTo(token: string, outcome: { saved?: string; error?: string }): never {
  const qs = outcome.saved
    ? `?saved=${encodeURIComponent(outcome.saved)}`
    : `?error=${encodeURIComponent(outcome.error ?? "unknown")}`;
  redirect(`/customer-portal/${token}/warranties${qs}`);
}

export async function submitWarrantyClaim(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(token)) {
    redirect(`/customer-portal/${encodeURIComponent(token)}/warranties?error=invalid_token`);
  }

  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) backTo(token, { error: "rate_limited" });

  const warrantyId = String(formData.get("warranty_id") ?? "");
  if (!TOKEN_RE.test(warrantyId)) backTo(token, { error: "invalid_input" });

  const parsed = warrantyClaimSchema.safeParse({
    summary: formData.get("summary"),
    details: formData.get("details"),
  });
  if (!parsed.success) backTo(token, { error: "invalid_input" });

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) backTo(token, { error: "invalid_token" });
  const { customer } = loaded;

  // OWNERSHIP: the warranty MUST be one of this customer's own visible warranties.
  // listPortalWarranties is job-scoped to (org_id, customer_id), so a warranty
  // for anyone else is simply absent — the write cannot target it.
  const warranties = await listPortalWarranties(customer.id, customer.org_id);
  const warranty = warranties.find((w) => w.id === warrantyId);
  if (!warranty) backTo(token, { error: "warranty_not_found" });

  const admin = createAdminClient();

  const { data: ticket, error: tErr } = await (
    admin.from("support_tickets" as never) as unknown as {
      insert: (row: unknown) => {
        select: (c: string) => {
          single: () => Promise<{
            data: { id: string; ticket_number: number } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: customer.org_id,
      customer_id: customer.id,
      warranty_id: warranty.id,
      subject: buildClaimSubject(warranty.title, parsed.data.summary),
      status: "open",
      priority: "normal",
      category: "warranty_claim",
      created_by: null,
    })
    .select("id, ticket_number")
    .single();

  if (tErr || !ticket?.id) {
    console.error("[portal/warranty-claim] ticket insert failed", tErr);
    backTo(token, { error: "could_not_submit" });
  }

  const { error: mErr } = await admin.from("support_messages" as never).insert({
    ticket_id: ticket.id,
    org_id: customer.org_id,
    author_id: null,
    author_kind: "customer",
    internal: false,
    body: buildClaimMessageBody({
      customerName: customer.name,
      warrantyTitle: warranty.title,
      jobReference: warranty.job_reference,
      details: parsed.data.details,
    }),
  } as never);
  if (mErr) {
    console.error("[portal/warranty-claim] message insert failed", mErr);
    backTo(token, { error: "could_not_submit" });
  }

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.warranty_claim.submitted",
    targetTable: "support_tickets",
    targetId: ticket.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      warranty_id: warranty.id,
      source: "customer_portal",
    },
  });

  await dispatchAutomation({
    type: "support.ticket.created",
    org_id: customer.org_id,
    source_table: "support_tickets",
    source_id: ticket.id,
    payload: { via: "customer_portal", customer_name: customer.name, warranty_claim: true },
    actor_email: customer.email ?? null,
  }).catch((e) => {
    console.error("[portal/warranty-claim] automation dispatch failed", e);
  });

  revalidatePath(`/customer-portal/${token}/warranties`);
  revalidatePath(`/admin/support`);
  revalidatePath(`/support`);
  backTo(token, { saved: "claim_submitted" });
}
