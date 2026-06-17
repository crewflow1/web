import {
  Building2,
  Package,
  Users,
  TrendingUp,
  Cpu,
  Megaphone,
  Banknote,
  BookOpen,
  Calendar,
  Gavel,
  Rocket,
  FlaskConical,
  Crosshair,
  LifeBuoy,
  Map,
  Library,
  Brain,
  type LucideIcon,
} from "lucide-react";

/**
 * Maps the seeded `icon` string key on a memory type to a lucide glyph.
 * Server-safe (lucide renders fine in RSC). Unknown keys fall back to the
 * generic Brain icon, so a future memory type added via data alone never
 * renders blank.
 */
const ICONS: Record<string, LucideIcon> = {
  building: Building2,
  package: Package,
  users: Users,
  "trending-up": TrendingUp,
  cpu: Cpu,
  megaphone: Megaphone,
  banknote: Banknote,
  "book-open": BookOpen,
  calendar: Calendar,
  gavel: Gavel,
  rocket: Rocket,
  flask: FlaskConical,
  crosshair: Crosshair,
  "life-buoy": LifeBuoy,
  map: Map,
  library: Library,
  brain: Brain,
};

export function MemoryTypeIcon({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const Glyph = ICONS[icon] ?? Brain;
  return <Glyph className={className} aria-hidden strokeWidth={1.75} />;
}
