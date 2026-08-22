"use client";

/**
 * Icon resolver for the HQ shell — the internal-operations counterpart to the
 * product's _nav/icons.tsx. Keeps hq-nav-model.ts pure data (string keys) while
 * the sidebar renders real lucide icons. Icons at the area level ONLY; the HQ
 * aesthetic stays serious/operational (no emoji, no sci-fi).
 */

import {
  LayoutDashboard,
  Gavel,
  Users,
  TrendingUp,
  Building2,
  ShieldCheck,
  Server,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  Gavel,
  Users,
  TrendingUp,
  Building2,
  ShieldCheck,
  Server,
};

export function HqNavIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? LayoutDashboard;
  return <Icon className={className ?? "h-[18px] w-[18px]"} strokeWidth={2} aria-hidden />;
}
