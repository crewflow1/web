"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  getReviewQueueItem,
  resolveReviewSend,
  resolveReviewDismiss,
  claimReviewConversation,
  releaseReviewConversation,
} from "@/server/services/receptionist-review";

/**
 * HQ-side Reply Review Inbox actions (Directive #018, R14: HUMAN HANDOFF & REPLY REVIEW INBOX).
 *
 *   - sendReviewedReply    → send a human-reviewed (optionally edited) reply through the
 *                            CANONICAL Enforce → Audit → Transport pipeline, then record the
 *                            human decision in the append-only resolution ledger.
 *   - dismissReviewedReply → record the human decision NOT to send (no transport).
 *   - claimConversation    → own a conversation for review (assignment).
 *   - releaseConversation  → release a conversation's ownership.
 *
 * Every action gates on the super-admin allowlist, delegates to the review orchestration
 * service (which re-derives the org from the held reply itself and NEVER bypasses policy/audit/
 * transport), audits via recordAdminActivity, and redirects back with a status the detail page
 * surfaces. The action layer opens NO send path of its own — it only calls the service.
 */

const REVIEW = "/admin/ai-receptionist/review";

async function requireSuperAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    redirect("/dashboard");
  }
  return { id: user.id, email: user.email ?? "" };
}

/** Read the review-audit id from a form, or bounce to the inbox when it is missing/malformed. */
function reviewAuditId(formData: FormData): string {
  const id = String(formData.get("review_audit_id") ?? "");
  if (!id.match(/^[0-9a-f-]{36}$/i)) {
    redirect(`${REVIEW}?error=invalid_input`);
  }
  return id;
}

/**
 * SEND a human-reviewed reply. The `text` is the proposed draft as-is or an edited version.
 * Runs the canonical pipeline via the service: policy is STILL evaluated, so an absolute `block`
 * is refused (audited, never transported, item stays pending). On a clean send the resolution
 * ledger records who sent it, whether it was edited, and the new allow-audit it produced.
 */
export async function sendReviewedReply(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = reviewAuditId(formData);
  const text = String(formData.get("text") ?? "").trim();
  if (!text) {
    redirect(`${REVIEW}/${id}?error=empty_draft`);
  }

  const result = await resolveReviewSend({
    review_audit_id: id,
    text,
    reviewed_by: admin.id,
    reviewed_by_email: admin.email,
  });

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "receptionist_review.send",
    targetTable: "ai_reply_audits",
    targetId: id,
    metadata: {
      ok: result.ok,
      reason: result.ok ? null : result.reason,
      edited: result.ok ? result.edited : null,
      sent_audit_id: result.ok ? result.outcome.audit_id : null,
    },
  });

  revalidatePath(REVIEW);
  revalidatePath(`${REVIEW}/${id}`);
  revalidatePath("/admin/ai-receptionist/deliveries");

  if (!result.ok) {
    if (result.reason === "not_found") redirect(`${REVIEW}?error=not_found`);
    redirect(`${REVIEW}/${id}?error=${result.reason}`);
  }
  redirect(`${REVIEW}/${id}?sent=${result.edited ? "edited" : "1"}`);
}

/** DISMISS a held reply — record the human decision NOT to send. No transport, no reply audit. */
export async function dismissReviewedReply(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = reviewAuditId(formData);
  const note = String(formData.get("note") ?? "").trim() || null;

  const result = await resolveReviewDismiss({
    review_audit_id: id,
    reviewed_by: admin.id,
    reviewed_by_email: admin.email,
    note,
  });

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "receptionist_review.dismiss",
    targetTable: "ai_reply_audits",
    targetId: id,
    metadata: { ok: result.ok, reason: result.ok ? null : result.reason, has_note: note !== null },
  });

  revalidatePath(REVIEW);
  revalidatePath(`${REVIEW}/${id}`);

  if (!result.ok) {
    if (result.reason === "not_found") redirect(`${REVIEW}?error=not_found`);
    redirect(`${REVIEW}/${id}?error=${result.reason}`);
  }
  redirect(`${REVIEW}/${id}?dismissed=1`);
}

/**
 * CLAIM a conversation for review — assign it to the acting operator. Org + conversation are
 * re-derived server-side from the held reply (never trusted from the form), so a claim can only
 * ever target the conversation the held reply actually belongs to.
 */
export async function claimConversation(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = reviewAuditId(formData);

  const item = await getReviewQueueItem({ review_audit_id: id });
  if (!item) redirect(`${REVIEW}?error=not_found`);
  if (!item!.conversation_id) redirect(`${REVIEW}/${id}?error=no_conversation`);

  const claimed = await claimReviewConversation({
    conversation_id: item!.conversation_id!,
    org_id: item!.org_id,
    assignee_id: admin.id,
    assigned_by: admin.id,
  });

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "receptionist_review.claim",
    targetTable: "receptionist_conversations",
    targetId: item!.conversation_id!,
    metadata: { review_audit_id: id, org_id: item!.org_id, claimed },
  });

  revalidatePath(REVIEW);
  revalidatePath(`${REVIEW}/${id}`);
  redirect(`${REVIEW}/${id}?${claimed ? "owned=1" : "error=claim_failed"}`);
}

/** RELEASE a conversation's ownership. Org + conversation re-derived from the held reply. */
export async function releaseConversation(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = reviewAuditId(formData);

  const item = await getReviewQueueItem({ review_audit_id: id });
  if (!item) redirect(`${REVIEW}?error=not_found`);
  if (!item!.conversation_id) redirect(`${REVIEW}/${id}?error=no_conversation`);

  const released = await releaseReviewConversation({
    conversation_id: item!.conversation_id!,
    org_id: item!.org_id,
  });

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "receptionist_review.release",
    targetTable: "receptionist_conversations",
    targetId: item!.conversation_id!,
    metadata: { review_audit_id: id, org_id: item!.org_id, released },
  });

  revalidatePath(REVIEW);
  revalidatePath(`${REVIEW}/${id}`);
  redirect(`${REVIEW}/${id}?${released ? "released=1" : "error=release_failed"}`);
}
