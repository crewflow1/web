/**
 * FEATURE 2 — the upload constraints, shared by the client button (its `accept`
 * attribute + a pre-flight size check) and the server action (defence-in-depth),
 * which both must agree with the `form-imports` bucket limits
 * (migration 20261264000000). Pure constants — no server-only, no I/O.
 */

/** 15 MB — must equal the bucket's file_size_limit. */
export const AUTOFILL_MAX_BYTES = 15 * 1024 * 1024;

/**
 * The MIME types the vision extractor can read as a document. Exactly the
 * bucket's allowed_mime_types. Office formats are deliberately absent — the
 * vision door takes PDF/image blocks only (see docs/imports/DOCUMENT-AUTOFILL.md
 * for the Phase-2 office-doc follow-up).
 */
export const AUTOFILL_ALLOWED_MIME: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

/** The `accept` attribute for the file picker. Extensions + MIME, so a camera
 *  capture (which may report no MIME) and a desktop pick both pass. */
export const AUTOFILL_ACCEPT = [
  ...AUTOFILL_ALLOWED_MIME,
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
].join(",");

export function isAllowedAutofillMime(mime: string): boolean {
  return AUTOFILL_ALLOWED_MIME.includes(mime);
}

/** File extension for a known MIME, for a stable storage object name. */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case "application/pdf":
      return "pdf";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "bin";
  }
}
