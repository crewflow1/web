"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { portalVariationRequestSchema } from "@/lib/variation-requests/schema";

/**
 * G2 — Customer portal "Request a change" → variation_requests.
 *
 * The customer asks for a CHANGE to a job already underway ("can you move the
 * socket while you're at it?"). Distinct from the future-work form beside it
 * (which creates a lead): this lands in the variation-request queue on the
 * job's own workspace, where management reviews it and — if accepted — prices
 * it through the existing Variation Order engine.
 *
 * Follows _future-work-action.ts to the letter:
 *   1. Rate-limit (same portal_write budget as messages/uploads).
 *   2. The token is the ONLY identity. Every stamped field below comes from
 *      the token-resolved customer; a crafted org_id/customer field in the
 *      form is never read.
 *   3. THE JOB IS RE-VERIFIED server-side: it must belong to the token's own
 *      org AND customer, and still be open. A guessed job uuid from another
 *      tenant is indistinguishable from a missing one.
 *   4. Insert with requester_type='customer' via the service-role client
 *      (customers have no Supabase session; the DB trigger still enforces the
 *      born-'requested' rule on this path).
 *   5. Audit-log.
 *
 * Error/saved outcomes are CODES rendered through the page's allowlist —
 * forged query text never appears on a branded page.
 */

const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backTo(
  token: string,
  outcome: { saved?: string; error?: string },
): never {
  const qs = outcome.saved
    ? `?saved=${encodeURIComponent(outcome.saved)}`
    : `?error=${encodeURIComponent(outcome.error ?? "unknown")}`;
  redirect(`/customer-portal/${token}/requests${qs}`);
}

export async function submitChangeRequest(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(token)) {
    redirect(
      `/customer-portal/${encodeURIComponent(token)}/requests?error=invalid_token`,
    );
  }

  // Same write budget as messages / uploads / future-work.
  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    backTo(token, { error: "rate_limited" });
  }

  const parsed = portalVariationRequestSchema.safeParse({
    job_id: formData.get("job_id"),
    title: formData.get("title"),
    description: formData.get("description"),
    reason: formData.get("reason") ?? "",
    urgency: formData.get("urgency") ?? "normal",
  });
  if (!parsed.success) {
    backTo(token, { error: "invalid_input" });
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    backTo(token, { error: "invalid_token" });
  }
  const { customer, contact } = loaded;

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as unknown as { from: (t: string) => any };

  // THE job gate: the picked job must be the token's own customer's job, in
  // the token's own org, and still open. Any miss → the same generic error.
  const { data: job, error: jobError } = await db
    .from("jobs")
    .select("id, status")
    .eq("id", parsed.data.job_id)
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (jobError || !job || job.status === "completed" || job.status === "cancelled") {
    backTo(token, { error: "invalid_input" });
  }

  // Identity is stamped from the token-resolved customer (and, for a named
  // contact's scoped token, that contact's name — so staff see WHO asked).
  const requesterName = contact
    ? `${contact.name} (${customer.name})`
    : customer.name;

  const { data: request, error: insertError } = await db
    .from("variation_requests")
    .insert({
      org_id: customer.org_id,
      job_id: job.id,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      reason: parsed.data.reason ?? null,
      urgency: parsed.data.urgency,
      requester_type: "customer",
      requested_by: null,
      requester_name: requesterName,
    })
    .select("id")
    .single();

  if (insertError || !request?.id) {
    console.error("[portal/change-request] insert failed", insertError);
    backTo(token, { error: "could_not_submit" });
  }

  // REFERENCES ONLY, no PII: admin_activity_log sits OUTSIDE the org-scoped
  // GDPR census (no org_id column), so a customer name/email written here
  // would survive the tenant's DSAR erasure sweep. customer_id is the join
  // key an HQ operator needs; the name/email live (and get erased) in
  // `customers`.
  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "portal.variation_request.submitted",
    targetTable: "variation_requests",
    targetId: request.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      job_id: job.id,
      source: "customer_portal",
    },
  });

  revalidatePath(`/customer-portal/${token}/requests`);
  backTo(token, { saved: "change_requested" });
}
