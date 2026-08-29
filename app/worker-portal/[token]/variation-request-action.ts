"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadWorkerSession } from "../_loader";
import { getIpFromHeaders } from "@/lib/security/ip-hash";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { variationRequestFormSchema } from "@/lib/variation-requests/schema";

/**
 * G2 — External worker "flag extra work" → variation_requests.
 *
 * A subcontractor on site is often the FIRST to see out-of-scope work ("this
 * wall is dot-and-dab, the spec assumed studwork"). This lets them flag it
 * from the same tokened portal they sign H&S documents in, so the ask lands
 * in the job's variation-request queue instead of dying in a phone call.
 *
 * Follows actions.ts (acknowledgeAsWorker) to the letter:
 *   - the caller is anonymous; loadWorkerSession is the ONLY gate (bad /
 *     expired / revoked token → nothing happens);
 *   - org_id AND job_id come from the token record, never from the form — a
 *     worker link is scoped to exactly one job and cannot file elsewhere;
 *   - rate-limited per token+IP (same budget as portal writes);
 *   - service-role insert (no Supabase session), with the DB trigger still
 *     enforcing the born-'requested' state machine on this path;
 *   - errors are authored server-side and never echo raw DB text.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };

export async function requestVariationAsWorker(
  token: string,
  formData: FormData,
): Promise<void> {
  const back = `/worker-portal/${encodeURIComponent(token)}`;

  // 1. Resolve the link — the ONLY gate.
  const session = await loadWorkerSession(token);
  if (!session) redirect(back);

  // 2. Rate-limit token+IP (portal_write: same budget as customer-portal writes).
  const h = await headers();
  const ip = getIpFromHeaders(h) ?? "anonymous";
  const rl = await consume(
    "portal_write",
    `${session!.token.id}:${ip}`,
    DEFAULT_LIMITS.portal_write,
  );
  if (!rl.allowed) {
    redirect(
      `${back}?error=${encodeURIComponent("Too many requests. Please wait a minute and try again.")}`,
    );
  }

  // 3. Validate shape. Identity fields are never read from the form.
  const parsed = variationRequestFormSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    reason: formData.get("reason") ?? "",
    urgency: formData.get("urgency") ?? "normal",
  });
  if (!parsed.success) {
    redirect(
      `${back}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Check the form and try again.")}`,
    );
  }

  const requesterName = session!.token.worker_company
    ? `${session!.token.worker_name} (${session!.token.worker_company})`
    : session!.token.worker_name;

  const admin = createAdminClient();
  const { error } = await (admin as unknown as FromChain)
    .from("variation_requests")
    .insert({
      // org + job are the TOKEN's own — the composite FK (job_id, org_id)
      // would refuse any mismatch even if this file ever drifted.
      org_id: session!.token.org_id,
      job_id: session!.token.job_id,
      title: parsed!.data.title,
      description: parsed!.data.description ?? null,
      reason: parsed!.data.reason ?? null,
      urgency: parsed!.data.urgency,
      requester_type: "worker_token",
      requested_by: null,
      requester_name: requesterName,
    });

  if (error) {
    console.error("[worker-portal] variation request insert failed", error);
    redirect(
      `${back}?error=${encodeURIComponent("Could not send your request — please try again.")}`,
    );
  }

  redirect(`${back}?saved=variation_requested`);
}
