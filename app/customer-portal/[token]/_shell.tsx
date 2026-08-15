import Link from "next/link";
import type { PortalCustomer, PortalOrg } from "../_helpers";

/**
 * Shared portal shell: header (org branding + customer name), tab nav,
 * and a wrapping container. Public-facing — no app sidebar / chrome.
 *
 * Each tab is a route, not a client component, so the customer can
 * deep-link or refresh into any section without losing state.
 *
 * NAVIGATION (Train 4). Eleven tabs no longer fit a phone:
 *  - ≥ sm: the familiar horizontal tab strip (unchanged pattern).
 *  - < sm: a fixed bottom nav with the four primary destinations plus a
 *    "More" disclosure listing the rest. Server-rendered and JS-free —
 *    <details>/<summary> is the accessible disclosure pattern the platform
 *    gives us for free (keyboard + screen-reader support without a client
 *    component). Every target is ≥ 44px; aria-current="page" marks the
 *    active link in BOTH navs; the sheet never widens the body (no
 *    horizontal scroll at 375px).
 */

type TabId =
  | "overview"
  | "quotes"
  | "invoices"
  | "jobs"
  | "photos"
  | "reports"
  | "warranties"
  | "servicing"
  | "documents"
  | "messages"
  | "requests"
  | "contacts"
  | "profile";

/** The four destinations that earn a permanent slot on the phone bottom bar. */
const PRIMARY_TAB_IDS: readonly TabId[] = [
  "overview",
  "jobs",
  "invoices",
  "messages",
];

export function PortalShell({
  customer,
  org,
  token,
  active,
  children,
}: {
  customer: PortalCustomer;
  org: PortalOrg;
  token: string;
  active: TabId;
  children: React.ReactNode;
}) {
  const base = `/customer-portal/${token}`;
  const tabs: Array<{ id: TabId; href: string; label: string }> = [
    { id: "overview", href: base, label: "Overview" },
    { id: "quotes", href: `${base}/quotes`, label: "Quotes" },
    { id: "invoices", href: `${base}/invoices`, label: "Invoices" },
    { id: "jobs", href: `${base}/jobs`, label: "Jobs" },
    { id: "photos", href: `${base}/photos`, label: "Photos" },
    { id: "reports", href: `${base}/reports`, label: "Reports" },
    { id: "warranties", href: `${base}/warranties`, label: "Warranties" },
    { id: "servicing", href: `${base}/servicing`, label: "Servicing" },
    { id: "documents", href: `${base}/documents`, label: "Documents" },
    { id: "messages", href: `${base}/messages`, label: "Messages" },
    { id: "requests", href: `${base}/requests`, label: "Requests" },
    { id: "contacts", href: `${base}/contacts`, label: "Contacts" },
    { id: "profile", href: `${base}/profile`, label: "Profile" },
  ];

  const primaryTabs = tabs.filter((t) => PRIMARY_TAB_IDS.includes(t.id));
  const moreTabs = tabs.filter((t) => !PRIMARY_TAB_IDS.includes(t.id));
  const moreIsActive = moreTabs.some((t) => t.id === active);

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:py-5">
          <div className="flex items-center gap-3 min-w-0">
            {org.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={org.logo_url}
                alt={`${org.name} logo`}
                className="h-9 w-9 shrink-0 rounded-md object-contain"
              />
            ) : null}
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {org.name}
              </div>
              <h1 className="truncate text-base font-semibold text-slate-900 sm:text-lg">
                Hello, {customer.name.split(" ")[0] ?? customer.name}
              </h1>
            </div>
          </div>
          {org.phone ? (
            <a
              href={`tel:${org.phone}`}
              className="flex min-h-[44px] items-center self-start rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 sm:self-auto"
            >
              Call {org.name}
            </a>
          ) : null}
        </div>
        {/* Desktop / tablet: the horizontal tab strip. Hidden on phones — the
            bottom nav below takes over there. */}
        <nav aria-label="Portal sections" className="mx-auto hidden max-w-3xl px-4 sm:block">
          <ul className="-mb-px flex gap-1 overflow-x-auto text-sm">
            {tabs.map((t) => (
              <li key={t.id}>
                <Link
                  href={t.href}
                  aria-current={t.id === active ? "page" : undefined}
                  className={
                    t.id === active
                      ? "block border-b-2 border-slate-900 px-3 py-2 font-medium text-slate-900"
                      : "block border-b-2 border-transparent px-3 py-2 text-slate-600 hover:border-slate-300 hover:text-slate-900"
                  }
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {/* pb-24 on phones clears the fixed bottom nav; sm+ needs none. */}
      <main className="mx-auto max-w-3xl space-y-4 px-4 pb-24 pt-6 sm:pb-6">
        {children}
      </main>

      <footer className="pb-28 pt-4 text-center text-xs text-slate-600 sm:pb-8">
        Powered by CrewFlow
      </footer>

      {/* Phone: fixed bottom navigation — 4 primary tabs + a "More" sheet. */}
      <nav
        aria-label="Portal sections"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        <ul className="grid grid-cols-5">
          {primaryTabs.map((t) => (
            <li key={t.id}>
              <Link
                href={t.href}
                aria-current={t.id === active ? "page" : undefined}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 text-[11px] ${
                  t.id === active
                    ? "font-semibold text-slate-900"
                    : "font-medium text-slate-500"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1 w-8 rounded-full ${t.id === active ? "bg-slate-900" : "bg-transparent"}`}
                />
                {t.label}
              </Link>
            </li>
          ))}
          <li>
            <details className="relative">
              <summary
                className={`flex min-h-[56px] cursor-pointer list-none flex-col items-center justify-center gap-0.5 px-1 text-[11px] [&::-webkit-details-marker]:hidden ${
                  moreIsActive
                    ? "font-semibold text-slate-900"
                    : "font-medium text-slate-500"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1 w-8 rounded-full ${moreIsActive ? "bg-slate-900" : "bg-transparent"}`}
                />
                More
              </summary>
              <div className="absolute bottom-full right-1 z-50 mb-2 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                <ul>
                  {moreTabs.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={t.href}
                        aria-current={t.id === active ? "page" : undefined}
                        className={`flex min-h-[44px] items-center rounded-lg px-3 text-sm ${
                          t.id === active
                            ? "bg-slate-100 font-semibold text-slate-900"
                            : "font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                        }`}
                      >
                        {t.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </li>
        </ul>
      </nav>
    </div>
  );
}
