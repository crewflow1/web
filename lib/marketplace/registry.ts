import { SCOPES, validateScopes, type Scope } from "@/lib/api-auth/scopes";

/**
 * Marketplace / partner-platform BUILD-TIME vocabulary + pure trust logic
 * (Phase 14).
 *
 * Client-safe on purpose (no `server-only`, no Node builtins, no Supabase):
 * the developer + discovery forms render category / scope pickers from this
 * module, the server actions validate against it, the SQL migrations mirror
 * its enums as CHECK constraints, and the hermetic tests prove the consent +
 * lifecycle contracts here without a database. One authority, three consumers
 * (form, action, migration), pinned against drift by __tests__/marketplace.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPES ARE NOT REDEFINED HERE.
 * ─────────────────────────────────────────────────────────────────────────────
 * A listing requests, and a tenant consents to, scopes drawn from the EXISTING
 * public-API scope vocabulary (lib/api-auth/scopes.ts). The marketplace adds NO
 * new scope string — an installed app is exactly a scoped API key on the same
 * /api/v1 surface, so its permissions are the same least-privilege grants the
 * key registry already understands. This is the integration point, not a
 * parallel permission model.
 */

// ── Categories (listing taxonomy) ────────────────────────────────────────────
export const LISTING_CATEGORIES = [
  "accounting",
  "crm",
  "field_service",
  "scheduling",
  "communications",
  "analytics",
  "productivity",
  "other",
] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<ListingCategory, string>> = {
  accounting: "Accounting & finance",
  crm: "CRM & sales",
  field_service: "Field service",
  scheduling: "Scheduling & calendars",
  communications: "Communications",
  analytics: "Analytics & reporting",
  productivity: "Productivity",
  other: "Other",
};

export function isListingCategory(value: string): value is ListingCategory {
  return (LISTING_CATEGORIES as readonly string[]).includes(value);
}

// ── Lifecycle vocabularies (mirror the migration CHECKs) ──────────────────────
/**
 * Listing review lifecycle. A listing is DISCOVERABLE + INSTALLABLE only when
 * `approved`. `draft` ↔ `pending_review` are the developer's own transitions;
 * reaching `approved` / `rejected` / `suspended` is a REVIEW decision made by a
 * platform reviewer through the service-role review RPC — a tenant can never
 * self-approve (proven in the migration-contract + trust-boundary tests).
 */
export const LISTING_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "suspended",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** The review outcomes a platform reviewer may set (service-role RPC only). */
export const REVIEW_DECISIONS = ["approved", "rejected", "suspended"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const PARTNER_STATUSES = ["active", "suspended"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/**
 * Install lifecycle. Born `active` (install is atomic with consent — there is
 * no half-installed state), `suspended` if the tenant pauses it, `uninstalled`
 * once revoked (terminal — the bound key is dead and entitlements are revoked).
 */
export const INSTALL_STATUSES = ["active", "suspended", "uninstalled"] as const;
export type InstallStatus = (typeof INSTALL_STATUSES)[number];

export const ENTITLEMENT_STATUSES = ["active", "revoked"] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

// ── Slug ─────────────────────────────────────────────────────────────────────
/** URL-safe listing/partner slug: lowercase, digits, single hyphens. */
export const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isValidSlug(value: string): boolean {
  return value.length >= 3 && value.length <= 63 && SLUG_RX.test(value);
}

// ── Discoverability + installability (the approval gate) ─────────────────────
/** A listing is discoverable in the tenant catalogue only once approved. */
export function isListingDiscoverable(status: string): boolean {
  return status === "approved";
}
/** A listing is installable only once approved — the review gate for installs. */
export function isListingInstallable(status: string): boolean {
  return status === "approved";
}
/** A developer may submit for review only from `draft`. */
export function canSubmitForReview(from: string): boolean {
  return from === "draft";
}

// ── Requested-scope validation (reuse the public-API vocabulary) ─────────────
/**
 * Validate a listing's REQUESTED scopes. They must be a non-empty subset of the
 * public-API SCOPES registry — the marketplace never invents scope strings.
 * Deduplicated, registry-ordered (delegated to validateScopes).
 */
export function validateRequestedScopes(
  requested: readonly string[],
): { ok: true; scopes: Scope[] } | { ok: false; invalid: string[] } {
  return validateScopes(requested);
}

/** Normalise a scope set: unique + registry order. Non-scopes are dropped. */
export function normaliseScopes(scopes: readonly string[]): Scope[] {
  const wanted = new Set(scopes);
  return SCOPES.filter((s) => wanted.has(s));
}

/** Order-insensitive, dedup-aware set equality over scope strings. */
export function sameScopeSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const s of sa) if (!sb.has(s)) return false;
  return true;
}

// ── The consent contract ─────────────────────────────────────────────────────
export type ConsentResult =
  | { ok: true; scopes: Scope[] }
  | { ok: false; reason: "not_installable" | "scope_mismatch" | "invalid_scopes" };

/**
 * THE INSTALL-CONSENT CONTRACT.
 *
 * A tenant installs a listing by CONSENTING to the EXACT set of scopes the
 * listing requests — no more (privilege escalation), no less (a partial grant
 * that would leave the app half-working while the tenant believes it consented
 * to the whole). This function is the single authority the install action and
 * the service-role install RPC both enforce (defence in depth):
 *
 *   1. the listing must be installable (approved) — the review gate;
 *   2. the listing's requested scopes must be a valid subset of SCOPES;
 *   3. the tenant's consented set must EQUAL the requested set (order/dup-insensitive).
 *
 * Returns the normalised (registry-ordered, deduped) scope list to grant, so
 * the bound key + entitlement rows are minted from a canonical set, never from
 * attacker-orderable client input.
 */
export function validateInstallConsent(
  listingStatus: string,
  requestedScopes: readonly string[],
  consentedScopes: readonly string[],
): ConsentResult {
  if (!isListingInstallable(listingStatus)) {
    return { ok: false, reason: "not_installable" };
  }
  const requested = validateRequestedScopes(requestedScopes);
  if (!requested.ok) return { ok: false, reason: "invalid_scopes" };

  if (!sameScopeSet(requestedScopes, consentedScopes)) {
    return { ok: false, reason: "scope_mismatch" };
  }
  return { ok: true, scopes: requested.scopes };
}
