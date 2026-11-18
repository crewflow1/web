"use server";

// The service (owner of the DARK flag gate) is imported before the session
// module on purpose: the flag is consulted first, ahead of any auth or DB work.
import { accountDeletionEnabled, requestStaffErasure } from "@/server/services/privacy-deletion";
import { requireOrgContext } from "@/server/auth/session";
import { verifyReauthentication } from "@/server/auth/reauth";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Staff → person → "Remove and erase personal data".
 *
 * Distinct from `removeStaff` (which only ends the membership): this removes the
 * person from the company AND erases the personal data the company holds about
 * them. It never touches the person's own login.
 *
 * The COMPANY is the session's active org and the ACTOR is the session user —
 * neither is read from the form. `staffUserId` necessarily names the target, but
 * it confers no authority: `privacy_request_create` re-proves, under row locks,
 * that the actor is an owner/admin of THAT org, that the target is a non-owner
 * member of THAT org (an admin only by the owner), and that the typed email is
 * the target's.
 *
 * Returns a FormState; the client navigates with `window.location.assign`
 * (this is a force-dynamic `[id]` route — no `redirect()` / `revalidatePath`).
 */
export async function eraseStaffMemberAction(
  staffUserId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!accountDeletionEnabled()) {
    return formError("Erasure is not available yet. Please contact support and we will handle the request.");
  }
  const { ctx, user } = await requireOrgContext();
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return formError("Only an owner or admin can erase a staff member's data.");
  }
  if (!UUID.test(staffUserId) || staffUserId === user.id) {
    return formError("That person cannot be erased from here.");
  }

  const password = formData.get("password");
  const reauth = await verifyReauthentication({
    user,
    password: typeof password === "string" ? password : "",
  });
  if (!reauth.ok) return formError(reauth.message);

  const confirm = formData.get("confirm_email");
  const result = await requestStaffErasure({
    orgId: ctx.org.id, // the SESSION's active org — never a posted id
    actorUserId: user.id,
    staffUserId,
    confirmEmail: typeof confirm === "string" ? confirm : "",
  });
  if (!result.ok) {
    return formError(
      result.code === "confirmation"
        ? "The email you typed does not match this person's email. Nothing was erased."
        : result.code === "forbidden"
          ? "You are not allowed to erase this person."
          : result.message,
    );
  }
  if (result.run?.status !== "completed") {
    return formError(
      "The erasure was recorded but has not finished. It will be completed automatically; nothing further is needed from you.",
    );
  }
  return formSuccess({ redirectTo: "/staff?saved=erased" });
}
