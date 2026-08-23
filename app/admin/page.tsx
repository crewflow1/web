import { Suspense } from "react";
import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { PageHeader } from "@/components/ui/page-header";
import {
  NeedsYou,
  ActiveNow,
  RecentOutcomes,
  CeoBrief,
  SystemHealth,
  HomeSectionSkeleton,
} from "./_components/hq-home";

/**
 * HQ Home — the canonical executive front door (product UX rebuild, HQ phase).
 *
 * Replaces the old `/admin → /admin/command-centre` redirect. Where HQ used to
 * open onto one of five different dashboard-like destinations, it now opens onto
 * ONE attention-first page that answers, in ~10 seconds: what needs me, what's
 * happening, what just finished, the CEO brief, and whether anything's wrong.
 *
 * The five former landings keep their deep functionality as SECONDARY views
 * (linked at the foot): Command centre (company metrics), CEO board
 * (departmental drill-down), Morning briefings (the brief archive), Overview,
 * and Pulse (the full activity feed).
 *
 * Attention, not metrics — no vanity charts here. Every section is real HQ data
 * and streams independently; the layout already gates on requireHqPage, and this
 * page re-gates for defence-in-depth (same as the other HQ pages).
 */

export const dynamic = "force-dynamic";

const SECONDARY = [
  { href: "/admin/command-centre", label: "Command centre", sub: "Company metrics" },
  { href: "/admin/ceo", label: "CEO board", sub: "Departments" },
  { href: "/admin/ceo/briefings", label: "Morning briefings", sub: "Brief archive" },
  { href: "/admin/overview", label: "Overview", sub: "KPI snapshot" },
  { href: "/admin/pulse", label: "Pulse", sub: "Activity feed" },
];

export default async function HqHomePage() {
  const user = await requireHqPage();
  const firstName = (user.email ?? "").split("@")[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="HQ Home"
        description={`Welcome back${firstName ? `, ${firstName}` : ""} — what needs you, what's happening, and what just finished.`}
      />

      {/* A. Needs your attention — the most important thing, full width. */}
      <Suspense fallback={<HomeSectionSkeleton title="Needs your attention" />}>
        <NeedsYou />
      </Suspense>

      {/* B–E in a two-column reading order (stacks on mobile). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Suspense fallback={<HomeSectionSkeleton title="Active now" />}>
            <ActiveNow />
          </Suspense>
          <Suspense fallback={<HomeSectionSkeleton title="Recent outcomes" />}>
            <RecentOutcomes />
          </Suspense>
        </div>
        <div className="space-y-6">
          <Suspense fallback={<HomeSectionSkeleton title="CEO brief" />}>
            <CeoBrief />
          </Suspense>
          <Suspense fallback={<HomeSectionSkeleton title="System health" />}>
            <SystemHealth />
          </Suspense>
        </div>
      </div>

      {/* The five former landings, kept as secondary deep views. */}
      <section>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Deeper views
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {SECONDARY.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition hover:border-slate-300 hover:shadow"
            >
              <p className="text-sm font-medium text-slate-900">{s.label}</p>
              <p className="mt-0.5 text-xs text-slate-500">{s.sub}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
