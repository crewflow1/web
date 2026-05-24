"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  uploadTenantAttachment,
  deleteTenantAttachment,
  ATTACHMENT_TARGET_TABLES,
  type AttachmentTargetTable,
} from "@/server/services/tenant-attachments";

/**
 * Phase F — Universal attachments server actions.
 *
 * Used by the <AttachmentsPanel> component on detail pages
 * (customers/jobs/quotes/invoices/suppliers/staff/leads).
 *
 * uploadAttachment: takes target_table + target_id from hidden fields,
 *   plus a File from the form. Returns a redirect-back via revalidate
 *   so the panel re-fetches the list.
 *
 * removeAttachment: takes the attachment id + the same target so we
 *   know where to revalidate.
 *
 * downloadAttachment: returns a 60-second signed URL (called via fetch
 *   from the client when the user clicks the link).
 */

const targetSchema = z.object({
  target_table: z.enum(
    ATTACHMENT_TARGET_TABLES as unknown as [AttachmentTargetTable, ...AttachmentTargetTable[]],
  ),
  target_id: z.string().uuid(),
});

export async function uploadAttachment(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireOrgContext();
  const parsed = targetSchema.safeParse({
    target_table: formData.get("target_table") ?? "",
    target_id: formData.get("target_id") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "bad_target" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "no_file" };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadTenantAttachment({
    targetTable: parsed.data.target_table,
    targetId: parsed.data.target_id,
    filename: file.name,
    mimeType: file.type,
    bytes,
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Revalidate the parent detail page so the panel re-renders.
  revalidatePath(`/${parsed.data.target_table}/${parsed.data.target_id}`);
  return { ok: true };
}

export async function removeAttachment(
  attachmentId: string,
  targetTable: AttachmentTargetTable,
  targetId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireOrgContext();
  const result = await deleteTenantAttachment(attachmentId);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath(`/${targetTable}/${targetId}`);
  return { ok: true };
}

/**
 * Returns a 60-second signed URL the browser can use to download or
 * preview the attachment. The caller authenticates via the user
 * session before the URL is generated.
 */
export async function getAttachmentSignedUrl(attachmentId: string): Promise<string | null> {
  await requireOrgContext();
  const id = z.string().uuid().safeParse(attachmentId);
  if (!id.success) return null;

  const tenant = await createClient();
  const { data: row } = await (
    tenant.from("tenant_attachments" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: { storage_path: string | null } | null }>;
        };
      };
    }
  )
    .select("storage_path")
    .eq("id", id.data)
    .maybeSingle();

  if (!row?.storage_path) return null;

  const admin = createAdminClient();
  const { data: signed } = await admin.storage
    .from("tenant-attachments")
    .createSignedUrl(row.storage_path, 60);
  return signed?.signedUrl ?? null;
}
