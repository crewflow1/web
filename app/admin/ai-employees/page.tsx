import Link from "next/link";
import { Boxes, Layers, Lock, Users } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { getEmployeeRoster } from "@/server/services/ai-employee-profiles";
import { departmentLabel, statusLabel } from "@/lib/ai-employees/model";
import { formatRate } from "@/lib/ai-employees/stats";
import {
  Badge,
  Card,
  FadeIn,
  GlowHeader,
  Stagger,
  StaggerItem,
  StatTile,
  Surface,
} from "@/components/ui";
import { toDesignAccent } from "@/components/ai-employees/styles";
import { AvatarTile, FrameworkBadge, HealthPill } from "./_components";

/**
 * AI Employees — the workforce roster (CEO Directive 007, Phase 1).
 *
 * The management surface for the reusable Employee SDK. Every card is one
 * `AIEmployee` configuration composed through the SAME six-dimension framework —
 * the page exists to prove the architecture supports many employee types from
 * one base class. Live `ai_employees` data binds onto runtime / performance
 * where it exists; otherwise an honest "foundation" baseline shows through.
 *
 * FRAMEWORK ONLY — no employee executes anything. The header says so.
 *
 * HQ-gated at the layout; this page re-calls `requireHqPage()` (the single
 * HQ page gate — 404 for non-super-admins) for defence-in-depth.
 */

export const dynamic = "force-dynamic";

export default async function AiEmployeesPage() {
  await requireHqPage();

  const roster = await getEmployeeRoster();

  const total = roster.length;
  const seeded = roster.filter((r) => r.seeded).length;
  const departments = new Set(roster.map((r) => r.employee.department)).size;

  return (
    <Surface>
      <GlowHeader
        icon={<Users className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
        eyebrow="Employee SDK"
        title="AI Employees"
        subtitle="Every employee is one configuration on a single reusable framework — the same six dimensions, the same base class. Adding a new hire is configuration, not another system."
        actions={<FrameworkBadge />}
      />

      <div className="space-y-6 p-5 sm:p-7">
        {/* Framework summary — honest, derived from the roster itself */}
        <FadeIn>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Employees"
              value={String(total)}
              sub="on the framework"
              accent="indigo"
              icon={<Users className="h-4 w-4" />}
            />
            <StatTile
              label="Departments"
              value={String(departments)}
              sub="covered by the roster"
              accent="violet"
              icon={<Layers className="h-4 w-4" />}
            />
            <StatTile
              label="Seeded"
              value={`${seeded}/${total}`}
              sub="backed by a live row"
              accent="sky"
              icon={<Boxes className="h-4 w-4" />}
            />
            <StatTile
              label="Execution"
              value="Locked"
              sub="human-approved, gated"
              accent="amber"
              icon={<Lock className="h-4 w-4" />}
            />
          </div>
        </FadeIn>

        {/* Roster grid */}
        <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {roster.map(({ employee, profile, seeded }) => {
            const ds = toDesignAccent(employee.identity().avatar.accent);
            const id = profile.identity;
            const perf = profile.performance;
            return (
              <StaggerItem key={employee.slug}>
                <Link
                  href={`/admin/ai-employees/${employee.slug}`}
                  className="block h-full rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <Card accent={ds} glow className="h-full">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <AvatarTile avatar={id.avatar} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-900 dark:text-white">
                            {id.name}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {id.role}
                          </p>
                        </div>
                      </div>
                      <HealthPill health={profile.runtime.health} />
                    </div>

                    <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-slate-500">
                      {id.tagline}
                    </p>

                    <div className="mt-4 flex flex-wrap items-center gap-1.5">
                      <Badge accent={ds} soft>
                        {departmentLabel(id.department)}
                      </Badge>
                      <Badge accent="slate" soft>
                        {profile.configuration.model.name}
                      </Badge>
                      {profile.foundation ? (
                        <Badge accent="amber" soft>
                          Foundation
                        </Badge>
                      ) : null}
                    </div>

                    <div className="mt-auto grid grid-cols-3 gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                      <MiniStat
                        label="State"
                        value={statusLabel(profile.runtime.state)}
                      />
                      <MiniStat label="Done" value={String(perf.tasksCompleted)} />
                      <MiniStat
                        label="Success"
                        value={formatRate(perf.successRate)}
                      />
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                        {seeded ? "Seeded" : "Foundation"}
                      </span>
                      <span className="text-xs font-medium text-slate-400 transition group-hover:text-slate-900 dark:group-hover:text-white">
                        Open →
                      </span>
                    </div>
                  </Card>
                </Link>
              </StaggerItem>
            );
          })}
        </Stagger>
      </div>
    </Surface>
  );
}

/** A compact label/value cell inside a roster card's telemetry strip. */
function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm font-bold tabular-nums text-slate-700 dark:text-slate-200">
        {value}
      </p>
    </div>
  );
}
