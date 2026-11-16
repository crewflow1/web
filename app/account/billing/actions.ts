"use server";

import { z } from "zod";
import { resolveBillingOwner } from "@/server/auth/billing-account";
import {
  requestReactivation,
  resumeOrgSubscription,
  scheduleOrgCancellation,
  wireCancellationDeps,
  wireReactivationDeps,
} from "@/server/services/subscription-cancellation";
import {
  ACCOUNT_BILLING_PATH,
  CANCELLATION_ERROR_COPY,
} from "@/lib/billing/cancellation";

/**
 * Billing ACCOUNT server actions — cancel the subscription, ask to reactivate.
 *
 * Shared by Settings → Billing (active workspaces) and /account/billing (the
 * surface a suspended / cancelled workspace's owner can still reach).
 *
 * AUTHORISATION. resolveBillingOwner() derives BOTH the user and the org from
 * the session and the caller's own membership row; the caller must be that
 * org's `owner`. No org id from the request is ever used to choose what to
 * cancel. `expected_org_id` is the opposite of a selector: it is the org the
 * confirmation dialog was RENDERED for, and the action refuses if it no longer
 * matches the session's org — so an owner of two companies who switched in
 * another tab cannot cancel the wrong one. Posting a foreign org id can only
 * ever produce that refusal.
 *
 * NAVIGATION. Cancelling moves the owner out of the (app) shell (the workspace
 * no longer has access). The action returns `redirectTo` and the client does a
 * full `window.location.assign` — the mandated pattern for a cross-shell route
 * swap (docs/engineering/CORRECTNESS-GUARDS.md), never redirect() from here.
 */

export type CancelFormState =
  | { status: "idle" }
  | { status: "error"; code: string; message: string }
  | { status: "done"; redirectTo: string };

const cancelSchema = z.object({
  expected_org_id: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
  // The access-end date (unix seconds) the dialog SHOWED. Absent when the
  // dialog said the workspace closes immediately.
  expected_access_ends_at: z.coerce.number().int().positive().optional(),
});

/** Settings → Billing, inside the app shell (the workspace keeps access). */
const SETTINGS_BILLING_PATH = "/settings/billing";

function refusal(code: string): CancelFormState {
  return {
    status: "error",
    code,
    message: CANCELLATION_ERROR_COPY[code] ?? "Something went wrong. Nothing has been cancelled.",
  };
}

export async function cancelSubscriptionAction(
  _prev: CancelFormState,
  formData: FormData,
): Promise<CancelFormState> {
  const owner = await resolveBillingOwner();
  if (!owner.ok) return refusal(owner.reason === "no_org" ? "org_not_found" : "forbidden");

  const parsed = cancelSchema.safeParse({
    expected_org_id: formData.get("expected_org_id"),
    reason: formData.get("reason") ?? undefined,
    expected_access_ends_at: formData.get("expected_access_ends_at") || undefined,
  });
  if (!parsed.success) return refusal("invalid");
  if (parsed.data.expected_org_id !== owner.ctx.org.id) return refusal("org_changed");

  let result;
  try {
    // Founder policy: a paying company is cancelled at the END of its paid
    // period (Stripe cancel_at_period_end); immediate only when nothing renews.
    result = await scheduleOrgCancellation(wireCancellationDeps(), {
      orgId: owner.ctx.org.id,
      actor: { userId: owner.user.id, email: owner.user.email ?? null },
      reason: parsed.data.reason ?? null,
      expectedAccessEndsAt: parsed.data.expected_access_ends_at ?? null,
    });
  } catch (e) {
    console.error("[account/billing] cancel failed", {
      org_id: owner.ctx.org.id,
      error: e instanceof Error ? e.message : String(e),
    });
    // Unexpected: we cannot say for certain what state things are in, so we do
    // not claim either "cancelled" or "nothing changed".
    return refusal("unexpected");
  }

  if (!result.ok) return refusal(result.reason);
  // `emailed` only chooses whether the success banner mentions the email — it
  // is display, not state, so it is safe in the query string.
  if (!("immediate" in result)) {
    const emailed = result.outcome === "scheduled" && result.emailSent ? "&emailed=1" : "";
    return { status: "done", redirectTo: `${SETTINGS_BILLING_PATH}?cancellation_scheduled=1${emailed}` };
  }
  const emailed = result.immediate.emailSent ? "&emailed=1" : "";
  return { status: "done", redirectTo: `${ACCOUNT_BILLING_PATH}?cancelled=1${emailed}` };
}

export type ResumeFormState =
  | { status: "idle" }
  | { status: "error"; code: string; message: string }
  | { status: "done"; redirectTo: string };

/** Withdraw a scheduled cancellation before it takes effect. Owner only. */
export async function resumeSubscriptionAction(
  _prev: ResumeFormState,
  formData: FormData,
): Promise<ResumeFormState> {
  const owner = await resolveBillingOwner();
  if (!owner.ok) return refusal(owner.reason === "no_org" ? "org_not_found" : "forbidden");
  const parsed = z.object({ expected_org_id: z.string().uuid() }).safeParse({
    expected_org_id: formData.get("expected_org_id"),
  });
  if (!parsed.success) return refusal("invalid");
  if (parsed.data.expected_org_id !== owner.ctx.org.id) return refusal("org_changed");
  let result;
  try {
    result = await resumeOrgSubscription(wireCancellationDeps(), {
      orgId: owner.ctx.org.id,
      actor: { userId: owner.user.id, email: owner.user.email ?? null },
    });
  } catch (e) {
    console.error("[account/billing] resume failed", {
      org_id: owner.ctx.org.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return refusal("unexpected");
  }
  if (!result.ok) return refusal(result.reason);
  const emailed = result.emailSent ? "&emailed=1" : "";
  return { status: "done", redirectTo: `${SETTINGS_BILLING_PATH}?resumed=1${emailed}` };
}

export type ReactivationFormState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "requested" };

const reactivationSchema = z.object({ expected_org_id: z.string().uuid() });

export async function requestReactivationAction(
  _prev: ReactivationFormState,
  formData: FormData,
): Promise<ReactivationFormState> {
  const owner = await resolveBillingOwner();
  if (!owner.ok) {
    return { status: "error", message: "Only the account owner can ask to reactivate." };
  }
  const parsed = reactivationSchema.safeParse({
    expected_org_id: formData.get("expected_org_id"),
  });
  if (!parsed.success || parsed.data.expected_org_id !== owner.ctx.org.id) {
    return { status: "error", message: "Reload the page and try again." };
  }

  try {
    const result = await requestReactivation(wireReactivationDeps(), {
      orgId: owner.ctx.org.id,
      actor: { userId: owner.user.id, email: owner.user.email ?? null },
    });
    if (!result.ok) {
      return {
        status: "error",
        message:
          result.reason === "not_cancelled"
            ? "This workspace isn't cancelled, so there's nothing to reactivate."
            : "We couldn't load your company. Reload and try again.",
      };
    }
    return { status: "requested" };
  } catch (e) {
    console.error("[account/billing] reactivation request failed", {
      org_id: owner.ctx.org.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      status: "error",
      message: "We couldn't send your request. Try again, or email hello@crewflow.uk.",
    };
  }
}
