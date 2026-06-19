/**
 * Relative-time formatting — the single source of truth for the whole app.
 *
 * Before Directive 007.5 this date-math lived copy-pasted in five places
 * (`lib/notifications/format`, `lib/activity/render`, `lib/ai-employees/model`,
 * and two local component copies) with subtly different contracts. They now all
 * route through here: one core for the compact "5m ago" family, one for the
 * verbose "5 minutes ago" family. Surfaces select behaviour through options
 * instead of re-implementing the maths.
 *
 * Pure and isomorphic — no `server-only`, safe in client components.
 */

const SHORT_LOCALE = "en-GB";
const LONDON_TZ = "Europe/London";

/** "20 May" — day + month, no year. */
function shortDate(d: Date): string {
  return d.toLocaleDateString(SHORT_LOCALE, { day: "numeric", month: "short" });
}

/** "20 May 2026" — pinned to London so server/client agree. */
function longDate(d: Date): string {
  return d.toLocaleDateString(SHORT_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: LONDON_TZ,
  });
}

/** Smallest unit the compact formatter resolves. */
export type RelativePrecision = "second" | "minute";

/**
 * What to render once a timestamp is older than the largest relative unit
 * (30 days):
 * - `extend`   → keep counting up in months / years ("2mo ago", "1y ago")
 * - `isoDate`  → the ISO calendar date ("2026-05-20")
 * - `shortDate`→ day + month ("20 May")
 */
export type RelativeOverflow = "extend" | "isoDate" | "shortDate";

export type RelativeTimeOptions = {
  /** Reference point. Defaults to now — pass a fixed Date in tests. */
  now?: Date;
  /** Resolve seconds ("30s ago") or floor sub-minute to `justNowLabel`. */
  precision?: RelativePrecision;
  /** Rendering once older than 30 days. */
  overflow?: RelativeOverflow;
  /** Text for null / undefined / unparseable input. */
  invalid?: string;
  /** Sub-minute label when `precision` is "minute", and the future fallback
   *  for `extend`/`shortDate` overflow. */
  justNowLabel?: string;
};

/**
 * Compact relative time: "just now" · "30s ago" · "5m ago" · "3h ago" ·
 * "5d ago", then per `overflow`. Defaults reproduce the AI-employee contract
 * (minute precision, ISO-date overflow, "—" for invalid).
 */
export function relativeTime(
  iso: string | null | undefined,
  opts: RelativeTimeOptions = {},
): string {
  const {
    now = new Date(),
    precision = "minute",
    overflow = "isoDate",
    invalid = "—",
    justNowLabel = "just now",
  } = opts;

  if (!iso) return invalid;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return invalid;

  const diff = now.getTime() - t;
  // Future timestamp — ISO-date overflow surfaces the date, others say "now".
  if (diff < 0) return overflow === "isoDate" ? iso.slice(0, 10) : justNowLabel;

  const s = Math.floor(diff / 1000);
  if (precision === "second" && s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 1) return justNowLabel;
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;

  switch (overflow) {
    case "extend": {
      const mo = Math.floor(d / 30);
      return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
    }
    case "shortDate":
      return shortDate(new Date(t));
    case "isoDate":
    default:
      return iso.slice(0, 10);
  }
}

const VERBOSE = new Intl.RelativeTimeFormat(SHORT_LOCALE, { numeric: "auto" });

/**
 * Verbose relative time via `Intl.RelativeTimeFormat`: "2 minutes ago",
 * "in 3 hours", falling back to a full London-pinned date past a week. Used by
 * the activity timeline where the long form reads better. Returns the raw input
 * unchanged when it can't be parsed (matches the prior activity-feed contract).
 */
export function relativeTimeVerbose(
  iso: string,
  now: Date = new Date(),
): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = (t - now.getTime()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return VERBOSE.format(Math.round(diffSec), "second");
  if (abs < 3600) return VERBOSE.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return VERBOSE.format(Math.round(diffSec / 3600), "hour");
  if (abs < 604_800) return VERBOSE.format(Math.round(diffSec / 86_400), "day");
  return longDate(new Date(t));
}
