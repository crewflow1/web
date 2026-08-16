import Link from "next/link";

/**
 * Shared inbox navigation (MP Wave R4 · inbox consolidation).
 *
 * The single tab bar that ties every inbox surface into ONE inbox: the captured
 * ENQUIRIES (/inbox), the two-way CONVERSATIONS projected from the same store
 * (/inbox/conversations), the assistant REVIEW queue (/inbox/review) and the
 * outbound DELIVERY audit (/inbox/audit). Rendered at the top of all four so a
 * user moves between them without leaving "the inbox". A pure server component —
 * the active tab is passed in, no client hook needed.
 */

export type InboxTab = "enquiries" | "conversations" | "review" | "audit";

const TABS: { key: InboxTab; href: string; label: string }[] = [
  { key: "enquiries", href: "/inbox", label: "Enquiries" },
  { key: "conversations", href: "/inbox/conversations", label: "Conversations" },
  { key: "review", href: "/inbox/review", label: "Review queue" },
  { key: "audit", href: "/inbox/audit", label: "Delivery audit" },
];

export function InboxTabs({ active }: { active: InboxTab }) {
  return (
    <nav
      aria-label="Inbox"
      className="flex flex-wrap gap-1 border-b border-slate-200 pb-px text-sm"
    >
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "-mb-px border-b-2 border-slate-900 px-3 py-2 font-semibold text-slate-900"
                : "-mb-px border-b-2 border-transparent px-3 py-2 font-medium text-slate-500 hover:text-slate-800"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
