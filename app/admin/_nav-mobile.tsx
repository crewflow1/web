"use client";

import { useState } from "react";
import Link from "next/link";

type NavItem = {
  href: string;
  label: string;
  shipsIn?: string;
};

/**
 * Mobile top-bar + sliding nav for HQ. The sidebar is hidden under
 * lg breakpoint; this handles everything below it.
 *
 * No global state library, no portal — a single useState toggles the
 * drawer. Closes on link click so we don't ship a janky two-tap nav.
 */
export function HqNavMobile({
  email,
  items,
}: {
  email: string;
  items: ReadonlyArray<NavItem>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            CrewFlow HQ
          </p>
          <p className="text-xs text-slate-700">{email}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
          aria-label="Open HQ navigation"
        >
          Menu
        </button>
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
            <div className="space-y-0.5">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900"
                >
                  <span>{item.label}</span>
                  {item.shipsIn ? (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800">
                      {item.shipsIn}
                    </span>
                  ) : null}
                </Link>
              ))}
            </div>
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
