import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import type { Database } from "@/lib/supabase/types";
import {
  LOGO_BUCKET,
  LOGO_SIGNED_TTL,
  isLogoAdminRole,
  validateLogoUpload,
  logoObjectPath,
  pickLogoSource,
} from "@/lib/branding/logo";

/**
 * Company-logo storage service.
 *
 * Replaces the old "paste a logo URL" flow. Owners/admins upload an image
 * file; the bytes go to the private `company-logos` bucket under a
 * tenant-scoped key (`<org_id>/logo-<uuid>.<ext>`), and the path is recorded
 * on organizations.logo_path. The legacy organizations.logo_url is cleared on
 * upload and only ever READ (never written) elsewhere, for back-compat.
 *
 * Permissions:
 *   - Upload / replace / delete: owner or admin only (enforced here in app
 *     code AND by the bucket's storage RLS insert/update/delete policies).
 *   - Storage writes use the service-role client (bypasses RLS); the role
 *     gate above is the authoritative check, mirroring tenant-attachments.
 *
 * Every change is written to the admin activity log (same audit helper the
 * tenant-attachments feature uses).
 */

export type LogoResult = { ok: true } | { ok: false; error: string };

type AdminClient = SupabaseClient<Database>;

export async function uploadCompanyLogo(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<LogoResult> {
  const { ctx, user } = await requireOrgContext();

  if (!isLogoAdminRole(ctx.membership.role)) {
    return { ok: false, error: "forbidden" };
  }

  const validation = validateLogoUpload({
    filename: input.filename,
    mimeType: input.mimeType,
    byteLength: input.bytes.byteLength,
  });
  if (!validation.ok) return { ok: false, error: validation.error };

  const tenant = await createClient();
  const admin = createAdminClient();

  // Remember the current object so we can clean it up after a successful swap.
  const { data: existing } = await tenant
    .from("organizations")
    .select("logo_path")
    .eq("id", ctx.org.id)
    .maybeSingle();
  const previousPath = existing?.logo_path ?? null;

  const path = logoObjectPath(ctx.org.id, validation.ext);

  const { error: upErr } = await admin.storage
    .from(LOGO_BUCKET)
    .upload(path, input.bytes, {
      contentType: input.mimeType,
      upsert: false,
    });
  if (upErr) {
    console.error("[company-logo] storage upload failed", upErr);
    return { ok: false, error: "upload_failed" };
  }

  // Point the org at the new object and drop any legacy external URL.
  const { error: updErr, count } = await tenant
    .from("organizations")
    .update({ logo_path: path, logo_url: null }, { count: "exact" })
    .eq("id", ctx.org.id);
  if (updErr || count === 0) {
    if (updErr) console.error("[company-logo] org update failed", updErr);
    // Roll back the just-uploaded object so we don't orphan it.
    await admin.storage
      .from(LOGO_BUCKET)
      .remove([path])
      .catch(() => undefined);
    return { ok: false, error: updErr ? "record_failed" : "forbidden" };
  }

  // Best-effort removal of the replaced object.
  if (previousPath && previousPath !== path) {
    await admin.storage
      .from(LOGO_BUCKET)
      .remove([previousPath])
      .catch(() => undefined);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "company_logo.upload",
    targetTable: "organizations",
    targetId: ctx.org.id,
    metadata: {
      storage_path: path,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
      replaced: Boolean(previousPath),
    },
  });

  return { ok: true };
}

export async function deleteCompanyLogo(): Promise<LogoResult> {
  const { ctx, user } = await requireOrgContext();

  if (!isLogoAdminRole(ctx.membership.role)) {
    return { ok: false, error: "forbidden" };
  }

  const tenant = await createClient();

  const { data: existing } = await tenant
    .from("organizations")
    .select("logo_path")
    .eq("id", ctx.org.id)
    .maybeSingle();
  const previousPath = existing?.logo_path ?? null;

  // Clear both the managed path and any legacy URL.
  const { error: updErr, count } = await tenant
    .from("organizations")
    .update({ logo_path: null, logo_url: null }, { count: "exact" })
    .eq("id", ctx.org.id);
  if (updErr || count === 0) {
    if (updErr) console.error("[company-logo] org clear failed", updErr);
    return { ok: false, error: updErr ? "record_failed" : "forbidden" };
  }

  if (previousPath) {
    const admin = createAdminClient();
    await admin.storage
      .from(LOGO_BUCKET)
      .remove([previousPath])
      .catch(() => undefined);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "company_logo.delete",
    targetTable: "organizations",
    targetId: ctx.org.id,
    metadata: { storage_path: previousPath },
  });

  return { ok: true };
}

/**
 * Resolve a usable image `src` for an org's logo, for any server-rendered
 * surface (quote/invoice PDFs, public quote page, customer portal).
 *
 *   - uploaded logo (logo_path) → a short-lived signed URL (private bucket)
 *   - legacy external logo_url   → returned as-is (back-compat display only)
 *   - neither                    → null
 *
 * Pass an existing service-role client to avoid constructing a second one
 * (the public quote page + portal loader already hold one).
 */
export async function resolveOrgLogoSrc(
  org: { logo_path?: string | null; logo_url?: string | null } | null | undefined,
  admin?: AdminClient,
): Promise<string | null> {
  const source = pickLogoSource(org ?? {});
  if (source.kind === "none") return null;
  if (source.kind === "legacy") return source.url;

  const client = admin ?? createAdminClient();
  const { data, error } = await client.storage
    .from(LOGO_BUCKET)
    .createSignedUrl(source.path, LOGO_SIGNED_TTL);
  if (error) {
    console.error("[company-logo] signed url failed", error);
    return null;
  }
  return data?.signedUrl ?? null;
}
