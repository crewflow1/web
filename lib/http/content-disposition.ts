/**
 * Build a `Content-Disposition` header value from a filename that contains
 * DATA (a customer name, an imported invoice number, a staff member's name…).
 *
 * WHY THIS EXISTS. A response header value is a ByteString: the runtime's
 * `Headers` THROWS (`TypeError: Cannot convert argument to a ByteString`) on any
 * character above U+00FF, and rejects CR/LF outright. So interpolating raw data
 * into `filename="…"` is not a header-SPLITTING hole (the runtime refuses the
 * split) — it is a hard 500: the payslip for "Łukasz", or the PDF of an
 * imported invoice numbered "INV–001" (en dash), could not be downloaded at
 * all. A `"` in the value additionally lets the data terminate the quoted
 * parameter and append its own (`…"; filename="x.exe`).
 *
 * WHAT IT EMITS (RFC 6266 §4.3 / RFC 5987):
 *   <kind>; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>
 *
 *   • the quoted fallback is reduced to `[A-Za-z0-9._-]` (accents folded via
 *     NFKD first, so "José García" → "Jose_Garcia"), which cannot contain a
 *     quote, a separator, a control character or a non-Latin-1 code point;
 *   • `filename*` carries the real name for every modern browser, percent-
 *     encoded so it too is pure ASCII;
 *   • path separators and control characters never survive in either form.
 *
 * Pure. No I/O. Total — any input yields a valid header value.
 */
const MAX_FILENAME_LENGTH = 150;

function splitExtension(name: string): { stem: string; ext: string } {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})$/.exec(name);
  return m ? { stem: m[1] ?? "", ext: m[2] ?? "" } : { stem: name, ext: "" };
}

/** ASCII-only, quote-free, separator-free rendition of a filename. */
export function asciiFilename(raw: string, fallbackStem = "download"): string {
  const { stem, ext } = splitExtension(String(raw ?? ""));
  const cleaned = stem
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip combining marks left by NFKD (é → e)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, MAX_FILENAME_LENGTH);
  return `${cleaned || fallbackStem}${ext}`;
}

/** RFC 5987 `ext-value` encoding (attr-char set), always pure ASCII. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function contentDisposition(
  kind: "inline" | "attachment",
  filename: string,
  fallbackStem = "download",
): string {
  // The human-facing name: drop control characters + path separators, keep the
  // rest (Unicode included) for the filename* form.
  const display = String(filename ?? "")
    .replace(/\p{Cc}/gu, "")
    .replace(/[\\/]+/g, "-")
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  const ascii = asciiFilename(display, fallbackStem);
  const star = encodeRfc5987(display || ascii);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}
