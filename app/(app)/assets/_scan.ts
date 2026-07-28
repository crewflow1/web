import "server-only";
import { createClient } from "@/lib/supabase/server";
import { resolveScannedAssetForOrg, type ScannedAsset } from "@/lib/assets/scan";

/**
 * Resolve a scanned QR token to the minimum authorised asset view.
 *
 * Thin request-scoped wrapper: it builds the tenant (user-JWT) client and hands
 * off to the `lib/assets/scan.ts` chokepoint, which carries the actual
 * predicates. The chokepoint takes its client and org as arguments so the
 * integration suite can drive it with a real multi-org user's JWT — see
 * `__tests__/integration/rls/asset-qr-active-org.test.ts`.
 *
 * Security: the caller has ALREADY authenticated (the /a/[token] page is under
 * the (app) auth group). RLS scopes the identity and the asset to the orgs the
 * scanner BELONGS TO — the outer boundary — and `orgId` (the caller's ACTIVE
 * org, from `requireOrgContext()`) scopes them to the one they are working in.
 * The active-org predicate is required, not belt-and-braces: `current_org_ids()`
 * returns every membership, so RLS alone lets a dual-org user scanning org B's
 * label render B's asset inside A's shell.
 *
 * Every failure — malformed / unknown / revoked / cross-tenant / non-active-org
 * — returns the SAME `null` (the page renders an identical not-found),
 * disclosing nothing and giving no enumeration signal.
 */

export type { ScannedAsset };

export async function resolveScannedAsset(
  token: string,
  orgId: string,
): Promise<ScannedAsset | null> {
  const supabase = await createClient();
  return resolveScannedAssetForOrg(supabase, token, orgId);
}
