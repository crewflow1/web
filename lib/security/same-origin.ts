/**
 * Same-origin check for state-changing browser requests to route handlers.
 *
 * Server actions get Next's built-in Origin check; plain route handlers do not.
 * A browser always sends `Origin` on a POST, and modern browsers add
 * `Sec-Fetch-Site`. A request is accepted only when `Origin` matches the
 * request's own origin (or the configured app origin) and `Sec-Fetch-Site`,
 * when present, is `same-origin`. A missing `Origin` fails closed: this guard is
 * for browser-initiated mutations only, never for server-to-server callers.
 */
export function isSameOriginRequest(request: Request, appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    /* relative URL — rely on the configured origin */
  }
  if (appUrl) {
    try {
      allowed.add(new URL(appUrl).origin);
    } catch {
      /* malformed config — ignore */
    }
  }
  return allowed.has(origin);
}
