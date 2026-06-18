import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { accent, type Accent } from "./tokens";

/**
 * Feedback atoms — Alert, EmptyState and Meter. The small bits of UI that tell
 * the operator what's happening: a status banner, a graceful nothing-here state,
 * and an honest progress bar.
 */

export type AlertTone = "info" | "success" | "warning" | "danger";

const ALERT: Record<AlertTone, string> = {
  info: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  danger: "border-red-500/30 bg-red-500/10 text-red-200",
};

/** A coloured status banner. Use `danger` for the inline form-error pattern. */
export function Alert({
  tone = "info",
  title,
  icon,
  className,
  children,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-lg border px-3 py-2.5 text-xs",
        ALERT[tone],
        className,
      )}
    >
      {icon ? (
        <span className="mt-0.5 shrink-0 [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? (
          <div className={cn(title && "mt-0.5 opacity-90")}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}

/** A graceful empty state — icon, message and an optional call to action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800/60 text-slate-400 ring-1 ring-inset ring-slate-700 [&>svg]:h-6 [&>svg]:w-6"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-semibold text-slate-200">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs text-slate-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Meter — a transparent progress bar. `value` is 0–100; an unknown value renders
 * an empty track so the gap is visible rather than guessed (the Research
 * "no black box" rule, generalised).
 */
export function Meter({
  value,
  accent: tone = "indigo",
  className,
}: {
  value: number | null;
  accent?: Accent;
  className?: string;
}) {
  const a = accent(tone);
  const known = typeof value === "number";
  const pct = known ? Math.max(0, Math.min(100, Math.round(value))) : 0;
  return (
    <div
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-slate-800",
        className,
      )}
      role="progressbar"
      aria-valuenow={known ? pct : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-700", a.bar)}
        style={{ width: `${known ? Math.max(3, pct) : 0}%` }}
      />
    </div>
  );
}
