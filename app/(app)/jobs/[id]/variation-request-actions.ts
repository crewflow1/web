"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  requireOrgContext,
  requireManagementRole,
} from "@/server/auth/session";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";
import {
  variationRequestFormSchema,
  variationRequestReviewSchema,
  canTransitionVariationRequest,
  type VariationRequestStatus,
} from "@/lib/variation-requests/schema";

/**
 * Variation-request intake + review — server actions (migration 20261221).
 *
 * INTAKE is member-level: asking "can someone price this change?" is site
 * work, not an administrative act (the snags/site-diary posture). REVIEW is
 * management-only: deciding whether out-of-scope work is entertained is a
 * commercial decision, and the DB backs the same split (member INSERT policy,
 * admin-only UPDATE policy) so this file is UX, not the boundary.
 *
 * NAVIGATION: FormState + StateForm/redirectTo full-document loads — never
 * redirect() from these actions and no revalidatePath. /jobs/[id] is exactly
 * the deep [id] route the Next 15.5 stranded-commit race eats server-action
 * redirects on (see progress-actions.ts header + StateForm.tsx).
 *
 * ACTIVE-ORG PINNING: ctx.org.id pins every read and write. RLS alone admits
 * every org the caller belongs to, so a dual-org member could otherwise file a
 * request into the workspace they are not looking at. The composite FK
 * (job_id, org_id) → jobs(id, org_id) makes the cross-tenant write
 * structurally impossible even without the predicate; the explicit job read
 * turns that constraint into a sentence a human can act on.
 *
 * WHAT ACCEPTING DOES NOT DO: it never creates the commercial variation. The
 * panel shows a "Create variation" link into the EXISTING
 * /jobs/[id]/variations/new flow (?fromRequest= prefills it); createVariation
 * stamps this row 'converted' once the VO exists. One money engine, no clone.
 */

const idSchema = z.string().uuid();
const jobUrl = (jobId: string, params: string): string =>
  `/jobs/${jobId}?${params}`;

// The generated Supabase types pre-date variation_requests — reads/writes go
// through a loose from-chain (the snags / worker-portal idiom).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };

/** Member-level intake: log a variation request against a job. */
export async function createVariationRequest(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) {
    return formError("That job link looks wrong — reload and try again.");
  }

  const parsed = variationRequestFormSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    reason: formData.get("reason") ?? "",
    urgency: formData.get("urgency") ?? "normal",
  });
  if (!parsed.success) {
    return formError(
      parsed.error.issues[0]?.message ?? "Check the form and try again.",
    );
  }

  const supabase = (await createClient()) as unknown as FromChain;

  // ACTIVE-org check — friendly refusal instead of an FK error.
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id")
    .eq("id", jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobError || !job) {
    return formError(
      "That job isn't in this workspace — switch workspace and try again.",
    );
  }

  const { error } = await supabase.from("variation_requests").insert({
    org_id: ctx.org.id,
    job_id: jobId,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    reason: parsed.data.reason ?? null,
    urgency: parsed.data.urgency,
    requester_type: "staff",
    requested_by: user.id,
    // status defaults to 'requested'; the DB trigger refuses anything else.
  });
  if (error) {
    console.error("[variation-requests] intake insert failed", error);
    return formError("Couldn't log that request. Refresh and try again.");
  }

  return formSuccess({
    redirectTo: jobUrl(jobId, "saved=variation_request#variation-requests"),
  });
}

/**
 * Management review: open a review, accept, or reject (with a note).
 *
 * The in-code transition check mirrors the DB trigger so an already-decided
 * request gets a readable refusal; the trigger stays the enforcement for
 * every writer, this action included.
 */
export async function reviewVariationRequest(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  requireManagementRole(ctx);
  if (!idSchema.safeParse(jobId).success) {
    return formError("That job link looks wrong — reload and try again.");
  }

  const parsed = variationRequestReviewSchema.safeParse({
    request_id: formData.get("request_id") ?? "",
    decision: formData.get("decision") ?? "",
    review_note: formData.get("review_note") ?? "",
  });
  if (!parsed.success) {
    return formError(
      parsed.error.issues[0]?.message ?? "Check the review and try again.",
    );
  }
  const input = parsed.data;

  const supabase = (await createClient()) as unknown as FromChain;

  // Org + job pinned load — a request outside the active org (or filed
  // against a different job) is indistinguishable from one that doesn't exist.
  const { data: request, error: loadError } = await supabase
    .from("variation_requests")
    .select("id, status")
    .eq("id", input.request_id)
    .eq("org_id", ctx.org.id)
    .eq("job_id", jobId)
    .maybeSingle();
  if (loadError || !request) {
    return formError("That request no longer exists. Refresh and try again.");
  }

  const from = request.status as VariationRequestStatus;
  if (!canTransitionVariationRequest(from, input.decision)) {
    return formError(
      from === input.decision
        ? "That request is already in that state."
        : "That request has already been decided — refresh to see its current state.",
    );
  }

  const decided = input.decision === "accepted" || input.decision === "rejected";
  const { error } = await supabase
    .from("variation_requests")
    .update({
      status: input.decision,
      review_note: input.review_note ?? null,
      reviewed_by: decided ? user.id : null,
      reviewed_at: decided ? new Date().toISOString() : null,
    })
    .eq("id", input.request_id)
    .eq("org_id", ctx.org.id) // write predicate re-asserts the org
    .eq("status", from); // optimistic-concurrency: no double-decide race
  if (error) {
    console.error("[variation-requests] review update failed", error);
    return formError("Couldn't save that decision. Refresh and try again.");
  }

  return formSuccess({
    redirectTo: jobUrl(
      jobId,
      "saved=variation_request_review#variation-requests",
    ),
  });
}
