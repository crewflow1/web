import { NextResponse, type NextRequest } from "next/server";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { verifyPortalAttachment } from "@/app/customer-portal/_attachments";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Customer-portal ATTACHMENT download.
 *
 *   GET /customer-portal/[token]/documents/attachments/[id]
 *
 * Serves a single portal-visible attachment as a short-lived signed URL.
 * Security model, in order:
 *
 *   1. TOKEN CHOKEPOINT — the URL token is resolved to a customer through the
 *      ONE authority (loadCustomerByPortalToken). Unknown / malformed / expired
 *      tokens 404 exactly like every other portal route.
 *   2. OWNERSHIP + FLAG RE-CHECK — verifyPortalAttachment independently confirms
 *      the attachment is `portal_visible = true` AND resolves to a quote /
 *      invoice / job the token-resolved customer owns. A guessed id, an
 *      un-flagged file, or another customer's attachment all fail closed → 404.
 *   3. SCOPED SIGNED URL — the storage path is read from the VERIFIED row, never
 *      from the request; the signed URL is object-scoped and expires in 60s.
 *   4. PRIVATE — `Cache-Control: private, no-store` on the redirect.
 */

type Ctx = { params: Promise<{ token: string; id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { token, id } = await params;

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { customer } = loaded;

  const verified = await verifyPortalAttachment(id, customer.id, customer.org_id);
  if (!verified) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: signed, error } = await admin.storage
    .from("tenant-attachments")
    .createSignedUrl(verified.storage_path, 60, {
      download: verified.filename ?? true,
    });
  if (error || !signed?.signedUrl) {
    return NextResponse.json({ error: "Unavailable" }, { status: 502 });
  }

  const res = NextResponse.redirect(signed.signedUrl, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
