"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Job workspace tab bar (product UX rebuild — object-centric job).
 *
 * Turns the job from a scroll of panels + scattered links into a workspace with
 * a persistent tab bar. Every tab points at an EXISTING job route — nothing is
 * rebuilt — and it de-orphans Valuations (applications for payment), which
 * previously had no inbound link at all.
 *
 * Kept as a local client component (reads the pathname for the active tab)
 * rather than a components/ui primitive, so the design system stays server-only
 * (the generic Tabs primitive is extracted in a later wave — see the ledger).
 */

const TABS: { label: string; sub: string; adminOnly?: boolean }[] = [
  { label: "Overview", sub: "" },
  // Commercial is margin/cost/profit — labour-cost-derived, so only owner/admin
  // can see a complete figure (staff_compensation makes co-worker pay admin-only,
  // 20261218); the page itself redirects non-admins. Hide the tab to match.
  { label: "Commercial", sub: "/commercial", adminOnly: true },
  { label: "Valuations", sub: "/valuations" },
  { label: "Billing", sub: "/billing" },
  { label: "Drawings", sub: "/blueprints" },
  { label: "Timeline", sub: "/timeline" },
  { label: "Certificate", sub: "/certificate" },
  { label: "Warranties", sub: "/warranties" },
];

export function JobTabs({ jobId, isAdmin = false }: { jobId: string; isAdmin?: boolean }) {
  const pathname = usePathname();
  const base = `/jobs/${jobId}`;

  return (
    <div className="border-b border-slate-200">
      <nav
        aria-label="Job sections"
        className="-mb-px flex gap-1 overflow-x-auto"
      >
        {TABS.filter((t) => isAdmin || !t.adminOnly).map((t) => {
          const href = `${base}${t.sub}`;
          const active =
            t.sub === ""
              ? pathname === base
              : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={t.label}
              href={href}
              aria-current={active ? "page" : undefined}
              className={[
                "whitespace-nowrap border-b-2 px-3 py-2 text-sm transition",
                active
                  ? "border-slate-900 font-semibold text-slate-900"
                  : "border-transparent font-medium text-slate-500 hover:text-slate-900",
              ].join(" ")}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
