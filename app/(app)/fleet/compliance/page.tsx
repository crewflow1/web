import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { loadFleetCompliance, loadFleetVehicles } from "@/server/services/fleet-snapshot";
import { FLEET_COMPLIANCE_LABELS } from "@/lib/fleet/compliance";
import { EmptyState } from "../../_components/empty-state";
import { Banner, CompliancePill, FilterPill, OperationalPill, Plate, Stat } from "../_components/ui";
import { errorMessage, savedMessage } from "../_components/messages";

export const dynamic = "force-dynamic";

/**
 * /fleet/compliance — every MOT, insurance, road tax and service date the
 * fleet is carrying, worst first.
 *
 * Deterministic end to end: lib/fleet/compliance.ts is pure date maths, so
 * every row here can be explained by pointing at a due date and today's date.
 * Nothing is inferred, predicted or scored by a model.
 *
 * DETECTION ONLY. This page tells you. It does not text a driver, email a
 * garage or book anything — no provider is wired into this lane at all.
 */

type SP = Promise<{ view?: string; saved?: string; error?: string }>;

export default async function FleetCompliancePage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);

  const vehicles = await loadFleetVehicles(ctx.org.id);
  const all = await loadFleetCompliance(ctx.org.id, todayIso, vehicles);
  const vehicleById = new Map(vehicles.map((v) => [v.assetId, v]));

  const breaches = all.filter((c) => c.severity === "critical");
  const overdue = all.filter((c) => c.state === "overdue");
  const dueSoon = all.filter((c) => c.state === "due_soon");
  const current = all.filter((c) => c.state === "ok");

  const view = sp.view === "all" || sp.view === "current" ? sp.view : "attention";
  const rows = view === "all" ? all : view === "current" ? current : [...overdue, ...dueSoon];

  const err = errorMessage(sp.error);
  const ok = savedMessage(sp.saved);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fleet compliance</h1>
          <p className="mt-1 text-sm text-slate-600">
            MOT, insurance, road tax and servicing across every vehicle — what&apos;s passed,
            what&apos;s coming, and what&apos;s illegal to drive today.
          </p>
        </div>
        <Link
          href="/fleet"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Fleet overview
        </Link>
      </header>

      {err ? <Banner tone="error">{err}</Banner> : null}
      {ok ? <Banner tone="success">{ok}</Banner> : null}

      {breaches.length > 0 ? (
        <Banner tone="error">
          <strong className="font-semibold">
            {new Set(breaches.map((b) => b.assetId)).size} vehicle
            {new Set(breaches.map((b) => b.assetId)).size === 1 ? "" : "s"} in service with an
            expired MOT or insurance.
          </strong>{" "}
          Driving without either is a Road Traffic Act offence — uninsured driving is strict
          liability. Take them off road or renew today.
        </Banner>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Legal breach"
          value={String(breaches.length)}
          hint="In service, expired MOT/insurance"
          accent={breaches.length > 0 ? "text-red-700" : "text-emerald-700"}
        />
        <Stat
          label="Overdue"
          value={String(overdue.length)}
          hint="Past the due date"
          accent={overdue.length > 0 ? "text-amber-700" : undefined}
        />
        <Stat label="Due soon" value={String(dueSoon.length)} hint="Inside the warning window" />
        <Stat label="Current" value={String(current.length)} hint="Nothing to do yet" />
      </div>

      <nav aria-label="View" className="flex flex-wrap gap-2">
        <FilterPill
          href="/fleet/compliance"
          label="Needs attention"
          active={view === "attention"}
          count={overdue.length + dueSoon.length}
        />
        <FilterPill
          href="/fleet/compliance?view=current"
          label="Current"
          active={view === "current"}
          count={current.length}
        />
        <FilterPill
          href="/fleet/compliance?view=all"
          label="Everything"
          active={view === "all"}
          count={all.length}
        />
      </nav>

      {all.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📋"
            title="No renewal dates tracked yet"
            body={
              vehicles.length === 0
                ? "Add a vehicle first, then record its MOT, insurance and road tax dates."
                : "Open a vehicle and add its MOT, insurance, road tax and service dates. They'll show here and in your daily briefing before they run out."
            }
            primary={
              vehicles.length === 0
                ? { href: "/fleet/vehicles/new", label: "Add a vehicle" }
                : { href: "/fleet/vehicles", label: "Open a vehicle" }
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="✅"
            title="Nothing needs you"
            body="Every MOT, insurance, road tax and service date on record is inside its window."
            primary={{ href: "/fleet/compliance?view=all", label: "See every date" }}
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Vehicle</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Obligation</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Due</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Availability</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => {
                const v = vehicleById.get(c.assetId);
                return (
                  <tr
                    key={c.id}
                    className={c.severity === "critical" ? "bg-red-50/50" : "hover:bg-slate-50"}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/fleet/vehicles/${c.assetId}#compliance`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {v?.name ?? "Vehicle"}
                      </Link>
                      <div className="mt-1">
                        <Plate registration={v?.registration ?? null} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {FLEET_COMPLIANCE_LABELS[c.type]}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{c.nextDue}</td>
                    <td className="px-4 py-3">
                      {v ? <OperationalPill status={v.operationalStatus} /> : null}
                    </td>
                    <td className="px-4 py-3">
                      <CompliancePill
                        type={c.type}
                        state={c.state}
                        daysUntilDue={c.daysUntilDue}
                        critical={c.severity === "critical"}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Dates are compared against today ({todayIso}). A certificate is valid through its expiry
        date, so something due today is not yet late. Nothing here sends a reminder to anyone — it
        is a board you check, and the urgent items also reach your daily briefing.
      </p>
    </div>
  );
}
