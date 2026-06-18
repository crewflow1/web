import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { accent, type Accent } from "./tokens";

/**
 * Structural surfaces — the dark glass canvas the whole HQ is built on.
 *
 * Pure server components (no client JS): safe to render anywhere. Every class
 * string is lifted verbatim from the live Command Centre + Research surfaces so
 * adopting these changes nothing visually — it only removes the duplication.
 */

/** The outermost page shell: a deep slate-950 card with a hairline border. */
export function Surface({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A titled section card — the workhorse content container. */
export function Panel({
  title,
  subtitle,
  action,
  icon,
  accent: tone,
  className,
  bodyClassName,
  children,
}: {
  title?: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  accent?: Accent;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const a = accent(tone);
  const hasHeader = Boolean(title || subtitle || action || icon);
  return (
    <section
      className={cn(
        "rounded-2xl border border-slate-800 bg-slate-900/40 p-5",
        className,
      )}
    >
      {hasHeader ? (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {icon ? (
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                  a.chip,
                )}
              >
                {icon}
              </span>
            ) : null}
            <div>
              {title ? (
                <h2 className="text-sm font-semibold text-white">{title}</h2>
              ) : null}
              {subtitle ? (
                <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
              ) : null}
            </div>
          </div>
          {action ?? null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/**
 * A premium page header with the signature indigo→emerald radial glow, an
 * accent icon tile, title/subtitle and an actions slot. The look the Command
 * Centre header established, made reusable for every HQ page.
 */
export function GlowHeader({
  icon,
  accent: tone = "indigo",
  eyebrow,
  title,
  subtitle,
  actions,
  className,
}: {
  icon?: ReactNode;
  accent?: Accent;
  eyebrow?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const a = accent(tone);
  return (
    <div
      className={cn(
        "relative overflow-hidden border-b border-slate-800 px-5 py-6 sm:px-7",
        className,
      )}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {icon ? (
            <span
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                a.chip,
              )}
            >
              {icon}
            </span>
          ) : null}
          <div>
            {eyebrow ? (
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {eyebrow}
              </div>
            ) : null}
            <h1 className="text-xl font-bold tracking-tight text-white">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">{subtitle}</p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

/** A lightweight section heading (title + optional subtitle), no card chrome. */
export function SectionHeading({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-end justify-between gap-3", className)}>
      <div>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
        ) : null}
      </div>
      {action ?? null}
    </div>
  );
}
