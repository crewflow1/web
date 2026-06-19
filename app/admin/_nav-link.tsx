"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { pill } from "@/components/ui/tokens";

type NavItem = {
  href: string;
  label: string;
  shipsIn?: string;
};

/**
 * One HQ sidebar link. Client component so it can light up the active
 * section from the current pathname — Next's <Link> doesn't set
 * aria-current itself, so a premium active state needs this.
 */
export function NavLink({
  item,
  badge,
}: {
  item: NavItem;
  badge?: string | null;
}) {
  const pathname = usePathname();
  const active =
    pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center justify-between rounded-lg px-3 py-1.5 text-sm font-medium transition duration-200",
        active
          ? "bg-indigo-500/15 text-white ring-1 ring-inset ring-indigo-400/30"
          : "text-slate-400 hover:bg-slate-900 hover:text-slate-100",
      )}
    >
      <span className="truncate">{item.label}</span>
      {item.shipsIn ? (
        <span className={`ml-2 shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${pill("amber")}`}>
          {item.shipsIn}
        </span>
      ) : badge ? (
        <span className="ml-2 shrink-0 rounded-full bg-rose-500/90 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm shadow-rose-950/40">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
