import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { storagePathBelongsToOrg } from "@/lib/storage/owned-path";
import {
  SIGNATURE_BUCKET,
  parseSignatureDataUrl,
  signatureStorageKey,
  type SignatureScope,
} from "@/lib/signatures/data-url";

/**
 * Drawn e-signature storage service — the ONE server path that turns a
 * canvas PNG data-URL into a stored object in the private `signatures` bucket.
 * Shared by quote/variation acceptance (anonymous customer) and H&S sign-off
 * (authenticated operative).
 *
 * Discipline (mirrors server/services/blueprints.ts):
 *   * bytes are validated as a real PNG (magic-byte sniff + size cap) — the
 *     declared MIME is untrusted;
 *   * the key is built server-side, org-first, with a random UUID — no user
 *     input reaches the path;
 *   * upload goes through the service-role client with upsert:false;
 *   * best-effort by contract: a storage failure NEVER breaks the acceptance /
 *     sign-off it enriches — the caller keeps the typed-name record and just
 *     stores no image path.
 */

export type StoredSignature = { bucket: string; path: string };

export async function storeSignatureImage(args: {
  orgId: string;
  scope: SignatureScope;
  subjectId: string;
  dataUrl: unknown;
}): Promise<StoredSignature | null> {
  const parsed = parseSignatureDataUrl(args.dataUrl);
  if (!parsed.ok) {
    // No/invalid drawn signature is fine — the typed name still stands.
    return null;
  }
  if (!args.orgId || !args.subjectId) return null;

  const key = signatureStorageKey(args.orgId, args.scope, args.subjectId, randomUUID());
  // Belt-and-braces: the key we just built must be under this org. (Also a
  // second reader of the invariant the DB CHECK + storage RLS both enforce.)
  if (!storagePathBelongsToOrg(key, args.orgId)) return null;

  const admin = createAdminClient();
  const { error } = await admin.storage
    .from(SIGNATURE_BUCKET)
    .upload(key, parsed.bytes, { contentType: "image/png", upsert: false });
  if (error) {
    console.error("[signatures] image upload failed", error.message);
    return null;
  }
  return { bucket: SIGNATURE_BUCKET, path: key };
}

/**
 * Best-effort removal of a just-uploaded signature object. Used to clean up an
 * orphan when the DB insert it was meant to accompany fails (or is an
 * idempotent no-op re-sign). Never throws.
 */
export async function deleteSignatureImage(stored: StoredSignature | null): Promise<void> {
  if (!stored) return;
  try {
    const admin = createAdminClient();
    await admin.storage.from(stored.bucket).remove([stored.path]);
  } catch (err) {
    console.error("[signatures] orphan cleanup failed", err);
  }
}

/**
 * Mint a short-lived signed URL for a stored signature image, for the
 * operator-facing audit trail. Re-checks org ownership of the stored path
 * before minting (defence-in-depth against a poisoned path) — the app-layer
 * half of the DB org-first CHECK, exactly as job-documents / blueprints do.
 * Returns null on any failure so a broken image never breaks the page.
 */
export async function signatureImageUrl(
  bucket: string | null | undefined,
  path: string | null | undefined,
  orgId: string,
  expiresInSeconds = 60,
): Promise<string | null> {
  if (!bucket || !path) return null;
  if (!storagePathBelongsToOrg(path, orgId)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
