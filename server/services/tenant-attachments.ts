import "server-only";
import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Phase F — Universal tenant-side attachments.
 *
 * Polymorphic file attachments for tenant entities. Mirror of
 * `portal_uploads` (customer-side) but the uploader is an
 * authenticated tenant user.
 *
 * Allowed target_table values (CHECK on the column): customers,
 * jobs, quotes, invoices, suppliers, memberships, leads, snags,
 * site_diary_entries, toolbox_talks, site_reports, assets.
 *
 * MIME whitelist: PDF, JPG, PNG, HEIC, HEIF, WebP, Excel, CSV.
 * Size cap: 25 MB.
 *
 * Permissions:
 *   - Upload: any member of the org (tenant client + RLS)
 *   - Download: any member of the org
 *   - Delete: owner/admin only (the table's RLS delete policy)
 */

export const ALLOWED_ATTACHMENT_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Mirrors the DB CHECK on tenant_attachments.target_table (authority:
// 20260925 added asset_assignments, 20260927 added asset_inspections). When a
// migration widens the CHECK, extend this list in the same PR.
export const ATTACHMENT_TARGET_TABLES = [
  "customers",
  "jobs",
  "quotes",
  "invoices",
  "suppliers",
  "memberships",
  "leads",
  "snags",
  "site_diary_entries",
  "toolbox_talks",
  "site_reports",
  "assets",
  "asset_assignments",
  "asset_inspections",
] as const;
export type AttachmentTargetTable = (typeof ATTACHMENT_TARGET_TABLES)[number];

export type AttachmentRow = {
  id: string;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

export type UploadResult =
  | { ok: true; attachment_id: string }
  | { ok: false; error: string };

export async function uploadTenantAttachment(input: {
  targetTable: AttachmentTargetTable;
  targetId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<UploadResult> {
  if (!ALLOWED_ATTACHMENT_MIME.has(input.mimeType)) {
    return { ok: false, error: "bad_file_type" };
  }
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: "file_too_large" };
  }

  const { ctx, user } = await requireOrgContext();
  const admin = createAdminClient();

  // Evidence hash — SHA-256 of the EXACT bytes we store, frozen (immutable once set) so a
  // later byte swap is detectable. Binary-safe on the raw Uint8Array (mirrors blueprints.ts).
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");

  const ext = mimeToExt(input.mimeType);
  const id = crypto.randomUUID();
  const storagePath = `${ctx.org.id}/${input.targetTable}/${input.targetId}/${id}.${ext}`;

  const { error: uErr } = await admin.storage
    .from("tenant-attachments")
    .upload(storagePath, input.bytes, {
      contentType: input.mimeType,
      upsert: false,
    });
  if (uErr) {
    console.error("[tenant-attachments] storage upload failed", uErr);
    return { ok: false, error: "upload_failed" };
  }

  // Use the tenant JWT for the row insert so RLS scopes correctly.
  const tenant = await createClient();
  const { error: insErr } = await tenant.from("tenant_attachments" as never).insert({
    id,
    org_id: ctx.org.id,
    target_table: input.targetTable,
    target_id: input.targetId,
    filename: input.filename,
    storage_path: storagePath,
    mime_type: input.mimeType,
    size_bytes: input.bytes.byteLength,
    content_hash: contentHash,
    uploaded_by: user.id,
  } as never);
  if (insErr) {
    console.error("[tenant-attachments] db insert failed", insErr);
    // Orphan cleanup.
    await admin.storage
      .from("tenant-attachments")
      .remove([storagePath])
      .catch(() => undefined);
    return { ok: false, error: "record_failed" };
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "tenant_attachment.upload",
    targetTable: input.targetTable,
    targetId: input.targetId,
    metadata: {
      attachment_id: id,
      filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
    },
  });

  return { ok: true, attachment_id: id };
}

export async function deleteTenantAttachment(id: string): Promise<UploadResult> {
  const { ctx, user } = await requireOrgContext();

  // SECURITY (P2 audit M-5): the RLS delete policy is owner/admin-only
  // (migration 20260705000000_tenant_attachments_delete_admin_only). Re-check
  // the caller's role in code so a member gets a deterministic "forbidden"
  // instead of relying solely on RLS, and as defense-in-depth if that policy
  // ever regresses. Storage removal below uses the SERVICE-ROLE admin client,
  // so the row delete on the RLS-scoped tenant client is the only gate that
  // actually scopes the destructive action — guard it before touching storage.
  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") {
    return { ok: false, error: "forbidden" };
  }

  const tenant = await createClient();
  const admin = createAdminClient();

  // Delete on the RLS-scoped tenant client (owner/admin-only policy). When RLS
  // removes zero rows it returns data=null with error=null, so success is gated
  // on a row actually coming back — never a false success that audits/returns ok
  // for a no-op (foreign id, already deleted, or an RLS refusal).
  const { data, error } = await tenant
    .from("tenant_attachments" as never)
    .delete()
    .eq("id", id)
    .select("storage_path")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "not_deleted" };
  const path = (data as { storage_path?: string } | null)?.storage_path;
  if (path) {
    await admin.storage.from("tenant-attachments").remove([path]).catch(() => undefined);
  }
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "tenant_attachment.delete",
    targetTable: "tenant_attachments",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  });
  return { ok: true, attachment_id: id };
}

function mimeToExt(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";
  if (mime === "image/webp") return "webp";
  if (mime === "text/csv") return "csv";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "xlsx";
  if (mime.includes("wordprocessing") || mime.includes("msword")) return "docx";
  return "bin";
}
