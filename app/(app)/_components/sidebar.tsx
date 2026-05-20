"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * App sidebar navigation.
 *
 * Client component because we read pathname to highlight the active link.
 * Mobile: hidden behind the header (md:block).
 *
 * Role scoping (Wave 4): staff see a slim nav focused on their day —
 * My day / Jobs / Leave. Owners/admins see the full business surface.
 */

const ADMIN_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/leads", label: "Leads" },
  { href: "/jobs", label: "Jobs" },
  { href: "/customers", label: "Customers" },
  { href: "/quotes", label: "Quotes" },
  { href: "/finances", label: "Finances" },
  { href: "/invoices", label: "Invoices" },
  { href: "/payments", label: "Payments" },
  { href: "/payroll", label: "Payroll" },
  { href: "/tax", label: "Tax" },
  { href: "/staff", label: "Staff" },
  { href: "/imports", label: "Migrate data" },
  { href: "/reports", label: "Reports" },
  { href: "/settings", label: "Settings" },
];

const STAFF_LINKS = [
  { href: "/me", label: "My day" },
  { href: "/jobs", label: "Jobs" },
  { href: "/staff/leave", label: "Leave" },
  { href: "/settings", label: "Settings" },
];

export function Sidebar({ role = "owner" }: { role?: string }) {
  const pathname = usePathname();
  const LINKS = role === "staff" ? STAFF_LINKS : ADMIN_LINKS;

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
