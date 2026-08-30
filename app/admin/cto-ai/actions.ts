"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import {
  enqueuePrReview,
  drainPrReviewTasks,
} from "@/server/services/hq-cto-review-runner";

/**
 * HQ CTO board — queue a PR review task (L9a, P7).
 *
 * cto_pr_review is EVENT-shaped: it needs a real PR number, so unlike the
 * cadence legs (content brief / design review / release notes, driven by the
 * roster-workers tick) its production door is this admin action — the exact
 * P13 support-seam shape: enqueue, then drain the just-enqueued task through
 * the canonical runner so the result is ready when the page re-renders.
 *
 * The runner itself stays honest while dark: the GitHub adapter refuses
 * before fetch with no credential bound, so the task completes with the
 * documented "adapter dark" outcome rather than a fabricated review.
 * Outcomes travel as CODES (?saved= / ?error=) — never free text.
 */
export async function queuePrReview(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");

  const parsed = z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .safeParse(formData.get("pr_number"));
  if (!parsed.success) redirect("/admin/cto-ai?error=invalid_pr_number");

  const enq = await enqueuePrReview(parsed.data);
  if (!enq.ok) redirect("/admin/cto-ai?error=pr_review_enqueue_failed");
  if (enq.skipped) redirect("/admin/cto-ai?error=pr_review_no_cto_ai");

  // Best-effort drain: a failed run leaves the task in the engine (retry/reap
  // applies) and the board shows the task's own state instead.
  try {
    await drainPrReviewTasks(1);
  } catch (e) {
    console.error("[cto-ai] pr-review drain failed", e);
  }

  redirect("/admin/cto-ai?saved=pr_review_queued");
}
