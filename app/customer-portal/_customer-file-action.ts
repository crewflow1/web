"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnCustomerFileUploaded } from "@/lib/notifications/events";

/**
 * Portal — general customer file upload ("send us a file").
 *
 * The proven payment-proof path (_upload-action.ts) is repurposed here for a
 * file that is NOT tied to an invoice: the customer just wants to send the org a
 * document/photo (a spec, a site photo, a signed form). We:
 *   1. Validate the token + load the customer (the ONE portal authority).
 *   2. Rate-limit (portal_write) to block upload spam / storage abuse.
 *   3. Validate MIME + size (same allowlist + 10MB cap the bucket also enforces).
 *   4. Upload to the private `portal-uploads` bucket under org → customer → uuid.
 *   5. Insert a portal_uploads row anchored to the CUSTOMER themselves
 *      (target_table='customers', target_id=customer.id, kind='customer_file').
 *   6. Audit-log + notify the org.
 *
 * SECURITY: the path prefix, org_id, customer_id and target_id are ALL derived
 * from the token-resolved customer — never from the request body — so a crafted
 * form can only ever file against the caller's own customer row in their own org.
 * The bucket is private; staff read it back only via a short-lived signed URL
 * scoped by (id + org_id + kind) on the admin client (see customers file inbox).
 */

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);
const MAX_BYTES = 10 * 1024 * 1024;

function backTo(token: string, error?: string): never {
  const base = `/customer-portal/${token}/files`;
  const qs = error ? `?error=${encodeURIComponent(error)}` : `?saved=uploaded`;
  redirect(`${base}${qs}`);
}

function extFor(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";
  return "bin";
}

export async function uploadCustomerFile(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const file = formData.get("file") as File | null;
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 500);

  if (!token) {
    redirect(`/customer-portal/invalid?error=missing_fields`);
  }

  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    backTo(token, "Too many uploads. Please wait a moment and try again.");
  }

  if (!file || typeof file.size !== "number" || file.size === 0) {
    backTo(token, "no_file");
  }
  if (file.size > MAX_BYTES) {
    backTo(token, "file_too_large");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    backTo(token, "bad_file_type");
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    backTo(token, "invalid_token");
  }
  const { customer } = loaded;

  const admin = createAdminClient();

  const ext = extFor(file.type);
  const uploadId = crypto.randomUUID();
  // Path keyed by the TOKEN-RESOLVED org → customer, never request input.
  const storagePath = `${customer.org_id}/${customer.id}/${uploadId}.${ext}`;

  const bytes = await file.arrayBuffer();
  const { error: uErr } = await admin.storage
    .from("portal-uploads")
    .upload(storagePath, bytes, { contentType: file.type, upsert: false });
  if (uErr) {
    console.error("[portal/customer-file] storage upload failed", uErr);
    backTo(token, "upload_failed");
  }

  const { error: insErr } = await (
    admin.from("portal_uploads" as never) as unknown as {
      insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert({
    id: uploadId,
    org_id: customer.org_id,
    customer_id: customer.id,
    // Anchored to the customer themselves — this file is not about an invoice.
    target_table: "customers",
    target_id: customer.id,
    kind: "customer_file",
    filename: file.name || `file.${ext}`,
    storage_path: storagePath,
    mime_type: file.type,
    size_bytes: file.size,
    notes: notes || null,
  });
  if (insErr) {
    console.error("[portal/customer-file] portal_uploads insert failed", insErr);
    // Best-effort orphan cleanup.
    await admin.storage
      .from("portal-uploads")
      .remove([storagePath])
      .catch(() => undefined);
    backTo(token, "record_failed");
  }

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.upload.customer_file",
    targetTable: "customers",
    targetId: customer.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      storage_path: storagePath,
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    },
  });

  // Announce it to the org. Best-effort by construction: emitNotifications never
  // throws (notifications-service), and both failure branches above are typed
  // `never` (they redirect), so this line is reached only after BOTH the storage
  // upload and the authoritative portal_uploads insert have succeeded — a failed
  // upload can never notify. Exactly one per upload (source_id = uploadId).
  await emitNotifications(
    notifyOnCustomerFileUploaded({
      org_id: customer.org_id,
      upload_id: uploadId,
      customer_id: customer.id,
      customer_name: customer.name,
      filename: file.name || `file.${ext}`,
      customer_note: notes || null,
    }),
  );

  revalidatePath(`/customer-portal/${token}/files`);
  revalidatePath(`/notifications`);
  revalidatePath(`/customers/${customer.id}`);
  backTo(token);
}
