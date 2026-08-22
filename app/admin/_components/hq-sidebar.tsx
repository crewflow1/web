"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import {
  HQ_AREAS,
  activeHqAreaId,
  isHqHrefActive,
  type HqNavArea,
} from "../_nav/hq-nav-model";
import { HqNavIcon } from "../_nav/hq-icons";

/**
 * HQ sidebar — the grouped, hierarchical internal-operations navigation
 * (product UX rebuild, HQ phase). Replaces the flat 46-link emoji list.
 *
 * Same discipline as the product sidebar: seven small first-level areas; the
 * active area's destinations expand beneath it; any area toggles; state persists
 * to localStorage; icons at the area level only; one calm active treatment. The
 * live Support/Notifications badges are preserved. Client component only because
 * it reads the pathname and remembers which areas are expanded.
 */

const STORAGE_KEY = "cf-hq-nav-expanded";

export function HqSidebar({
  email,
  supportBadge,
  notifBadge,
}: {
  email: string;
  supportBadge?: string | null;
  notifBadge?: string | null;
}) {
  const pathname = usePathname();
  const activeId = activeHqAreaId(pathname);

  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setOverrides(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);
  const setOpen = (id: string, open: boolean) => {
    setOverrides((prev) => {
      const next = { ...prev, [id]: open };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const isOpen = (area: HqNavArea) => overrides[area.id] ?? area.id === activeId;

  const badgeFor = (b?: "support" | "notifications") =>
    b === "support" ? supportBadge : b === "notifications" ? notifBadge : null;

  return (
    <nav aria-label="HQ primary" className="space-y-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          CrewFlow HQ
        </p>
        <p className="mt-0.5 truncate text-xs text-slate-500">{email}</p>
      </div>

      <ul className="space-y-0.5">
        {HQ_AREAS.map((area) => {
          const areaActive = area.id === activeId;
          const open = isOpen(area);
          return (
            <li key={area.id}>
              <div className="group flex items-center gap-0.5">
                <Link
                  href={area.href}
                  className={[
                    "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition",
                    areaActive
                      ? "font-semibold text-slate-900"
                      : "font-medium text-slate-600 hover:bg-white hover:text-slate-900",
                  ].join(" ")}
                >
                  <HqNavIcon
                    name={area.icon}
                    className={
                      areaActive
                        ? "h-[18px] w-[18px] shrink-0 text-slate-900"
                        : "h-[18px] w-[18px] shrink-0 text-slate-400 group-hover:text-slate-600"
                    }
                  />
                  <span className="truncate">{area.label}</span>
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(area.id, !open)}
                  aria-label={`${open ? "Collapse" : "Expand"} ${area.label}`}
                  aria-expanded={open}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white hover:text-slate-700"
                >
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`}
                    aria-hidden
                  />
                </button>
              </div>

              {open ? (
                <ul className="mb-1 mt-0.5 space-y-0.5">
                  {area.children.map((child) => {
                    const childActive =
                      isHqHrefActive(pathname, child.href) &&
                      !area.children.some(
                        (o) =>
                          o !== child &&
                          o.href.length > child.href.length &&
                          isHqHrefActive(pathname, o.href),
                      );
                    const badge = badgeFor(child.badge);
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          aria-current={childActive ? "page" : undefined}
                          className={[
                            "flex items-center justify-between gap-2 rounded-md py-1.5 pl-[38px] pr-3 text-[13px] transition",
                            childActive
                              ? "bg-slate-900 font-semibold text-white"
                              : "text-slate-600 hover:bg-white hover:text-slate-900",
                          ].join(" ")}
                        >
                          <span className="truncate">{child.label}</span>
                          {badge ? (
                            <span
                              className={[
                                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                                childActive
                                  ? "bg-red-500 text-white"
                                  : "bg-red-600 text-white",
                              ].join(" ")}
                            >
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

      <div className="border-t border-slate-200 pt-3 text-[11px] text-slate-500">
        <a href="/admin/switch-to-customer" className="block hover:text-slate-900">
          ↩ Switch to customer view
        </a>
      </div>
    </nav>
  );
}
