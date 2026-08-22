import { NOINDEX_METADATA } from "@/lib/seo/metadata";
import { requireHqPage } from "@/server/auth/hq";
import { countOpenSupportTicketsForHq } from "@/server/services/hq-support-snapshot";
import { badgeText } from "@/lib/hq/support";
import { getUnreadCountForHq } from "@/server/services/notifications-service";
import { badgeText as notifBadgeText } from "@/lib/notifications/sort";
import { HqNavMobile } from "./_nav-mobile";
import { HqSidebar } from "./_components/hq-sidebar";
import { HQ_AREAS, flatHqNav } from "./_nav/hq-nav-model";

/**
 * CrewFlow HQ — internal operating system for the team running CrewFlow.
 *
 * NOT the customer product. Gated at this layout level so every child route
 * inherits the 404-for-non-allowlisted rule.
 *
 * Product UX rebuild (HQ phase): the navigation is now a grouped, seven-area
 * IA (Home · Decisions · Workforce · Growth · Customers · Governance · Systems)
 * defined once in `_nav/hq-nav-model.ts` and rendered by the client `HqSidebar`
 * (desktop) + `HqNavMobile` (mobile drawer). The old flat 46-link emoji list is
 * gone. `HQ_NAV` is kept as a flat projection of the model for the HQ tests that
 * import it.
 */

/**
 * Back-compat flat projection of the grouped nav — several HQ tests import
 * `HQ_NAV` to assert a surface is reachable and not a stub. Every entry is a
 * live page (no `shipsIn`).
 */
export const HQ_NAV = flatHqNav();

// Internal HQ — never index.
export const metadata = NOINDEX_METADATA;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireHqPage();

  // Live badges — best-effort; a read failure degrades to no badge (never a
  // false all-clear, never a broken layout).
  const openTickets = await countOpenSupportTicketsForHq().catch(() => 0);
  const supportBadge = badgeText(openTickets ?? 0);
  const unreadNotifs = await getUnreadCountForHq().catch(() => 0);
  const notifBadge = notifBadgeText(unreadNotifs);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Mobile top bar + grouped drawer */}
      <HqNavMobile
        email={user.email ?? ""}
        areas={HQ_AREAS}
        supportBadge={supportBadge}
        notifBadge={notifBadge}
      />

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:gap-8">
        {/* Sidebar — hidden on mobile, sticky column on lg */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-6">
            <HqSidebar
              email={user.email ?? ""}
              supportBadge={supportBadge}
              notifBadge={notifBadge}
            />
          </div>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 pb-12">{children}</main>
      </div>
    </div>
  );
}
