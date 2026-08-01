/**
 * API scope registry — a BUILD-TIME fact (Train 9 substrate).
 *
 * Scopes are validated in the app layer against this registry, not in the
 * database: the set of scopes this build understands is a compile-time fact
 * the DB cannot see (the comms SENDER_IMPLEMENTED precedent). The migration
 * pins only shape (no NULL/blank entries); THIS module is the authority on
 * which scope strings exist.
 *
 * v1 defines EXACTLY ONE scope. `read:jobs` names a capability the future
 * jobs read endpoint will enforce via {@link hasScope} — no such endpoint
 * exists yet (substrate only; the /api/v1/me probe requires no scope).
 * Adding a scope here is a reviewed code change: the drift-guard test in
 * __tests__/api-auth freezes this array with a deep-equal, so growth is a
 * deliberate diff line, never an accident.
 *
 * Client-safe on purpose (no server-only, no imports): the settings form
 * renders scope checkboxes from this same registry, so the UI can never
 * offer a scope the resolver would not understand.
 */

export const SCOPES = ["read:jobs"] as const;

/** Compile-time union of every scope this build understands. */
export type Scope = (typeof SCOPES)[number];

/** Human labels for the settings UI, keyed by the registry (so a scope
 *  cannot be offered without being defined, nor defined without a label). */
export const SCOPE_LABELS: Readonly<Record<Scope, string>> = {
  "read:jobs": "Read jobs",
};

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/**
 * Validate a set of requested scope strings against the registry.
 * Deduplicates; preserves registry order; refuses the empty set (a key with
 * no scopes can do nothing and is a creation mistake, not a credential).
 */
export function validateScopes(
  requested: readonly string[],
): { ok: true; scopes: Scope[] } | { ok: false; invalid: string[] } {
  const invalid = [...new Set(requested.filter((s) => !isScope(s)))];
  if (invalid.length > 0) return { ok: false, invalid };
  const wanted = new Set(requested);
  const scopes = SCOPES.filter((s) => wanted.has(s));
  if (scopes.length === 0) return { ok: false, invalid: [] };
  return { ok: true, scopes };
}

/**
 * Does a key's granted scope list include `required`?
 *
 * `required` is the compile-time union, so an endpoint can only ever demand
 * a scope this build defines. `granted` is whatever the DB row holds —
 * unknown strings in it (e.g. a scope retired from the registry) simply
 * never match, so a stale grant degrades to "no access", never to a bypass.
 */
export function hasScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required);
}
