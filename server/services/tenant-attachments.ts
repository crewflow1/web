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

// Mirrors the DB CHECK on tenant_attachments.target_table. This list is what
// the upload action validates against, so a target the database accepts but
// this list omits is simply unreachable from the app. A security test derives
// the CHECK's value set from the migrations and asserts this list equals it,
// so the two can no longer drift (the maintenance-case and fuel-log targets
// sat DB-enabled but app-unreachable for weeks exactly this way).
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
  "asset_maintenance_cases",
  "asset_fuel_logs",
  // delivery-note photos: the whole point of receiving on a phone in a yard.
  "goods_received_notes",
  // works-quality evidence: the photo / test certificate that backs an ITP
  // sign-off. Append-only once the sign-off exists (20261076).
  "inspection_signoffs",
  // works-quality M2: the photo of the nonconformity, the rework, the re-test
  // certificate — evidence on an NCR (20261081).
  "non_conformance_reports",
  // blueprint pins: a photo attached DIRECTLY to a marker on a drawing (P2
  // pins wave, 20261122000001) — the photo of the thing the pin flags, no
  // longer only reachable through a linked snag.
  "blueprint_pins",
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

/**
 * Service-role sibling of {@link uploadTenantAttachment}, for a SYSTEM context
 * with no user session (e.g. the WhatsApp webhook attaching an inbound photo to
 * a job). Same evidence discipline VERBATIM — MIME whitelist, size cap, SHA-256
 * content_hash of the exact bytes, org-first path, service-role byte write — but
 * the org is passed EXPLICITLY rather than read from `requireOrgContext()`, and
 * `uploaded_by` is null (no human uploaded it).
 *
 * The org scoping is the caller's responsibility and MUST be enforced before
 * calling: because this uses the service role it BYPASSES RLS, so the caller has
 * to have already verified `targetId` belongs to `orgId` (the assistant-actions
 * pipeline does — it re-reads the job under `.eq("org_id", orgId)` first). This
 * function only stamps the row with the org it is told.
 */
export async function uploadTenantAttachmentAsService(input: {
  orgId: string;
  targetTable: AttachmentTargetTable;
  targetId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Optional idempotency guard: skip if a row already exists for this hash+target. */
  dedupeContentHash?: boolean;
}): Promise<UploadResult> {
  if (!ALLOWED_ATTACHMENT_MIME.has(input.mimeType)) {
    return { ok: false, error: "bad_file_type" };
  }
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: "file_too_large" };
  }

  const admin = createAdminClient();
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");

  // Idempotency: an at-least-once webhook must not attach the same photo twice.
  if (input.dedupeContentHash) {
    const existing = await (
      admin.from("tenant_attachments" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              eq: (k: string, v: unknown) => {
                maybeSingle: () => Promise<{ data: { id: string } | null; error: unknown }>;
              };
            };
          };
        };
      }
    )
      .select("id")
      .eq("org_id", input.orgId)
      .eq("target_id", input.targetId)
      .eq("content_hash", contentHash)
      .maybeSingle();
    if (existing.data?.id) {
      return { ok: true, attachment_id: String(existing.data.id) };
    }
  }

  const ext = mimeToExt(input.mimeType);
  const id = crypto.randomUUID();
  const storagePath = `${input.orgId}/${input.targetTable}/${input.targetId}/${id}.${ext}`;

  const { error: uErr } = await admin.storage
    .from("tenant-attachments")
    .upload(storagePath, input.bytes, { contentType: input.mimeType, upsert: false });
  if (uErr) {
    console.error("[tenant-attachments] service upload failed", uErr);
    return { ok: false, error: "upload_failed" };
  }

  const { error: insErr } = await admin.from("tenant_attachments" as never).insert({
    id,
    org_id: input.orgId,
    target_table: input.targetTable,
    target_id: input.targetId,
    filename: input.filename,
    storage_path: storagePath,
    mime_type: input.mimeType,
    size_bytes: input.bytes.byteLength,
    content_hash: contentHash,
    uploaded_by: null,
  } as never);
  if (insErr) {
    console.error("[tenant-attachments] service db insert failed", insErr);
    await admin.storage.from("tenant-attachments").remove([storagePath]).catch(() => undefined);
    return { ok: false, error: "record_failed" };
  }

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
    // ACTIVE-org pin: the DELETE row is the only gate that scopes the
    // destructive action (the storage purge below uses the service-role client).
    // tenant_attachments' delete RLS is is_org_admin(org_id), which a dual-org
    // owner/admin satisfies for BOTH orgs — so without this a member in org A
    // could delete org B's attachment and purge its bytes.
    .eq("org_id", ctx.org.id)
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
