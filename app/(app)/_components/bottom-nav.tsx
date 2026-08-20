"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createTranslator } from "@/lib/i18n";

/**
 * Mobile bottom navigation.
 *
 * Mirrors the desktop sidebar links but in a fixed bottom bar that only
 * shows on screens <md (under 768px). On desktop it's hidden so the
 * sidebar handles navigation.
 *
 * Five items max for legibility (Settings only reachable from More on
 * mobile if we expand later — for v1, fits in the bar).
 *
 * i18n: labels are message KEYS resolved through the negotiated `locale` prop —
 * byte-identical for en-GB, per-key fallback for other locales.
 */

const ADMIN_LINKS = [
  { href: "/dashboard", labelKey: "nav.home", icon: "🏠" },
  { href: "/leads", labelKey: "nav.leads", icon: "🎯" },
  { href: "/jobs", labelKey: "nav.jobs", icon: "🔧" },
  { href: "/quotes", labelKey: "nav.quotes", icon: "📝" },
  { href: "/invoices", labelKey: "nav.invoices", icon: "💷" },
];

const STAFF_LINKS = [
  { href: "/me", labelKey: "nav.my_day", icon: "⏱️" },
  { href: "/jobs", labelKey: "nav.jobs", icon: "🔧" },
  { href: "/staff/leave", labelKey: "nav.leave", icon: "🌴" },
];

export function BottomNav({
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
      aria-label="Primary mobile"
      className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.04)]"
      // safe-area for iPhone home indicator
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul
        className="grid"
        style={{ gridTemplateColumns: `repeat(${LINKS.length}, minmax(0, 1fr))` }}
      >
        {LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "flex flex-col items-center gap-0.5 py-2 text-xs font-medium text-slate-900"
                    : "flex flex-col items-center gap-0.5 py-2 text-xs font-medium text-slate-500 hover:text-slate-900"
                }
              >
                <span aria-hidden className="text-base leading-none">{l.icon}</span>
                <span>{t(l.labelKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
