/**
 * CrewFlow product navigation — the SINGLE SOURCE OF TRUTH for the app shell.
 *
 * The desktop sidebar, the mobile navigation, and the command palette all read
 * this one model, so the information architecture is defined in exactly one
 * place. Adding a destination here surfaces it in every navigation surface at
 * once — which is the mechanism that guarantees Rule #1 (nothing gets lost) and
 * fixes the mobile P0 (every authorised destination reachable on a phone).
 *
 * This module is PURE DATA — no React, no client boundary, no icon components
 * (icons are referenced by string key and resolved by _nav/icons.tsx on the
 * client). That keeps it importable from server components and from tests
 * (__tests__/nav/reachability.test.ts pins that every capability has a home).
 *
 * ── The eight primary areas ────────────────────────────────────────────────
 *   Home · Sales · Projects · Site & Safety · People · Money · Operations · Inbox
 * plus a demoted Settings (utility, gear at the foot of the nav) and Help/Support.
 * HQ/super-admin stays entirely out of this model — it is a separate, env-gated
 * surface and must never appear in a customer's navigation.
 *
 * Site & Safety is its OWN top-level area (not folded into Projects). Reasoning
 * is recorded in docs/ux-rebuild/LEDGER.md §"Site & Safety decision": it is the
 * highest-frequency field-worker domain, a legal/compliance domain that must be
 * one tap away, and it maps cleanly onto the site/foreman role — while the
 * per-job site records still live inside the job workspace (object-centric), so
 * this top-level area is the cross-job register view, not a duplicate.
 */

/** The membership roles the product recognises (public.memberships.role). */
export type NavRole = "owner" | "admin" | "staff";

/** All roles — the default visibility (any authenticated member). */
export const ALL_ROLES: readonly NavRole[] = ["owner", "admin", "staff"] as const;
/** Owner + admin only (the "business/back-office" surfaces). */
export const ADMIN_ROLES: readonly NavRole[] = ["owner", "admin"] as const;

export interface NavChild {
  /** en-GB label (kept byte-identical to today's labels where one exists). */
  label: string;
  /** i18n key (lib/i18n/catalog.ts). Falls back to `label` if unkeyed. */
  labelKey?: string;
  /** Route this destination opens. */
  href: string;
  /** Who sees it. Defaults to the parent area's roles when omitted. */
  roles?: readonly NavRole[];
  /** Extra search terms for the command palette (never rendered). */
  keywords?: string[];
}

export interface NavArea {
  /** Stable id — used for expand/collapse persistence + active detection. */
  id: string;
  label: string;
  labelKey?: string;
  /** The area's default landing route (clicking the area header goes here). */
  href: string;
  /** Icon key resolved by _nav/icons.tsx (a lucide-react icon). */
  icon: string;
  /** Who sees the area. */
  roles: readonly NavRole[];
  /** Second-level destinations, shown when the area is expanded/active. */
  children: NavChild[];
}

/**
 * PRIMARY_NAV — the eight areas. Order is deliberate: the daily operating loop
 * reads top to bottom (attention → win work → run the job → site → crew →
 * money → supply → talk to customers).
 */
export const PRIMARY_NAV: NavArea[] = [
  // Owner/admin land on the attention-first dashboard…
  {
    id: "home",
    label: "Home",
    labelKey: "nav.home",
    href: "/dashboard",
    icon: "LayoutDashboard",
    roles: ADMIN_ROLES,
    children: [],
  },
  // …staff land on their own day (the field home). Only one of these two shows
  // per role, so "Home" is never ambiguous.
  {
    id: "myday",
    label: "My day",
    labelKey: "nav.my_day",
    href: "/me",
    icon: "Clock",
    roles: ["staff"],
    children: [],
  },

  {
    id: "sales",
    label: "Sales",
    labelKey: "nav.sales",
    href: "/leads",
    icon: "TrendingUp",
    roles: ADMIN_ROLES,
    children: [
      { label: "Leads", labelKey: "nav.leads", href: "/leads", keywords: ["pipeline", "enquiry"] },
      { label: "Quotes", labelKey: "nav.quotes", href: "/quotes", keywords: ["estimate", "proposal"] },
      { label: "Customers", labelKey: "nav.customers", href: "/customers", keywords: ["client", "contact"] },
      { label: "Price book", labelKey: "nav.price_book", href: "/price-book", keywords: ["rates"] },
      { label: "Reviews", labelKey: "nav.reviews", href: "/reviews", keywords: ["reputation", "feedback"] },
    ],
  },

  {
    id: "projects",
    label: "Projects",
    labelKey: "nav.projects",
    href: "/jobs",
    icon: "Hammer",
    roles: ALL_ROLES,
    children: [
      { label: "Jobs", labelKey: "nav.jobs", href: "/jobs", keywords: ["project", "work"] },
      { label: "Calendar", labelKey: "nav.calendar", href: "/jobs/calendar", roles: ALL_ROLES, keywords: ["schedule", "diary"] },
      { label: "Job templates", labelKey: "nav.job_templates", href: "/jobs/templates", roles: ADMIN_ROLES },
    ],
  },

  // Its own area (see file header + ledger). Cross-job registers; per-job
  // records live in the job workspace's Site/Safety/Quality tabs.
  {
    id: "site-safety",
    label: "Site & safety",
    labelKey: "nav.site_safety",
    href: "/health-safety",
    icon: "ShieldCheck",
    roles: ALL_ROLES,
    children: [
      { label: "Health & safety", labelKey: "nav.health_safety", href: "/health-safety", roles: ADMIN_ROLES, keywords: ["rams", "risk assessment", "method statement"] },
      { label: "Permits", labelKey: "nav.permits", href: "/health-safety/permits", roles: ADMIN_ROLES, keywords: ["permit to work"] },
      { label: "Toolbox talks", labelKey: "nav.toolbox", href: "/toolbox", keywords: ["briefing"] },
      { label: "Site diary", labelKey: "nav.site_diary", href: "/diary", keywords: ["daily log"] },
      { label: "Snagging", labelKey: "nav.snagging", href: "/snags", keywords: ["defects", "punch list"] },
      { label: "Works quality", labelKey: "nav.quality", href: "/quality", keywords: ["itp", "inspection", "ncr", "hold point"] },
      { label: "Delays & EOT", labelKey: "nav.delays", href: "/delays", keywords: ["extension of time", "eot"] },
      { label: "Site reports", labelKey: "nav.site_reports", href: "/site-reports", roles: ADMIN_ROLES },
      { label: "Drawings", labelKey: "nav.drawings", href: "/blueprints", keywords: ["blueprints", "plans", "markup"] },
      { label: "Documents", labelKey: "nav.documents", href: "/documents", roles: ADMIN_ROLES },
      { label: "Site compliance", labelKey: "nav.site_compliance", href: "/site-compliance", keywords: ["induction", "muster", "visitor"] },
      { label: "Compliance library", labelKey: "nav.compliance", href: "/compliance", roles: ADMIN_ROLES, keywords: ["insurance", "certificates"] },
      { label: "Weather", labelKey: "nav.weather", href: "/weather", roles: ADMIN_ROLES, keywords: ["conditions", "forecast"] },
    ],
  },

  {
    id: "people",
    label: "People",
    labelKey: "nav.people",
    href: "/staff",
    icon: "Users",
    roles: ALL_ROLES,
    children: [
      { label: "Staff", labelKey: "nav.staff", href: "/staff", roles: ADMIN_ROLES, keywords: ["team", "workforce", "employees"] },
      { label: "Rota", labelKey: "nav.rota", href: "/staff/rota", roles: ADMIN_ROLES, keywords: ["schedule", "shifts"] },
      { label: "Leave", labelKey: "nav.leave", href: "/staff/leave", keywords: ["holiday", "absence"] },
      { label: "Payroll", labelKey: "nav.payroll", href: "/payroll", roles: ADMIN_ROLES, keywords: ["wages", "pay"] },
      { label: "My day", labelKey: "nav.my_day", href: "/me", roles: ["staff"], keywords: ["timesheet", "clock in"] },
    ],
  },

  {
    id: "money",
    label: "Money",
    labelKey: "nav.money",
    href: "/cash",
    icon: "PoundSterling",
    roles: ADMIN_ROLES,
    children: [
      { label: "Cash position", labelKey: "nav.cash", href: "/cash", keywords: ["overview", "money in", "money out"] },
      { label: "Invoices", labelKey: "nav.invoices", href: "/invoices", keywords: ["billing", "get paid"] },
      { label: "Payments", labelKey: "nav.payments", href: "/payments", keywords: ["bank", "reconcile", "reconciliation"] },
      { label: "Receipts", labelKey: "nav.expenses", href: "/expenses", keywords: ["expenses", "receipt capture", "supplier invoice", "approve"] },
      { label: "Costs", labelKey: "nav.finances", href: "/finances", keywords: ["finances", "spend", "cost log", "ledger", "journal"] },
      { label: "CIS", labelKey: "nav.cis", href: "/cis", keywords: ["subcontractor", "deductions", "rct"] },
      { label: "Tax", labelKey: "nav.tax", href: "/tax", keywords: ["vat", "paye", "mtd", "hmrc"] },
      { label: "Reports", labelKey: "nav.reports", href: "/reports", keywords: ["profit", "cashflow", "ageing", "pipeline"] },
      { label: "AI insights", labelKey: "nav.ai_insights", href: "/insights", keywords: ["intelligence", "company health"] },
    ],
  },

  {
    id: "operations",
    label: "Operations",
    labelKey: "nav.operations",
    href: "/operations",
    icon: "Boxes",
    roles: ADMIN_ROLES,
    children: [
      { label: "Overview", labelKey: "nav.operations", href: "/operations", keywords: ["what needs me"] },
      { label: "Assets", labelKey: "nav.assets", href: "/assets", keywords: ["plant", "equipment", "pat", "loler", "calibration"] },
      { label: "Fleet", labelKey: "nav.fleet", href: "/fleet", keywords: ["vehicles", "vans", "mot"] },
      { label: "Stock", labelKey: "nav.stock", href: "/stock", keywords: ["inventory", "warehouse", "stocktake"] },
      { label: "Materials", labelKey: "nav.material_requests", href: "/materials/requests", keywords: ["requests"] },
      { label: "Sites", labelKey: "nav.sites", href: "/sites", keywords: ["depots", "yards"] },
      { label: "Suppliers", labelKey: "nav.suppliers", href: "/suppliers", keywords: ["vendors", "merchants"] },
      { label: "Purchase orders", labelKey: "nav.purchase_orders", href: "/purchase-orders", keywords: ["po", "buying", "grn", "3-way"] },
    ],
  },

  {
    id: "inbox",
    label: "Inbox",
    labelKey: "nav.inbox",
    href: "/inbox",
    icon: "Inbox",
    roles: ADMIN_ROLES,
    children: [
      { label: "Enquiries", labelKey: "nav.inbox", href: "/inbox", keywords: ["messages"] },
      { label: "Conversations", labelKey: "nav.conversations", href: "/inbox/conversations", keywords: ["chat", "threads"] },
      { label: "Review queue", labelKey: "nav.review_queue", href: "/inbox/review" },
      { label: "Delivery audit", labelKey: "nav.delivery_audit", href: "/inbox/audit" },
    ],
  },
];

/**
 * UTILITY_NAV — demoted from the daily operating areas. Rendered separately
 * (foot of the sidebar / account menu on mobile) so it never competes with work.
 */
export const UTILITY_NAV: NavArea[] = [
  {
    id: "settings",
    label: "Settings",
    labelKey: "nav.settings",
    href: "/settings",
    icon: "Settings",
    roles: ALL_ROLES,
    children: [
      { label: "Settings home", labelKey: "nav.settings", href: "/settings" },
      { label: "Plan & billing", labelKey: "settings.billing.title", href: "/settings/billing", roles: ADMIN_ROLES },
      { label: "Security", labelKey: "settings.security.title", href: "/settings/security", roles: ADMIN_ROLES },
      { label: "Integrations", labelKey: "settings.integrations.title", href: "/settings/integrations", roles: ADMIN_ROLES },
      { label: "API keys", labelKey: "settings.api_keys.title", href: "/settings/api-keys", roles: ADMIN_ROLES },
      { label: "Webhooks", labelKey: "settings.webhooks.title", href: "/settings/webhooks", roles: ADMIN_ROLES },
      { label: "Automations", labelKey: "settings.automations.title", href: "/settings/automations", roles: ADMIN_ROLES },
      { label: "Data retention", labelKey: "settings.data_retention.title", href: "/settings/data-retention", roles: ADMIN_ROLES },
      { label: "Import data", labelKey: "nav.migrate_data", href: "/imports", roles: ADMIN_ROLES, keywords: ["migrate", "csv"] },
    ],
  },
  {
    id: "help",
    label: "Help",
    labelKey: "nav.help",
    href: "/help",
    icon: "LifeBuoy",
    roles: ALL_ROLES,
    children: [
      { label: "Help centre", labelKey: "nav.help", href: "/help" },
      { label: "Support", labelKey: "nav.support", href: "/support" },
    ],
  },
];

// ── Role filtering ───────────────────────────────────────────────────────────

function roleAllowed(roles: readonly NavRole[] | undefined, role: NavRole): boolean {
  return !roles || roles.includes(role);
}

/** The primary areas (with children) a given role should see. */
export function navForRole(role: NavRole, nav: NavArea[] = PRIMARY_NAV): NavArea[] {
  return nav
    .filter((a) => roleAllowed(a.roles, role))
    .map((a) => ({
      ...a,
      children: a.children.filter((c) => roleAllowed(c.roles ?? a.roles, role)),
    }));
}

/** Utility areas (Settings/Help) for a role. */
export function utilityForRole(role: NavRole): NavArea[] {
  return navForRole(role, UTILITY_NAV);
}

// ── Active-state detection ───────────────────────────────────────────────────

/** True when `pathname` is `href` or a nested route under it. */
export function isHrefActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The id of the primary area that owns `pathname`, or null. Uses the LONGEST
 * matching child href so `/jobs/[id]` resolves to Projects and `/staff/rota`
 * to People, even though several areas share a route prefix.
 */
export function activeAreaId(pathname: string, nav: NavArea[] = PRIMARY_NAV): string | null {
  let bestId: string | null = null;
  let bestLen = -1;
  for (const area of nav) {
    const hrefs = [area.href, ...area.children.map((c) => c.href)];
    for (const h of hrefs) {
      if (isHrefActive(pathname, h) && h.length > bestLen) {
        bestLen = h.length;
        bestId = area.id;
      }
    }
  }
  return bestId;
}

/** Every destination href in the model (primary + utility) — used by tests. */
export function allNavHrefs(): string[] {
  const out = new Set<string>();
  for (const area of [...PRIMARY_NAV, ...UTILITY_NAV]) {
    out.add(area.href);
    for (const c of area.children) out.add(c.href);
  }
  return [...out];
}

/**
 * The route an area HEADER should navigate to for a given (already role-filtered)
 * area — the first child the role can actually see, falling back to the area's
 * own href.
 *
 * Pass an area produced by `navForRole()` (its children are role-filtered). For
 * an owner/admin the first child equals `area.href` for every area, so their
 * landing is unchanged; for a `staff` member it prevents an area header from
 * dropping them onto an admin-only route their own sidebar deliberately hides —
 * e.g. "Site & safety" lands on the first staff-visible child (Toolbox talks),
 * not the admin RAMS register, and "People" on Leave, not the pay-bearing roster.
 * A row with no visible children keeps `area.href` (unreachable in practice —
 * such an area is filtered out of the sidebar entirely).
 */
export function areaLandingHref(area: NavArea): string {
  return area.children[0]?.href ?? area.href;
}
