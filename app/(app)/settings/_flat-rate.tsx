import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readOrgSettings } from "@/lib/org-config/service";
import { saveFlatRateConfig } from "./org-config-actions";
import { FlatRateForm } from "./_flat-rate.client";

/**
 * Settings → VAT Flat Rate Scheme (MP W1) — self-contained section.
 *
 * Reads the org's FRS config (disabled by default — a LOUD read that throws on a
 * real error) and hands it to the client editor. Admin (owner/admin) may edit;
 * members see it read-only. The DB + action enforce admin-write regardless.
 */
export async function FlatRateSettings() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const supabase = await createClient();
  const settings = await readOrgSettings(supabase, ctx.org.id);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            VAT Flat Rate Scheme
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            If HMRC has you on the Flat Rate Scheme, enter your sector percentage
            here. Your VAT return then charges that flat rate on gross turnover
            instead of your line-by-line output VAT. Leave disabled otherwise.
          </p>
        </div>
        {!isAdmin ? (
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            Read only · ask an admin
          </span>
        ) : null}
      </div>
      <FlatRateForm
        config={settings.flat_rate_config}
        isAdmin={isAdmin}
        action={saveFlatRateConfig}
      />
    </section>
  );
}
