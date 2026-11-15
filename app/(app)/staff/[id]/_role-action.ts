"use server";

import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { updateStaffRole } from "@/app/(app)/staff/actions";
import { formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Role-change form adapter.
 *
 * `updateStaffRole` ends in redirect(). Next 15.5 intermittently drops that
 * navigation when the route-swap is deep (the write lands, the URL — and the
 * `?saved=role` banner — never arrive; reproduced 4/6 in a real browser).
 * D-12: return the destination as FormState.redirectTo and let the client
 * `window.location.assign` it. ALL authorisation, validation and writes stay in
 * `updateStaffRole`; this adapter only translates its redirect into state, and
 * rethrows anything that is not a redirect.
 */
export async function updateStaffRoleState(
  userId: string,
  _prev: FormState<Record<string, unknown>>,
  formData: FormData,
): Promise<FormState<Record<string, unknown>>> {
  try {
    await updateStaffRole(userId, formData);
  } catch (e) {
    if (isRedirectError(e)) {
      return formSuccess({ redirectTo: getURLFromRedirectError(e) });
    }
    throw e;
  }
  return formSuccess({});
}
