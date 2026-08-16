/**
 * API scope registry — a BUILD-TIME fact (Train 9 substrate).
 *
 * Scopes are validated in the app layer against this registry, not in the
 * database: the set of scopes this build understands is a compile-time fact
 * the DB cannot see (the comms SENDER_IMPLEMENTED precedent). The migration
 * pins only shape (no NULL/blank entries); THIS module is the authority on
 * which scope strings exist.
 *
 * v1 defines a per-RESOURCE, per-VERB scope, one string per public-API
 * capability. The READS: `read:jobs`, `read:customers`, `read:invoices`,
 * `read:quotes`, `read:leads`. The WRITES: `write:customers`, `write:leads`,
 * `write:jobs`, `write:quotes`, `write:invoices` (create/update the
 * corresponding resource). Each names a capability the matching /api/v1
 * endpoint enforces via {@link hasScope}, so a key granted only `read:jobs`
 * cannot read invoices, and a key granted only `read:customers` cannot CREATE a
 * customer — least privilege is expressed in the grant, not just the route.
 * Read and write are DISTINCT capabilities: a key must hold `write:customers` to
 * POST/PATCH a customer even if it already holds `read:customers`. The whole
 * surface ships DARK behind FEATURE_PUBLIC_API_JOBS (lib/public-api/flag.ts);
 * these scopes are inert until that flag is flipped.
 *
 * `write:invoices` grants ONLY the create-from-accepted-quote path the app
 * itself uses (POST /api/v1/invoices generates a draft invoice from a quote the
 * key's org already accepted — totals/customer/line-items come from the quote,
 * never the request body); it does NOT open arbitrary invoice mutation, and
 * there is no invoice update or delete scope. A scope exists only where a route
 * enforces it.
 *
 * Adding a scope here is a reviewed code change: the drift-guard test in
 * __tests__/api-auth freezes this array with a deep-equal, so growth is a
 * deliberate diff line, never an accident. The DB stores scopes as opaque
 * text[] (shape-checked only — no value constraint), so this registry, not a
 * migration, is the single authority on which strings exist.
 *
 * Client-safe on purpose (no server-only, no imports): the settings form
 * renders scope checkboxes from this same registry, so the UI can never
 * offer a scope the resolver would not understand.
 */

export const SCOPES = [
  "read:jobs",
  "read:customers",
  "read:invoices",
  "read:quotes",
  "read:leads",
  "write:customers",
  "write:leads",
  "write:jobs",
  "write:quotes",
  "write:invoices",
] as const;

/** Compile-time union of every scope this build understands. */
export type Scope = (typeof SCOPES)[number];

/** Human labels for the settings UI, keyed by the registry (so a scope
 *  cannot be offered without being defined, nor defined without a label). */
export const SCOPE_LABELS: Readonly<Record<Scope, string>> = {
  "read:jobs": "Read jobs",
  "read:customers": "Read customers",
  "read:invoices": "Read invoices",
  "read:quotes": "Read quotes",
  "read:leads": "Read leads",
  "write:customers": "Create & update customers",
  "write:leads": "Create leads",
  "write:jobs": "Create & update jobs",
  "write:quotes": "Create quotes",
  "write:invoices": "Create invoices from accepted quotes",
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
