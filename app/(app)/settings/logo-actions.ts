"use server";

import { revalidatePath } from "next/cache";
import {
  uploadCompanyLogo,
  deleteCompanyLogo,
} from "@/server/services/company-logo";

/**
 * Settings → Organisation logo actions.
 *
 * Thin wrappers over the company-logo service. The service enforces the
 * owner/admin role gate, validates MIME + extension + size, and writes the
 * audit log; these just marshal the File from the form and revalidate the
 * pages that render the logo.
 *
 * Returns a plain result object (not a useActionState FormState) — the logo
 * control is a small client component that calls these directly via
 * useTransition, like the attachments uploader.
 */

export type LogoActionResult = { ok: true } | { ok: false; error: string };

export async function uploadLogoAction(
  formData: FormData,
): Promise<LogoActionResult> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "no_file" };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadCompanyLogo({
    filename: file.name,
    mimeType: file.type,
    bytes,
  });
  if (!result.ok) return result;

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteLogoAction(): Promise<LogoActionResult> {
  const result = await deleteCompanyLogo();
  if (!result.ok) return result;

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: true };
}
