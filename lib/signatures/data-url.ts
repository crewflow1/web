/**
 * Drawn e-signature — pure, deterministic helpers for the canvas → PNG
 * data-URL → storage pipeline. No DB / IO here so the trust-boundary rules
 * (what counts as a valid signature image, how the storage key is shaped) are
 * unit-testable in isolation and shared by every write path (quotes + H&S).
 */

export const SIGNATURE_BUCKET = "signatures";

/** Hard cap on the decoded PNG (matches the bucket's file_size_limit). A canvas
 *  signature is a few KB to low hundreds; anything larger is not a signature. */
export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** The 8-byte PNG magic number. The declared data-URL MIME is untrusted — we
 *  verify the real bytes so only a genuine PNG is ever stored. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type ParsedSignature =
  | { ok: true; bytes: Uint8Array; byteLength: number }
  | { ok: false; error: string };

/**
 * Parse + validate a `data:image/png;base64,....` URL produced by
 * HTMLCanvasElement.toDataURL("image/png"). Returns the decoded bytes on
 * success. Rejects: wrong scheme/MIME, non-base64, empty, oversized, or bytes
 * whose magic number isn't PNG. Never throws — always returns a result.
 */
export function parseSignatureDataUrl(input: unknown): ParsedSignature {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "No signature image provided" };
  }
  // Strict prefix: PNG + base64 only. (No SVG/data-less/other MIME.)
  const prefix = "data:image/png;base64,";
  if (!input.startsWith(prefix)) {
    return { ok: false, error: "Signature must be a PNG image" };
  }
  const b64 = input.slice(prefix.length).trim();
  if (b64.length === 0) return { ok: false, error: "Signature image is empty" };
  // Base64 alphabet only — reject anything that isn't a clean base64 payload.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, error: "Signature image is malformed" };
  }
  // Cheap size gate on the encoded form BEFORE decoding, so a huge payload
  // can't force a large allocation. base64 is ~4/3 of the raw size.
  if (b64.length > Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 4) {
    return { ok: false, error: "Signature image is too large" };
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return { ok: false, error: "Signature image is malformed" };
  }
  if (bytes.byteLength === 0) return { ok: false, error: "Signature image is empty" };
  if (bytes.byteLength > MAX_SIGNATURE_BYTES) {
    return { ok: false, error: "Signature image is too large" };
  }
  if (bytes.byteLength < PNG_MAGIC.length || !PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    return { ok: false, error: "Signature image is not a valid PNG" };
  }
  return { ok: true, bytes, byteLength: bytes.byteLength };
}

/** Is this a non-empty string that at least claims to be a PNG data URL? Used
 *  by schemas to treat a blank/absent field as "no drawn signature" (optional)
 *  rather than an error. */
export function looksLikeSignatureDataUrl(input: unknown): input is string {
  return typeof input === "string" && input.startsWith("data:image/png;base64,");
}

export type SignatureScope = "quotes" | "safety_acknowledgements";

/**
 * Build the org-first, server-controlled storage key. No user input reaches the
 * key (org_id, scope, subjectId are server-derived; sigId is a random UUID), so
 * a caller can never traverse out of its org prefix. Shape:
 *   `${orgId}/${scope}/${subjectId}/${sigId}.png`
 */
export function signatureStorageKey(
  orgId: string,
  scope: SignatureScope,
  subjectId: string,
  sigId: string,
): string {
  return `${orgId}/${scope}/${subjectId}/${sigId}.png`;
}
