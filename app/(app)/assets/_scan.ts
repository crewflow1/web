import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isValidTokenFormat } from "@/lib/assets/qr";

/**
 * Resolve a scanned QR token to the minimum authorised asset view.
 *
 * Security: the caller has ALREADY authenticated (the /a/[token] page is under
 * the (app) auth group). This runs on the tenant (user-JWT) client, so RLS scopes
 * BOTH the identity and the asset to the scanner's own org — a token belonging to
 * another tenant simply resolves to nothing. Combined with the active filter and
 * the token-shape gate, every failure — malformed / unknown / revoked /
 * cross-tenant / inaccessible — returns the SAME `null` (the page renders an
 * identical not-found), disclosing nothing and giving no enumeration signal.
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

export async function resolveScannedAsset(token: string): Promise<ScannedAsset | null> {
  // Cheap edge rejection before any DB work (enumeration/DoS resistance).
  if (!isValidTokenFormat(token)) return null;

  const supabase = await createClient();

  // Active identity for this token, RLS-scoped to the scanner's org.
  const { data: identity } = await (
    supabase.from("asset_qr_identities" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: { asset_id: string } | null }>;
          };
        };
      };
    }
  )
    .select("asset_id")
    .eq("token", token)
    .eq("active", true)
    .maybeSingle();
  if (!identity?.asset_id) return null;

  const { data: asset } = await (
    supabase.from("assets" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: ScannedAsset | null }>;
        };
      };
    }
  )
    .select(
      "id, name, category, manufacturer, model, serial_number, registration, ownership, status",
    )
    .eq("id", identity.asset_id)
    .maybeSingle();

  return asset ?? null;
}
