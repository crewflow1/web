"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import {
  buildFutureWorkNotes,
  futureWorkRequestSchema,
  timingToUrgency,
} from "@/lib/leads/portal";

/**
 * Train 4 — Portal future-work request → lead.
 *
 * The customer asks for MORE work from the org that already serves them. We
 * create a row in the EXISTING public.leads table, so staff triage it in the
 * pipeline they already run — zero new staff surface:
 *
 *   1. Rate-limit (same portal_write budget as messages/uploads).
 *   2. Validate the token — the ONLY way a customer is identified. Every
 *      stamped identity below comes from the token-resolved customer, never
 *      from the form: a crafted customer_id/org_id field is simply ignored
 *      because it is never read.
 *   3. Insert the lead: org_id + customer_id (token-resolved), source
 *      'portal', contact details copied from the CUSTOMER RECORD (not typed
 *      by the requester — a portal visitor cannot plant a phishing callback
 *      number on someone else's account), title → service, structured
 *      details+timing → notes.
 *   4. Audit-log.
 *
 * The customer's read-back lives in _future-work.ts and exposes a coarse
 * stage word only — staff notes and pipeline internals never round-trip.
 */

const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backTo(token: string, outcome: { saved?: string; error?: string }): never {
  const qs = outcome.saved
    ? `?saved=${encodeURIComponent(outcome.saved)}`
    : `?error=${encodeURIComponent(outcome.error ?? "unknown")}`;
  redirect(`/customer-portal/${token}/requests${qs}`);
}

export async function submitFutureWorkRequest(
  formData: FormData,
): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(token)) {
    redirect(`/customer-portal/${token}/requests?error=invalid_token`);
  }

  // Throttle portal writes per token — same budget as messages + uploads.
  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    backTo(token, {
      error: "Too many requests. Please wait a moment and try again.",
    });
  }

  const parsed = futureWorkRequestSchema.safeParse({
    title: formData.get("title"),
    details: formData.get("details"),
    timing: formData.get("timing"),
  });
  if (!parsed.success) {
    backTo(token, {
      error: parsed.error.issues[0]?.message ?? "invalid_input",
    });
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    backTo(token, { error: "invalid_token" });
  }
  const { customer } = loaded;

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Identity is stamped from the token-resolved customer — org_id, customer_id
  // AND the contact fields. Nothing identity-bearing comes from the form.
  const { data: lead, error: leadError } = await (
    admin.from("leads" as never) as unknown as {
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
      contact_name: customer.name,
      contact_email: customer.email,
      contact_phone: customer.phone,
      source: "portal",
      service: parsed.data.title,
      urgency: timingToUrgency(parsed.data.timing),
      notes: buildFutureWorkNotes(parsed.data),
      status: "new",
      first_contact_at: now,
      last_activity_at: now,
    })
    .select("id")
    .single();

  if (leadError || !lead?.id) {
    console.error("[portal/future-work] lead insert failed", leadError);
    backTo(token, { error: "could_not_submit" });
  }

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.future_work.requested",
    targetTable: "leads",
    targetId: lead.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      source: "customer_portal",
    },
  });

  revalidatePath(`/customer-portal/${token}/requests`);
  // The staff pipeline now carries the new lead.
  revalidatePath(`/leads`);
  backTo(token, { saved: "submitted" });
}
