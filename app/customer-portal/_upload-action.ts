"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";

/**
 * Phase 3 — Portal payment-proof upload.
 *
 * Customer attaches a PDF / JPG / PNG (proof of bank transfer or
 * similar). We:
 *   1. Validate the token + load the customer.
 *   2. Re-verify the invoice belongs to this customer (via the
 *      quote→customer FK chain) so a crafted URL can't attach a
 *      proof to a different org's invoice.
 *   3. Upload the bytes to the `portal-uploads` bucket.
 *   4. Insert a `portal_uploads` row capturing the link.
 *   5. Audit-log the action.
 *
 * File type + size validation:
 *   - Allowed MIME types: application/pdf, image/jpeg, image/png,
 *     image/heic, image/heif
 *   - Max size: 10 MB (storage bucket policy enforces server-side)
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

function backTo(token: string, invoiceId: string, error?: string): never {
  const base = `/customer-portal/${token}/invoices`;
  const qs = error ? `?error=${encodeURIComponent(error)}` : `?saved=uploaded`;
  redirect(`${base}${qs}#inv-${invoiceId}`);
}

export async function uploadPaymentProof(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const invoiceId = String(formData.get("invoice_id") ?? "");
  const file = formData.get("file") as File | null;
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 500);

  if (!token || !invoiceId) {
    redirect(`/customer-portal/${token}/invoices?error=missing_fields`);
  }

  // Throttle portal uploads per token to block upload spam / storage abuse.
  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    backTo(token, invoiceId, "Too many uploads. Please wait a moment and try again.");
  }

  if (!file || typeof file.size !== "number" || file.size === 0) {
    backTo(token, invoiceId, "no_file");
  }
  if (file.size > MAX_BYTES) {
    backTo(token, invoiceId, "file_too_large");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    backTo(token, invoiceId, "bad_file_type");
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    backTo(token, invoiceId, "invalid_token");
  }
  const { customer } = loaded;

  const admin = createAdminClient();

  // Re-verify the invoice is for this customer. Invoices don't have a
  // direct customer_id column; we join via quote.
  const { data: invoiceRow } = await admin
    .from("invoices")
    .select("id, quote:quotes ( customer_id )")
    .eq("id", invoiceId)
    .eq("org_id", customer.org_id)
    .maybeSingle();
  type InvJoined = { id: string; quote?: { customer_id: string } | null };
  const inv = invoiceRow as unknown as InvJoined | null;
  if (!inv || inv.quote?.customer_id !== customer.id) {
    backTo(token, invoiceId, "invoice_not_yours");
  }

  // Upload to storage. Path keyed by org → customer → uuid+ext so the
  // same customer can upload many proofs and HQ can audit by prefix.
  const ext = (() => {
    if (file.type === "application/pdf") return "pdf";
    if (file.type === "image/jpeg") return "jpg";
    if (file.type === "image/png") return "png";
    if (file.type === "image/webp") return "webp";
    if (file.type === "image/heic") return "heic";
    if (file.type === "image/heif") return "heif";
    return "bin";
  })();
  const uploadId = crypto.randomUUID();
  const storagePath = `${customer.org_id}/${customer.id}/${uploadId}.${ext}`;

  const bytes = await file.arrayBuffer();
  const { error: uErr } = await admin.storage
    .from("portal-uploads")
    .upload(storagePath, bytes, {
      contentType: file.type,
      upsert: false,
    });
  if (uErr) {
    console.error("[portal/upload] storage upload failed", uErr);
    backTo(token, invoiceId, "upload_failed");
  }

  // Record in portal_uploads.
  const { error: insErr } = await (
    admin.from("portal_uploads" as never) as unknown as {
      insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert({
    id: uploadId,
    org_id: customer.org_id,
    customer_id: customer.id,
    target_table: "invoices",
    target_id: invoiceId,
    kind: "payment_proof",
    filename: file.name || `proof.${ext}`,
    storage_path: storagePath,
    mime_type: file.type,
    size_bytes: file.size,
    notes: notes || null,
  });
  if (insErr) {
    console.error("[portal/upload] portal_uploads insert failed", insErr);
    // Try to clean up the orphan file (best-effort).
    await admin.storage
      .from("portal-uploads")
      .remove([storagePath])
      .catch(() => undefined);
    backTo(token, invoiceId, "record_failed");
  }

  // Audit log.
  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.upload.payment_proof",
    targetTable: "invoices",
    targetId: invoiceId,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      storage_path: storagePath,
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    },
  });

  revalidatePath(`/customer-portal/${token}/invoices`);
  backTo(token, invoiceId);
}
