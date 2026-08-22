"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, ChevronRight, ArrowLeft, Search } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import {
  navForRole,
  utilityForRole,
  activeAreaId,
  isHrefActive,
  type NavArea,
  type NavRole,
} from "../_nav/nav-model";
import { NavIcon } from "../_nav/icons";

/**
 * Mobile navigation (product UX rebuild, Wave 1B) — replaces the old 5-item
 * bottom bar that stranded ~100 capabilities on a phone.
 *
 * A REAL hierarchy, not a 40-link drawer:
 *   • a fixed bottom bar of role-tuned quick destinations + a Menu button;
 *   • a full-height sheet that opens at the eight primary areas and DRILLS DOWN
 *     into an area's destinations, with a back button and the area name as
 *     current-location context;
 *   • a Search row that opens the command palette (Cmd+K's mobile equivalent);
 *   • Settings/Help at the foot.
 *
 * Every authorised destination in the nav model is reachable here, so the
 * mobile P0 is closed. Reads the same nav model as the desktop sidebar and the
 * command palette — one source of truth, no drift. md:hidden (desktop uses the
 * sidebar).
 */

function coerceRole(role: string): NavRole {
  return role === "staff" || role === "admin" || role === "owner" ? role : "owner";
}

// Role-tuned quick bar (4 destinations + Menu). Field roles get their day and
// their site; back-office gets money and inbox.
const QUICK: Record<"admin" | "staff", { href: string; labelKey: string; label: string; icon: string }[]> = {
  admin: [
    { href: "/dashboard", labelKey: "nav.home", label: "Home", icon: "LayoutDashboard" },
    { href: "/jobs", labelKey: "nav.jobs", label: "Jobs", icon: "Hammer" },
    { href: "/cash", labelKey: "nav.money", label: "Money", icon: "PoundSterling" },
    { href: "/inbox", labelKey: "nav.inbox", label: "Inbox", icon: "Inbox" },
  ],
  staff: [
    { href: "/me", labelKey: "nav.my_day", label: "My day", icon: "Clock" },
    { href: "/jobs", labelKey: "nav.jobs", label: "Jobs", icon: "Hammer" },
    { href: "/diary", labelKey: "nav.site_diary", label: "Diary", icon: "ShieldCheck" },
    { href: "/health-safety", labelKey: "nav.site_safety", label: "Safety", icon: "ShieldCheck" },
  ],
};

export function MobileNav({
  role = "owner",
  locale = "en-GB",
}: {
  role?: string;
  locale?: string;
}) {
  const pathname = usePathname();
  const tr = createTranslator(locale);
  const label = (key: string | undefined, fallback: string) =>
    key && tr.has(key) ? tr.t(key) : fallback;

  const navRole = coerceRole(role);
  const areas = navForRole(navRole);
  const utility = utilityForRole(navRole);
  const activeId = activeAreaId(pathname);
  const quick = QUICK[navRole === "staff" ? "staff" : "admin"];

  const [open, setOpen] = useState(false);
  const [areaId, setAreaId] = useState<string | null>(null); // null = root list

  // Close the sheet whenever the route changes (a destination was chosen).
  useEffect(() => {
    setOpen(false);
    setAreaId(null);
  }, [pathname]);

  // Lock body scroll + Escape to close while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openSheet = () => {
    setAreaId(null);
    setOpen(true);
  };
  const openCommand = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("cf:command-open"));
  };

  const currentArea: NavArea | undefined = areaId
    ? areas.concat(utility).find((a) => a.id === areaId)
    : undefined;

  return (
    <>
      {/* Bottom quick bar */}
      <nav
        aria-label="Primary mobile"
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-5">
          {quick.map((q) => {
            const active = isHrefActive(pathname, q.href);
            return (
              <li key={q.href}>
                <Link
                  href={q.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                    active ? "text-slate-900" : "text-slate-500",
                  ].join(" ")}
                >
                  <NavIcon name={q.icon} className="h-5 w-5" />
                  <span>{label(q.labelKey, q.label)}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={openSheet}
              aria-label="Open menu"
              aria-expanded={open}
              className="flex w-full flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-slate-500"
            >
              <Menu className="h-5 w-5" aria-hidden />
              <span>Menu</span>
            </button>
          </li>
        </ul>
      </nav>

      {/* Full-height navigation sheet */}
      {open ? (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col bg-white">
          {/* Sheet header — back/context + close */}
          <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-3">
            {currentArea ? (
              <button
                type="button"
                onClick={() => setAreaId(null)}
                aria-label="Back"
                className="rounded-md p-2 text-slate-600 hover:bg-slate-100"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden />
              </button>
            ) : null}
            <span className="flex-1 truncate text-base font-semibold text-slate-900">
              {currentArea ? label(currentArea.labelKey, currentArea.label) : "Menu"}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            {/* Search row (opens the command palette) */}
            {!currentArea ? (
              <button
                type="button"
                onClick={openCommand}
                className="mb-2 flex w-full items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-500"
              >
                <Search className="h-4 w-4" aria-hidden />
                <span>Search or jump to…</span>
              </button>
            ) : null}

            {!currentArea ? (
              // ── Root: the primary areas ──
              <ul className="space-y-0.5">
                {areas.map((area) => {
                  const active = area.id === activeId;
                  const hasChildren = area.children.length > 0;
                  return (
                    <li key={area.id}>
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={() => setAreaId(area.id)}
                          className={[
                            "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-[15px]",
                            active ? "bg-slate-100 font-semibold text-slate-900" : "text-slate-700",
                          ].join(" ")}
                        >
                          <NavIcon
                            name={area.icon}
                            className={active ? "h-5 w-5 text-slate-900" : "h-5 w-5 text-slate-400"}
                          />
                          <span className="flex-1 truncate">{label(area.labelKey, area.label)}</span>
                          <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden />
                        </button>
                      ) : (
                        <Link
                          href={area.href}
                          className={[
                            "flex items-center gap-3 rounded-lg px-3 py-3 text-[15px]",
                            active ? "bg-slate-100 font-semibold text-slate-900" : "text-slate-700",
                          ].join(" ")}
                        >
                          <NavIcon
                            name={area.icon}
                            className={active ? "h-5 w-5 text-slate-900" : "h-5 w-5 text-slate-400"}
                          />
                          <span className="flex-1 truncate">{label(area.labelKey, area.label)}</span>
                        </Link>
                      )}
                    </li>
                  );
                })}

                {/* Utility */}
                <li className="my-2 border-t border-slate-100" aria-hidden />
                {utility.map((area) => (
                  <li key={area.id}>
                    <button
                      type="button"
                      onClick={() => setAreaId(area.id)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-[15px] text-slate-700"
                    >
                      <NavIcon name={area.icon} className="h-5 w-5 text-slate-400" />
                      <span className="flex-1 truncate">{label(area.labelKey, area.label)}</span>
                      <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              // ── Area: its destinations ──
              <ul className="space-y-0.5">
                <li>
                  <Link
                    href={currentArea.href}
                    className="flex items-center gap-3 rounded-lg px-3 py-3 text-[15px] font-medium text-slate-900"
                  >
                    <NavIcon name={currentArea.icon} className="h-5 w-5 text-slate-500" />
                    <span>{label(currentArea.labelKey, currentArea.label)} overview</span>
                  </Link>
                </li>
                {currentArea.children.map((child) => {
                  const active = isHrefActive(pathname, child.href);
                  return (
                    <li key={child.href}>
                      <Link
                        href={child.href}
                        aria-current={active ? "page" : undefined}
                        className={[
                          "block rounded-lg py-3 pl-11 pr-3 text-[15px]",
                          active ? "bg-slate-100 font-semibold text-slate-900" : "text-slate-700",
                        ].join(" ")}
                      >
                        {label(child.labelKey, child.label)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
