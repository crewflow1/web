import type { ReactNode } from "react";
import { ShieldOff } from "lucide-react";
import { Badge, Dot, type Accent } from "@/components/ui";
import { EmployeeIcon } from "@/components/ai-employees/icon";
import { accentClasses } from "@/components/ai-employees/styles";
import type {
  EmployeeAvatar,
  EmployeeHealth,
  EmployeeHealthTone,
} from "@/lib/ai-employees/framework";

/**
 * AI Employees HQ — shared presentational atoms (CEO Directive 007, Phase 1).
 *
 * Server components only. They translate the framework's six-dimension
 * vocabulary into the design system: the 11-colour employee accent drives the
 * avatar tile, the health tone maps onto a DS accent, and the "framework mode"
 * badge states the honest posture — no employee executes anything yet.
 */

/** Health tone → design-system accent. Keeps the signal colour consistent. */
const HEALTH_ACCENT: Record<EmployeeHealthTone, Accent> = {
  healthy: "emerald",
  steady: "sky",
  attention: "amber",
  foundation: "slate",
};

export function healthAccent(tone: EmployeeHealthTone): Accent {
  return HEALTH_ACCENT[tone] ?? "slate";
}

/** The employee's coloured icon tile — the full 11-accent employee palette. */
export function AvatarTile({
  avatar,
  size = "md",
}: {
  avatar: EmployeeAvatar;
  size?: "sm" | "md" | "lg";
}) {
  const a = accentClasses(avatar.accent);
  const box =
    size === "lg" ? "h-14 w-14" : size === "sm" ? "h-9 w-9" : "h-11 w-11";
  const glyph = size === "lg" ? "h-7 w-7" : size === "sm" ? "h-4 w-4" : "h-5 w-5";
  return (
    <span
      className={`flex ${box} shrink-0 items-center justify-center rounded-xl ${a.icon}`}
    >
      <EmployeeIcon icon={avatar.icon} className={glyph} />
    </span>
  );
}

/** Transparent health signal — a tone-coloured pill with its label. */
export function HealthPill({ health }: { health: EmployeeHealth }) {
  const tone = healthAccent(health.tone);
  return (
    <Badge accent={tone} soft className="shrink-0">
      <Dot accent={tone} pulse={health.tone === "healthy"} />
      {health.label}
    </Badge>
  );
}

/** The honest Phase-1 posture: framework only, nothing executes autonomously. */
export function FrameworkBadge({
  label = "Framework mode · no execution",
}: {
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30">
      <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      {label}
    </span>
  );
}

/** A small monospace chip — capability labels, scopes, slugs. */
export function MonoChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
      {children}
    </span>
  );
}

/** A numbered "N / 6" eyebrow that reinforces the six-dimension contract. */
export function DimensionTag({ index }: { index: number }) {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-500 ring-1 ring-inset ring-slate-200 dark:bg-slate-800/80 dark:text-slate-400 dark:ring-slate-700">
      {index} / 6
    </span>
  );
}
