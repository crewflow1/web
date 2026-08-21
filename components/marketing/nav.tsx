"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookDemoButton } from "@/app/(public)/_book-demo-modal";
import { WordmarkDark } from "@/components/marketing/logo";

/**
 * Global marketing navigation, dark "Blueprint" system.
 *
 * Fixes the pre-redesign defect where mobile had NO navigation (links were
 * `hidden md:inline-flex` with no replacement). Desktop gets a compact bar with
 * two dropdown menus; mobile gets a proper accessible drawer (focus-trapped,
 * Esc-to-close, scroll-locked, keyboard-operable, 44px targets).
 *
 * Information architecture (six-pillar product model):
 *   Product ▾  · Solutions ▾ · Pricing · Resources ▾   + Sign in + Book a demo
 */

type NavLink = { label: string; href: string; note?: string };
type NavMenu = { label: string; items: NavLink[] };

const PRODUCT: NavMenu = {
  label: "Product",
  items: [
    { label: "Platform overview", href: "/product", note: "The whole system, one place" },
    { label: "Win work", href: "/product/win-work", note: "CRM, leads, quotes, pipeline" },
    { label: "Run jobs", href: "/product/run-jobs", note: "Jobs, scheduling, ops centre" },
    { label: "Site & safety", href: "/product/site-safety", note: "RAMS, permits, diaries, drawings" },
    { label: "Money", href: "/product/money", note: "Invoicing, CIS, retention, costing" },
    { label: "People & assets", href: "/product/people-assets", note: "Workforce, fleet, stock" },
    { label: "Automation & intelligence", href: "/product/automation", note: "Workflows, reminders, reporting" },
    { label: "Features A to Z", href: "/features", note: "Every capability, one list" },
  ],
};

const SOLUTIONS: NavMenu = {
  label: "Solutions",
  items: [
    { label: "By trade", href: "/industries", note: "Built for your trade" },
    { label: "Compare CrewFlow", href: "/compare", note: "Honest, side by side" },
    { label: "By location", href: "/construction-software", note: "Construction software near you" },
  ],
};

const RESOURCES: NavMenu = {
  label: "Resources",
  items: [
    { label: "Guides", href: "/blog", note: "Running a UK construction business" },
    { label: "Free tools", href: "/tools", note: "Markup, VAT, concrete & brick calculators" },
  ],
};

const MENUS = [PRODUCT, SOLUTIONS, RESOURCES];

export function SiteNav() {
  const [open, setOpen] = useState(false); // mobile drawer
  const [openMenu, setOpenMenu] = useState<string | null>(null); // desktop dropdown
  const pathname = usePathname();
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close everything on route change.
  useEffect(() => {
    setOpen(false);
    setOpenMenu(null);
  }, [pathname]);

  // Mobile drawer: scroll-lock + Esc + real focus trap + restore focus on close.
  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    const restoreTo = triggerRef.current;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        drawer?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      const outside = !drawer?.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    focusables()[0]?.focus();

    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      restoreTo?.focus();
    };
  }, [open]);

  // Desktop dropdowns: close on outside click / Esc.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuBarRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-navy-950/80 backdrop-blur-md">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-cf items-center justify-between gap-4 px-5 sm:px-7"
      >
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
          aria-label="CrewFlow home"
        >
          <WordmarkDark />
        </Link>

        {/* Desktop menu */}
        <div ref={menuBarRef} className="hidden items-center gap-1 lg:flex">
          {MENUS.map((menu) => (
            <DesktopMenu
              key={menu.label}
              menu={menu}
              open={openMenu === menu.label}
              onToggle={() =>
                setOpenMenu((cur) => (cur === menu.label ? null : menu.label))
              }
              onOpen={() => setOpenMenu(menu.label)}
            />
          ))}
          <Link
            href="/pricing"
            className="rounded-md px-3 py-2 text-sm font-medium text-ink-mut transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
          >
            Pricing
          </Link>
        </div>

        {/* Desktop actions */}
        <div className="hidden items-center gap-2 lg:flex">
          <Link
            href="/login"
            className="rounded-md px-3 py-2 text-sm font-medium text-ink-mut transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
          >
            Sign in
          </Link>
          <BookDemoButton className="inline-flex items-center rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100">
            Book a demo
          </BookDemoButton>
        </div>

        {/* Mobile trigger */}
        <button
          ref={triggerRef}
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink lg:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
          aria-expanded={open}
          aria-controls="mobile-drawer"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          <Burger open={open} />
        </button>
      </nav>

      {/* Mobile drawer */}
      {open && (
        <div
          className="fixed inset-0 top-16 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          id="mobile-drawer"
        >
          <div
            className="absolute inset-0 bg-navy-950/70"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={drawerRef}
            className="absolute inset-x-0 top-0 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-white/10 bg-navy-900 px-5 pb-8 pt-4"
          >
            {MENUS.map((menu) => (
              <MobileGroup key={menu.label} menu={menu} onNavigate={() => setOpen(false)} />
            ))}
            <Link
              href="/pricing"
              className="block border-b border-white/10 py-3.5 text-base font-medium text-ink"
              onClick={() => setOpen(false)}
            >
              Pricing
            </Link>
            <div className="mt-5 flex flex-col gap-3">
              <BookDemoButton className="inline-flex h-12 items-center justify-center rounded-lg bg-gold-500 px-4 text-base font-semibold text-navy-950">
                Book a demo
              </BookDemoButton>
              <Link
                href="/login"
                className="inline-flex h-12 items-center justify-center rounded-lg border border-white/15 px-4 text-base font-medium text-ink"
                onClick={() => setOpen(false)}
              >
                Sign in
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function DesktopMenu({
  menu,
  open,
  onToggle,
  onOpen,
}: {
  menu: NavMenu;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const id = useId();
  return (
    <div className="relative" onMouseEnter={onOpen} onMouseLeave={() => open && onToggle()}>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-ink-mut transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        {menu.label}
        <Chevron open={open} />
      </button>
      {open && (
        <div
          id={id}
          className="absolute left-0 top-full w-72 pt-2"
        >
          <ul className="overflow-hidden rounded-cf border border-cfborder bg-navy-800 p-1.5 shadow-cf">
            {menu.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-500"
                >
                  <span className="block text-sm font-medium text-ink">{item.label}</span>
                  {item.note && (
                    <span className="mt-0.5 block text-xs text-ink-dim">{item.note}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MobileGroup({ menu, onNavigate }: { menu: NavMenu; onNavigate: () => void }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <div className="border-b border-white/10">
      <button
        type="button"
        className="flex w-full items-center justify-between py-3.5 text-base font-semibold text-ink"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {menu.label}
        <Chevron open={open} />
      </button>
      {open && (
        <ul id={id} className="pb-2">
          {menu.items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="block rounded-lg px-3 py-2.5 text-[15px] text-ink-mut hover:bg-white/5"
                onClick={onNavigate}
              >
                {item.label}
                {item.note && (
                  <span className="mt-0.5 block text-xs text-ink-dim">{item.note}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Burger({ open }: { open: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {open ? (
        <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}
