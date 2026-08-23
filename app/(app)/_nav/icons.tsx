"use client";

/**
 * Icon resolver for the navigation shell. The nav model (nav-model.ts) stays
 * pure data and references icons by string key; this client module maps those
 * keys to lucide-react components (already a dependency). Icons are used only
 * for RECOGNITION at the primary-area level — second-level destinations are
 * text-only, per the navigation quality bar (text hierarchy over iconography,
 * no icon noise).
 */

import {
  LayoutDashboard,
  Clock,
  TrendingUp,
  Hammer,
  ShieldCheck,
  Users,
  PoundSterling,
  Boxes,
  Inbox,
  Settings,
  LifeBuoy,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  Clock,
  TrendingUp,
  Hammer,
  ShieldCheck,
  Users,
  PoundSterling,
  Boxes,
  Inbox,
  Settings,
  LifeBuoy,
};

export function NavIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const Icon = ICONS[name] ?? LayoutDashboard;
  return <Icon className={className ?? "h-4 w-4"} strokeWidth={2} aria-hidden />;
}
