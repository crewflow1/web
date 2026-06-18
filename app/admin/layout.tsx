import { notFound } from "next/navigation";
import { NOINDEX_METADATA } from "@/lib/seo/metadata";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { countOpenSupportTicketsForHq } from "@/server/services/hq-support-snapshot";
import { badgeText } from "@/lib/hq/support";
import { getUnreadCountForHq } from "@/server/services/notifications-service";
import { badgeText as notifBadgeText } from "@/lib/notifications/sort";
import { PageTransition } from "@/components/ui";
import { HqNavMobile } from "./_nav-mobile";
import { NavLink } from "./_nav-link";

/**
 * CrewFlow HQ — internal operating system for the team running CrewFlow.
 *
 * NOT the customer product. Gated at this layout level so every child
 * route inherits the 404-for-non-allowlisted rule; the existing
 * /admin/organizations page also calls `notFound()` itself for
 * defence-in-depth.
 *
 * Sidebar carries all 12 sections from the directive. Sections not yet
 * built render a "Coming in HQ Sprint N" stub — no dead ends.
 */

type NavItem = {
  href: string;
  label: string;
  /** When true, the link routes to the legacy /admin/organizations
   *  panel while the dedicated section is on the roadmap. */
  legacy?: boolean;
  /** Sprint number that ships the dedicated page. Stubs render until. */
  shipsIn?: "HQ-2" | "HQ-3" | "HQ-4" | "HQ-5" | "HQ-6";
};

export const HQ_NAV: ReadonlyArray<NavItem> = [
  { href: "/admin/command-centre", label: "⚡ Command Centre" },
  { href: "/admin/ceo", label: "👑 CEO Dashboard" },
  { href: "/admin/overview", label: "Overview" },
  { href: "/admin/ai-boardroom", label: "🧠 AI Boardroom" },
  { href: "/admin/memory", label: "📚 Shared Memory" },
  { href: "/admin/sales", label: "💼 Sales AI" },
  { href: "/admin/research", label: "🔬 Research AI" },
  { href: "/admin/demos", label: "Demos CRM" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/onboarding", label: "Onboarding & migration" },
  { href: "/admin/ai-receptionist", label: "AI Receptionist setups" },
  { href: "/admin/billing", label: "Billing" },
  { href: "/admin/support", label: "Support queue" },
  { href: "/admin/notifications", label: "Notifications" },
  { href: "/admin/alerts", label: "Alerts" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/impersonation", label: "Impersonation log" },
  { href: "/admin/notes", label: "Internal notes" },
  { href: "/admin/health", label: "Customer health" },
  { href: "/admin/ops", label: "Ops" },
  { href: "/admin/automations", label: "Automations" },
  { href: "/admin/launch-checklist", label: "Launch checklist" },
  { href: "/admin/design", label: "🎨 Design System" },
  { href: "/admin/settings", label: "Settings" },
];

// Internal HQ — never index.
export const metadata = NOINDEX_METADATA;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();

  // Live ticket count drives the Support queue badge. Best-effort —
  // failures degrade to no badge rather than breaking the layout.
  const openTickets = await countOpenSupportTicketsForHq().catch(() => 0);
  const supportBadge = badgeText(openTickets);
  // Same pattern for unread HQ notifications.
  const unreadNotifs = await getUnreadCountForHq().catch(() => 0);
  const notifBadge = notifBadgeText(unreadNotifs);

  return (
    <div className="dark [color-scheme:dark] relative min-h-screen bg-slate-950 text-slate-100">
      {/* Ambient glow — the subtle navy/indigo gradient that anchors the
          whole HQ in the premium dark design language. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-0 h-80 bg-[radial-gradient(60%_120%_at_50%_0%,rgba(79,70,229,0.14),transparent_70%)]"
      />

      {/* Mobile top bar with hamburger */}
      <HqNavMobile email={user.email ?? ""} items={HQ_NAV} />

      <div className="relative z-10 mx-auto flex max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:gap-8">
        {/* Sidebar — hidden on mobile, fixed-ish column on lg */}
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-6 space-y-4">
            <div className="px-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                CrewFlow HQ
              </p>
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {user.email}
              </p>
            </div>
            <nav className="space-y-0.5">
              {HQ_NAV.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  badge={
                    item.href === "/admin/support"
                      ? supportBadge
                      : item.href === "/admin/notifications"
                        ? notifBadge
                        : null
                  }
                />
              ))}
            </nav>
            <div className="border-t border-slate-800 px-3 pt-3 text-[11px] text-slate-500">
              <a
                href="/admin/switch-to-customer"
                className="block transition hover:text-slate-200"
              >
                ↩ Switch to customer view
              </a>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 pb-12">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
  );
}

