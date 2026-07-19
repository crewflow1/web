import { randomBytes } from "node:crypto";

/**
 * Asset QR identity — pure domain helpers (no `qrcode` dependency; that library
 * only renders the image in the label slice). Unit-tested directly.
 *
 * The token is a high-entropy opaque random encoding NO business data. A scan
 * validates the payload's shape, then resolves it through an authenticated,
 * tenant-scoped lookup — the token's value is the only thing the QR carries.
 */

/** 24 random bytes → a 32-char URL-safe (base64url) opaque token. */
export function generateOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}

// base64url charset; bounded length so a scan can cheaply reject junk before any
// DB lookup (enumeration/DoS resistance at the edge).
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidTokenFormat(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** A scanned identity resolves only while active (revoked ⇒ old label is dead). */
export function isResolvable(identity: { active: boolean } | null | undefined): boolean {
  return !!identity && identity.active === true;
}

/** The app path a QR encodes — an opaque token only, resolved behind auth. */
export function scanPath(token: string): string {
  return `/a/${token}`;
}

/**
 * A safe download filename for a QR label PDF — no path/header injection, always
 * `.pdf`, never leaks internal ids.
 */
export function safeLabelFilename(assetName: string | null, assetRef?: string | null): string {
  const base = (assetRef && assetRef.trim()) || (assetName && assetName.trim()) || "asset-label";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleaned || "asset-label"}-qr.pdf`;
}
