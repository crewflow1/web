import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { isInService, loadFleetCompliance, loadFleetVehicles } from "@/server/services/fleet-snapshot";
import { OPERATIONAL_STATUSES, OPERATIONAL_STATUS_LABELS, normaliseRegistration } from "@/lib/fleet/schema";
import { EmptyState } from "../../_components/empty-state";
import {
  Banner,
  CompliancePill,
  FilterPill,
  OperationalPill,
  Plate,
  VehicleClassLabel,
  inputClass,
} from "../_components/ui";
import { errorMessage, savedMessage } from "../_components/messages";

export const dynamic = "force-dynamic";

/**
 * /fleet/vehicles — the vehicle register.
 *
 * ORG-PINNED: loadFleetVehicles carries `.eq("org_id", ctx.org.id)` on BOTH of
 * its reads (the extension rows and their asset parents), on top of RLS.
 *
 * PAGING with a TOTAL ORDER: the service sorts by `created_at desc` with a
 * unique `asset_id` tiebreaker, so the sequence is fully determined and a row
 * can never be dropped or repeated at a page boundary. Its underlying reads are
 * themselves paged via fetchAllRows (PostgREST silently truncates at 1000 rows,
 * so an unbounded select would quietly hide a large fleet's tail).
 *
 * Search runs in TypeScript over the fully-read, org-scoped set rather than as
 * a database filter, because it spans BOTH tables (name/registration/make on
 * `assets`, VIN/depot/variant on `fleet_vehicles`). Doing it here keeps the two
 * org predicates explicit and the matching honest; at the launch horizon — tens
 * to low hundreds of vehicles per org — it is the correct trade, and the same
 * one lib/supabase/paginate.ts documents for the dashboard aggregates.
 */

const PAGE_SIZE = 25;

type SP = Promise<{
  status?: string;
  q?: string;
  page?: string;
  saved?: string;
  error?: string;
}>;

export default async function VehicleRegisterPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);

  const vehicles = await loadFleetVehicles(ctx.org.id);
  const compliance = await loadFleetCompliance(ctx.org.id, todayIso, vehicles);

  const worstByAsset = new Map<string, (typeof compliance)[number]>();
  for (const c of compliance) {
    if (c.state === "ok") continue;
    // `compliance` is already sorted worst-first, so the first hit per vehicle
    // IS the worst one — no re-comparison needed.
    if (!worstByAsset.has(c.assetId)) worstByAsset.set(c.assetId, c);
  }

  const statusFilter =
    sp.status && (OPERATIONAL_STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null;

  const rawQuery = (sp.q ?? "").trim();
  const query = rawQuery.toLowerCase();
  // A plate is matched with spaces stripped so "AB12 CDE" finds "AB12CDE".
  const plateQuery = normaliseRegistration(rawQuery);

  const filtered = vehicles.filter((v) => {
    if (statusFilter && v.operationalStatus !== statusFilter) return false;
    if (!query) return true;
    const haystack = [
      v.name,
      v.manufacturer,
      v.model,
      v.variant,
      v.vin,
      v.homeDepot,
      v.vehicleClass,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (haystack.includes(query)) return true;
    const reg = normaliseRegistration(v.registration);
    return plateQuery != null && reg != null && reg.includes(plateQuery);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const requested = Number.parseInt(sp.page ?? "1", 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), totalPages) : 1;
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const counts = {
    all: vehicles.length,
    in_service: vehicles.filter((v) => v.operationalStatus === "in_service").length,
    off_road: vehicles.filter((v) => v.operationalStatus === "off_road").length,
    in_workshop: vehicles.filter((v) => v.operationalStatus === "in_workshop").length,
  };

  const err = errorMessage(sp.error);
  const ok = savedMessage(sp.saved);
  const qs = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { status: sp.status, q: rawQuery || undefined, page: undefined, ...over };
    for (const [k, val] of Object.entries(merged)) if (val) params.set(k, val);
    const s = params.toString();
    return s ? `/fleet/vehicles?${s}` : "/fleet/vehicles";
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Vehicle register</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every vehicle on the fleet, with its plate, mileage and next renewal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/fleet"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Overview
          </Link>
          <Link
            href="/fleet/vehicles/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            + Add vehicle
          </Link>
        </div>
      </header>

      {err ? <Banner tone="error">{err}</Banner> : null}
      {ok ? <Banner tone="success">{ok}</Banner> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Availability" className="flex flex-wrap gap-2">
          <FilterPill href={qs({ status: undefined })} label="All" active={!statusFilter} count={counts.all} />
          {OPERATIONAL_STATUSES.map((s) => (
            <FilterPill
              key={s}
              href={qs({ status: s })}
              label={OPERATIONAL_STATUS_LABELS[s]}
              active={statusFilter === s}
              count={counts[s]}
            />
          ))}
        </nav>

        <form method="get" action="/fleet/vehicles" className="flex items-center gap-2">
          {statusFilter ? <input type="hidden" name="status" value={statusFilter} /> : null}
          <label htmlFor="q" className="sr-only">
            Search vehicles
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={rawQuery}
            placeholder="Registration, make, VIN, depot…"
            className={`${inputClass} mt-0 w-64`}
          />
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Search
          </button>
        </form>
      </div>

      {vehicles.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🚐"
            title="No vehicles yet"
            body="Add your first van, tipper or pickup and its MOT, insurance and tax dates land on the fleet board."
            primary={{ href: "/fleet/vehicles/new", label: "Add a vehicle" }}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🔍"
            title="Nothing matches"
            body={
              rawQuery
                ? `No vehicle matches “${rawQuery}”${statusFilter ? " with that availability" : ""}. Try a partial registration or make.`
                : "No vehicle has that availability right now."
            }
            primary={{ href: "/fleet/vehicles", label: "Clear filters" }}
          />
        </div>
      ) : (
        <>
          {/* Cards on mobile, a dense table from `sm` up — a foreman checks this
              on a phone in a yard, an office manager on a desktop. */}
          <ul className="space-y-3 sm:hidden">
            {rows.map((v) => (
              <li key={v.assetId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <Link href={`/fleet/vehicles/${v.assetId}`} className="block">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                      {v.name}
                    </p>
                    <OperationalPill status={v.operationalStatus} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Plate registration={v.registration} />
                    {v.odometerMiles != null ? (
                      <span className="tabular-nums">{v.odometerMiles.toLocaleString("en-GB")} mi</span>
                    ) : null}
                  </div>
                  {worstByAsset.get(v.assetId) ? (
                    <div className="mt-2">
                      <CompliancePill
                        type={worstByAsset.get(v.assetId)!.type}
                        state={worstByAsset.get(v.assetId)!.state}
                        daysUntilDue={worstByAsset.get(v.assetId)!.daysUntilDue}
                        critical={worstByAsset.get(v.assetId)!.severity === "critical"}
                      />
                    </div>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm sm:block">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Vehicle</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Registration</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Type</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Mileage</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Availability</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Next due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((v) => {
                  const worst = worstByAsset.get(v.assetId);
                  return (
                    <tr key={v.assetId} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/fleet/vehicles/${v.assetId}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {v.name}
                        </Link>
                        {v.manufacturer || v.model ? (
                          <p className="text-xs text-slate-500">
                            {[v.manufacturer, v.model, v.variant].filter(Boolean).join(" ")}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <Plate registration={v.registration} />
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        <VehicleClassLabel value={v.vehicleClass} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                        {v.odometerMiles != null ? v.odometerMiles.toLocaleString("en-GB") : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <OperationalPill status={v.operationalStatus} />
                        {!isInService(v) && v.assetStatus !== "active" ? (
                          <span className="ml-1 text-xs text-slate-500">({v.assetStatus})</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {worst ? (
                          <CompliancePill
                            type={worst.type}
                            state={worst.state}
                            daysUntilDue={worst.daysUntilDue}
                            critical={worst.severity === "critical"}
                          />
                        ) : (
                          <span className="text-xs text-slate-500">All current</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
            <p>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of{" "}
              {filtered.length} vehicle{filtered.length === 1 ? "" : "s"}
              {filtered.length !== vehicles.length ? ` (${vehicles.length} in the fleet)` : ""}.
            </p>
            {totalPages > 1 ? (
              <nav aria-label="Pagination" className="flex items-center gap-2">
                {page > 1 ? (
                  <Link href={qs({ page: String(page - 1) })} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
                    Previous
                  </Link>
                ) : null}
                <span className="tabular-nums">
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link href={qs({ page: String(page + 1) })} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
                    Next
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
