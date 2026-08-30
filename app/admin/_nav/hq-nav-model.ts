/**
 * CrewFlow HQ navigation — the SINGLE SOURCE OF TRUTH for the internal
 * super-admin shell (product UX rebuild, HQ phase).
 *
 * Replaces the flat, emoji-prefixed 46-link list with a small, stable grouped
 * IA. Derived from docs/ux-rebuild/hq-audit.md §6 (Home · Decisions · Workforce ·
 * Operations · Governance · Systems), refined to SEVEN areas by splitting the
 * audit's two-lane "Operations" into **Growth** (pre-customer) and **Customers**
 * (post-sale) so no area is overloaded — the same evidence-led refinement used
 * for the product shell's eighth area.
 *
 * Pure data (no React/client boundary, no icon components — icons are string
 * keys resolved by hq-icons.tsx), so it is importable by the server layout and
 * unit tests. The desktop sidebar, the mobile drawer, and the flat HQ_NAV
 * back-compat projection all read this one model.
 *
 * Rule #1 (nothing gets lost): every one of the 46 current surfaces has a home
 * here. The AI-employee cockpits are grouped by the DOMAIN their work serves
 * (Support AI → Customers, Marketing AI → Growth, CTO AI → Systems), per the
 * audit's "group by lifecycle, not by which AI produced the work" principle;
 * per-employee detail remains reachable from the Boardroom roster.
 */

export interface HqNavChild {
  href: string;
  label: string;
  /** Optional live badge source, wired by the layout (support/notifications). */
  badge?: "support" | "notifications";
}

export interface HqNavArea {
  id: string;
  label: string;
  /** Icon key resolved by hq-icons.tsx (a lucide-react icon). */
  icon: string;
  /** Default landing route when the area header is clicked. */
  href: string;
  children: HqNavChild[];
}

export const HQ_AREAS: HqNavArea[] = [
  {
    id: "home",
    label: "Home",
    icon: "LayoutDashboard",
    // The new executive front door (app/admin/page.tsx). Longest-match active
    // resolution means "/admin" only wins for the exact path; every deeper
    // route resolves to its own (longer) area href.
    href: "/admin",
    children: [
      { href: "/admin", label: "Home" },
      { href: "/admin/command-centre", label: "Command centre" },
      { href: "/admin/ceo", label: "CEO board" },
      { href: "/admin/ceo/briefings", label: "Morning briefings" },
      { href: "/admin/overview", label: "Overview" },
      { href: "/admin/pulse", label: "Pulse (activity)" },
    ],
  },
  {
    id: "decisions",
    label: "Decisions",
    icon: "Gavel",
    href: "/admin/executive-assistant-ai",
    children: [
      { href: "/admin/executive-assistant-ai", label: "What needs you" },
      { href: "/admin/approvals", label: "Approvals" },
      { href: "/admin/decisions", label: "Decision centre" },
      { href: "/admin/workflow-sagas", label: "Workflow sagas" },
    ],
  },
  {
    id: "workforce",
    label: "Workforce",
    icon: "Users",
    href: "/admin/ai-boardroom",
    children: [
      { href: "/admin/ai-boardroom", label: "AI Boardroom" },
      { href: "/admin/tasks", label: "Task queue" },
      { href: "/admin/memory", label: "Shared memory" },
    ],
  },
  {
    id: "growth",
    label: "Growth",
    icon: "TrendingUp",
    href: "/admin/sales",
    children: [
      { href: "/admin/sales", label: "Sales AI" },
      { href: "/admin/sales-orchestrator-ai", label: "Sales orchestrator" },
      { href: "/admin/research", label: "Research AI" },
      { href: "/admin/qualification", label: "Qualification AI" },
      { href: "/admin/outreach", label: "Outreach AI" },
      { href: "/admin/marketing-ai", label: "Marketing AI" },
      { href: "/admin/product-ai", label: "Product AI" },
      { href: "/admin/demos", label: "Demos" },
      { href: "/admin/organizations", label: "Signups & intake" },
      { href: "/admin/ai-receptionist", label: "AI Receptionist" },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    icon: "Building2",
    href: "/admin/customers",
    children: [
      { href: "/admin/customers", label: "Customers" },
      { href: "/admin/onboarding", label: "Onboarding & migration" },
      { href: "/admin/billing", label: "Billing" },
      { href: "/admin/finance", label: "Finance AI" },
      { href: "/admin/support", label: "Support queue", badge: "support" },
      { href: "/admin/support-ai", label: "Support AI" },
      { href: "/admin/customer-success-ai", label: "Customer success AI" },
      { href: "/admin/health", label: "Customer health" },
      { href: "/admin/alerts", label: "Alerts" },
      { href: "/admin/notifications", label: "Notifications", badge: "notifications" },
      { href: "/admin/notes", label: "Internal notes" },
    ],
  },
  {
    id: "governance",
    label: "Governance",
    icon: "ShieldCheck",
    href: "/admin/executor-shadow",
    children: [
      { href: "/admin/executor-shadow", label: "Executor shadow" },
      { href: "/admin/hq-cadence", label: "Cadence clock" },
      { href: "/admin/automations", label: "Automations" },
      { href: "/admin/ai-costs", label: "AI cost governance" },
    ],
  },
  {
    id: "systems",
    label: "Systems",
    icon: "Server",
    href: "/admin/ops",
    children: [
      { href: "/admin/ops", label: "System status" },
      { href: "/admin/analytics", label: "Analytics" },
      { href: "/admin/cto-ai", label: "CTO AI" },
      { href: "/admin/design-ai", label: "Design AI" },
      { href: "/admin/documentation-ai", label: "Documentation AI" },
      { href: "/admin/qa-ai", label: "QA AI" },
      { href: "/admin/operations-ai", label: "Operations AI" },
      { href: "/admin/impersonation", label: "Impersonation" },
      { href: "/admin/launch-checklist", label: "Launch checklist" },
      { href: "/admin/settings", label: "Settings" },
    ],
  },
];

/** True when `pathname` is `href` or a nested route under it. */
export function isHqHrefActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The id of the area that owns `pathname` (longest matching href wins). */
export function activeHqAreaId(pathname: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const area of HQ_AREAS) {
    for (const h of [area.href, ...area.children.map((c) => c.href)]) {
      if (isHqHrefActive(pathname, h) && h.length > bestLen) {
        bestLen = h.length;
        best = area.id;
      }
    }
  }
  return best;
}

/**
 * Flat projection of every destination — back-compat for the exported HQ_NAV
 * that several HQ tests import from app/admin/layout.tsx. Every entry is a live
 * page — the rebuild retired the old roadmap-stub concept entirely.
 */
export function flatHqNav(): ReadonlyArray<{ href: string; label: string }> {
  const seen = new Set<string>();
  const out: { href: string; label: string }[] = [];
  for (const area of HQ_AREAS) {
    for (const c of area.children) {
      if (seen.has(c.href)) continue;
      seen.add(c.href);
      out.push({ href: c.href, label: c.label });
    }
  }
  return out;
}
