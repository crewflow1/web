import Link from "next/link";
import {
  FINANCE_TYPES,
  FINANCE_TYPE_LABELS,
  FUEL_TYPES,
  FUEL_TYPE_LABELS,
  OPERATIONAL_STATUSES,
  OPERATIONAL_STATUS_LABELS,
  VEHICLE_CLASSES,
  VEHICLE_CLASS_LABELS,
} from "@/lib/fleet/schema";
import type { FleetVehicle } from "@/server/services/fleet-snapshot";
import type { SiteOption } from "@/server/services/sites";
import { siteKindLabel } from "@/lib/sites/schema";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "./ui";

/**
 * The add / edit vehicle form — ONE component for both, so the two can never
 * drift into accepting different fields. Grouped the way a UK operator reads a
 * V5C: identity, then the vehicle itself, then how it's paid for, then where it
 * lives. Every input is a plain form control posting to a Server Action, so it
 * works with JavaScript disabled and needs no client bundle.
 */

export type SupplierOption = { id: string; name: string };

export function VehicleForm({
  action,
  vehicle,
  suppliers,
  sites,
  submitLabel,
  cancelHref,
}: {
  action: (formData: FormData) => Promise<void>;
  vehicle?: FleetVehicle;
  suppliers: SupplierOption[];
  /** Company locations (public.sites) — active, plus the one already chosen. */
  sites: SiteOption[];
  submitLabel: string;
  cancelHref: string;
}) {
  const v = vehicle;
  return (
    <form action={action} className="space-y-5">
      {v ? <input type="hidden" name="asset_id" value={v.assetId} /> : null}

      <Group
        title="Identity"
        hint="Held on the asset record — the same record the asset register, custody log and inspections use."
      >
        <Row>
          <FormField name="name" label="Name" required span={2}>
            <input
              id="name"
              name="name"
              required
              maxLength={200}
              defaultValue={v?.name ?? ""}
              placeholder="Transit 350 — Site 1"
              className={inputClass}
            />
          </FormField>
          <FormField name="registration" label="Registration">
            <input
              id="registration"
              name="registration"
              maxLength={20}
              defaultValue={v?.registration ?? ""}
              placeholder="AB12 CDE"
              className={`${inputClass} font-mono uppercase`}
            />
          </FormField>
        </Row>
        <Row>
          <FormField name="manufacturer" label="Make">
            <input
              id="manufacturer"
              name="manufacturer"
              maxLength={120}
              defaultValue={v?.manufacturer ?? ""}
              placeholder="Ford"
              className={inputClass}
            />
          </FormField>
          <FormField name="model" label="Model">
            <input
              id="model"
              name="model"
              maxLength={120}
              defaultValue={v?.model ?? ""}
              placeholder="Transit"
              className={inputClass}
            />
          </FormField>
          <FormField name="variant" label="Variant">
            <input
              id="variant"
              name="variant"
              maxLength={120}
              defaultValue={v?.variant ?? ""}
              placeholder="350 L3 H3 Leader"
              className={inputClass}
            />
          </FormField>
        </Row>
        <Row>
          <FormField name="vin" label="VIN / chassis number" help="11-17 characters, no I, O or Q.">
            <input
              id="vin"
              name="vin"
              maxLength={20}
              defaultValue={v?.vin ?? ""}
              className={`${inputClass} font-mono uppercase`}
            />
          </FormField>
          <FormField name="year_of_manufacture" label="Year">
            <input
              id="year_of_manufacture"
              name="year_of_manufacture"
              type="number"
              min={1900}
              max={2100}
              defaultValue={v?.yearOfManufacture ?? ""}
              className={inputClass}
            />
          </FormField>
          <FormField name="first_registered_on" label="First registered">
            <input
              id="first_registered_on"
              name="first_registered_on"
              type="date"
              defaultValue={v?.firstRegisteredOn ?? ""}
              className={inputClass}
            />
          </FormField>
        </Row>
      </Group>

      <Group title="The vehicle">
        <Row>
          <FormField name="vehicle_class" label="Type">
            <select
              id="vehicle_class"
              name="vehicle_class"
              defaultValue={v?.vehicleClass ?? ""}
              className={inputClass}
            >
              <option value="">Not set</option>
              {VEHICLE_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {VEHICLE_CLASS_LABELS[c]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField name="fuel_type" label="Fuel">
            <select
              id="fuel_type"
              name="fuel_type"
              defaultValue={v?.fuelType ?? ""}
              className={inputClass}
            >
              <option value="">Not set</option>
              {FUEL_TYPES.map((f) => (
                <option key={f} value={f}>
                  {FUEL_TYPE_LABELS[f]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField
            name="gross_weight_kg"
            label="Gross weight (kg)"
            help="Decides HGV class and licence entitlement."
          >
            <input
              id="gross_weight_kg"
              name="gross_weight_kg"
              type="number"
              min={1}
              max={100000}
              defaultValue={v?.grossWeightKg ?? ""}
              className={inputClass}
            />
          </FormField>
        </Row>
        <Row>
          <FormField name="operational_status" label="Availability">
            <select
              id="operational_status"
              name="operational_status"
              defaultValue={v?.operationalStatus ?? "in_service"}
              className={inputClass}
            >
              {OPERATIONAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {OPERATIONAL_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField name="odometer_miles" label="Mileage (miles)">
            <input
              id="odometer_miles"
              name="odometer_miles"
              type="number"
              min={0}
              max={3000000}
              defaultValue={v?.odometerMiles ?? ""}
              className={inputClass}
            />
          </FormField>
          <FormField
            name="home_site_id"
            label="Home site"
            help={
              sites.length === 0
                ? "No sites named yet — add your depots and yards under Sites."
                : "Where this vehicle is based."
            }
          >
            <select
              id="home_site_id"
              name="home_site_id"
              defaultValue={v?.homeSiteId ?? ""}
              className={inputClass}
            >
              <option value="">Not set</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {siteKindLabel(s.kind)}
                  {s.active ? "" : " (retired)"}
                </option>
              ))}
            </select>
          </FormField>
        </Row>
        {/* The free-text depot is KEPT, not replaced. Companies that have not
            named their sites yet keep working exactly as before, and existing
            values are never silently thrown away by a save. Once a site is
            picked the text is redundant, which the hint says out loud rather
            than the form deciding for the operator. */}
        <Row>
          <FormField
            name="home_depot"
            label="Home depot / yard (free text)"
            help="The old free-text field. Kept so nothing is lost — prefer the picker above."
            span={2}
          >
            <input
              id="home_depot"
              name="home_depot"
              maxLength={160}
              defaultValue={v?.homeDepot ?? ""}
              placeholder="Wakefield yard"
              className={inputClass}
            />
          </FormField>
        </Row>
        <label className="flex items-start gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            name="mot_exempt"
            defaultChecked={v?.motExempt ?? false}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="font-medium">MOT exempt</span>
            <span className="mt-0.5 block text-slate-500">
              Under three years old, or a historic vehicle over forty. You&apos;re recording this,
              not being told it.
            </span>
          </span>
        </label>
      </Group>

      <Group
        title="Ownership &amp; finance"
        hint="How it's paid for. Separate from whether you own it: a hire-purchase van is owned and on an agreement."
      >
        <Row>
          <FormField name="ownership" label="Owned or hired">
            <select
              id="ownership"
              name="ownership"
              defaultValue={v?.ownership ?? "owned"}
              className={inputClass}
            >
              <option value="owned">Owned</option>
              <option value="hired">Hired</option>
            </select>
          </FormField>
          <FormField name="finance_type" label="Agreement">
            <select
              id="finance_type"
              name="finance_type"
              defaultValue={v?.financeType ?? "none"}
              className={inputClass}
            >
              {FINANCE_TYPES.map((f) => (
                <option key={f} value={f}>
                  {FINANCE_TYPE_LABELS[f]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField name="finance_provider_id" label="Finance provider">
            <select
              id="finance_provider_id"
              name="finance_provider_id"
              defaultValue={v?.financeProviderId ?? ""}
              className={inputClass}
            >
              <option value="">Not set</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </FormField>
        </Row>
        <Row>
          <FormField name="finance_agreement_ref" label="Agreement reference">
            <input
              id="finance_agreement_ref"
              name="finance_agreement_ref"
              maxLength={120}
              defaultValue={v?.financeAgreementRef ?? ""}
              className={inputClass}
            />
          </FormField>
          <FormField name="finance_monthly_payment" label="Monthly payment (£)">
            <input
              id="finance_monthly_payment"
              name="finance_monthly_payment"
              type="number"
              step="0.01"
              min={0}
              defaultValue={v?.financeMonthlyPayment ?? ""}
              className={inputClass}
            />
          </FormField>
          <FormField name="finance_end_date" label="Agreement ends">
            <input
              id="finance_end_date"
              name="finance_end_date"
              type="date"
              defaultValue={v?.financeEndDate ?? ""}
              className={inputClass}
            />
          </FormField>
        </Row>
        <Row>
          <FormField name="supplier_id" label="Bought / hired from">
            <select
              id="supplier_id"
              name="supplier_id"
              defaultValue={v?.supplierId ?? ""}
              className={inputClass}
            >
              <option value="">Not set</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField name="purchase_date" label="Purchased">
            <input
              id="purchase_date"
              name="purchase_date"
              type="date"
              defaultValue={v?.purchaseDate ?? ""}
              className={inputClass}
            />
          </FormField>
          <FormField name="purchase_price" label="Purchase price (£)">
            <input
              id="purchase_price"
              name="purchase_price"
              type="number"
              step="0.01"
              min={0}
              defaultValue={v?.purchasePrice ?? ""}
              className={inputClass}
            />
          </FormField>
        </Row>
      </Group>

      <Group title="Notes">
        <FormField name="notes" label="Notes" span={3}>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            maxLength={4000}
            defaultValue={v?.notes ?? ""}
            className={inputClass}
          />
        </FormField>
      </Group>

      <div className="flex items-center gap-3">
        <button type="submit" className={primaryButtonClass}>
          {submitLabel}
        </button>
        <Link href={cancelHref} className={secondaryButtonClass}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <legend className="px-1 text-sm font-semibold text-slate-900">{title}</legend>
      {hint ? <p className="mb-3 text-xs text-slate-500">{hint}</p> : null}
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function FormField({
  name,
  label,
  required,
  help,
  span,
  children,
}: {
  name: string;
  label: string;
  required?: boolean;
  help?: string;
  span?: number;
  children: React.ReactNode;
}) {
  return (
    <div className={span === 2 ? "sm:col-span-2" : span === 3 ? "lg:col-span-3" : undefined}>
      <label htmlFor={name} className={labelClass}>
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      {children}
      {help ? <p className="mt-1 text-[11px] text-slate-500">{help}</p> : null}
    </div>
  );
}
