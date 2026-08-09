import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { loadVehicleDetail, loadVehicleTelematics, isInService } from "@/server/services/fleet-snapshot";
import { formatGbp } from "@/lib/money";
import { computeConsumption, mileageSpan, sumFuel } from "@/lib/fleet/fuel";
import {
  FLEET_COMPLIANCE_LABELS,
  FLEET_COMPLIANCE_TYPES,
  assessCompliance,
  isFleetComplianceType,
  type FleetComplianceType,
} from "@/lib/fleet/compliance";
import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from "@/lib/assets/maintenance";
import {
  FUEL_TYPE_LABELS,
  OPERATIONAL_STATUS_LABELS,
  type FuelType,
  type OperationalStatus,
} from "@/lib/fleet/schema";
import { loadSiteOptions, loadSupplierOptions, loadVehicleForOrg } from "../../_components/load";
import { recordComplianceCompletion, saveComplianceSchedule, deactivateComplianceSchedule } from "../../compliance-actions";
import { createFuelLog } from "../../fuel-actions";
import { StateForm } from "../../_components/state-form";
import {
  Banner,
  CompliancePill,
  OperationalPill,
  Plate,
  SectionCard,
  Stat,
  VehicleClassLabel,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../_components/ui";
import { errorMessage, savedMessage } from "../../_components/messages";
import { withPreservedOption } from "@/lib/quotes/preserve-option";

export const dynamic = "force-dynamic";

/**
 * /fleet/vehicles/[id] — the vehicle, composed from the EXISTING asset spine.
 *
 * Custody comes from `asset_assignments` (20260925000000) and is READ here;
 * issuing and transferring stay on the asset page, which already owns that flow
 * with its atomic transfer RPC. Fleet does not build a second custody engine —
 * the whole architecture rests on there being exactly one.
 *
 * ACTIVE-ORG PINNED: loadVehicleForOrg and loadVehicleDetail both carry
 * ctx.org.id, so a vehicle id from the caller's other org is notFound().
 */

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

export default async function VehiclePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const sp = await searchParams;

  const vehicle = await loadVehicleForOrg(ctx.org.id, id);
  if (!vehicle) notFound();

  const [detail, telematics, suppliers, sites] = await Promise.all([
    loadVehicleDetail(ctx.org.id, id),
    // The CONSUMPTION half of the telematics feed. Dark today (no readings), so
    // this returns an empty view the section below renders as a graceful empty
    // state rather than an error.
    loadVehicleTelematics(ctx.org.id, id),
    loadSupplierOptions(ctx.org.id),
    // Org-pinned; includes a retired site when this vehicle still points at one,
    // so the detail page never shows a blank where a real home site exists.
    loadSiteOptions(ctx.org.id, vehicle.homeSiteId),
  ]);
  const homeSite = vehicle.homeSiteId
    ? (sites.find((s) => s.id === vehicle.homeSiteId) ?? null)
    : null;

  const todayIso = new Date().toISOString().slice(0, 10);
  const inService = isInService(vehicle);
  const compliance = assessCompliance(
    detail.schedules
      .filter((s) => isFleetComplianceType(s.maintenanceType))
      .map((s) => ({
        id: s.id,
        assetId: id,
        type: s.maintenanceType as FleetComplianceType,
        nextDue: s.nextDue,
        active: s.active,
        leadTimeDays: s.leadTimeDays,
        inService,
      })),
    todayIso,
  );
  const complianceById = new Map(compliance.map((c) => [c.id, c]));

  const fuelTotals = sumFuel(detail.fuel);
  const consumption = computeConsumption(detail.fuel);
  const span = mileageSpan(detail.fuel);
  const openAssignment = detail.assignments.find((a) => a.status === "open") ?? null;
  const openCases = detail.cases.filter(
    (c) => c.status !== "completed" && c.status !== "cancelled",
  );
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

  const err = errorMessage(sp.error);
  const ok = savedMessage(sp.saved);
  const worst = compliance.find((c) => c.state !== "ok") ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="space-y-2">
        <nav aria-label="Breadcrumb" className="text-xs text-slate-500">
          <Link href="/fleet" className="hover:text-slate-900">
            Fleet
          </Link>
          <span className="mx-1">/</span>
          <Link href="/fleet/vehicles" className="hover:text-slate-900">
            Vehicles
          </Link>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{vehicle.name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <Plate registration={vehicle.registration} />
              <OperationalPill status={vehicle.operationalStatus} />
              {vehicle.assetStatus !== "active" ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                  Asset: {vehicle.assetStatus.replace(/_/g, " ")}
                </span>
              ) : null}
              {vehicle.vehicleClass ? (
                <span>
                  <VehicleClassLabel value={vehicle.vehicleClass} />
                </span>
              ) : null}
              {vehicle.fuelType ? (
                <span>{FUEL_TYPE_LABELS[vehicle.fuelType as FuelType] ?? vehicle.fuelType}</span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/assets/${id}`} className={secondaryButtonClass}>
              Asset record
            </Link>
            <Link href={`/fleet/vehicles/${id}/edit`} className={primaryButtonClass}>
              Edit
            </Link>
          </div>
        </div>
      </header>

      {err ? <Banner tone="error">{err}</Banner> : null}
      {ok ? <Banner tone="success">{ok}</Banner> : null}

      {worst && worst.severity === "critical" ? (
        <Banner tone="error">
          <strong className="font-semibold">
            This vehicle is in service with an expired {FLEET_COMPLIANCE_LABELS[worst.type]}.
          </strong>{" "}
          Driving it is an offence. Take it off road or renew it today.
        </Banner>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Mileage"
          value={
            vehicle.odometerMiles != null
              ? `${vehicle.odometerMiles.toLocaleString("en-GB")}`
              : "—"
          }
          hint={
            vehicle.odometerRecordedAt
              ? `as at ${vehicle.odometerRecordedAt.slice(0, 10)}`
              : "no reading yet"
          }
        />
        <Stat
          label="Next due"
          value={worst ? FLEET_COMPLIANCE_LABELS[worst.type] : "—"}
          hint={
            worst
              ? worst.state === "overdue"
                ? `${Math.abs(worst.daysUntilDue)} days late`
                : `in ${worst.daysUntilDue} days`
              : compliance.length === 0
                ? "no dates tracked"
                : "all current"
          }
          accent={
            worst?.severity === "critical"
              ? "text-red-700"
              : worst?.state === "overdue"
                ? "text-amber-700"
                : undefined
          }
        />
        <Stat
          label="Fuel logged"
          value={formatGbp(fuelTotals.spend)}
          hint={`${fuelTotals.entries} ${fuelTotals.entries === 1 ? "entry" : "entries"}`}
        />
        <Stat
          label="Consumption"
          value={consumption.mpg == null ? "—" : `${consumption.mpg.toFixed(1)}`}
          hint={consumption.mpg == null ? "needs two full fills" : "mpg, full-to-full"}
        />
      </div>

      {/* ── Custody: READ from the existing engine ─────────────────────────── */}
      <SectionCard
        title="Who has it"
        action={
          <Link
            href={`/assets/${id}`}
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            Issue or transfer
          </Link>
        }
      >
        {openAssignment ? (
          <div className="p-4 text-sm">
            <p className="font-medium text-slate-900">
              {openAssignment.assignmentType.replace(/_/g, " ")}
              {openAssignment.location ? ` — ${openAssignment.location}` : ""}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Since {openAssignment.assignedAt.slice(0, 10)}
              {openAssignment.expectedReturnAt
                ? ` · due back ${openAssignment.expectedReturnAt}`
                : ""}
              {openAssignment.jobId ? (
                <>
                  {" · "}
                  <Link href={`/jobs/${openAssignment.jobId}`} className="underline">
                    on a job
                  </Link>
                </>
              ) : null}
            </p>
          </div>
        ) : (
          <p className="p-4 text-sm text-slate-500">
            Not currently issued to anyone. Custody, transfers and return conditions are handled on
            the asset record — Fleet reads the same log rather than keeping a second one.
          </p>
        )}
        {detail.assignments.length > 1 ? (
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            {detail.assignments.length} custody{" "}
            {detail.assignments.length === 1 ? "entry" : "entries"} on record.
          </p>
        ) : null}
      </SectionCard>

      {/* ── Location & telematics (READ of the live feed) ─────────────────── */}
      <SectionCard title="Location &amp; telematics" id="telematics">
        {telematics.track.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No telematics data for this vehicle. When a tracker feed is connected,
            its latest position and recent movements appear here — the fleet reads
            the same feed rather than keeping a second location log.
          </p>
        ) : (
          <>
            <div className="grid gap-3 border-b border-slate-100 p-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Latest position
                </p>
                {telematics.latestFix &&
                telematics.latestFix.latitude != null &&
                telematics.latestFix.longitude != null ? (
                  <>
                    <p className="mt-1 font-mono text-sm text-slate-900">
                      {telematics.latestFix.latitude.toFixed(6)},{" "}
                      {telematics.latestFix.longitude.toFixed(6)}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      as at {fmtReadingTime(telematics.latestFix.recordedAt)} ·{" "}
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${telematics.latestFix.latitude}&mlon=${telematics.latestFix.longitude}#map=15/${telematics.latestFix.latitude}/${telematics.latestFix.longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-slate-900"
                      >
                        View on map
                      </a>
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-slate-500">
                    No GPS fix in recent samples.
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Latest reading
                </p>
                <p className="mt-1 text-sm text-slate-900">
                  {telematics.latest && telematics.latest.odometerMiles != null
                    ? `${telematics.latest.odometerMiles.toLocaleString("en-GB")} mi`
                    : "—"}
                </p>
                {telematics.latest ? (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {fmtReadingTime(telematics.latest.recordedAt)}
                  </p>
                ) : null}
              </div>
            </div>
            <ul className="divide-y divide-slate-100">
              {telematics.track.slice(0, 10).map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 p-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">
                      {fmtReadingTime(r.recordedAt)}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-slate-500">
                      {r.latitude != null && r.longitude != null
                        ? `${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}`
                        : "no fix"}
                    </p>
                  </div>
                  <span className="shrink-0 tabular-nums text-xs text-slate-600">
                    {r.odometerMiles != null
                      ? `${r.odometerMiles.toLocaleString("en-GB")} mi`
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
            {telematics.track.length > 10 ? (
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                Showing the 10 most recent of {telematics.track.length} readings.
              </p>
            ) : null}
          </>
        )}
      </SectionCard>

      {/* ── Compliance ────────────────────────────────────────────────────── */}
      <SectionCard title="Compliance" id="compliance">
        {detail.schedules.filter((s) => isFleetComplianceType(s.maintenanceType)).length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No renewal dates tracked yet. Add the MOT, insurance, road tax and service dates below
            and they&apos;ll appear on the fleet board and in your daily briefing before they run
            out.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {detail.schedules
              .filter((s) => isFleetComplianceType(s.maintenanceType))
              .map((s) => {
                const c = complianceById.get(s.id);
                const type = s.maintenanceType as FleetComplianceType;
                return (
                  <li key={s.id} className="p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900">
                          {FLEET_COMPLIANCE_LABELS[type]}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          Due {s.nextDue}
                          {s.intervalMonths ? ` · every ${s.intervalMonths} months` : ""}
                          {s.intervalDays ? ` · every ${s.intervalDays} days` : ""}
                          {!s.active ? " · not tracked" : ""}
                          {s.lastCompletedAt ? ` · last done ${s.lastCompletedAt.slice(0, 10)}` : ""}
                        </p>
                      </div>
                      {c ? (
                        <CompliancePill
                          type={c.type}
                          state={c.state}
                          daysUntilDue={c.daysUntilDue}
                          critical={c.severity === "critical"}
                        />
                      ) : (
                        <span className="text-xs text-slate-500">Not tracked</span>
                      )}
                    </div>

                    {s.active ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-900">
                          Record it as done
                        </summary>
                        <StateForm
                          action={recordComplianceCompletion}
                          className="mt-2 grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-3"
                        >
                          <input type="hidden" name="asset_id" value={id} />
                          <input type="hidden" name="schedule_id" value={s.id} />
                          <input type="hidden" name="maintenance_type" value={type} />
                          <div>
                            <label htmlFor={`done-${s.id}`} className={labelClass}>
                              Completed on
                            </label>
                            <input
                              id={`done-${s.id}`}
                              name="completed_on"
                              type="date"
                              required
                              defaultValue={todayIso}
                              className={inputClass}
                            />
                          </div>
                          <div>
                            <label htmlFor={`next-${s.id}`} className={labelClass}>
                              Next due
                            </label>
                            <input
                              id={`next-${s.id}`}
                              name="next_due"
                              type="date"
                              className={inputClass}
                            />
                          </div>
                          <div>
                            <label htmlFor={`odo-${s.id}`} className={labelClass}>
                              Mileage
                            </label>
                            <input
                              id={`odo-${s.id}`}
                              name="odometer_miles"
                              type="number"
                              min={0}
                              max={3000000}
                              defaultValue={vehicle.odometerMiles ?? ""}
                              className={inputClass}
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label htmlFor={`work-${s.id}`} className={labelClass}>
                              What was done
                            </label>
                            <input
                              id={`work-${s.id}`}
                              name="work_performed"
                              required
                              maxLength={4000}
                              placeholder="MOT passed, no advisories"
                              className={inputClass}
                            />
                          </div>
                          <div>
                            <label htmlFor={`sup-${s.id}`} className={labelClass}>
                              Garage / provider
                            </label>
                            <select
                              id={`sup-${s.id}`}
                              name="supplier_id"
                              defaultValue={s.supplierId ?? ""}
                              className={inputClass}
                            >
                              <option value="">Not set</option>
                              {/* Preserve the schedule's saved provider even if it
                                  falls outside the (paged) supplier list, so
                                  recording a service can never NULL it. */}
                              {withPreservedOption(
                                suppliers,
                                s.supplierId ?? undefined,
                                (id) => ({ id, name: "Current provider" }),
                              ).map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="sm:col-span-3">
                            <button type="submit" className={primaryButtonClass}>
                              Record
                            </button>
                          </div>
                        </StateForm>
                      </details>
                    ) : null}

                    {s.active ? (
                      <StateForm action={deactivateComplianceSchedule} className="mt-1">
                        <input type="hidden" name="asset_id" value={id} />
                        <input type="hidden" name="schedule_id" value={s.id} />
                        <button
                          type="submit"
                          className="text-xs font-medium text-slate-500 hover:text-slate-900"
                        >
                          Stop tracking
                        </button>
                      </StateForm>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        )}

        <div className="border-t border-slate-100 p-3">
          <details>
            <summary className="cursor-pointer text-xs font-semibold text-slate-700 hover:text-slate-900">
              Add a renewal date
            </summary>
            <StateForm action={saveComplianceSchedule} className="mt-2 grid gap-2 sm:grid-cols-4">
              <input type="hidden" name="asset_id" value={id} />
              <div>
                <label htmlFor="new-type" className={labelClass}>
                  What
                </label>
                <select id="new-type" name="maintenance_type" className={inputClass}>
                  {FLEET_COMPLIANCE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FLEET_COMPLIANCE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="new-due" className={labelClass}>
                  Next due
                </label>
                <input
                  id="new-due"
                  name="next_due"
                  type="date"
                  required
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="new-months" className={labelClass}>
                  Repeat (months)
                </label>
                <input
                  id="new-months"
                  name="interval_months"
                  type="number"
                  min={1}
                  max={120}
                  defaultValue={12}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="new-lead" className={labelClass}>
                  Warn me (days before)
                </label>
                <input
                  id="new-lead"
                  name="lead_time_days"
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={30}
                  className={inputClass}
                />
              </div>
              <div className="sm:col-span-4">
                <button type="submit" className={primaryButtonClass}>
                  Add renewal date
                </button>
                <p className="mt-1 text-[11px] text-slate-500">
                  Standing renewal dates are an owner/admin setting.
                </p>
              </div>
            </StateForm>
          </details>
        </div>
      </SectionCard>

      {/* ── Maintenance (existing engine) ─────────────────────────────────── */}
      <SectionCard
        title="Maintenance &amp; repairs"
        action={
          <Link
            href={`/assets/${id}`}
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            Raise a case
          </Link>
        }
      >
        {detail.cases.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No repairs or services recorded. Breakdowns, servicing and warranty work are raised on
            the asset record and appear here.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {detail.cases.slice(0, 8).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{c.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {c.caseType.replace(/_/g, " ")}
                    {c.scheduledFor ? ` · due ${c.scheduledFor}` : ""}
                    {c.completedAt ? ` · done ${c.completedAt.slice(0, 10)}` : ""}
                    {c.odometerMiles != null
                      ? ` · ${c.odometerMiles.toLocaleString("en-GB")} mi`
                      : ""}
                    {c.supplierId ? ` · ${supplierName.get(c.supplierId) ?? "provider"}` : ""}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    c.status === "completed"
                      ? "bg-emerald-100 text-emerald-800"
                      : c.status === "cancelled"
                        ? "bg-slate-100 text-slate-600"
                        : "bg-blue-100 text-blue-700"
                  }`}
                >
                  {MAINTENANCE_STATUS_LABELS[c.status as MaintenanceStatus] ?? c.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        {openCases.length > 0 ? (
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            {openCases.length} open {openCases.length === 1 ? "case" : "cases"}.
          </p>
        ) : null}
      </SectionCard>

      {/* ── Fuel ──────────────────────────────────────────────────────────── */}
      <SectionCard title="Fuel" id="fuel">
        <div className="border-b border-slate-100 p-3">
          <StateForm action={createFuelLog} className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <input type="hidden" name="asset_id" value={id} />
            <div>
              <label htmlFor="filled_on" className={labelClass}>
                Date
              </label>
              <input
                id="filled_on"
                name="filled_on"
                type="date"
                required
                defaultValue={todayIso}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="fuel_odometer" className={labelClass}>
                Mileage
              </label>
              <input
                id="fuel_odometer"
                name="odometer_miles"
                type="number"
                min={0}
                max={3000000}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="litres" className={labelClass}>
                Litres
              </label>
              <input
                id="litres"
                name="litres"
                type="number"
                step="0.01"
                min={0}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="cost" className={labelClass}>
                Cost (£)
              </label>
              <input
                id="cost"
                name="cost"
                type="number"
                step="0.01"
                min={0}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="station" className={labelClass}>
                Station
              </label>
              <input id="station" name="station" maxLength={160} className={inputClass} />
            </div>
            <div className="flex items-end">
              <button type="submit" className={`${primaryButtonClass} w-full`}>
                Log fill
              </button>
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-700 sm:col-span-3 lg:col-span-6">
              <input
                type="checkbox"
                name="is_full_fill"
                defaultChecked
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                <span className="font-medium">Filled to the brim</span>
                <span className="mt-0.5 block text-slate-500">
                  Leave this ticked for a full tank. Consumption can only be measured between two
                  brim-full fills, so a partial fill is recorded but produces no mpg figure — we
                  won&apos;t invent one.
                </span>
              </span>
            </label>
          </StateForm>
        </div>

        {detail.fuel.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No fuel logged for this vehicle yet.</p>
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {[...detail.fuel]
                .sort((a, b) => b.filledOn.localeCompare(a.filledOn) || b.id.localeCompare(a.id))
                .slice(0, 10)
                .map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{l.filledOn}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {l.litres != null ? `${Number(l.litres).toFixed(2)} L` : "no litres"}
                        {l.odometerMiles != null
                          ? ` · ${l.odometerMiles.toLocaleString("en-GB")} mi`
                          : ""}
                        {l.isFullFill ? " · full fill" : " · partial"}
                      </p>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums text-slate-900">
                      {formatGbp(l.cost)}
                    </span>
                  </li>
                ))}
            </ul>
            <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
              {formatGbp(fuelTotals.spend)} across {fuelTotals.entries}{" "}
              {fuelTotals.entries === 1 ? "entry" : "entries"}
              {span ? ` · ${span.miles.toLocaleString("en-GB")} miles covered ${span.fromIso} to ${span.toIso}` : ""}
              {consumption.mpg != null
                ? ` · ${consumption.mpg.toFixed(1)} mpg over ${consumption.segments.length} full-to-full ${consumption.segments.length === 1 ? "tank" : "tanks"}`
                : " · consumption not calculable from these entries"}
              .
            </div>
          </>
        )}
      </SectionCard>

      {/* ── Inspections (existing engine) ─────────────────────────────────── */}
      <SectionCard
        title="Inspections"
        action={
          <Link
            href={`/assets/${id}`}
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            Inspect
          </Link>
        }
      >
        {detail.inspections.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No inspections recorded. Daily walkarounds and safety checks use the asset inspection
            templates — Fleet shows the results, it doesn&apos;t run a separate check.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {detail.inspections.slice(0, 5).map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-slate-900">
                    {(i.performedAt ?? i.createdAt).slice(0, 10)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {i.status}
                    {i.safetyCritical ? " · safety critical" : ""}
                  </p>
                </div>
                {i.outcome ? (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      i.outcome === "fail"
                        ? "bg-red-100 text-red-800"
                        : "bg-emerald-100 text-emerald-800"
                    }`}
                  >
                    {i.outcome}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Details">
        <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
          <Detail label="VIN" value={vehicle.vin} mono />
          <Detail
            label="First registered"
            value={vehicle.firstRegisteredOn ?? (vehicle.yearOfManufacture ? String(vehicle.yearOfManufacture) : null)}
          />
          <Detail
            label="Gross weight"
            value={vehicle.grossWeightKg ? `${vehicle.grossWeightKg.toLocaleString("en-GB")} kg` : null}
          />
          <Detail label="MOT exempt" value={vehicle.motExempt ? "Yes" : "No"} />
          {/* The named site is the authority; the free text is shown only when
              there is no site to show, so the two can never contradict each
              other on screen. */}
          <Detail
            label="Home site"
            value={homeSite ? `${homeSite.name}${homeSite.active ? "" : " (retired)"}` : vehicle.homeDepot}
          />
          <Detail
            label="Availability"
            value={OPERATIONAL_STATUS_LABELS[vehicle.operationalStatus as OperationalStatus] ?? null}
          />
          <Detail
            label="Agreement"
            value={
              vehicle.financeType === "none"
                ? "None"
                : [
                    vehicle.financeType.replace(/_/g, " "),
                    vehicle.financeAgreementRef,
                    vehicle.financeMonthlyPayment != null
                      ? `${formatGbp(vehicle.financeMonthlyPayment)}/month`
                      : null,
                    vehicle.financeEndDate ? `ends ${vehicle.financeEndDate}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
            }
          />
          <Detail
            label="Bought / hired from"
            value={vehicle.supplierId ? (supplierName.get(vehicle.supplierId) ?? null) : null}
          />
        </dl>
        {vehicle.notes ? (
          <div className="border-t border-slate-100 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{vehicle.notes}</p>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

/** Format a reading's ISO timestamp for display; falls back to the raw date. */
function fmtReadingTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 16).replace("T", " ");
  return new Date(t).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-50 py-1 last:border-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`text-right text-slate-900 ${mono ? "font-mono text-xs" : ""}`}>
        {value || <span className="text-slate-500">—</span>}
      </dd>
    </div>
  );
}
