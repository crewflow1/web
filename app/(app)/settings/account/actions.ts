"use server";

// NOTE: the service module (which owns the DARK feature-flag gate) is imported
// BEFORE the session module on purpose — the flag is the first thing every
// action here consults, ahead of any auth or database work.
import {
  accountDeletionEnabled,
  cancelOrgDeletion,
  getLiveOrgDeletion,
  requestAccountDeletion,
  requestOrgDeletion,
} from "@/server/services/privacy-deletion";
import { requireOrgContext, requireUser } from "@/server/auth/session";
import { verifyReauthentication } from "@/server/auth/reauth";
import { createClient } from "@/lib/supabase/server";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Settings → Account: the two SELF-initiated deletions.
 *
 *   • deleteMyAccountAction          — a person deletes their OWN login + profile.
 *   • requestCompanyDeletionAction   — the OWNER schedules deletion of the company.
 *   • cancelCompanyDeletionAction    — an owner cancels it during the cooling-off.
 *
 * AUTHORITY COMES FROM THE SESSION, NEVER FROM THE FORM. No action here reads a
 * user id, an org id or a request id from `formData`: the user is the validated
 * session user, the org is the session's active org, and the request to cancel
 * is looked up for that org. The form supplies only what a person must type —
 * a password and a confirmation string — and those are re-proved server-side
 * (the password against Supabase Auth; the confirmation, and the caller's role,
 * inside `privacy_request_create` under row locks).
 *
 * Order in every action: FLAG → session → role → re-authentication → service.
 * Each returns a FormState; navigation after success is done by the client with
 * `window.location.assign` (never `redirect()` / `revalidatePath` here — see
 * docs/engineering/CORRECTNESS-GUARDS.md).
 */

const DARK = "Deletion is not available yet. Please contact support and we will handle your request.";

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function deleteMyAccountAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!accountDeletionEnabled()) return formError(DARK);
  const user = await requireUser();

  const reauth = await verifyReauthentication({ user, password: field(formData, "password") });
  if (!reauth.ok) return formError(reauth.message);

  const result = await requestAccountDeletion({
    userId: user.id,
    confirmEmail: field(formData, "confirm_email"),
  });
  if (!result.ok) {
    return formError(
      result.code === "confirmation"
        ? "The email you typed does not match your account email. Nothing was deleted."
        : result.message,
    );
  }
  if (result.run?.status === "cancelled") {
    return formError(
      "You are now the only owner of a company. Delete the company, or have another owner added, before deleting your account.",
    );
  }
  if (result.run?.status !== "completed") {
    // Recorded and resumable: the scheduled drain finishes it. Sessions for a
    // partially-erased account are ended below either way.
    console.error("[account-deletion] run did not complete", { status: result.run?.status });
  }

  // The identity is gone; drop this browser's now-dead cookies (best effort).
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The session no longer exists server-side — nothing left to clear.
  }
  return formSuccess({ redirectTo: "/login?deleted=account" });
}

export async function requestCompanyDeletionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!accountDeletionEnabled()) return formError(DARK);
  const { ctx, user } = await requireOrgContext();
  if (ctx.membership.role !== "owner") {
    return formError("Only the owner of the company can delete it.");
  }
  if (field(formData, "acknowledge") !== "on") {
    return formError("Tick the box to confirm you understand what will be deleted.");
  }

  const reauth = await verifyReauthentication({ user, password: field(formData, "password") });
  if (!reauth.ok) return formError(reauth.message);

  const result = await requestOrgDeletion({
    orgId: ctx.org.id, // the SESSION's active org — never a posted id
    actorUserId: user.id,
    confirmName: field(formData, "confirm_name"),
  });
  if (!result.ok) {
    return formError(
      result.code === "confirmation"
        ? "The company name you typed does not match exactly. Nothing was scheduled."
        : result.code === "forbidden"
          ? "Only the owner of the company can delete it."
          : result.message,
    );
  }
  return formSuccess({
    successMessage: "Deletion scheduled. You can cancel it at any time before it starts.",
    redirectTo: "/settings/account",
  });
}

export async function cancelCompanyDeletionAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  if (!accountDeletionEnabled()) return formError(DARK);
  const { ctx, user } = await requireOrgContext();
  if (ctx.membership.role !== "owner") {
    return formError("Only an owner of the company can cancel its deletion.");
  }
  // The request is resolved from the session's org — a posted id is never used.
  const live = await getLiveOrgDeletion(ctx.org.id);
  if (!live) return formError("There is no pending deletion to cancel.");

  const result = await cancelOrgDeletion({ requestId: live.requestId, actorUserId: user.id });
  if (!result.ok) return formError(result.message);
  return formSuccess({
    successMessage: "Deletion cancelled. Nothing was deleted.",
    redirectTo: "/settings/account",
  });
}
