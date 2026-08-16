import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readOrgSettings } from "@/lib/org-config/service";
import { saveTaxDefaults } from "./org-config-actions";
import { TaxDefaultsForm } from "./_tax-defaults.client";

/**
 * Settings → Tax & defaults (P3W2) — self-contained section.
 *
 * Rendered from settings/page.tsx with a single import + JSX line. Reads the
 * org's tax config (defaults when no row exists — a LOUD read that throws on a
 * real error) and hands it to the client editor. Admin (owner/admin) may edit;
 * members see it read-only.
 */
export async function TaxDefaultsSettings() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const supabase = await createClient();
  const settings = await readOrgSettings(supabase, ctx.org.id);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Tax &amp; defaults</h2>
          <p className="mt-1 text-sm text-slate-600">
            Default VAT and CIS rates, your financial-year start, and default
            payment terms — used to pre-fill new quotes, invoices and returns.
          </p>
        </div>
        {!isAdmin ? (
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            Read only · ask an admin
          </span>
        ) : null}
      </div>
      <TaxDefaultsForm
        defaults={{
          default_vat_rate: settings.default_vat_rate,
          cis_default_rate: settings.cis_default_rate,
          financial_year_start_month: settings.financial_year_start_month,
          default_payment_terms_days: settings.default_payment_terms_days,
        }}
        isAdmin={isAdmin}
        action={saveTaxDefaults}
      />
    </section>
  );
}
