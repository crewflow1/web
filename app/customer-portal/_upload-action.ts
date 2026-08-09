"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnPaymentProofUploaded } from "@/lib/notifications/events";
import { readFailure } from "@/lib/supabase/read-failure";
import { invoiceCustomerId } from "@/lib/invoices/customer";

/**
 * Phase 3 — Portal payment-proof upload.
 *
 * Customer attaches a PDF / JPG / PNG (proof of bank transfer or
 * similar). We:
 *   1. Validate the token + load the customer.
 *   2. Re-verify the invoice belongs to this customer via the ONE
 *      customer authority (invoiceCustomerId: the invoice's own
 *      customer_id, quote fallback) so a crafted URL can't attach a
 *      proof to a different org's invoice.
 *   3. Upload the bytes to the `portal-uploads` bucket.
 *   4. Insert a `portal_uploads` row capturing the link.
 *   5. Audit-log the action.
 *
 * File type + size validation:
 *   - Allowed MIME types: application/pdf, image/jpeg, image/png,
 *     image/heic, image/heif, image/webp
 *   - Max size: 10 MB
 * Both checks run here AND at the storage layer: the portal-uploads
 * bucket carries a matching file_size_limit + allowed_mime_types
 * (20260711000000_portal_uploads_bucket_limits.sql), so the same
 * limits hold even for an upload that bypasses this action.
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

  // Re-verify the invoice is for this customer. Resolve the customer via the ONE
  // authority (Issue #349 Phase 1): the invoice's own customer_id first, quote
  // fallback — the same way the portal PDF route and the invoices list scope.
  // The direct customer_id is authoritative and survives quote loss: because
  // invoices.quote_id is ON DELETE SET NULL, a deleted quote yields a
  // quote-less invoice whose customer_id still points here. Gating on
  // quote.customer_id ALONE wrongly rejected that invoice's legitimate owner
  // (and could accept the wrong owner if a stale quote pointed elsewhere).
  const { data: invoiceRow, error: invoiceError } = await admin
    .from("invoices")
    .select("id, number, customer_id, quote:quotes ( customer_id )")
    .eq("id", invoiceId)
    .eq("org_id", customer.org_id)
    .maybeSingle();
  // Loud fail: a query failure must not refuse the upload as "not yours" —
  // that blames the customer for a DB blip.
  if (invoiceError) throw readFailure("portal uploads: invoice ownership", invoiceError);
  // `number` rides along on the ownership lookup that already runs — staff need
  // a human-readable invoice reference in the notification below, and a UUID
  // identifies nothing. No extra round trip, no behaviour change.
  type InvJoined = {
    id: string;
    number: string | null;
    customer_id: string | null;
    quote?: { customer_id: string } | null;
  };
  const inv = invoiceRow as unknown as InvJoined | null;
  if (!inv || invoiceCustomerId(inv) !== customer.id) {
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

  // Tell the org a proof landed. The portal already promises the customer that
  // "{org} will confirm here once it's matched", and the staff proof panel on
  // the invoice exists — but nothing announced the arrival, so that promise
  // relied on someone happening to open the invoice.
  //
  // Placement is the contract: both failure branches above call backTo(), which
  // is typed `never` (it redirects), so reaching this line means the storage
  // upload AND the authoritative portal_uploads insert have both succeeded. A
  // failed upload or a failed record can never notify.
  //
  // Best-effort by construction: emitNotifications catches and logs its own
  // errors and never throws (notifications-service.ts), so a notification
  // failure cannot roll back or invalidate an upload the customer has already
  // been told succeeded. It is deliberately placed after the audit log, which
  // is the durable record.
  //
  // Exactly one per upload: source_id is `uploadId`, the portal_uploads primary
  // key generated once per invocation. A retried submission uploads a new file
  // and inserts a new row with a new id — a genuinely different proof, not a
  // duplicate of this one — so there is nothing to de-duplicate here.
  await emitNotifications(
    notifyOnPaymentProofUploaded({
      org_id: customer.org_id,
      upload_id: uploadId,
      invoice_id: invoiceId,
      invoice_number: inv.number,
      customer_id: customer.id,
      customer_name: customer.name,
      filename: file.name || `proof.${ext}`,
      customer_note: notes || null,
    }),
  );

  revalidatePath(`/customer-portal/${token}/invoices`);
  // Staff surfaces that now carry the notification + the proof itself.
  revalidatePath(`/notifications`);
  revalidatePath(`/invoices/${invoiceId}`);
  backTo(token, invoiceId);
}
