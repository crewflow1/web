import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { loadFleetOverview } from "@/server/services/fleet-snapshot";
import { formatGbp } from "@/lib/money";
import type { FleetComplianceType } from "@/lib/fleet/compliance";
import { EmptyState } from "../_components/empty-state";
import { Banner, CompliancePill, Plate, SectionCard, Stat } from "./_components/ui";
import { errorMessage, savedMessage } from "./_components/messages";

export const dynamic = "force-dynamic";

/**
 * /fleet — the overview.
 *
 * ORG-PINNED: every read runs through server/services/fleet-snapshot.ts, which
 * carries `.eq("org_id", ctx.org.id)` on top of RLS. `current_org_ids()` alone
 * would blend a dual-org user's two fleets onto one page.
 *
 * The attention list is DETERMINISTIC — pure date maths in lib/fleet/compliance.ts,
 * no model, no scoring heuristic. What it shows, it can explain.
 */

type SP = Promise<{ saved?: string; error?: string }>;

export default async function FleetPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);
  const overview = await loadFleetOverview(ctx.org.id, todayIso);

  const nameByAsset = new Map(overview.vehicles.map((v) => [v.assetId, v]));
  const attention = overview.compliance.filter(
    (c) => c.state === "overdue" || c.state === "due_soon",
  );
  const breaches = overview.compliance.filter((c) => c.severity === "critical");
  const err = errorMessage(sp.error);
  const ok = savedMessage(sp.saved);

  const mpg = overview.fuel.consumption.mpg;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fleet</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every van, tipper and HGV you run — MOT, insurance and road tax dates, who&apos;s
            driving what, and what it costs to keep on the road.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/fleet/compliance"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Compliance
          </Link>
          <Link
            href="/fleet/fuel"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Fuel &amp; costs
          </Link>
          <Link
            href="/fleet/vehicles"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Vehicle register
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

      {/* The legal-breach banner sits above everything: it is the one thing on
          this page that can put a director in front of a magistrate. */}
      {breaches.length > 0 ? (
        <Banner tone="error">
          <strong className="font-semibold">
            {new Set(breaches.map((b) => b.assetId)).size} vehicle
            {new Set(breaches.map((b) => b.assetId)).size === 1 ? "" : "s"} in service without a
            valid MOT or insurance.
          </strong>{" "}
          Driving on either is an offence. Take them off road or renew today —{" "}
          <Link href="/fleet/compliance" className="underline">
            see the list
          </Link>
          .
        </Banner>
      ) : null}

      {overview.vehicles.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🚐"
            title="No vehicles in the fleet yet"
            body={
              <>
                Add your first van, tipper or pickup. You&apos;ll get its MOT, insurance and road
                tax dates on one board, its driver from the asset custody log, and its fuel and
                repair spend in one place.
                <span className="mt-2 block text-xs text-slate-500">
                  Already tracking vehicles as assets? Adding one here creates the asset too — the
                  two registers are the same records, not two lists.
                </span>
              </>
            }
            primary={{ href: "/fleet/vehicles/new", label: "Add a vehicle" }}
            secondary={{ href: "/assets", label: "View the asset register" }}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Vehicles"
              value={String(overview.counts.total)}
              hint={`${overview.counts.inService} in service`}
              href="/fleet/vehicles"
            />
            <Stat
              label="Needs attention"
              value={String(attention.length)}
              hint={
                breaches.length > 0
                  ? `${breaches.length} a legal breach`
                  : attention.length === 0
                    ? "All dates current"
                    : "Renewals due or passed"
              }
              accent={
                breaches.length > 0
                  ? "text-red-700"
                  : attention.length > 0
                    ? "text-amber-700"
                    : "text-emerald-700"
              }
              href="/fleet/compliance"
            />
            <Stat
              label="Off the road"
              value={String(overview.counts.offRoad + overview.counts.inWorkshop)}
              hint={`${overview.counts.inWorkshop} in workshop`}
              href="/fleet/vehicles?status=off_road"
            />
            <Stat
              label="Fuel logged"
              value={formatGbp(overview.fuel.totals.spend)}
              hint={`${overview.fuel.totals.entries} ${
                overview.fuel.totals.entries === 1 ? "entry" : "entries"
              }`}
              href="/fleet/fuel"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SectionCard
                title="Compliance attention"
                action={
                  <Link
                    href="/fleet/compliance"
                    className="text-xs font-medium text-slate-600 hover:text-slate-900"
                  >
                    View all
                  </Link>
                }
              >
                {attention.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">
                    Nothing due. Every MOT, insurance, tax and service date on record is inside its
                    window.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {attention.slice(0, 8).map((c) => {
                      const v = nameByAsset.get(c.assetId);
                      return (
                        <li key={c.id}>
                          <Link
                            href={`/fleet/vehicles/${c.assetId}#compliance`}
                            className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-slate-50"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-slate-900">
                                {v?.name ?? "Vehicle"}
                              </p>
                              <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                                <Plate registration={v?.registration ?? null} />
                                {c.inService ? null : (
                                  <span className="text-slate-500">not in service</span>
                                )}
                              </p>
                            </div>
                            <CompliancePill
                              type={c.type}
                              state={c.state}
                              daysUntilDue={c.daysUntilDue}
                              critical={c.severity === "critical"}
                            />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </SectionCard>
            </div>

            <div className="space-y-4">
              <SectionCard title="Running costs">
                <dl className="divide-y divide-slate-100 text-sm">
                  <CostRow label="Fuel logged" value={formatGbp(overview.fuel.totals.spend)} />
                  <CostRow
                    label="Maintenance"
                    value={formatGbp(overview.maintenanceSpend)}
                    hint={
                      ctx.membership.role === "owner" || ctx.membership.role === "admin"
                        ? undefined
                        : "Visible to owners and admins only"
                    }
                  />
                  <CostRow
                    label="Total recorded"
                    value={formatGbp(overview.operatingCost)}
                    strong
                    hint="Fuel plus repairs only — not finance, insurance or depreciation."
                  />
                </dl>
              </SectionCard>

              <SectionCard title="Fuel efficiency">
                <div className="p-4">
                  {mpg == null ? (
                    <>
                      <p className="text-2xl font-bold tabular-nums text-slate-500">—</p>
                      <p className="mt-1 text-xs text-slate-500">
                        Not calculable yet. Consumption can only be measured between two
                        consecutive brim-full fills that both carry a mileage reading. Log full
                        fills with the odometer and a figure appears here.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-2xl font-bold tabular-nums text-slate-900">
                        {mpg.toFixed(1)}{" "}
                        <span className="text-sm font-medium text-slate-500">mpg</span>
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Measured across {overview.fuel.consumption.segments.length} full-to-full{" "}
                        {overview.fuel.consumption.segments.length === 1 ? "tank" : "tanks"} (
                        {overview.fuel.consumption.measuredMiles.toLocaleString("en-GB")} miles).
                        {overview.fuel.consumption.skipped > 0
                          ? ` ${overview.fuel.consumption.skipped} entries couldn't be used.`
                          : ""}
                      </p>
                    </>
                  )}
                </div>
              </SectionCard>
            </div>
          </div>

          <SectionCard
            title="Vehicles"
            action={
              <Link
                href="/fleet/vehicles"
                className="text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Full register
              </Link>
            }
          >
            <ul className="divide-y divide-slate-100">
              {overview.vehicles.slice(0, 6).map((v) => {
                const worst = overview.compliance.find(
                  (c) => c.assetId === v.assetId && c.state !== "ok",
                );
                return (
                  <li key={v.assetId}>
                    <Link
                      href={`/fleet/vehicles/${v.assetId}`}
                      className="flex flex-wrap items-center justify-between gap-3 p-3 hover:bg-slate-50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{v.name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <Plate registration={v.registration} />
                          {v.odometerMiles != null ? (
                            <span className="tabular-nums">
                              {v.odometerMiles.toLocaleString("en-GB")} mi
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {worst ? (
                        <CompliancePill
                          type={worst.type as FleetComplianceType}
                          state={worst.state}
                          daysUntilDue={worst.daysUntilDue}
                          critical={worst.severity === "critical"}
                        />
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                          All current
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        </>
      )}
    </div>
  );
}

function CostRow({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <dt className={strong ? "font-semibold text-slate-900" : "text-slate-700"}>{label}</dt>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
      <dd
        className={`shrink-0 tabular-nums ${
          strong ? "text-lg font-bold text-slate-900" : "font-medium text-slate-900"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
