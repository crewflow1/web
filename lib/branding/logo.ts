/**
 * Company-logo pure helpers — no I/O, no Supabase, no `server-only`, so the
 * full validation matrix is unit-testable in isolation. The server service
 * (server/services/company-logo.ts) layers storage + DB + audit on top.
 *
 * Security posture this encodes:
 *   - Only PNG / JPEG / WebP, validated on BOTH the declared MIME type AND the
 *     filename extension (a `.png` file claiming image/png, not a `.exe`).
 *   - A hard byte cap (2 MB) so an admin can't upload a 50 MB "logo".
 *   - Tenant-scoped object paths: every key begins with `<org_id>/`, so an
 *     object is always attributable to exactly one org.
 *   - Write gating to owner/admin roles (staff can't change branding). This
 *     app-code gate is authoritative: the bucket has NO authenticated
 *     storage.objects policies at all (service-role-only byte access, per the
 *     20261032 storage-mutation lockdown).
 *   - Source selection that NEVER surfaces a non-http(s) legacy value, so a
 *     malformed/`javascript:` logo_url left in old data can't render.
 */

/** Storage bucket id (created in 20261041000000_company_logo_storage.sql). */
export const LOGO_BUCKET = "company-logos";

/** Accepted upload formats. WebP included for modern, small logos. */
export const LOGO_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** `accept` attribute for the file input — mirrors LOGO_ALLOWED_MIME. */
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/** Hard size cap. Matches the bucket's file_size_limit (2 MB). */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Signed-URL lifetime (seconds) for server-side rendered display. */
export const LOGO_SIGNED_TTL = 60 * 60;

/** Roles permitted to upload / replace / delete the company logo. */
export const LOGO_ADMIN_ROLES = new Set(["owner", "admin"]);

export function isLogoAdminRole(role: string | null | undefined): boolean {
  return typeof role === "string" && LOGO_ADMIN_ROLES.has(role);
}

/** Canonical storage extension for an accepted MIME type (null if rejected). */
export function logoExtForMime(mime: string): "png" | "jpg" | "webp" | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/** Lower-cased file extension (without the dot), or "" if none. */
export function fileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/** Does the filename's extension agree with the declared (accepted) MIME? */
export function extMatchesMime(filename: string, mime: string): boolean {
  const ext = fileExt(filename);
  switch (mime) {
    case "image/png":
      return ext === "png";
    case "image/jpeg":
      return ext === "jpg" || ext === "jpeg";
    case "image/webp":
      return ext === "webp";
    default:
      return false;
  }
}

export type LogoValidationError =
  | "empty_file"
  | "file_too_large"
  | "bad_file_type"
  | "ext_mismatch";

export type LogoValidation =
  | { ok: true; ext: "png" | "jpg" | "webp" }
  | { ok: false; error: LogoValidationError };

/**
 * Validate an upload before it touches storage. Checks run in a deliberate
 * order so the returned reason is the most useful one: empty → too-large →
 * bad-mime → extension-mismatch.
 */
export function validateLogoUpload(input: {
  filename: string;
  mimeType: string;
  byteLength: number;
}): LogoValidation {
  if (!Number.isFinite(input.byteLength) || input.byteLength <= 0) {
    return { ok: false, error: "empty_file" };
  }
  if (input.byteLength > LOGO_MAX_BYTES) {
    return { ok: false, error: "file_too_large" };
  }
  if (!LOGO_ALLOWED_MIME.has(input.mimeType)) {
    return { ok: false, error: "bad_file_type" };
  }
  if (!extMatchesMime(input.filename, input.mimeType)) {
    return { ok: false, error: "ext_mismatch" };
  }
  const ext = logoExtForMime(input.mimeType);
  // ext is non-null here (mime is in the allowlist), but narrow defensively.
  if (!ext) return { ok: false, error: "bad_file_type" };
  return { ok: true, ext };
}

/**
 * Tenant-scoped storage object key. The leading `<org_id>/` segment is the
 * tenancy attribution for the object (and the prefix any future policy or
 * audit would key off), so it must always be the org id and nothing else.
 */
export function logoObjectPath(orgId: string, ext: string): string {
  return `${orgId}/logo-${crypto.randomUUID()}.${ext}`;
}

export type LogoSource =
  | { kind: "path"; path: string }
  | { kind: "legacy"; url: string }
  | { kind: "none" };

/**
 * Decide which stored value to display, preferring an uploaded object over a
 * legacy external URL. A legacy logo_url is only honoured when it is an
 * http(s) URL — anything else (empty, malformed, `javascript:`…) is treated
 * as "no logo" so old/garbage data can't render.
 */
export function pickLogoSource(org: {
  logo_path?: string | null;
  logo_url?: string | null;
}): LogoSource {
  const path = typeof org.logo_path === "string" ? org.logo_path.trim() : "";
  if (path.length > 0) return { kind: "path", path };

  const url = typeof org.logo_url === "string" ? org.logo_url.trim() : "";
  if (/^https?:\/\//i.test(url)) return { kind: "legacy", url };

  return { kind: "none" };
}
