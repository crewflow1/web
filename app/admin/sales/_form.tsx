import {
  PIPELINE_STATUSES,
  STATUS_LABELS,
  type SalesCompany,
  type SalesSource,
} from "@/lib/sales/model";
import { Field, Section } from "./_components";
import { inputCls, selectCls, textareaCls } from "./_styles";

/**
 * Shared create/edit form for the master company record (CEO Directive
 * 003). Server component — native form submission to the passed server
 * action. Used by /admin/sales/companies/new and …/[id]/edit.
 *
 * Every field the directive's Company Intelligence section lists is here.
 * The action normalises tags / tech / scores and derives the domain.
 */

export function CompanyForm({
  action,
  sources,
  initial,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  sources: SalesSource[];
  initial?: SalesCompany | null;
  submitLabel: string;
}) {
  const c = initial;
  const num = (n: number | null | undefined) => (n == null ? "" : String(n));

  return (
    <form action={action} className="space-y-5">
      {c ? <input type="hidden" name="id" value={c.id} /> : null}

      <Section title="Identity">
        <div className="space-y-4">
          <Field label="Company name">
            <input
              name="name"
              type="text"
              required
              maxLength={300}
              defaultValue={c?.name ?? ""}
              placeholder="Acme Plumbing Ltd"
              className={inputCls}
            />
          </Field>
          <Field label="Summary" hint="one or two lines — shown on cards + search">
            <textarea
              name="summary"
              rows={3}
              maxLength={4000}
              defaultValue={c?.summary ?? ""}
              placeholder="What the company does, in plain English."
              className={textareaCls}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Website">
              <input
                name="website"
                type="text"
                maxLength={500}
                defaultValue={c?.website ?? ""}
                placeholder="https://acme.co.uk"
                className={inputCls}
              />
            </Field>
            <Field label="Industry">
              <input
                name="industry"
                type="text"
                maxLength={160}
                defaultValue={c?.industry ?? ""}
                placeholder="e.g. Plumbing & heating"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Tags" hint="comma separated">
            <input
              name="tags"
              type="text"
              defaultValue={(c?.tags ?? []).join(", ")}
              placeholder="e.g. trades, field-service, midlands"
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section title="Size & value">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Employees" hint="number">
            <input
              name="employee_count"
              type="number"
              min={0}
              defaultValue={num(c?.employee_count)}
              placeholder="25"
              className={inputCls}
            />
          </Field>
          <Field label="Annual turnover" hint="£, whole number">
            <input
              name="annual_turnover_gbp"
              type="number"
              min={0}
              defaultValue={num(c?.annual_turnover_gbp)}
              placeholder="1500000"
              className={inputCls}
            />
          </Field>
          <Field label="Est. deal value" hint="£ if won — drives pipeline value">
            <input
              name="estimated_deal_value_gbp"
              type="number"
              min={0}
              defaultValue={num(c?.estimated_deal_value_gbp)}
              placeholder="6000"
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section title="Geography">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Location" hint="town / city">
            <input
              name="location"
              type="text"
              maxLength={300}
              defaultValue={c?.location ?? ""}
              placeholder="Birmingham"
              className={inputCls}
            />
          </Field>
          <Field label="County">
            <input
              name="county"
              type="text"
              maxLength={160}
              defaultValue={c?.county ?? ""}
              placeholder="West Midlands"
              className={inputCls}
            />
          </Field>
          <Field label="Region">
            <input
              name="region"
              type="text"
              maxLength={160}
              defaultValue={c?.region ?? ""}
              placeholder="Midlands"
              className={inputCls}
            />
          </Field>
          <Field label="Country">
            <input
              name="country"
              type="text"
              maxLength={120}
              defaultValue={c?.country ?? "United Kingdom"}
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section title="Contact & links">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Primary email">
            <input
              name="primary_email"
              type="text"
              maxLength={320}
              defaultValue={c?.primary_email ?? ""}
              placeholder="hello@acme.co.uk"
              className={inputCls}
            />
          </Field>
          <Field label="Primary phone">
            <input
              name="primary_phone"
              type="text"
              maxLength={60}
              defaultValue={c?.primary_phone ?? ""}
              placeholder="0121 000 0000"
              className={inputCls}
            />
          </Field>
          <Field label="LinkedIn URL">
            <input
              name="linkedin_url"
              type="text"
              maxLength={500}
              defaultValue={c?.linkedin_url ?? ""}
              className={inputCls}
            />
          </Field>
          <Field label="Instagram URL">
            <input
              name="instagram_url"
              type="text"
              maxLength={500}
              defaultValue={c?.instagram_url ?? ""}
              className={inputCls}
            />
          </Field>
          <Field label="Facebook URL">
            <input
              name="facebook_url"
              type="text"
              maxLength={500}
              defaultValue={c?.facebook_url ?? ""}
              className={inputCls}
            />
          </Field>
          <Field label="Website technology" hint="comma separated">
            <input
              name="website_technology"
              type="text"
              defaultValue={(c?.website_technology ?? []).join(", ")}
              placeholder="WordPress, HubSpot, Intercom"
              className={inputCls}
            />
          </Field>
          <Field label="Companies House URL">
            <input
              name="companies_house_url"
              type="text"
              maxLength={500}
              defaultValue={c?.companies_house_url ?? ""}
              placeholder="https://find-and-update.company-information.service.gov.uk/company/…"
              className={inputCls}
            />
          </Field>
          <Field label="Companies House number">
            <input
              name="companies_house_number"
              type="text"
              maxLength={40}
              defaultValue={c?.companies_house_number ?? ""}
              placeholder="01234567"
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Scoring & pipeline"
        subtitle="Scores are 0–100. Leave blank for unscored (distinct from 0)."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="CRM score" hint="0–100">
            <input
              name="crm_score"
              type="number"
              min={0}
              max={100}
              defaultValue={num(c?.crm_score)}
              className={inputCls}
            />
          </Field>
          <Field label="AI qualification score" hint="0–100">
            <input
              name="ai_qualification_score"
              type="number"
              min={0}
              max={100}
              defaultValue={num(c?.ai_qualification_score)}
              className={inputCls}
            />
          </Field>
          <Field label="Assigned salesperson" hint="email">
            <input
              name="assigned_to_email"
              type="text"
              maxLength={320}
              defaultValue={c?.assigned_to_email ?? ""}
              placeholder="rep@crewflow.uk"
              className={inputCls}
            />
          </Field>
          <Field label="Status">
            <select
              name="status"
              defaultValue={c?.status ?? "new"}
              className={selectCls}
            >
              {PIPELINE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source">
            <select
              name="source"
              defaultValue={c?.source ?? sources[0]?.slug ?? "manual"}
              className={selectCls}
            >
              {sources.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section
        title="Company intelligence signals"
        subtitle="Reserved enrichment signals — normally filled in automatically by future autonomous research. Optional; leave blank where unknown. Scores are 0–100."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Revenue estimate" hint="£">
            <input
              name="revenue_estimate_gbp"
              type="number"
              min={0}
              defaultValue={num(c?.revenue_estimate_gbp)}
              placeholder="2400000"
              className={inputCls}
            />
          </Field>
          <Field label="Est. software spend" hint="£/yr">
            <input
              name="estimated_software_spend_gbp"
              type="number"
              min={0}
              defaultValue={num(c?.estimated_software_spend_gbp)}
              placeholder="18000"
              className={inputCls}
            />
          </Field>
          <Field label="Construction sector">
            <input
              name="construction_sector"
              type="text"
              maxLength={160}
              defaultValue={c?.construction_sector ?? ""}
              placeholder="e.g. Groundworks"
              className={inputCls}
            />
          </Field>
          <Field label="Fleet size" hint="vehicles">
            <input
              name="fleet_size"
              type="number"
              min={0}
              defaultValue={num(c?.fleet_size)}
              placeholder="12"
              className={inputCls}
            />
          </Field>
          <Field label="Staff size" hint="headcount">
            <input
              name="staff_size"
              type="number"
              min={0}
              defaultValue={num(c?.staff_size)}
              placeholder="40"
              className={inputCls}
            />
          </Field>
          <Field label="Software in use" hint="comma separated">
            <input
              name="software_used"
              type="text"
              defaultValue={(c?.software_used ?? []).join(", ")}
              placeholder="Xero, Fergus, WhatsApp"
              className={inputCls}
            />
          </Field>
          <Field label="Growth score" hint="0–100">
            <input
              name="growth_score"
              type="number"
              min={0}
              max={100}
              defaultValue={num(c?.growth_score)}
              className={inputCls}
            />
          </Field>
          <Field label="Website quality" hint="0–100">
            <input
              name="website_quality_score"
              type="number"
              min={0}
              max={100}
              defaultValue={num(c?.website_quality_score)}
              className={inputCls}
            />
          </Field>
          <Field label="Marketing quality" hint="0–100">
            <input
              name="marketing_quality_score"
              type="number"
              min={0}
              max={100}
              defaultValue={num(c?.marketing_quality_score)}
              className={inputCls}
            />
          </Field>
          <Field label="Hiring activity" hint="0–100">
            <input
              name="hiring_activity_score"
              type="number"
              min={0}
              max={100}
              defaultValue={num(c?.hiring_activity_score)}
              className={inputCls}
            />
          </Field>
          <Field label="Digital maturity" hint="0–100">
            <input
              name="digital_maturity_score"
              type="number"
              min={0}
              max={100}
              defaultValue={num(c?.digital_maturity_score)}
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          {submitLabel}
        </button>
        <span className="text-[11px] text-slate-500">
          Saved companies are audit-logged and added to the activity feed.
        </span>
      </div>
    </form>
  );
}
