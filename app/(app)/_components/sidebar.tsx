"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import {
  navForRole,
  utilityForRole,
  activeAreaId,
  areaLandingHref,
  isHrefActive,
  type NavArea,
  type NavRole,
} from "../_nav/nav-model";
import { NavIcon } from "../_nav/icons";

/**
 * App sidebar — the grouped, hierarchical primary navigation (product UX
 * rebuild, Wave 1A). Replaces the previous flat ~44-item list.
 *
 * Reads the single nav model (../_nav/nav-model.ts) so this, the mobile nav and
 * the command palette can never drift. Progressive disclosure: eight small
 * first-level areas; the active area's second-level destinations expand beneath
 * it, and any area can be toggled. The current area + page are always obvious.
 *
 * Calm by construction: icons only at the area level, text-only children, one
 * subtle active treatment, no badges/gradients/shadows. Client component only
 * because it reads the pathname and remembers which areas are expanded.
 *
 * i18n: labels resolve through the negotiated locale, falling back to the
 * model's en-GB label when a key is not yet in the catalogue.
 */

const STORAGE_KEY = "cf-nav-expanded";

function coerceRole(role: string): NavRole {
  return role === "staff" || role === "admin" || role === "owner" ? role : "owner";
}

export function Sidebar({
  role = "owner",
  locale = "en-GB",
  flags = [],
}: {
  role?: string;
  locale?: string;
  /** Server-resolved feature flags (layout reads server-only env) — gates
   *  flag-conditional nav entries (nav-model `flag`). */
  flags?: readonly string[];
}) {
  const pathname = usePathname();
  const tr = createTranslator(locale);
  const label = (key: string | undefined, fallback: string) =>
    key && tr.has(key) ? tr.t(key) : fallback;

  const navRole = coerceRole(role);
  const areas = navForRole(navRole, flags);
  const utility = utilityForRole(navRole, flags);
  const activeId = activeAreaId(pathname);

  // Expand state: explicit user toggles override the default (active area open).
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
  const isOpen = (area: NavArea) =>
    overrides[area.id] ?? area.id === activeId;

  return (
    <nav
      aria-label="Primary"
      className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-slate-200 bg-white"
    >
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-0.5">
          {areas.map((area) => {
            const areaActive = area.id === activeId;
            const hasChildren = area.children.length > 0;
            const open = hasChildren && isOpen(area);
            return (
              <li key={area.id}>
                {/* Row: the area link (flex-1) + a non-overlapping toggle. The
                    toggle is a full 36px target (WCAG 2.5.8) and a sibling, not
                    an overlay, so adjacent targets never collide. */}
                <div className="group flex items-center gap-0.5">
                  <Link
                    href={areaLandingHref(area)}
                    aria-current={areaActive && !hasChildren ? "page" : undefined}
                    className={[
                      "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition",
                      areaActive
                        ? "font-semibold text-slate-900"
                        : "font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                      areaActive && !hasChildren ? "bg-slate-100" : "",
                    ].join(" ")}
                  >
                    <NavIcon
                      name={area.icon}
                      className={
                        areaActive
                          ? "h-[18px] w-[18px] shrink-0 text-slate-900"
                          : "h-[18px] w-[18px] shrink-0 text-slate-400 group-hover:text-slate-600"
                      }
                    />
                    <span className="truncate">{label(area.labelKey, area.label)}</span>
                  </Link>
                  {hasChildren ? (
                    <button
                      type="button"
                      onClick={() => setOpen(area.id, !open)}
                      aria-label={`${open ? "Collapse" : "Expand"} ${label(area.labelKey, area.label)}`}
                      aria-expanded={open}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`}
                        aria-hidden
                      />
                    </button>
                  ) : null}
                </div>

                {open ? (
                  <ul className="mb-1 mt-0.5 space-y-0.5">
                    {area.children.map((child) => {
                      const childActive =
                        isHrefActive(pathname, child.href) &&
                        // only mark the longest match active (avoid /jobs marking
                        // when on /jobs/calendar which is its own child)
                        !area.children.some(
                          (o) =>
                            o !== child &&
                            o.href.length > child.href.length &&
                            isHrefActive(pathname, o.href),
                        );
                      return (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            aria-current={childActive ? "page" : undefined}
                            className={[
                              "block rounded-md py-1.5 pl-[38px] pr-3 text-[13px] transition",
                              childActive
                                ? "bg-slate-100 font-semibold text-slate-900"
                                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                            ].join(" ")}
                          >
                            {label(child.labelKey, child.label)}
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
      </div>

      {/* Utility — demoted from the daily areas, pinned at the foot. */}
      <div className="border-t border-slate-200 px-3 py-3">
        <ul className="space-y-0.5">
          {utility.map((area) => {
            const areaActive = area.id === activeId;
            return (
              <li key={area.id}>
                <Link
                  href={area.href}
                  aria-current={areaActive ? "page" : undefined}
                  className={[
                    "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition",
                    areaActive
                      ? "bg-slate-100 font-semibold text-slate-900"
                      : "font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                  ].join(" ")}
                >
                  <NavIcon
                    name={area.icon}
                    className={
                      areaActive
                        ? "h-[18px] w-[18px] shrink-0 text-slate-900"
                        : "h-[18px] w-[18px] shrink-0 text-slate-400 group-hover:text-slate-600"
                    }
                  />
                  <span className="truncate">{label(area.labelKey, area.label)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
