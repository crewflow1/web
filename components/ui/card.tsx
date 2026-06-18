import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { accent, type Accent } from "./tokens";

/**
 * Glass card — the elevated content tile used across HQ.
 *
 * Lifts and brightens on hover (GPU transform only, so it stays at 60fps) and
 * carries an optional blurred accent glow in the corner. Pure CSS; renders on
 * the server. Wrap in `<HoverLift>` from ./motion only when you need spring
 * physics beyond the default transition.
 */
export function Card({
  accent: tone,
  hover = true,
  glow = false,
  className,
  children,
}: {
  accent?: Accent;
  hover?: boolean;
  glow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const a = accent(tone);
  return (
    <div
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5",
        hover &&
          "transition duration-200 hover:-translate-y-0.5 hover:bg-slate-900 hover:shadow-xl",
        className,
      )}
    >
      {glow ? (
        <span
          className={cn(
            "pointer-events-none absolute -right-6 -top-8 h-20 w-20 rounded-full blur-2xl",
            a.glow,
          )}
          aria-hidden
        />
      ) : null}
      {children}
    </div>
  );
}
