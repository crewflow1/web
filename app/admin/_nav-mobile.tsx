"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import {
  activeHqAreaId,
  isHqHrefActive,
  type HqNavArea,
} from "./_nav/hq-nav-model";
import { HqNavIcon } from "./_nav/hq-icons";

/**
 * Mobile top-bar + drawer for HQ (product UX rebuild, HQ phase). The desktop
 * sidebar is hidden under lg; this is the phone/tablet navigation.
 *
 * Grouped accordion of the seven HQ areas (not the old 46-link flat list): the
 * area you're in is expanded; tap any area header to toggle. Live Support/
 * Notifications badges preserved. Closes on link click.
 */
export function HqNavMobile({
  email,
  areas,
  supportBadge,
  notifBadge,
}: {
  email: string;
  areas: ReadonlyArray<HqNavArea>;
  supportBadge?: string | null;
  notifBadge?: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const activeId = activeHqAreaId(pathname);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => expanded[id] ?? id === activeId;
  const badgeFor = (b?: "support" | "notifications") =>
    b === "support" ? supportBadge : b === "notifications" ? notifBadge : null;

  return (
    <>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            CrewFlow HQ
          </p>
          <p className="text-xs text-slate-700">{email}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("cf:hq-command-open"))}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700"
            aria-label="Search HQ"
          >
            🔎
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
            aria-label="Open HQ navigation"
            aria-expanded={open}
          >
            Menu
          </button>
        </div>
      </div>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-40 flex bg-slate-900/40 lg:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <nav className="ml-auto h-full w-72 max-w-[85vw] overflow-y-auto bg-white px-4 py-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                CrewFlow HQ
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            <ul className="space-y-0.5">
              {areas.map((area) => {
                const areaActive = area.id === activeId;
                const exp = isOpen(area.id);
                return (
                  <li key={area.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((p) => ({ ...p, [area.id]: !exp }))
                      }
                      aria-expanded={exp}
                      className={[
                        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm",
                        areaActive ? "font-semibold text-slate-900" : "font-medium text-slate-700",
                      ].join(" ")}
                    >
                      <HqNavIcon
                        name={area.icon}
                        className={
                          areaActive
                            ? "h-[18px] w-[18px] shrink-0 text-slate-900"
                            : "h-[18px] w-[18px] shrink-0 text-slate-400"
                        }
                      />
                      <span className="flex-1 truncate">{area.label}</span>
                      <ChevronDown
                        className={`h-4 w-4 text-slate-400 transition-transform ${exp ? "" : "-rotate-90"}`}
                        aria-hidden
                      />
                    </button>
                    {exp ? (
                      <ul className="mb-1 space-y-0.5">
                        {area.children.map((child) => {
                          const active = isHqHrefActive(pathname, child.href);
                          const badge = badgeFor(child.badge);
                          return (
                            <li key={child.href}>
                              <Link
                                href={child.href}
                                onClick={() => setOpen(false)}
                                aria-current={active ? "page" : undefined}
                                className={[
                                  "flex items-center justify-between gap-2 rounded-md py-2 pl-11 pr-3 text-[13px]",
                                  active
                                    ? "bg-slate-900 font-semibold text-white"
                                    : "text-slate-700 hover:bg-slate-50",
                                ].join(" ")}
                              >
                                <span className="truncate">{child.label}</span>
                                {badge ? (
                                  <span className="shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                                    {badge}
                                  </span>
                                ) : null}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 border-t border-slate-200 pt-3 text-[11px] text-slate-500">
              <a
                href="/admin/switch-to-customer"
                onClick={() => setOpen(false)}
                className="block hover:text-slate-900"
              >
                ↩ Switch to customer view
              </a>
            </div>
          </nav>
        </div>
      ) : null}
    </>
  );
}
