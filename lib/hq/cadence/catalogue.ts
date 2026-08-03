/**
 * CrewFlow HQ — the cadence CATALOGUE (OS Vol XIV / census O1).
 *
 * The code-side source of truth for the operating-model cadence clock. Each
 * entry binds a `cadence_key` (the identity persisted in hq_ai_schedules) to its
 * canonical cron expression and a human description. The catalogue is the DARK
 * substrate's map from "a modelled cadence" to "the EXISTING HQ authority that
 * cadence routes to" — the dispatch binding itself lives in the service
 * (server/services/hq-cadence.ts), which imports the drains; keeping the pure
 * catalogue free of those server-only imports lets it be imported anywhere
 * (client, tests, the tick) with no I/O and no clock.
 *
 * WHY A CATALOGUE, NOT A DB ENUM. The set of cadences evolves with code (each is
 * bound to a code authority), so the DB stores `cadence_key` as validated free
 * text (mirrors automation_schedules.rule_key). The migration SEEDS these keys;
 * this catalogue is what a write validates against and what the tick maps.
 *
 * cron_expr matches the live vercel.json entry for each cadence, so an enabled
 * registry row fires on the SAME clock the legacy cron already runs on. UTC,
 * 5-field, parseable by lib/automation/cron.ts.
 */

export const HQ_CADENCE_KEYS = [
  "research-drain",
  "qualification-drain",
  "outreach-drain",
  "notifications-drain",
  "automation-schedules-drain",
] as const;

export type CadenceKey = (typeof HQ_CADENCE_KEYS)[number];

export type CadenceDefinition = {
  /** Stable identity; the hq_ai_schedules.cadence_key value. */
  readonly key: CadenceKey;
  /** Standard 5-field UTC cron expression (matches vercel.json). */
  readonly cronExpr: string;
  /** What the cadence does — surfaced in the admin registry. */
  readonly description: string;
};

/**
 * The seeded HQ cadences: the minute→quarter-hour AI-employee / HQ safety-net
 * drains. Kept in one frozen array so the migration seed, the service dispatch
 * map, the admin UI and the tests all agree on the key set.
 */
export const HQ_CADENCES: readonly CadenceDefinition[] = Object.freeze([
  {
    key: "research-drain",
    cronExpr: "*/5 * * * *",
    description:
      "HQ Research AI — drain enqueued-but-unkicked research tasks through the Task Engine.",
  },
  {
    key: "qualification-drain",
    cronExpr: "*/5 * * * *",
    description:
      "HQ Lead Qualification AI — drain enqueued-but-unkicked qualification tasks.",
  },
  {
    key: "outreach-drain",
    cronExpr: "*/5 * * * *",
    description:
      "HQ Outreach AI — drain enqueued-but-unkicked outreach drafts (execution stays locked).",
  },
  {
    key: "notifications-drain",
    cronExpr: "*/15 * * * *",
    description:
      "Notification email drain — dispatch queued notification emails and prune old rows.",
  },
  {
    key: "automation-schedules-drain",
    cronExpr: "* * * * *",
    description:
      "Automation OS — fire every due org-scoped automation schedule through the dispatcher.",
  },
]);

const BY_KEY: ReadonlyMap<string, CadenceDefinition> = new Map(
  HQ_CADENCES.map((c) => [c.key, c]),
);

/** The catalogue entry for a key, or null when the key is unknown. Pure. */
export function getCadence(key: string): CadenceDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** True when `key` is a catalogue cadence. Pure. */
export function isKnownCadenceKey(key: string): key is CadenceKey {
  return BY_KEY.has(key);
}
