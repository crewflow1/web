"use server";

/**
 * FEATURE 2 — the server action the `<ImportButton>` calls.
 *
 * A thin, serializable boundary over server/services/document-autofill.ts. It
 * receives the uploaded file as FormData (so the bytes never transit as a
 * base64 string in a JSON body), and returns the review payload the dialog
 * renders. All authorisation, validation, storage and extraction happen in the
 * service — this file adds nothing but the "use server" boundary and the
 * form-field read.
 */

import {
  startDocumentImport,
  discardImportDraft,
  type ImportStartResult,
} from "@/server/services/document-autofill";

export async function startImportAction(formData: FormData): Promise<ImportStartResult> {
  const formType = String(formData.get("formType") ?? "");
  const file = formData.get("file");
  return startDocumentImport(formType, file instanceof File ? file : null);
}

export async function discardImportAction(draftId: string): Promise<void> {
  await discardImportDraft(String(draftId ?? ""));
}
