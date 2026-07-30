/**
 * Relative-time formatting — the single source of truth for the whole app.
 *
 * This date-math used to live copy-pasted in SEVEN places
 * (`lib/notifications/format`, `lib/activity/render`, `lib/ai-employees/model`,
 * and local copies in `app/(app)/_components/notifications.tsx`,
 * `app/admin/research/page.tsx`, `app/admin/tasks/page.tsx`,
 * `app/admin/qualification/page.tsx`) with contracts that had silently drifted
 * apart on five axes: what to print for absent/unparseable input, what to do
 * with a FUTURE timestamp, whether sub-minute resolves to seconds, what happens
 * once a timestamp passes the largest relative unit, and whether each unit is
 * floored or rounded to nearest.
 *
 * They now all route through here: one core for the compact "5m ago" family,
 * one for the verbose "5 minutes ago" family. Surfaces select behaviour through
 * options instead of re-implementing the maths — so a divergence has to be
 * written down as an option, where it is visible and testable, rather than
 * hiding in a private helper at the bottom of a page component.
 *
 * Pure and isomorphic — no `server-only`, safe in client components. The
 * `Intl.RelativeTimeFormat` used by the verbose family is constructed LAZILY on
 * first use, which keeps this module's top level free of side effects so a
 * client chunk that only needs the compact form pays nothing for it.
 */

import { UK_LOCALE, formatDateShortUK, formatDayMonthUK } from "./format";

/** Smallest unit the compact formatter resolves. */
export type RelativePrecision = "second" | "minute";

/**
 * What to render once a timestamp is older than the largest relative unit
 * (30 days):
 * - `extend`    → keep counting up in months / years ("2mo ago", "1y ago")
 * - `isoDate`   → the ISO calendar date ("2026-05-20")
 * - `dayMonth`  → day + month, London-pinned ("20 May")
 */
export type RelativeOverflow = "extend" | "isoDate" | "dayMonth";

/**
 * How each unit is derived from the one below it.
 * - `floor`   → "89 minutes" is "1h ago" (elapsed time, never overstates)
 * - `nearest` → "89 minutes" is "1h ago" but "91 minutes" is "2h ago"
 *
 * `nearest` cascades: hours are rounded from the ALREADY-ROUNDED minutes, so
 * 23h30m reads "1d ago". It exists to reproduce the admin-console contract
 * byte-for-byte; prefer `floor` for anything new.
 */
export type RelativeRounding = "floor" | "nearest";

export type RelativeTimeOptions = {
  /** Reference point. Defaults to now — pass a fixed Date in tests. */
  now?: Date;
  /** Resolve seconds ("30s ago") or floor sub-minute to `justNowLabel`. */
  precision?: RelativePrecision;
  /** Rendering once older than 30 days. */
  overflow?: RelativeOverflow;
  /** Per-unit rounding mode. */
  rounding?: RelativeRounding;
  /** Text for null / undefined / unparseable input. */
  invalid?: string;
  /**
   * Sub-minute label when `precision` is "minute", and the FUTURE-timestamp
   * fallback for `extend`/`dayMonth` overflow.
   */
  justNowLabel?: string;
};

/**
 * Compact relative time: "just now" · "30s ago" · "5m ago" · "3h ago" ·
 * "5d ago", then per `overflow`. Defaults reproduce the AI-employee contract
 * (minute precision, ISO-date overflow, floor rounding, "—" for invalid).
 *
 * A future timestamp is not an error — clock skew between the DB and a browser
 * routinely produces one. `isoDate` overflow surfaces the date (there is no
 * sensible "in 5m" in a compact past-tense ladder); every other mode collapses
 * it to `justNowLabel`.
 */
export function relativeTime(
  iso: string | null | undefined,
  opts: RelativeTimeOptions = {},
): string {
  const {
    now = new Date(),
    precision = "minute",
    overflow = "isoDate",
    rounding = "floor",
    invalid = "—",
    justNowLabel = "just now",
  } = opts;

  if (!iso) return invalid;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return invalid;

  const diff = now.getTime() - t;
  if (diff < 0) return overflow === "isoDate" ? iso.slice(0, 10) : justNowLabel;

  const round = rounding === "nearest" ? Math.round : Math.floor;

  if (precision === "second") {
    const s = round(diff / 1000);
    if (s < 60) return `${s}s ago`;
  }
  // Minutes come straight off the millisecond diff rather than off a rounded
  // seconds value: under `nearest`, round(round(29_500/1000)/60) is 1 while
  // round(29_500/60_000) is 0, and the latter is the contract being preserved.
  const m = round(diff / 60_000);
  if (m < 1) return justNowLabel;
  if (m < 60) return `${m}m ago`;
  const h = round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = round(h / 24);
  if (d < 30) return `${d}d ago`;

  switch (overflow) {
    case "extend": {
      const mo = round(d / 30);
      return mo < 12 ? `${mo}mo ago` : `${round(mo / 12)}y ago`;
    }
    case "dayMonth":
      return formatDayMonthUK(t);
    case "isoDate":
    default:
      // A raw echo of the stored value, deliberately NOT London-pinned: these
      // surfaces show the timestamp as recorded, and ~15 call sites plus a test
      // depend on the exact substring.
      return iso.slice(0, 10);
  }
}

/**
 * Every compact relative-time contract this app actually renders, enumerated in
 * one place. A surface that wants different behaviour adds a preset HERE, where
 * the divergence is reviewable next to its siblings — which is precisely what
 * did not happen the first six times.
 *
 * Surfaces on the module DEFAULTS (minute precision, ISO-date overflow, "—")
 * need no preset: that is the AI-employee / boardroom / sales / memory contract.
 */
export const RELATIVE_TIME_PRESETS = {
  /** Notification bell + row list: "0s ago" … "5d ago" … "2y ago". */
  notification: { precision: "second", overflow: "extend" },
  /**
   * HQ operator consoles (research / tasks / qualification): nearest-rounded so
   * "45s" reads "1m ago", "20 May" past a month, and blank for absent input.
   */
  hqConsole: { rounding: "nearest", overflow: "dayMonth", invalid: "" },
} as const satisfies Record<string, RelativeTimeOptions>;

let verboseFormatter: Intl.RelativeTimeFormat | null = null;
function verbose(): Intl.RelativeTimeFormat {
  verboseFormatter ??= new Intl.RelativeTimeFormat(UK_LOCALE, {
    numeric: "auto",
  });
  return verboseFormatter;
}

/**
 * Verbose relative time via `Intl.RelativeTimeFormat`: "2 minutes ago",
 * "yesterday", "in 3 hours", falling back to a full London-pinned date past a
 * week. Used by the activity timeline and event feeds where the long form reads
 * better and future-dated rows are meaningful. Returns the raw input unchanged
 * when it can't be parsed (matches the prior activity-feed contract).
 */
export function relativeTimeVerbose(
  iso: string,
  now: Date = new Date(),
): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = (t - now.getTime()) / 1000;
  const abs = Math.abs(diffSec);
  const fmt = verbose();
  if (abs < 60) return fmt.format(Math.round(diffSec), "second");
  if (abs < 3600) return fmt.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return fmt.format(Math.round(diffSec / 3600), "hour");
  if (abs < 604_800) return fmt.format(Math.round(diffSec / 86_400), "day");
  return formatDateShortUK(t);
}
