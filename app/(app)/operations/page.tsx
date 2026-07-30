import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import {
  buildOperationsSnapshot,
  OPS_CARD_LIMIT,
} from "@/server/services/operations-snapshot";
import { formatGbp } from "@/lib/money";
import { formatConflictDay } from "@/lib/schedule/conflicts";
import type { FleetComplianceType } from "@/lib/fleet/compliance";
import type {
  OpsCaseRow,
  OpsComplianceRow,
  OpsCustodyRow,
  OpsInspectionRow,
  OpsSafetyRow,
} from "@/lib/operations/compose";
import { EmptyState } from "../_components/empty-state";
// The generic design-system primitives: one AA-verified tone map behind every
// status pill and KPI value on this page, instead of a colour decision re-typed
// at each call site. See components/ui/tokens.ts.
import { Badge, StatTile } from "@/components/ui";
// Fleet's DOMAIN primitives, reused rather than reproduced: a van's compliance
// chip and number plate must look identical here and on /fleet, and those two
// encode wording (a day count becomes "12d late"), not just colour, so they stay
// where the domain rules live.
import { Banner, CompliancePill, Plate, SectionCard } from "../fleet/_components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Operations · CrewFlow" };

/**
 * /operations — the command centre.
 *
 * ONE question: what needs my attention across everything I run? Vans, plant,
 * inspections, maintenance, custody and the week's schedule, on one screen, with
 * the exposure that can put a director in front of a magistrate at the top.
 *
 * STRICTLY READ-ONLY. No form, no server action, no mutation: every row states a
 * fact and links to the surface where a human acts on it.
 *
 * ORG-PINNED: every figure comes from server/services/operations-snapshot.ts,
 * which carries `.eq("org_id", ctx.org.id)` on top of RLS — `current_org_ids()`
 * alone would blend a dual-org user's two estates onto one page.
 *
 * COMPOSED, NEVER RE-DERIVED: this page owns no rules. Fleet compliance is
 * lib/fleet/compliance.ts, conflicts are lib/schedule/conflicts.ts, safety blocks
 * are lib/assets/inspection-override.ts, due-ness is lib/assets/inspection-
 * schedule.ts, custody lateness is lib/assets/assignment.ts, and the money is
 * lib/fleet/fuel.ts. If a number here disagreed with its own domain page, that
 * would be a bug in one shared function, not two opinions.
 */
export default async function OperationsPage() {
  const { ctx } = await requireOrgContext();
  const snapshot = await buildOperationsSnapshot(ctx.org.id);
  const { view, costs, window } = snapshot;

  const { fleet, equipment, inspections, schedule, custody, estate } = view;
  const offRoad = estate.vehicles.offRoad + estate.vehicles.inWorkshop;
  const blockedAssets = equipment.safetyBlocked.filter((a) => a.blocking);
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (view.isNewEstate) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Header />
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🧭"
            title="Nothing to run yet"
            body={
              <>
                Operations is the one screen that tells you what needs you across the whole yard —
                MOTs and insurance about to lapse, plant sat out of service, inspections overdue,
                kit that never came back, and anyone double-booked this fortnight.
                <span className="mt-2 block text-xs text-slate-500">
                  It fills itself in. Add a vehicle or a machine and its dates, inspections and
                  custody start appearing here without you doing anything else.
                </span>
              </>
            }
            primary={{ href: "/fleet/vehicles/new", label: "Add a vehicle" }}
            secondary={{ href: "/assets/new", label: "Add plant or a tool" }}
          />
        </div>
        <SectionCard title="What lands here as you go">
          <ul className="divide-y divide-slate-100 text-sm">
            <FirstStep
              href="/fleet/vehicles/new"
              title="Vehicles and their dates"
              body="MOT, insurance, road tax and servicing — counted down to the day, and flagged as a legal breach the moment an in-service van lapses."
            />
            <FirstStep
              href="/assets/new"
              title="Plant and tools"
              body="Serials, warranties and who is holding what. Anything taken out of service shows up here until it is back."
            />
            <FirstStep
              href="/assets/templates"
              title="Inspection schedules"
              body="Set a template and a cadence once; CrewFlow raises the inspections and tells you here when one goes overdue."
            />
            <FirstStep
              href="/staff/rota"
              title="The rota"
              body={`Once people are on shifts, the schedule check watches the next ${window.days} days for double-bookings, leave clashes and jobs with nobody on them.`}
            />
          </ul>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Header />

      {/* The two live-exposure classes, above everything. Both are "someone
          could be prosecuted or hurt today", and neither is a scheduling
          annoyance dressed up in red. */}
      {fleet.breachVehicleCount > 0 ? (
        <Banner tone="error">
          <strong className="font-semibold">
            {fleet.breachVehicleCount} vehicle{fleet.breachVehicleCount === 1 ? "" : "s"} in service
            without a valid MOT or insurance.
          </strong>{" "}
          Driving on either is an offence. Take them off road or renew today —{" "}
          <Link href="/fleet/compliance" className="underline">
            see the list
          </Link>
          .
        </Banner>
      ) : null}
      {blockedAssets.length > 0 ? (
        <Banner tone="error">
          <strong className="font-semibold">
            {blockedAssets.length} asset{blockedAssets.length === 1 ? "" : "s"} failed a safety
            inspection and {blockedAssets.length === 1 ? "has" : "have"} not been cleared.
          </strong>{" "}
          {blockedAssets.length === 1 ? "It cannot" : "They cannot"} be issued until a passing
          re-inspection is recorded —{" "}
          <Link href="/assets/inspections" className="underline">
            see what is blocked
          </Link>
          .
        </Banner>
      ) : null}

      {/* Tone carries severity and nothing else: red is a live breach or an
          overdue duty, amber is "needs you soon", emerald is "inside its
          window". The hint line always states the fact in words, so the colour
          is reinforcement rather than the message. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Off the road"
          value={String(offRoad)}
          hint={
            offRoad === 0
              ? "Every vehicle available"
              : `${estate.vehicles.inWorkshop} in the workshop`
          }
          tone={offRoad > 0 ? "amber" : "emerald"}
          href="/fleet/vehicles"
        />
        <StatTile
          label="Renewals due"
          value={String(fleet.attention.length)}
          hint={
            fleet.breaches.length > 0
              ? `${fleet.breaches.length} a legal breach`
              : fleet.attention.length === 0
                ? "All dates current"
                : "MOT, tax, insurance, service"
          }
          tone={
            fleet.breaches.length > 0
              ? "red"
              : fleet.attention.length > 0
                ? "amber"
                : "emerald"
          }
          href="/fleet/compliance"
        />
        <StatTile
          label="Out of action"
          value={String(equipment.unusableAssetCount)}
          hint={
            equipment.otherOpen.length > 0
              ? `${equipment.otherOpen.length} other open case${equipment.otherOpen.length === 1 ? "" : "s"}`
              : equipment.unusableAssetCount === 0
                ? "Nothing withdrawn from use"
                : "Broken down or blocked"
          }
          tone={equipment.unusableAssetCount > 0 ? "red" : "emerald"}
          href="/assets"
        />
        <StatTile
          label="Inspections overdue"
          value={String(inspections.overdue.length)}
          hint={
            inspections.upcoming.length > 0
              ? `${inspections.upcoming.length} more open`
              : "Nothing waiting"
          }
          tone={inspections.overdue.length > 0 ? "red" : "emerald"}
          href="/assets/inspections"
        />
        <StatTile
          label="Clashes today"
          value={String(schedule.imminent.length)}
          hint={
            schedule.total > schedule.imminent.length
              ? `${schedule.total} in the next ${window.days} days`
              : schedule.total === 0
                ? "Rota and jobs agree"
                : "Today and tomorrow"
          }
          tone={schedule.imminent.length > 0 ? "amber" : "emerald"}
          href="/staff/rota/conflicts"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard
            title="Vehicle dates"
            action={<CardLink href="/fleet/compliance">Compliance board</CardLink>}
          >
            {fleet.attention.length === 0 ? (
              <CardEmpty>
                {estate.vehicles.total === 0
                  ? "No vehicles on the register yet. Add one and its MOT, insurance and tax dates are watched from then on."
                  : "Nothing due. Every MOT, insurance, tax and service date on record is inside its window."}
              </CardEmpty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {fleet.attention.slice(0, OPS_CARD_LIMIT).map((row) => (
                  <ComplianceLine key={row.status.id} row={row} />
                ))}
              </ul>
            )}
            <More
              shown={Math.min(fleet.attention.length, OPS_CARD_LIMIT)}
              total={fleet.attention.length}
              href="/fleet/compliance"
              noun="renewal"
            />
          </SectionCard>

          <SectionCard
            title="Out of action"
            action={<CardLink href="/assets">Asset register</CardLink>}
          >
            {equipment.outOfService.length === 0 && equipment.safetyBlocked.length === 0 ? (
              <CardEmpty>
                {equipment.otherOpen.length > 0
                  ? `Nothing is withdrawn from use. ${equipment.otherOpen.length} maintenance case${equipment.otherOpen.length === 1 ? " is" : "s are"} open but the kit is still working.`
                  : "Everything on the register is available. Raise a maintenance case from an asset when something breaks."}
              </CardEmpty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {equipment.safetyBlocked.slice(0, OPS_CARD_LIMIT).map((row) => (
                  <SafetyLine key={row.assetId} row={row} />
                ))}
                {equipment.outOfService.slice(0, OPS_CARD_LIMIT).map((row) => (
                  <CaseLine key={row.caseId} row={row} />
                ))}
              </ul>
            )}
            <More
              shown={
                Math.min(equipment.safetyBlocked.length, OPS_CARD_LIMIT) +
                Math.min(equipment.outOfService.length, OPS_CARD_LIMIT)
              }
              total={equipment.safetyBlocked.length + equipment.outOfService.length}
              href="/assets"
              noun="item"
            />
          </SectionCard>

          <SectionCard
            title="Inspections"
            action={<CardLink href="/assets/inspections">All inspections</CardLink>}
          >
            {inspections.overdue.length === 0 && inspections.upcoming.length === 0 ? (
              <CardEmpty>
                Nothing due. Standing schedules raise inspections automatically each morning — set
                one up from an asset&apos;s page and they land here.
              </CardEmpty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {[...inspections.overdue, ...inspections.upcoming]
                  .slice(0, OPS_CARD_LIMIT)
                  .map((row) => (
                    <InspectionLine key={row.inspectionId} row={row} />
                  ))}
              </ul>
            )}
            <More
              shown={Math.min(
                inspections.overdue.length + inspections.upcoming.length,
                OPS_CARD_LIMIT,
              )}
              total={inspections.overdue.length + inspections.upcoming.length}
              href="/assets/inspections"
              noun="inspection"
            />
          </SectionCard>

          <SectionCard
            title="Today and tomorrow"
            action={<CardLink href="/staff/rota/conflicts">Schedule check</CardLink>}
          >
            {schedule.imminent.length === 0 ? (
              <CardEmpty>
                {schedule.total === 0
                  ? `No conflicts anywhere in the next ${window.days} days — the rota, the jobs, approved leave and plant custody all agree.`
                  : `Nothing clashes today or tomorrow. ${schedule.total} further ${schedule.total === 1 ? "conflict sits" : "conflicts sit"} inside the next ${window.days} days.`}
              </CardEmpty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {schedule.imminent.slice(0, OPS_CARD_LIMIT).map((c) => (
                  <li key={c.key}>
                    <Link href={c.href} className="block p-3 hover:bg-slate-50">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="min-w-0 text-sm font-medium text-slate-900">{c.title}</p>
                        <span className="shrink-0 text-xs font-medium text-slate-500">
                          {c.daysAway <= 0 ? "Today" : "Tomorrow"} · {formatConflictDay(c.day)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">{c.detail}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <More
              shown={Math.min(schedule.imminent.length, OPS_CARD_LIMIT)}
              total={schedule.imminent.length}
              href="/staff/rota/conflicts"
              noun="clash"
              plural="clashes"
            />
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title="The estate">
            <ul className="divide-y divide-slate-100 text-sm">
              <GlanceRow
                label="Vehicles"
                value={String(estate.vehicles.total)}
                hint={`${estate.vehicles.inService} in service`}
                href="/fleet/vehicles"
              />
              {/* Vehicles are assets with an extension row, so this count
                  INCLUDES them — the hint says so rather than implying two
                  separate registers. */}
              <GlanceRow
                label="Assets in use"
                value={String(estate.assets.active)}
                hint={
                  estate.assets.total > estate.assets.active
                    ? `Vans, plant and tools · ${estate.assets.total - estate.assets.active} sold, lost or retired`
                    : "Every van, machine and tool on the register"
                }
                href="/assets"
              />
              <GlanceRow
                label="Signed out"
                value={String(estate.assets.held)}
                hint={`${estate.assets.idle} sat in the yard`}
                href="/assets/holdings"
              />
            </ul>
          </SectionCard>

          <SectionCard
            title="Overdue back"
            action={<CardLink href="/assets/holdings">Holdings</CardLink>}
          >
            {custody.overdue.length === 0 ? (
              <CardEmpty>
                {custody.openTotal === 0
                  ? "Nothing is signed out. Check kit out from its asset page and it shows here."
                  : `Everything signed out is either inside its return date or has none set. ${custody.openTotal} item${custody.openTotal === 1 ? " is" : "s are"} out.`}
              </CardEmpty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {custody.overdue.slice(0, OPS_CARD_LIMIT).map((row) => (
                  <CustodyLine key={row.assignmentId} row={row} />
                ))}
              </ul>
            )}
            <More
              shown={Math.min(custody.overdue.length, OPS_CARD_LIMIT)}
              total={custody.overdue.length}
              href="/assets/holdings"
              noun="item"
            />
          </SectionCard>

          <SectionCard
            title="Running costs"
            action={<CardLink href="/fleet/fuel">Fuel and costs</CardLink>}
          >
            <ul className="divide-y divide-slate-100 text-sm">
              <GlanceRow
                label="Fuel logged"
                value={formatGbp(costs.fuel.spend)}
                hint={`${costs.fuel.entries} ${costs.fuel.entries === 1 ? "entry" : "entries"}`}
              />
              <GlanceRow
                label="Maintenance"
                value={formatGbp(costs.maintenanceSpend)}
                hint={isAdmin ? "Parts, labour and external work" : "Visible to owners and admins only"}
              />
              <GlanceRow
                label="Total recorded"
                value={formatGbp(costs.operatingCost)}
                hint="Fuel plus repairs only — not finance, insurance or depreciation."
                strong
              />
            </ul>
          </SectionCard>

          <SectionCard title={`Done in the last ${window.recentDays} days`}>
            {view.recentCompletions.length === 0 ? (
              <CardEmpty>
                No maintenance or compliance work has been signed off in the last{" "}
                {window.recentDays} days.
              </CardEmpty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {view.recentCompletions.slice(0, OPS_CARD_LIMIT).map((row) => (
                  <li key={row.caseId}>
                    <Link href={row.href} className="block p-3 hover:bg-slate-50">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-medium text-slate-900">
                          {row.assetName}
                        </p>
                        <span className="shrink-0 text-xs tabular-nums text-slate-500">
                          {(row.completedAt ?? "").slice(0, 10)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {row.typeLabel} · {row.title}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Read-only. Vehicle dates, inspections, maintenance, custody and schedule conflicts are all
        shown as their own screens compute them — nothing on this page is a second opinion, and
        nothing here changes anything.
      </p>
    </div>
  );
}

// ── Presentation ─────────────────────────────────────────────────────────────

function Header() {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Operations</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Everything you run, on one screen — vans, plant, inspections, who is holding what, and
          where the week disagrees with itself. Worst first.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/fleet"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Fleet
        </Link>
        <Link
          href="/assets"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Assets
        </Link>
        <Link
          href="/staff/rota/conflicts"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Schedule check
        </Link>
      </div>
    </header>
  );
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-xs font-medium text-slate-600 hover:text-slate-900">
      {children}
    </Link>
  );
}

function CardEmpty({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-sm text-slate-500">{children}</p>;
}

/** "Showing 6 of 19" — never a silent truncation. */
function More({
  shown,
  total,
  href,
  noun,
  plural,
}: {
  shown: number;
  total: number;
  href: string;
  noun: string;
  plural?: string;
}) {
  if (total <= shown) return null;
  const word = total === 1 ? noun : (plural ?? `${noun}s`);
  return (
    <div className="border-t border-slate-100 px-4 py-2.5">
      <Link href={href} className="text-xs font-medium text-slate-600 hover:text-slate-900">
        Showing {shown} of {total} {word} →
      </Link>
    </div>
  );
}

function FirstStep({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <li>
      <Link href={href} className="block p-4 hover:bg-slate-50">
        <p className="text-sm font-medium text-slate-900">{title}</p>
        <p className="mt-0.5 text-xs text-slate-500">{body}</p>
      </Link>
    </li>
  );
}

/**
 * A label/value fact row, optionally linking to the surface it came from.
 *
 * Renders as a list item, NOT a `<dt>`/`<dd>` pair. The definition-list markup
 * this used to emit was invalid and axe flagged it as two serious violations
 * (`definition-list` + `dlitem`, 9 nodes): a row that links wraps its own
 * `<dt>`/`<dd>` in an `<a>`, so the `<dl>` ended up with an `<a>` child and the
 * terms lost their required `<dl>` parent. A definition list cannot express "the
 * whole term/definition pair is one link", so this is a list of facts instead —
 * which is also what every other section on this page already uses. Boxes are
 * unchanged (`dt`/`dd`/`div` are all `display:block` and Tailwind's preflight
 * zeroes their margins), so the fix is invisible.
 */
function GlanceRow({
  label,
  value,
  hint,
  href,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  strong?: boolean;
}) {
  const body = (
    <div className="flex items-baseline justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className={strong ? "font-semibold text-slate-900" : "text-slate-700"}>{label}</div>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
      <div
        className={`shrink-0 tabular-nums ${
          strong ? "text-lg font-bold text-slate-900" : "font-medium text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
  return (
    <li>
      {href ? (
        <Link href={href} className="block hover:bg-slate-50">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

function ComplianceLine({ row }: { row: OpsComplianceRow }) {
  return (
    <li>
      <Link
        href={row.href}
        className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-slate-50"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{row.assetName}</p>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
            <Plate registration={row.registration} />
            {row.status.inService ? null : <span className="text-slate-500">not in service</span>}
          </p>
        </div>
        <CompliancePill
          type={row.status.type as FleetComplianceType}
          state={row.status.state}
          daysUntilDue={row.status.daysUntilDue}
          critical={row.status.severity === "critical"}
        />
      </Link>
    </li>
  );
}

function CaseLine({ row }: { row: OpsCaseRow }) {
  return (
    <li>
      <Link
        href={row.href}
        className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-slate-50"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{row.assetName}</p>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {row.typeLabel} · {row.title}
          </p>
        </div>
        <Badge tone="red" className="shrink-0">
          {row.statusLabel}
        </Badge>
      </Link>
    </li>
  );
}

function SafetyLine({ row }: { row: OpsSafetyRow }) {
  return (
    <li>
      <Link
        href={row.href}
        className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-slate-50"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{row.assetName}</p>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {row.blocks.length === 1
              ? row.blocks[0]!.inspection.title
              : `${row.blocks.length} failed safety inspections`}
          </p>
        </div>
        {/* A live block gets the emphatic solid fill; a recorded override is a
            warning, not a stop. `solid` is bg-red-700 (6.47:1 with white) where
            this previously used red-600 (4.83:1) — the same statement, further
            clear of the AA floor. */}
        <Badge
          tone={row.blocking ? "red" : "amber"}
          variant={row.blocking ? "solid" : "pill"}
          className="shrink-0 font-semibold"
        >
          {row.blocking ? "Blocked from issue" : "Override recorded"}
        </Badge>
      </Link>
    </li>
  );
}

function InspectionLine({ row }: { row: OpsInspectionRow }) {
  return (
    <li>
      <Link
        href={row.href}
        className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-slate-50"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{row.title}</p>
          <p className="mt-0.5 truncate text-xs text-slate-500">{row.assetName}</p>
        </div>
        {/* Overdue is a duty already missed; merely due is information. The soft
            blue fill is the same low-emphasis recipe this page shipped with. */}
        <Badge
          tone={row.overdue ? "red" : "blue"}
          variant={row.overdue ? "pill" : "soft"}
          className="shrink-0 tabular-nums"
        >
          {row.overdue ? "Was due" : "Due"} {row.dueAt}
        </Badge>
      </Link>
    </li>
  );
}

function CustodyLine({ row }: { row: OpsCustodyRow }) {
  return (
    <li>
      <Link href={row.href} className="block p-3 hover:bg-slate-50">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium text-slate-900">{row.assetName}</p>
          <Badge tone="red" className="shrink-0 tabular-nums">
            due back {row.expectedReturnAt}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">With {row.holderLabel}</p>
      </Link>
    </li>
  );
}
