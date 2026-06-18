import { cn } from "@/lib/utils";

/**
 * The CrewFlow logo — the single source of truth for the brand mark.
 *
 * One symbol everywhere: a deep slate tile with three descending bars (the
 * "flow" — a crew's work, ordered). Monochrome and theme-agnostic, so it reads
 * cleanly on the light marketing site and the dark HQ alike. If a locked brand
 * SVG is ever supplied, replace the bars here and it propagates to the header,
 * footer, homepage, favicon and OG image at once.
 */

export function Logo({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <rect width="32" height="32" rx="8" fill="#0F172A" />
      <rect x="8" y="10" width="16" height="3" rx="1.5" fill="#FFFFFF" />
      <rect x="8" y="14.5" width="12" height="3" rx="1.5" fill="#FFFFFF" />
      <rect x="8" y="19" width="8" height="3" rx="1.5" fill="#FFFFFF" />
    </svg>
  );
}

/** The mark paired with the CrewFlow wordmark — for headers and nav. */
export function Wordmark({
  size = 28,
  className,
  textClassName,
}: {
  size?: number;
  className?: string;
  textClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Logo size={size} />
      <span
        className={cn(
          "text-base font-semibold tracking-tight text-slate-900",
          textClassName,
        )}
      >
        CrewFlow
      </span>
    </span>
  );
}
