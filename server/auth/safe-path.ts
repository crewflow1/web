/**
 * Post-auth redirect safety — the single source of truth for validating an
 * untrusted `next` as a LOCAL, same-origin path.
 *
 * Shared by app/(auth)/actions.ts (safeLanding) and
 * app/(auth)/login/mfa/page.tsx so both gates apply identical rules.
 *
 * A path is accepted ONLY when it starts with a single "/" whose second
 * character is neither "/" nor "\". This rejects:
 *   - protocol-relative targets:  "//evil.com"
 *   - backslash targets:          "/\evil.com", "/\\evil.com"
 *
 * The backslash case matters because the client navigates with
 * `window.location.assign(next)`, and the browser normalises
 * `new URL("/\evil.com", origin)` to "https://evil.com/" — so a naive
 * `startsWith("/") && !startsWith("//")` check is an open-redirect / phishing
 * primitive. Returns the path when safe, otherwise null (caller picks a
 * default landing).
 */
export function safeInternalPath(next: string | undefined | null): string | null {
  return next && /^\/(?![/\\])/.test(next) ? next : null;
}
