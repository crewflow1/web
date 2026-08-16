import "server-only";

import type { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  defaultOrgSettings,
  normalizeWorkingHours,
  taxDefaultsSchema,
  type OrgSettings,
} from "./schema";

/**
 * Org configuration READ path (server-only).
 *
 * `readOrgSettings` returns the org's stored config, or the canonical defaults
 * when no row exists yet (absence = defaults — see the migration header). It is a
 * LOUD read: an actual query ERROR throws (a config surface must never silently
 * render defaults over a failed read and let a save clobber real values), while a
 * simple missing row degrades to defaults, which is the designed empty state.
 *
 * org_id comes from the caller's session context, never from client input; RLS
 * (member-read) is the real tenant boundary.
 *
 * NOTE ON THE CASTS: org_settings is a brand-new table not yet present in the
 * generated Database types (types.ts is regenerated out-of-band), so the query
 * uses the same `as never` idiom as the other post-types tables (e.g.
 * notification-preferences-service.ts).
 */

type OrgSettingsRow = {
  working_hours: unknown;
  default_vat_rate: number;
  cis_default_rate: number;
  financial_year_start_month: number;
  default_payment_terms_days: number;
};

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export async function readOrgSettings(
  supabase: ServerClient,
  orgId: string,
): Promise<OrgSettings> {
  const { data, error } = await supabase
    .from("org_settings" as never)
    .select(
      "working_hours, default_vat_rate, cis_default_rate, financial_year_start_month, default_payment_terms_days" as never,
    )
    .eq("org_id" as never, orgId as never)
    .maybeSingle();

  if (error) throw readFailure("org-config: settings", error);
  if (!data) return defaultOrgSettings();

  const row = data as unknown as OrgSettingsRow;

  // Coerce the scalar tax fields through the same schema the writer uses; if a
  // stored value is somehow out of range, fall back to the field default rather
  // than surfacing an invalid config to a pricing/scheduling reader.
  const tax = taxDefaultsSchema.safeParse({
    default_vat_rate: row.default_vat_rate,
    cis_default_rate: row.cis_default_rate,
    financial_year_start_month: row.financial_year_start_month,
    default_payment_terms_days: row.default_payment_terms_days,
  });
  const defaults = defaultOrgSettings();

  return {
    working_hours: normalizeWorkingHours(row.working_hours),
    default_vat_rate: tax.success ? tax.data.default_vat_rate : defaults.default_vat_rate,
    cis_default_rate: tax.success ? tax.data.cis_default_rate : defaults.cis_default_rate,
    financial_year_start_month: tax.success
      ? tax.data.financial_year_start_month
      : defaults.financial_year_start_month,
    default_payment_terms_days: tax.success
      ? tax.data.default_payment_terms_days
      : defaults.default_payment_terms_days,
  };
}
