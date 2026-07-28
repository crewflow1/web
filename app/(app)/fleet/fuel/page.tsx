import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { loadFleetOverview } from "@/server/services/fleet-snapshot";
import { formatGbp } from "@/lib/money";
import { EmptyState } from "../../_components/empty-state";
import { Banner, Plate, SectionCard, Stat } from "../_components/ui";
import { errorMessage, savedMessage } from "../_components/messages";

export const dynamic = "force-dynamic";

/**
 * /fleet/fuel — fuel spend and what it buys.
 *
 * WHAT THIS PAGE WILL NOT DO: invent an efficiency figure. Every mpg shown is
 * measured between two consecutive brim-full fills with real odometer readings
 * (lib/fleet/fuel.ts); where that evidence doesn't exist the cell reads "—" and
 * says why. A fabricated 31.4 mpg would look better and be worthless — a
 * builder comparing two vans on it would make a purchasing decision on noise.
 *
 * It is also NOT an expense ledger. Fuel entries do not post to /finances; this
 * is the operational record of what went into the tank.
 */

type SP = Promise<{ saved?: string; error?: string }>;

export default async function FleetFuelPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);
  const overview = await loadFleetOverview(ctx.org.id, todayIso);

  const vehicleById = new Map(overview.vehicles.map((v) => [v.assetId, v]));
  const err = errorMessage(sp.error);
  const ok = savedMessage(sp.saved);
  const { totals, consumption, byVehicle } = overview.fuel;
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fuel &amp; running costs</h1>
          <p className="mt-1 text-sm text-slate-600">
            What the fleet burns and what it costs to keep moving.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/fleet"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Fleet overview
          </Link>
          <Link
            href="/fleet/vehicles"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Log a fill
          </Link>
        </div>
      </header>

      {err ? <Banner tone="error">{err}</Banner> : null}
      {ok ? <Banner tone="success">{ok}</Banner> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Fuel spend"
          value={formatGbp(totals.spend)}
          hint={`${totals.entries} ${totals.entries === 1 ? "entry" : "entries"}`}
        />
        <Stat
          label="Litres"
          value={totals.litres > 0 ? totals.litres.toLocaleString("en-GB") : "—"}
          hint={totals.litres > 0 ? "recorded" : "none recorded"}
        />
        <Stat
          label="Maintenance"
          value={formatGbp(overview.maintenanceSpend)}
          hint={isAdmin ? "parts, labour, external" : "owners and admins only"}
        />
        <Stat
          label="Total recorded"
          value={formatGbp(overview.operatingCost)}
          hint="Fuel + repairs only"
        />
      </div>

      {totals.entries === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="⛽"
            title="No fuel logged yet"
            body={
              <>
                Open a vehicle and log a fill — date, mileage, litres and cost. Log full tanks and
                you&apos;ll get real consumption figures; log partial fills and you&apos;ll still
                get accurate spend.
              </>
            }
            primary={{ href: "/fleet/vehicles", label: "Open a vehicle" }}
          />
        </div>
      ) : (
        <>
          <SectionCard title="Fleet consumption">
            <div className="p-4">
              {consumption.mpg == null ? (
                <>
                  <p className="text-3xl font-bold tabular-nums text-slate-400">—</p>
                  <p className="mt-2 max-w-2xl text-sm text-slate-600">
                    Not calculable from the entries recorded. Consumption is only knowable
                    tank-to-tank: two consecutive brim-full fills, both with an odometer reading.
                    Anything else leaves an unmeasured amount in the tank, so any figure would be
                    arithmetic on a number nobody recorded — we&apos;d rather show nothing than
                    something wrong.
                  </p>
                  {consumption.skipped > 0 ? (
                    <p className="mt-2 text-xs text-slate-500">
                      {consumption.skipped}{" "}
                      {consumption.skipped === 1 ? "entry pair" : "entry pairs"} couldn&apos;t be
                      used — usually a partial fill or a missing mileage.
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-3xl font-bold tabular-nums text-slate-900">
                    {consumption.mpg.toFixed(1)}{" "}
                    <span className="text-base font-medium text-slate-500">mpg</span>
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    Measured across {consumption.segments.length} full-to-full{" "}
                    {consumption.segments.length === 1 ? "tank" : "tanks"} covering{" "}
                    {consumption.measuredMiles.toLocaleString("en-GB")} miles. Imperial gallons.
                    {consumption.skipped > 0
                      ? ` ${consumption.skipped} other entry pairs couldn't be used.`
                      : ""}
                  </p>
                </>
              )}
            </div>
          </SectionCard>

          <SectionCard title="By vehicle">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">Vehicle</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Spend</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Litres</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Fills</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">mpg</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Mileage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {byVehicle.map((s) => {
                    const v = vehicleById.get(s.assetId);
                    return (
                      <tr key={s.assetId} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <Link
                            href={`/fleet/vehicles/${s.assetId}#fuel`}
                            className="font-medium text-slate-900 hover:underline"
                          >
                            {v?.name ?? "Vehicle"}
                          </Link>
                          <div className="mt-1">
                            <Plate registration={v?.registration ?? null} />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums text-slate-900">
                          {formatGbp(s.spend)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                          {s.litres > 0 ? s.litres.toFixed(2) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                          {s.entries}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {s.mpg == null ? (
                            <span className="text-slate-400" title="Needs two consecutive full fills with mileage">
                              —
                            </span>
                          ) : (
                            <span className="font-medium text-slate-900">{s.mpg.toFixed(1)}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                          {s.latestOdometer != null
                            ? s.latestOdometer.toLocaleString("en-GB")
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
              A dash under mpg means the entries for that vehicle can&apos;t support a figure yet —
              log two consecutive full fills with the mileage and it appears.
            </p>
          </SectionCard>
        </>
      )}
    </div>
  );
}
