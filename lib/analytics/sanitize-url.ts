/**
 * Analytics URL sanitisation — keep resource UUIDs out of captured URLs.
 *
 * PostHog's `capture_pageview` records `$current_url` / `$pathname` / `$referrer`
 * verbatim. CrewFlow routes embed raw resource UUIDs (`/jobs/<uuid>`,
 * `/customers/<uuid>`, `?org=<uuid>`), so a pageview would ship those ids to a
 * third party even though `sanitizeEventProperties` (which only covers
 * `trackEvent` props) never sees them. This masks every UUID in a URL to `:id`,
 * preserving the route shape for analytics while removing the identifier.
 *
 * Pure, deterministic, isomorphic (no `server-only`, no deps) so the browser
 * loader can pass it to `posthog.init({ sanitize_properties })` and it stays
 * unit-testable in isolation.
 */

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Replace every UUID in a string (path or query) with the literal `:id`. */
export function maskUuidsInUrl(value: string): string {
  return value.replace(UUID_RE, ":id");
}

/** The PostHog property keys that carry a URL and must be masked. */
const URL_PROPERTY_KEYS: readonly string[] = [
  "$current_url",
  "$pathname",
  "$referrer",
  "$initial_current_url",
  "$initial_pathname",
  "$initial_referrer",
];

/**
 * `sanitize_properties` hook for `posthog.init`: mask UUIDs in every URL-bearing
 * property, leaving all other properties untouched. Never throws — analytics
 * must never break a page — and returns the same object (mutated in place), as
 * PostHog expects.
 */
export function sanitizeAnalyticsProperties<T extends Record<string, unknown>>(
  properties: T,
): T {
  try {
    for (const key of URL_PROPERTY_KEYS) {
      const v = properties[key];
      if (typeof v === "string") (properties as Record<string, unknown>)[key] = maskUuidsInUrl(v);
    }
  } catch {
    // never let sanitisation break capture
  }
  return properties;
}
