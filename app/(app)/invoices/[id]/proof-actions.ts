"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext, requireManagementRole } from "@/server/auth/session";

/**
 * Staff-side access to a customer-submitted payment proof.
 *
 * Completes the payment-verification loop. The portal half already exists: a
 * customer uploads a proof (`app/customer-portal/_upload-action.ts` → a
 * `portal_uploads` row + the private `portal-uploads` bucket) and sees it read
 * back on their invoices page. Until now nothing on the staff side could open
 * that file, so the portal's "we'll confirm once it's matched to your payment"
 * was a promise against a file no one could look at.
 *
 * Mirrors `getAttachmentSignedUrl` (components/attachments/actions.ts) — same
 * 60-second signed URL, same fail-closed-to-null shape — with one deliberate
 * difference noted below.
 *
 * SECURITY: `portal_uploads` has RLS enabled with NO policies (service-role
 * only — see supabase/migrations/20260620000000_portal_uploads.sql), so unlike
 * `tenant_attachments` it cannot be ownership-checked on the user-JWT client:
 * that client reads zero rows. This therefore runs on the RLS-BYPASSING admin
 * client, which makes the `org_id` filter below the ONLY thing enforcing
 * organisation isolation. It must never be removed or widened. `kind` pins the
 * row to a payment proof so this action can't be repurposed into a general
 * reader for other portal upload kinds.
 */
export async function getPaymentProofSignedUrl(
  proofId: string,
): Promise<string | null> {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // payment-proof access (fix 1)
  const id = z.string().uuid().safeParse(proofId);
  if (!id.success) return null;

  const admin = createAdminClient();

  // `portal_uploads` isn't in the generated Supabase types, so we cast exactly
  // like the portal read/write sides do.
  type ProofLookup = {
    eq: (k: string, v: unknown) => ProofLookup;
    maybeSingle: () => Promise<{
      data: { storage_path: string | null } | null;
      error: { message: string } | null;
    }>;
  };
  const { data: row } = await (
    admin.from("portal_uploads" as never) as unknown as {
      select: (cols: string) => ProofLookup;
    }
  )
    .select("storage_path")
    .eq("id", id.data)
    .eq("org_id", ctx.org.id)
    .eq("kind", "payment_proof")
    .maybeSingle();

  // Fails closed: another org's proof id resolves to no row, so no URL.
  if (!row?.storage_path) return null;

  const { data: signed } = await admin.storage
    .from("portal-uploads")
    .createSignedUrl(row.storage_path, 60);
  return signed?.signedUrl ?? null;
}
