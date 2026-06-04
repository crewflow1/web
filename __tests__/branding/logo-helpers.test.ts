import { describe, it, expect } from "vitest";
import {
  LOGO_BUCKET,
  LOGO_ACCEPT,
  LOGO_ALLOWED_MIME,
  LOGO_MAX_BYTES,
  isLogoAdminRole,
  logoExtForMime,
  fileExt,
  extMatchesMime,
  validateLogoUpload,
  logoObjectPath,
  pickLogoSource,
} from "@/lib/branding/logo";

/**
 * Pure-helper matrix for the company-logo feature. No I/O, so this exercises
 * the full security posture directly: format allow-list (MIME + extension),
 * the hard size cap, owner/admin write-gating, tenant-scoped object paths, and
 * the "never render a non-http(s) legacy URL" source selection.
 */

const ORG = "11111111-1111-1111-1111-111111111111";

describe("logo constants", () => {
  it("targets a single private bucket and the three accepted formats", () => {
    expect(LOGO_BUCKET).toBe("company-logos");
    expect([...LOGO_ALLOWED_MIME].sort()).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    // The input `accept` attr must mirror the server-side allow-list exactly.
    expect(LOGO_ACCEPT).toBe("image/png,image/jpeg,image/webp");
    expect(LOGO_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("isLogoAdminRole — only owners/admins may change branding", () => {
  it("allows owner and admin", () => {
    expect(isLogoAdminRole("owner")).toBe(true);
    expect(isLogoAdminRole("admin")).toBe(true);
  });
  it("blocks staff, member, and any falsy/unknown role", () => {
    for (const r of ["staff", "member", "viewer", "", "OWNER", "Admin"]) {
      expect(isLogoAdminRole(r)).toBe(false);
    }
    expect(isLogoAdminRole(null)).toBe(false);
    expect(isLogoAdminRole(undefined)).toBe(false);
  });
});

describe("logoExtForMime / fileExt / extMatchesMime", () => {
  it("maps accepted MIME types to a canonical extension", () => {
    expect(logoExtForMime("image/png")).toBe("png");
    expect(logoExtForMime("image/jpeg")).toBe("jpg");
    expect(logoExtForMime("image/webp")).toBe("webp");
    expect(logoExtForMime("image/gif")).toBeNull();
    expect(logoExtForMime("application/pdf")).toBeNull();
  });

  it("extracts a lower-cased extension, or '' when none", () => {
    expect(fileExt("logo.PNG")).toBe("png");
    expect(fileExt("a.b.JPEG")).toBe("jpeg");
    expect(fileExt("noext")).toBe("");
    expect(fileExt("trailingdot.")).toBe("");
  });

  it("accepts jpg AND jpeg for image/jpeg; rejects cross-format names", () => {
    expect(extMatchesMime("a.png", "image/png")).toBe(true);
    expect(extMatchesMime("a.jpg", "image/jpeg")).toBe(true);
    expect(extMatchesMime("a.jpeg", "image/jpeg")).toBe(true);
    expect(extMatchesMime("a.webp", "image/webp")).toBe(true);
    expect(extMatchesMime("a.png", "image/jpeg")).toBe(false);
    expect(extMatchesMime("a.exe", "image/png")).toBe(false);
    expect(extMatchesMime("a.png", "image/gif")).toBe(false);
  });
});

describe("validateLogoUpload — accepts valid PNG/JPG/JPEG/WebP", () => {
  it("returns the canonical ext for each accepted format", () => {
    expect(validateLogoUpload({ filename: "logo.png", mimeType: "image/png", byteLength: 1024 })).toEqual({ ok: true, ext: "png" });
    expect(validateLogoUpload({ filename: "logo.jpg", mimeType: "image/jpeg", byteLength: 1024 })).toEqual({ ok: true, ext: "jpg" });
    expect(validateLogoUpload({ filename: "logo.jpeg", mimeType: "image/jpeg", byteLength: 1024 })).toEqual({ ok: true, ext: "jpg" });
    expect(validateLogoUpload({ filename: "logo.webp", mimeType: "image/webp", byteLength: 1024 })).toEqual({ ok: true, ext: "webp" });
  });
  it("accepts a file exactly at the 2 MB cap", () => {
    expect(validateLogoUpload({ filename: "logo.png", mimeType: "image/png", byteLength: LOGO_MAX_BYTES })).toEqual({ ok: true, ext: "png" });
  });
});

describe("validateLogoUpload — rejects unsafe uploads", () => {
  it("rejects a disallowed MIME type (e.g. SVG / GIF / PDF)", () => {
    expect(validateLogoUpload({ filename: "logo.svg", mimeType: "image/svg+xml", byteLength: 1024 })).toEqual({ ok: false, error: "bad_file_type" });
    expect(validateLogoUpload({ filename: "logo.gif", mimeType: "image/gif", byteLength: 1024 })).toEqual({ ok: false, error: "bad_file_type" });
    expect(validateLogoUpload({ filename: "x.pdf", mimeType: "application/pdf", byteLength: 1024 })).toEqual({ ok: false, error: "bad_file_type" });
  });

  it("rejects an oversized file (> 2 MB)", () => {
    expect(validateLogoUpload({ filename: "logo.png", mimeType: "image/png", byteLength: LOGO_MAX_BYTES + 1 })).toEqual({ ok: false, error: "file_too_large" });
  });

  it("rejects an empty / zero / non-finite byte length", () => {
    expect(validateLogoUpload({ filename: "logo.png", mimeType: "image/png", byteLength: 0 })).toEqual({ ok: false, error: "empty_file" });
    expect(validateLogoUpload({ filename: "logo.png", mimeType: "image/png", byteLength: -5 })).toEqual({ ok: false, error: "empty_file" });
    expect(validateLogoUpload({ filename: "logo.png", mimeType: "image/png", byteLength: Number.NaN })).toEqual({ ok: false, error: "empty_file" });
  });

  it("rejects an extension that disagrees with a valid MIME (smuggled type)", () => {
    // image/png bytes but a .jpg name, or a renamed .exe declaring image/png.
    expect(validateLogoUpload({ filename: "logo.jpg", mimeType: "image/png", byteLength: 1024 })).toEqual({ ok: false, error: "ext_mismatch" });
    expect(validateLogoUpload({ filename: "payload.exe", mimeType: "image/png", byteLength: 1024 })).toEqual({ ok: false, error: "ext_mismatch" });
  });

  it("applies checks in priority order: empty → too_large → bad_mime → ext_mismatch", () => {
    // empty beats everything (even a bad mime + oversized)
    expect(validateLogoUpload({ filename: "x.exe", mimeType: "application/x-msdownload", byteLength: 0 }).ok).toBe(false);
    expect(validateLogoUpload({ filename: "x.exe", mimeType: "application/x-msdownload", byteLength: 0 })).toEqual({ ok: false, error: "empty_file" });
    // too_large beats bad mime
    expect(validateLogoUpload({ filename: "x.exe", mimeType: "application/x-msdownload", byteLength: LOGO_MAX_BYTES + 1 })).toEqual({ ok: false, error: "file_too_large" });
    // bad mime beats ext mismatch (mime checked before ext)
    expect(validateLogoUpload({ filename: "logo.png", mimeType: "image/gif", byteLength: 1024 })).toEqual({ ok: false, error: "bad_file_type" });
  });
});

describe("logoObjectPath — tenant-scoped keys", () => {
  it("always begins with `<org_id>/` and carries the given extension", () => {
    const p = logoObjectPath(ORG, "png");
    expect(p.startsWith(`${ORG}/`)).toBe(true);
    expect(p.split("/")[0]).toBe(ORG); // first segment IS the org id (RLS key)
    expect(p.endsWith(".png")).toBe(true);
    expect(p).toMatch(/^.+\/logo-[0-9a-f-]+\.png$/i);
  });
  it("produces a unique key per call (no collisions on rapid replace)", () => {
    const a = logoObjectPath(ORG, "webp");
    const b = logoObjectPath(ORG, "webp");
    expect(a).not.toBe(b);
  });
});

describe("pickLogoSource — prefer uploaded object, never render unsafe legacy URLs", () => {
  it("prefers logo_path over a legacy logo_url", () => {
    expect(
      pickLogoSource({ logo_path: `${ORG}/logo-x.png`, logo_url: "https://cdn.example/logo.png" }),
    ).toEqual({ kind: "path", path: `${ORG}/logo-x.png` });
  });
  it("falls back to an http(s) legacy URL when there is no path", () => {
    expect(pickLogoSource({ logo_url: "https://cdn.example/logo.png" })).toEqual({ kind: "legacy", url: "https://cdn.example/logo.png" });
    expect(pickLogoSource({ logo_url: "http://cdn.example/logo.png" })).toEqual({ kind: "legacy", url: "http://cdn.example/logo.png" });
  });
  it("treats a non-http(s) / malformed legacy URL as no logo", () => {
    expect(pickLogoSource({ logo_url: "javascript:alert(1)" })).toEqual({ kind: "none" });
    expect(pickLogoSource({ logo_url: "data:image/png;base64,AAAA" })).toEqual({ kind: "none" });
    expect(pickLogoSource({ logo_url: "/relative/path.png" })).toEqual({ kind: "none" });
    expect(pickLogoSource({ logo_url: "ftp://host/logo.png" })).toEqual({ kind: "none" });
    expect(pickLogoSource({ logo_url: "   " })).toEqual({ kind: "none" });
  });
  it("returns none for empty / null / undefined inputs", () => {
    expect(pickLogoSource({})).toEqual({ kind: "none" });
    expect(pickLogoSource({ logo_path: null, logo_url: null })).toEqual({ kind: "none" });
    expect(pickLogoSource({ logo_path: "", logo_url: "" })).toEqual({ kind: "none" });
  });
});
