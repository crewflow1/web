/**
 * The ONE guard for turning a stored notification `action_url` into a link.
 *
 * A notification's deep link is DATA (a row column), and every surface that
 * renders it — the bell, the notifications centre, the HQ console, the digest
 * email, the single-notification email — must treat it as untrusted: it is
 * either a same-origin RELATIVE path or it is not a link at all. Server writers
 * only ever emit relative in-app paths (`/jobs/<id>`, `/admin/alerts`, …), so
 * anything else is by definition a poisoned value.
 *
 * Why not "just prefix the origin": `https://crewflow.uk` + `@evil.example/x`
 * is `https://crewflow.uk@evil.example/x` — a link to evil.example whose
 * userinfo merely LOOKS like us; `.evil.example/x` and `//evil.example/x` are
 * the same trick. So the value must start with exactly one `/`.
 *
 * Rejected (returns null → render the title as plain text / omit the link):
 *   • anything not starting with `/` — absolute URLs, `javascript:`, `data:`,
 *     `@host`, `.host`, bare words;
 *   • `//host` and `/\host` — protocol-relative forms browsers resolve off-origin;
 *   • any backslash, whitespace or control character anywhere — browsers strip
 *     tabs/newlines and normalise `\` → `/` while parsing, which is how a
 *     filter-evading scheme or host is smuggled.
 *
 * Mirrors the inline same-origin guard already used for push
 * (lib/notifications/types.ts → buildPushPayload) and SMS
 * (lib/notifications/sms.ts → buildSmsText). Pure — safe in client components.
 */
export function safeActionPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (path.length === 0) return null;
  if (!path.startsWith("/")) return null;
  if (path.startsWith("//")) return null;
  if (path.includes("\\")) return null;
  if (/\s/.test(path) || /\p{Cc}/u.test(path)) return null;
  return path;
}
