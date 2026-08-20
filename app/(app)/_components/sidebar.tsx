"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createTranslator } from "@/lib/i18n";

/**
 * App sidebar navigation.
 *
 * Client component because we read pathname to highlight the active link.
 * Mobile: hidden behind the header (md:block).
 *
 * Role scoping (Wave 4): staff see a slim nav focused on their day —
 * My day / Jobs / Leave. Owners/admins see the full business surface.
 *
 * i18n: labels are message KEYS resolved through a translator built from the
 * negotiated `locale` prop (server → layout → here). The translator is pure and
 * isomorphic, so it runs client-side; for en-GB every key resolves to the exact
 * prior English label (byte-identical). A non-en-GB locale renders any overridden
 * key from its catalogue and falls back to en-GB per key.
 */

const ADMIN_LINKS = [
  { href: "/dashboard", labelKey: "nav.dashboard" },
  // Renamed from "Get paid" when /cash gained the money-OUT side and a net
  // position: the page now answers "where do we stand", not just "who owes us".
  { href: "/cash", labelKey: "nav.cash" },
  // One inbox: the /inbox area now carries a tab bar (enquiries · conversations
  // · review queue · delivery audit), so the sidebar needs a single entry rather
  // than one per surface.
  { href: "/inbox", labelKey: "nav.inbox" },
  { href: "/leads", labelKey: "nav.leads" },
  { href: "/jobs", labelKey: "nav.jobs" },
  { href: "/snags", labelKey: "nav.snagging" },
  { href: "/diary", labelKey: "nav.site_diary" },
  { href: "/toolbox", labelKey: "nav.toolbox" },
  { href: "/health-safety", labelKey: "nav.health_safety" },
  // Works quality (ITPs) sits beside H&S, not under Snagging: snags are defects
  // FOUND after the fact, an ITP is the plan that proves the works were built
  // right in the first place. Different question, opposite direction.
  { href: "/quality", labelKey: "nav.quality" },
  // Delays & EOT sits beside quality: both are contemporaneous-record
  // registers — one proves the works were built right, the other proves what
  // stopped them. The evidence log behind any extension-of-time claim.
  { href: "/delays", labelKey: "nav.delays" },
  // Weather sits with health & safety, not with the estate: the limits it
  // applies are wind/frost/rain limits from WAHR 2005, LOLER 1998 and CDM 2015,
  // and the question it answers ("can this work happen safely today") is the
  // same question the surfaces above it answer. Ships DARK — no provider is
  // connected, and the page says so rather than showing a forecast it has not got.
  { href: "/weather", labelKey: "nav.weather" },
  { href: "/site-reports", labelKey: "nav.site_reports" },
  // The drawing register across every job (the Blueprint Centre). The full
  // viewer/compare/markup experience stays job-scoped at /jobs/[id]/blueprints;
  // this top-level entry is the org-wide index into it. Sits with the other
  // document-shaped surfaces (site reports, documents).
  { href: "/blueprints", labelKey: "nav.drawings" },
  // Org-wide document home: aggregates per-job documents + the universal
  // attachment store into one searchable list. Sits after Site reports (the
  // other document-shaped surface) and before the commercial group.
  { href: "/documents", labelKey: "nav.documents" },
  { href: "/customers", labelKey: "nav.customers" },
  { href: "/quotes", labelKey: "nav.quotes" },
  { href: "/price-book", labelKey: "nav.price_book" },
  { href: "/suppliers", labelKey: "nav.suppliers" },
  { href: "/purchase-orders", labelKey: "nav.purchase_orders" },
  { href: "/expenses", labelKey: "nav.expenses" },
  { href: "/finances", labelKey: "nav.finances" },
  { href: "/invoices", labelKey: "nav.invoices" },
  { href: "/payments", labelKey: "nav.payments" },
  { href: "/payroll", labelKey: "nav.payroll" },
  { href: "/cis", labelKey: "nav.cis" },
  { href: "/tax", labelKey: "nav.tax" },
  { href: "/staff", labelKey: "nav.staff" },
  // Operations heads the estate group: the cross-cutting "what needs me" view,
  // then the registers it reads from.
  { href: "/operations", labelKey: "nav.operations" },
  { href: "/assets", labelKey: "nav.assets" },
  { href: "/fleet", labelKey: "nav.fleet" },
  // Stock sits with the estate, between the registers of THINGS (assets, fleet)
  // and the register of PLACES (sites) — it is the one that joins them: a
  // quantity of a thing, at a place. Not under Purchase orders: buying and
  // holding are different questions, and the stock you hold outlives the order
  // it arrived on.
  { href: "/stock", labelKey: "nav.stock" },
  { href: "/materials/requests", labelKey: "nav.material_requests" },
  // The company's own places (depots, yards, lock-ups) — reference data both
  // registers above point at. NOT customer job sites, which live on the job.
  { href: "/sites", labelKey: "nav.sites" },
  // Per-site inductions, visitor log and live fire-muster roll. Sits by Sites
  // (the register of places) because it operates ON those places, and by H&S in
  // spirit — the gate that puts a worker onto a site and accounts for everyone
  // on it. Distinct from /compliance (the org's insurance/certificate library).
  { href: "/site-compliance", labelKey: "nav.site_compliance" },
  { href: "/compliance", labelKey: "nav.compliance" },
  { href: "/reviews", labelKey: "nav.reviews" },
  { href: "/imports", labelKey: "nav.migrate_data" },
  { href: "/reports", labelKey: "nav.reports" },
  { href: "/insights", labelKey: "nav.ai_insights" },
  { href: "/notifications", labelKey: "nav.notifications" },
  { href: "/help", labelKey: "nav.help" },
  { href: "/support", labelKey: "nav.support" },
  { href: "/settings", labelKey: "nav.settings" },
];

const STAFF_LINKS = [
  { href: "/me", labelKey: "nav.my_day" },
  { href: "/jobs", labelKey: "nav.jobs" },
  { href: "/snags", labelKey: "nav.snagging" },
  { href: "/diary", labelKey: "nav.site_diary" },
  { href: "/toolbox", labelKey: "nav.toolbox" },
  // Site staff read drawings on site (view / compare revisions / mark up), so the
  // register belongs in the slim nav too. Links to the org-wide index; the viewer
  // itself stays job-scoped.
  { href: "/blueprints", labelKey: "nav.drawings" },
  // Site staff run the gate: they induct operatives, sign visitors in/out and
  // pull the muster when the alarm goes. This is site work, so it is in the slim
  // nav too.
  { href: "/site-compliance", labelKey: "nav.site_compliance" },
  // Staff need this: the person signing off a hold point on site IS site staff.
  { href: "/quality", labelKey: "nav.quality" },
  // ...and the person standing in the rain when work stops is the one who
  // should log it the same day. Recording delays is site work.
  { href: "/delays", labelKey: "nav.delays" },
  { href: "/staff/leave", labelKey: "nav.leave" },
  { href: "/notifications", labelKey: "nav.notifications" },
  { href: "/help", labelKey: "nav.help" },
  { href: "/support", labelKey: "nav.support" },
  { href: "/settings", labelKey: "nav.settings" },
];

export function Sidebar({
  role = "owner",
  locale = "en-GB",
}: {
  role?: string;
  locale?: string;
}) {
  const pathname = usePathname();
  const { t } = createTranslator(locale);
  const LINKS = role === "staff" ? STAFF_LINKS : ADMIN_LINKS;

  return (
    <nav
      aria-label="Primary"
      className="hidden md:block w-56 shrink-0 border-r border-slate-200 bg-white px-3 py-4"
    >
      <ul className="space-y-1">
        {LINKS.map((link) => {
          // active if pathname matches exactly OR is a nested route under it
          const isActive =
            pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={
                  isActive
                    ? "block rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                    : "block rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                }
              >
                {t(link.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
