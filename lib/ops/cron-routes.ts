import vercelConfig from "@/vercel.json";

/**
 * The FULL cron roster, derived from vercel.json — the single source of
 * truth for what Vercel actually schedules.
 *
 * History: server/services/ops-snapshot.ts used to carry a hard-coded
 * CRON_ROUTES tuple that stopped at 8 routes while vercel.json grew to 45,
 * so /admin/ops silently monitored a fifth of the estate. Deriving the list
 * here (a plain Node JSON import, evaluated at build time server-side) makes
 * that drift structurally impossible: a cron added to vercel.json appears on
 * the ops panel on the next deploy with zero code change, and the parity
 * test (__tests__/ops/cron-coverage.test.ts) pins both directions.
 *
 * This module is dependency-free and framework-free (no "server-only") so
 * unit tests can import it directly. vercel.json contains no secrets —
 * only paths and schedules.
 */

type VercelCron = { path: string; schedule: string };

const CRON_PATH_PREFIX = "/api/cron/";

const crons: ReadonlyArray<VercelCron> =
  (vercelConfig as { crons?: VercelCron[] }).crons ?? [];

/**
 * Route names (the segment after /api/cron/), in vercel.json order.
 * A loud throw on a malformed path — a cron scheduled outside
 * /api/cron/ would silently escape telemetry, so refuse to build.
 */
export const CRON_ROUTES: ReadonlyArray<string> = crons.map((c) => {
  if (!c.path.startsWith(CRON_PATH_PREFIX)) {
    throw new Error(
      `vercel.json cron path outside ${CRON_PATH_PREFIX}: ${c.path}`,
    );
  }
  return c.path.slice(CRON_PATH_PREFIX.length);
});

export type CronRouteName = string;

/**
 * Readability grouping for the ops panel. Classification is by naming
 * convention (checked in this order):
 *   hq          — the HQ AI-employee/agent machinery (hq-* routes)
 *   drains      — queue/outbox drains (anything with "drain")
 *   syncs       — external-provider pulls (anything with "sync")
 *   maintenance — everything else (reminders, recomputes, retention, …)
 */
export const CRON_FAMILIES = [
  "hq",
  "drains",
  "syncs",
  "maintenance",
] as const;
export type CronFamily = (typeof CRON_FAMILIES)[number];

export function cronFamily(route: string): CronFamily {
  if (route.startsWith("hq-")) return "hq";
  if (route.includes("drain")) return "drains";
  if (route.includes("sync")) return "syncs";
  return "maintenance";
}

export const CRON_FAMILY_LABEL: Record<CronFamily, string> = {
  hq: "HQ agents",
  drains: "Queue drains",
  syncs: "Provider syncs",
  maintenance: "Maintenance & schedules",
};
