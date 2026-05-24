/**
 * Customer portal token helper.
 *
 * Single source of truth for "what does a portal token look like".
 * Used by the rotate-token server action; available to any future
 * code path that needs to mint a token explicitly.
 *
 * Tokens are RFC 4122 v4 UUIDs (`crypto.randomUUID()`):
 *   - 122 bits of entropy → unguessable
 *   - URL-safe (only hex + dashes)
 *   - Server-generated only — never accept a customer-supplied token
 *
 * For most INSERTs the SQL `default gen_random_uuid()` (added in
 * migration 20260622) already mints a token at the database level,
 * so callers DO NOT need to set `portal_token` explicitly. Use this
 * helper when you need the token value before the INSERT round-trip
 * (e.g. to return it from a server action).
 */
export function generateCustomerPortalToken(): string {
  return crypto.randomUUID();
}

/** Tight UUID-v4 shape check. Matches the existing loader regex in
 *  `app/customer-portal/_helpers.ts` so the two stay aligned. */
export function isValidPortalTokenShape(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
