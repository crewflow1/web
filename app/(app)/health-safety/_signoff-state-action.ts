"use server";

import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { acknowledgeSafetyDocument } from "./signoff-actions";
import { formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Sign-off form adapter (D-12).
 *
 * `acknowledgeSafetyDocument` ends in redirect() back to the document page it was submitted
 * from. On that deep `[id]` route the router does not complete the navigation: measured in a
 * real browser as a field worker, the acknowledgement was written in ~0.1 s and the page then
 * sat for exactly 10 s before the confirmation appeared, every time. Returning the destination
 * as FormState.redirectTo lets <StateForm> do a full document load instead. ALL authorisation,
 * validation and writes stay in `acknowledgeSafetyDocument`; this only translates its redirect
 * (success or `?error=`) into state, and rethrows anything that is not a redirect.
 */
export async function acknowledgeSafetyDocumentState(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    await acknowledgeSafetyDocument(formData);
  } catch (e) {
    if (isRedirectError(e)) {
      return formSuccess({ redirectTo: getURLFromRedirectError(e) });
    }
    throw e;
  }
  return formSuccess({});
}
