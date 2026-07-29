"use client";

import { useEffect, useRef, useState } from "react";
import { setActiveOrg } from "../org-actions";
import type { OrgSummary } from "@/server/auth/session";

/**
 * Header org switcher.
 *
 * Renders the current org as a clickable pill in the top bar; click to
 * expand a dropdown listing every org the user is a member of. Selecting
 * a different org submits a form to the setActiveOrg server action,
 * which validates membership and writes the cookie.
 *
 * Each option is its own form (one-button POST) so a JS-disabled user
 * still gets a functional switcher.
 */
export function OrgSwitcher({
  current,
  orgs,
}: {
  current: { id: string; name: string };
  orgs: OrgSummary[];
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Single-org users: render a plain label, no dropdown affordance.
  if (orgs.length <= 1) {
    return (
      <span className="truncate text-sm text-slate-600">{current.name}</span>
    );
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 truncate rounded-md px-2 py-1 text-sm text-slate-700 hover:bg-slate-100"
      >
        <span className="truncate">{current.name}</span>
        <svg
          className="h-3 w-3 text-slate-500"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
        >
          <path
            d="M3 4.5l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute left-0 z-50 mt-1 w-64 origin-top-left rounded-md border border-slate-200 bg-white shadow-lg"
        >
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            Switch organisation
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {orgs.map((o) => {
              const active = o.id === current.id;
              return (
                <li key={o.id}>
                  <form action={setActiveOrg}>
                    <input type="hidden" name="org_id" value={o.id} />
                    <button
                      type="submit"
                      role="menuitem"
                      disabled={active}
                      className={
                        active
                          ? "flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-900"
                          : "flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                      }
                    >
                      <div className="min-w-0">
                        <div className="truncate">{o.name}</div>
                        <div className="truncate text-xs text-slate-500">
                          {o.role}
                        </div>
                      </div>
                      {active ? (
                        <span aria-hidden className="text-slate-500">
                          ✓
                        </span>
                      ) : null}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
