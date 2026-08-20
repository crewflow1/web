import "server-only";

import type { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { normalizeOrgI18n, defaultOrgI18n, type OrgI18n } from "@/lib/i18n/config";

/**
 * Organisation internationalisation config READ path (server-only).
 *
 * Reads the six i18n dimensions from `organizations` (migration 20261210000000
 * added locale/currency/tax_jurisdiction/phone_region; country/timezone are
 * baseline) and normalises them to a complete, runtime-valid {@link OrgI18n}.
 *
 * It is a LOUD read: an actual query ERROR throws (a formatting surface must never
 * silently render defaults over a failed read and then, e.g., money in the wrong
 * currency). A genuinely missing row / null column degrades to the UK defaults via
 * normalizeOrgI18n — which is the designed empty state for a pre-migration or
 * backfill-miss row, and is exactly the pre-wave behaviour.
 *
 * org_id comes from the caller's session context, never client input; the
 * organizations RLS policies are the real tenant boundary.
 */

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export async function readOrgI18n(
  supabase: ServerClient,
  orgId: string,
): Promise<OrgI18n> {
  const { data, error } = await supabase
    .from("organizations")
    .select("country, locale, currency, timezone, tax_jurisdiction, phone_region")
    .eq("id", orgId)
    .maybeSingle();

  if (error) throw readFailure("org-i18n: organizations config", error);
  if (!data) return defaultOrgI18n();

  return normalizeOrgI18n(data as Partial<Record<keyof OrgI18n, unknown>>);
}
