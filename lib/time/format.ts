/**
 * Central date/time display formatting for CrewFlow.
 *
 * All timestamps are stored in UTC. The business operates in the UK, so every
 * USER-FACING timestamp must render in Europe/London — the IANA zone handles
 * the BST/GMT switch automatically. Never format display times without a
 * timeZone or they fall back to the runtime zone (UTC on the server), which
 * is the cause of the "10:06 shown as 09:06" bug.
 *
 * Use these helpers everywhere instead of bare toLocale or Intl calls.
 */

export const UK_TIME_ZONE = "Europe/London";
/** Exported so siblings (lib/time/relative.ts) never re-declare the locale. */
export const UK_LOCALE = "en-GB";
const LOCALE = UK_LOCALE;

type DateInput = Date | string | number | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** HH:mm in Europe/London (e.g. "10:06"). */
export function formatTimeUK(input: DateInput): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: UK_TIME_ZONE,
  });
}

/** dd/MM/yyyy in Europe/London (e.g. "01/06/2026"). */
export function formatDateUK(input: DateInput): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleDateString(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: UK_TIME_ZONE,
  });
}

/** dd/MM/yyyy HH:mm in Europe/London. */
export function formatDateTimeUK(input: DateInput): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleString(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: UK_TIME_ZONE,
  });
}

/** Long form, e.g. "1 June 2026" in Europe/London. */
export function formatDateLongUK(input: DateInput): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: UK_TIME_ZONE,
  });
}

/** Short form, e.g. "1 Jun 2026" in Europe/London. */
export function formatDateShortUK(input: DateInput): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: UK_TIME_ZONE,
  });
}

/**
 * Day + month with no year, e.g. "1 Jun" in Europe/London.
 *
 * For "older than a month" relative-time fallbacks, where the year is implied
 * by context. London-pinned like every other helper here: without a timeZone a
 * 23:30 BST instant renders as the PREVIOUS day on a UTC server.
 */
export function formatDayMonthUK(input: DateInput): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    timeZone: UK_TIME_ZONE,
  });
}

/**
 * The Europe/London CALENDAR DAY an instant falls on, as `YYYY-MM-DD`.
 *
 * For grouping timestamps into day buckets. Using the UK day (not the UTC day)
 * is what makes a 23:30 UTC event in summer bucket under the same date its
 * `formatTimeUK` (00:30) reads. `en-CA` is used purely because it yields
 * ISO field order. Returns "" for absent/unparseable input.
 */
export function formatDayKeyUK(input: DateInput): string {
  const d = toDate(input);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: UK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// ---------------------------------------------------------------------------
// Locale/timezone-aware formatting (multi-country readiness)
// ---------------------------------------------------------------------------
//
// The *UK helpers above pin Europe/London + en-GB — correct for every existing
// org. The functions below take an org's { locale, timeZone } (from
// organizations.locale / .timezone; lib/i18n/config.ts defaults en-GB /
// Europe/London) so a non-UK org's timestamps render in its own zone/locale.
//
// DEFAULT-SAFETY: called with no options — or with en-GB / Europe/London — these
// produce output byte-identical to the *UK helpers (same locale, same timeZone,
// same Intl options). A default-safety test pins that equivalence, and a bad
// locale/tz degrades to the UK constants rather than throwing at a render.

export type ZonedFormatOptions = {
  /** BCP-47 locale. Default "en-GB". */
  locale?: string;
  /** IANA time zone. Default "Europe/London". */
  timeZone?: string;
};

function safeLocale(locale?: string): string {
  return locale && locale.trim() ? locale : UK_LOCALE;
}
function safeZone(tz?: string): string {
  if (!tz || !tz.trim()) return UK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat(UK_LOCALE, { timeZone: tz });
    return tz;
  } catch {
    return UK_TIME_ZONE;
  }
}

/** HH:mm in the given zone/locale (default Europe/London / en-GB → == formatTimeUK). */
export function formatTimeInZone(input: DateInput, opts: ZonedFormatOptions = {}): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleTimeString(safeLocale(opts.locale), {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: safeZone(opts.timeZone),
  });
}

/** Numeric date in the given zone/locale (default → == formatDateUK). */
export function formatDateInZone(input: DateInput, opts: ZonedFormatOptions = {}): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleDateString(safeLocale(opts.locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: safeZone(opts.timeZone),
  });
}

/** Numeric date + time in the given zone/locale (default → == formatDateTimeUK). */
export function formatDateTimeInZone(input: DateInput, opts: ZonedFormatOptions = {}): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleString(safeLocale(opts.locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: safeZone(opts.timeZone),
  });
}

/** Long-form date in the given zone/locale (default → == formatDateLongUK). */
export function formatDateLongInZone(input: DateInput, opts: ZonedFormatOptions = {}): string {
  const d = toDate(input);
  if (!d) return "";
  return d.toLocaleDateString(safeLocale(opts.locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: safeZone(opts.timeZone),
  });
}

/**
 * The CALENDAR DAY an instant falls on IN A GIVEN ZONE, as `YYYY-MM-DD`. The
 * zone-aware generalisation of formatDayKeyUK — used to bucket timestamps into an
 * org's local days. Uses en-CA purely for ISO field order (like formatDayKeyUK).
 */
export function formatDayKeyInZone(input: DateInput, timeZone?: string): string {
  const d = toDate(input);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Whether a UTC instant currently falls in British Summer Time. */
export function isBST(input: DateInput): boolean {
  const d = toDate(input);
  if (!d) return false;
  const name = new Intl.DateTimeFormat(LOCALE, {
    timeZone: UK_TIME_ZONE,
    timeZoneName: "short",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return name === "BST";
}
