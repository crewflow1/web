import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { isValidTokenFormat } from "@/lib/assets/qr";

/**
 * Active-org-scoped resolution of a scanned QR token → asset.
 *
 * This is the QR-flow sibling of `lib/jobs/load.ts` and exists for the same
 * reason. The RLS helper `current_org_ids()` is deliberately permissive: it
 * returns EVERY org the viewer belongs to, because RLS enforces the OUTER
 * boundary ("you cannot see an org you are not a member of"), not the inner
 * one. So RLS is NOT scoping.
 *
 * A resolver that did
 *
 *     .from("asset_qr_identities").select("asset_id").eq("token", t).eq("active", true)
 *     .from("assets").select(...).eq("id", identity.asset_id)
 *
 * resolves a token belonging to a DIFFERENT org the viewer also happens to be a
 * member of. The scanned asset then renders inside the ACTIVE org's shell and
 * hands off to `/assets/<id>` — custody actions (check out / return / transfer)
 * are then taken against another org's asset under the active org's assumptions.
 *
 * That is a correctness / data-integrity defect rather than a cross-tenant
 * breach (the viewer is a legitimate member of both orgs), and it matches how
 * the app treats a non-active org EVERYWHERE else: wrong org = not found.
 *
 * Both predicates are pinned to the active org:
 *   - the IDENTITY, so a foreign token never yields an asset_id at all; and
 *   - the ASSET, so a mis-provisioned identity row can't dereference across orgs
 *     (defence in depth behind the DB's `tg_asset_qr_same_org` trigger).
 *
 * Every failure mode — malformed / unknown / revoked / cross-tenant /
 * non-active-org — returns the SAME `null`, so the caller's `notFound()` is
 * indistinguishable between them and the flow gives no enumeration signal.
 *
 * Takes the Supabase client as an argument (rather than building one from
 * cookies) so the integration suite can drive it with a real multi-org user's
 * JWT — the same contract as `loadJobForOrg`.
 */

export type ScannedAsset = {
  id: string;
  name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  registration: string | null;
  ownership: string;
  status: string;
};

const ASSET_COLUMNS =
  "id, name, category, manufacturer, model, serial_number, registration, ownership, status";

/**
 * Minimal PostgREST surface used here. The asset tables are not in the
 * generated `Database` types yet, so the client is accessed through this shape
 * — the same cast style already used across the assets domain.
 */
type LooseClient = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: unknown,
      ): {
        eq(
          column: string,
          value: unknown,
        ): {
          eq(
            column: string,
            value: unknown,
          ): { maybeSingle(): Promise<{ data: unknown }> };
          maybeSingle(): Promise<{ data: unknown }>;
        };
      };
    };
  };
};

/**
 * Resolve a scanned token to the minimum asset view, constrained to `orgId`
 * (the ACTIVE org). Returns null when the token is malformed, unknown, revoked,
 * or resolves outside the active org — all deliberately indistinguishable.
 */
export async function resolveScannedAssetForOrg(
  supabase: SupabaseClient<Database>,
  token: string,
  orgId: string,
): Promise<ScannedAsset | null> {
  // Cheap edge rejection before any DB work (enumeration/DoS resistance).
  if (!isValidTokenFormat(token)) return null;
  if (!orgId) return null;

  const client = supabase as unknown as LooseClient;

  const { data: identity } = await client
    .from("asset_qr_identities")
    .select("asset_id")
    .eq("token", token)
    .eq("active", true)
    .eq("org_id", orgId)
    .maybeSingle();

  const assetId = (identity as { asset_id?: string } | null)?.asset_id;
  if (!assetId) return null;

  const { data: asset } = await client
    .from("assets")
    .select(ASSET_COLUMNS)
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();

  return (asset as ScannedAsset | null) ?? null;
}
