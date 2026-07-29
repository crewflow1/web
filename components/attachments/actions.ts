"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { storagePathBelongsToOrg } from "@/lib/storage/owned-path";
import { requireOrgContext } from "@/server/auth/session";
import { reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
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
  const { data: row, error: rowError } = await (
    tenant.from("tenant_attachments" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: { org_id: string | null; storage_path: string | null } | null;
            error: SupabaseReadError | null;
          }>;
        };
      };
    }
  )
    .select("org_id, storage_path")
    .eq("id", id.data)
    .maybeSingle();
  // REPORT, don't throw. This action is called from a click handler inside
  // startTransition (AttachmentsClient.onOpen); a thrown Server Action error
  // there is unhandled on the client and takes the WHOLE page down for one
  // broken download. The client already renders "Couldn't open the file." on
  // null, which is an explicit failure state — not the silent-empty lie this
  // sweep exists to remove — and Sentry still gets the exception.
  if (rowError) {
    reportReadFailure("attachments: signed-url row", rowError);
    return null;
  }

  if (!row?.storage_path) return null;
  // Never sign a path that doesn't live under the row's own org — a poisoned storage_path
  // (org-A row → org-B object) would otherwise mint a cross-tenant download URL. Mirrors the
  // DB trigger (20261031) and covers any row written before it.
  if (!storagePathBelongsToOrg(row.storage_path, row.org_id)) return null;

  const admin = createAdminClient();
  const { data: signed, error: signError } = await admin.storage
    .from("tenant-attachments")
    .createSignedUrl(row.storage_path, 60);
  if (signError) {
    reportReadFailure("attachments: sign url", signError);
    return null;
  }
  return signed?.signedUrl ?? null;
}
