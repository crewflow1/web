"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * App sidebar navigation.
 *
 * Client component because we read pathname to highlight the active link.
 * Mobile: hidden behind the header (md:block).
 *
 * Order is fixed for v1 — Dashboard, Jobs, Customers. New modules
 * (quotes/invoices/accounting) get added here as they ship.
 */

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/jobs", label: "Jobs" },
  { href: "/customers", label: "Customers" },
  { href: "/finances", label: "Finances" },
  { href: "/invoices", label: "Invoices" },
  { href: "/settings", label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="hidden md:block w-56 shrink-0 border-r border-slate-200 bg-white px-3 py-4"
    >
      <ul className="space-y-1">
        {LINKS.map((link) => {
          // active if pathname matches exactly OR is a nested route under it
          const isActive =
            pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={
                  isActive
                    ? "block rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                    : "block rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                }
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
