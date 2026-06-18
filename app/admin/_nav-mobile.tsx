"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

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
  const pathname = usePathname();

  return (
    <>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800 bg-slate-950/90 px-4 py-3 backdrop-blur lg:hidden">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            CrewFlow HQ
          </p>
          <p className="text-xs text-slate-300">{email}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800"
          aria-label="Open HQ navigation"
        >
          Menu
        </button>
      </div>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-40 flex bg-slate-950/70 backdrop-blur-sm lg:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <nav className="ml-auto h-full w-72 max-w-[85vw] overflow-y-auto border-l border-slate-800 bg-slate-950 px-4 py-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                CrewFlow HQ
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-900 hover:text-slate-200"
              >
                ✕
              </button>
            </div>
            <div className="space-y-0.5">
              {items.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition",
                      active
                        ? "bg-indigo-500/15 text-white ring-1 ring-inset ring-indigo-400/30"
                        : "text-slate-300 hover:bg-slate-900 hover:text-white",
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.shipsIn ? (
                      <span className="ml-2 shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300 ring-1 ring-inset ring-amber-400/30">
                        {item.shipsIn}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
            <div className="mt-4 border-t border-slate-800 pt-3 text-[11px] text-slate-500">
              <a
                href="/admin/switch-to-customer"
                onClick={() => setOpen(false)}
                className="block transition hover:text-slate-200"
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
