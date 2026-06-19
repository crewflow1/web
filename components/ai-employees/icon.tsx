import {
  Crown,
  Cpu,
  TrendingUp,
  Megaphone,
  Palette,
  ShieldCheck,
  BookOpen,
  Compass,
  Banknote,
  LifeBuoy,
  Settings2,
  Bot,
  type LucideIcon,
} from "lucide-react";

/**
 * Maps the seeded `icon` string key on an AI employee to a lucide
 * glyph. Server-safe (lucide renders fine in RSC). Unknown keys fall
 * back to the generic Bot icon so a new seed never renders blank.
 */
const ICONS: Record<string, LucideIcon> = {
  crown: Crown,
  cpu: Cpu,
  "trending-up": TrendingUp,
  megaphone: Megaphone,
  palette: Palette,
  "shield-check": ShieldCheck,
  "book-open": BookOpen,
  compass: Compass,
  banknote: Banknote,
  "life-buoy": LifeBuoy,
  "settings-2": Settings2,
  bot: Bot,
};

export function EmployeeIcon({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const Glyph = ICONS[icon] ?? Bot;
  return <Glyph className={className} aria-hidden strokeWidth={1.75} />;
}
