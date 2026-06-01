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
const LOCALE = "en-GB";

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
