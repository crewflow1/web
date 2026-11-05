/**
 * Canonical HTML-escaping for server-rendered email/document/notification HTML.
 *
 * Historically this five-replacement escaper was copy-pasted, byte-identical,
 * into every email template, the report-delivery cron, review actions, and the
 * material-request / leave mailers. One audited implementation removes that
 * drift and gives the escaper a single home + unit test.
 *
 * It escapes the five characters that are unsafe in BOTH element text and
 * double-quoted attribute values (`&`, `<`, `>`, `"`, `'`), so the same
 * function is safe wherever interpolated user/tenant text lands in our
 * hand-built HTML strings. `&` is replaced first so the entity ampersands the
 * later replacements introduce are not themselves re-escaped.
 *
 * This is NOT a sanitizer for untrusted *markup* — it is an escaper for text
 * that must appear verbatim. Never use it to allow-list tags.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
