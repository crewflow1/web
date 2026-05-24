import Link from "next/link";
import type { PortalCustomer, PortalOrg } from "../_helpers";

/**
 * Shared portal shell: header (org branding + customer name), tab nav,
 * and a wrapping container. Public-facing — no app sidebar / chrome.
 *
 * Each tab is a route, not a client component, so the customer can
 * deep-link or refresh into any section without losing state.
 */

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
  active: "overview" | "quotes" | "invoices" | "jobs" | "messages";
  children: React.ReactNode;
}) {
  const tabs = [
    { id: "overview" as const, href: `/customer-portal/${token}`, label: "Overview" },
    { id: "quotes" as const, href: `/customer-portal/${token}/quotes`, label: "Quotes" },
    { id: "invoices" as const, href: `/customer-portal/${token}/invoices`, label: "Invoices" },
    { id: "jobs" as const, href: `/customer-portal/${token}/jobs`, label: "Jobs" },
    { id: "messages" as const, href: `/customer-portal/${token}/messages`, label: "Messages" },
  ];

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
              className="self-start rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 sm:self-auto"
            >
              Call {org.name}
            </a>
          ) : null}
        </div>
        <nav className="mx-auto max-w-3xl px-4">
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

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">{children}</main>

      <footer className="pb-8 pt-4 text-center text-xs text-slate-400">
        Powered by CrewFlow
      </footer>
    </div>
  );
}
