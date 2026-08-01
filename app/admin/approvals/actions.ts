"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import {
  approveApproval,
  editApproval,
  escalateApproval,
  rejectApproval,
  type Reviewer,
} from "@/server/services/hq-approvals";
import { parseEditedPayloadJson } from "@/lib/approvals/payload";

/**
 * HQ Approval Console — server actions (Train 11).
 *
 * THIN WRAPPERS, deliberately. The Approval Engine service
 * (server/services/hq-approvals.ts) is the ONE authority on transitions: it owns
 * the reviewer gate (isSuperAdminEmail inside reviewerGate), the idempotency
 * rules, and the audit writes; the DB trigger beneath it is the unbypassable
 * enforcer. These actions add NO state logic and touch NO table — they parse the
 * form, name the reviewer, call the service, and translate its discriminated
 * result into a redirect. There is no direct hq_approvals access here, ever.
 *
 * Gating: every action re-checks isSuperAdminEmail before calling the service
 * (which checks again). The /admin/* layout already 404s non-allowlisted users;
 * this is the same defence-in-depth the AI Boardroom actions carry — a
 * stolen-cookie attempt that reaches an action URL directly still bounces.
 *
 * UNTRUSTED PAYLOADS: an edited payload arrives as reviewer-typed JSON and is
 * validated to a plain object (lib/approvals/payload.ts) before it goes anywhere.
 * Nothing here interprets, executes, or follows payload content.
 */

async function requireAdmin(): Promise<Reviewer & { email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

const idSchema = z.object({ id: z.string().uuid() });

const rejectSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

const editSchema = z.object({
  id: z.string().uuid(),
  payload_json: z.string().max(30_000),
});

function backTo(params: Record<string, string>): never {
  const sp = new URLSearchParams(params);
  revalidatePath("/admin/approvals");
  redirect(`/admin/approvals?${sp.toString()}`);
}

/** Human-readable translation of the service's error vocabulary. */
function describeError(error: string): string {
  switch (error) {
    case "not_found":
      return "Approval not found.";
    case "not_active":
      return "Already decided — this item is in a terminal state.";
    case "forbidden":
      return "You are not a permitted reviewer.";
    case "reason_required":
      return "A rejection reason is required.";
    default:
      return "Couldn't apply the decision — try again.";
  }
}

export async function approveApprovalAction(formData: FormData): Promise<void> {
  const reviewer = await requireAdmin();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) backTo({ error: "Invalid approval id." });

  const res = await approveApproval({ id: parsed.data.id, reviewer });
  if (!res.ok) backTo({ error: describeError(res.error) });
  backTo({ saved: "approved" });
}

export async function rejectApprovalAction(formData: FormData): Promise<void> {
  const reviewer = await requireAdmin();
  const parsed = rejectSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) backTo({ error: "A rejection reason is required." });

  const res = await rejectApproval({
    id: parsed.data.id,
    reviewer,
    reason: parsed.data.reason,
  });
  if (!res.ok) backTo({ error: describeError(res.error) });
  backTo({ saved: "rejected" });
}

export async function escalateApprovalAction(formData: FormData): Promise<void> {
  const reviewer = await requireAdmin();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) backTo({ error: "Invalid approval id." });

  const res = await escalateApproval({ id: parsed.data.id, reviewer });
  if (!res.ok) backTo({ error: describeError(res.error) });
  backTo({ saved: "escalated" });
}

export async function editApprovalAction(formData: FormData): Promise<void> {
  const reviewer = await requireAdmin();
  const parsed = editSchema.safeParse({
    id: formData.get("id"),
    payload_json: formData.get("payload_json"),
  });
  if (!parsed.success) backTo({ error: "Invalid edit input." });

  const payload = parseEditedPayloadJson(parsed.data.payload_json);
  if (!payload.ok) backTo({ error: payload.error });

  const res = await editApproval({
    id: parsed.data.id,
    reviewer,
    editedPayload: payload.payload,
  });
  if (!res.ok) backTo({ error: describeError(res.error) });
  backTo({ saved: "edited" });
}
