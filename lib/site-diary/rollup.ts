import { formatDiaryDate } from "@/lib/site-diary/schema";

/**
 * Site Diary — the PURE end-of-day roll-up composer + aggregator.
 *
 * PURE AND DETERMINISTIC. No I/O, no `process.env`, no clock, no `server-only`.
 * It takes the rows a day's real site activity ALREADY produced (photos, snags,
 * deliveries/GRNs, timesheets/labour — fetched, org-scoped and paged by
 * server/services/site-diary-rollup.ts) and reduces them, per job, into the
 * fields of ONE automatic diary entry. Every grouping / counting / wording rule
 * is therefore unit-testable without a database
 * (__tests__/site-diary/rollup.test.ts), exactly like lib/site-ops/timeline.ts.
 *
 * WHY A SEPARATE `source`. A manual diary entry is a person's account of the
 * day; an auto roll-up is a machine's summary of what the system recorded. They
 * must never be confused, and the migration marks the two apart with a `source`
 * column (`manual` | `auto_rollup`). This module owns the `auto_rollup` value
 * and the shape of the text it writes, so the marker and the content that earns
 * it live in one place.
 *
 * HONESTY, as in weather.ts: the roll-up describes ONLY what the day actually
 * carried. A signal with a zero count contributes NOTHING to the summary (it is
 * never rendered as "0 photos"); a job with no activity at all yields NO entry
 * (`composeDiaryRollup` returns null and the caller writes nothing). The weather
 * line is supplied separately and is `null` on every build where the weather
 * provider is dark — it simply does not appear.
 */

/** The two diary provenances. Mirrors the CHECK in 20261183000000. */
export const MANUAL_SOURCE = "manual" as const;
export const AUTO_ROLLUP_SOURCE = "auto_rollup" as const;
export type DiarySource = typeof MANUAL_SOURCE | typeof AUTO_ROLLUP_SOURCE;

// ── Input rows (exactly the columns the service selects, job-scoped) ─────────

/** One raised snag on the target day. Only its job matters to the roll-up. */
export type RollupSnagRow = { job_id: string | null };
/** One snag that reached a terminal status on the target day. */
export type RollupResolvedSnagRow = { job_id: string | null };
/** One timesheet/labour entry that STARTED on the target day. */
export type RollupLabourRow = {
  job_id: string | null;
  user_id: string;
  started_at: string;
  /** Null while the entry is still open (on the clock) — counts to headcount, not hours. */
  ended_at: string | null;
};
/** One POSTED goods-received note DELIVERED on the target day, resolved to its job. */
export type RollupDeliveryRow = {
  job_id: string | null;
  /** The supplier's delivery-note reference, else the GRN number — for the summary line. */
  reference: string | null;
};
/** One image attachment added to a job on the target day. */
export type RollupPhotoRow = { job_id: string | null };

export type DailyActivityInput = {
  /**
   * The jobs the roll-up may write for — ACTIVE jobs only (a completed job gets
   * no new diary). Activity for any other job is ignored, so a stale or foreign
   * job_id can never mint an entry.
   */
  activeJobIds: ReadonlySet<string>;
  snagsRaised: readonly RollupSnagRow[];
  snagsResolved: readonly RollupResolvedSnagRow[];
  labour: readonly RollupLabourRow[];
  deliveries: readonly RollupDeliveryRow[];
  photos: readonly RollupPhotoRow[];
};

/** The reduced, per-job activity of ONE day — the substance of the entry. */
export type DiaryRollupFacts = {
  photos: number;
  snagsRaised: number;
  snagsResolved: number;
  deliveries: number;
  /** De-duplicated, order-stable delivery references (may be empty even when deliveries > 0). */
  deliveryReferences: string[];
  /** Distinct people who logged time on this job today. */
  labourHeadcount: number;
  /** Total CLOSED hours logged today, rounded to 1 dp. Open entries add headcount, not hours. */
  labourHours: number;
};

function emptyFacts(): DiaryRollupFacts {
  return {
    photos: 0,
    snagsRaised: 0,
    snagsResolved: 0,
    deliveries: 0,
    deliveryReferences: [],
    labourHeadcount: 0,
    labourHours: 0,
  };
}

/** True when a job's day carried at least one recordable signal. */
export function hasRollupActivity(f: DiaryRollupFacts): boolean {
  return (
    f.photos > 0 ||
    f.snagsRaised > 0 ||
    f.snagsResolved > 0 ||
    f.deliveries > 0 ||
    f.labourHeadcount > 0
  );
}

/** Hours between two ISO instants, or null when either is unparseable / non-positive. */
function hoursBetween(startIso: string, endIso: string): number | null {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const ms = b - a;
  if (ms <= 0) return null;
  return ms / 3_600_000;
}

/** One decimal place. */
function oneDp(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Reduce a day's raw activity rows into per-job facts.
 *
 * Restricted to `activeJobIds`: a row whose `job_id` is null or not an active
 * job contributes to nothing. The returned map contains ONLY jobs that ended
 * the day with real activity — a job present in `activeJobIds` but idle is
 * absent, so the caller writes no empty entry for it.
 *
 * Pure: no mutation of the inputs, no clock. Labour headcount counts DISTINCT
 * users (two shifts by the same person are one head); hours sum only CLOSED
 * entries. Delivery references are de-duplicated in first-seen order so the
 * summary line is stable across any permutation of the input.
 */
export function aggregateDailyActivity(
  input: DailyActivityInput,
): Map<string, DiaryRollupFacts> {
  const active = input.activeJobIds;
  const byJob = new Map<string, DiaryRollupFacts>();
  // Distinct-user tracking is separate so the public facts stay a plain count.
  const labourUsers = new Map<string, Set<string>>();
  const refsSeen = new Map<string, Set<string>>();

  const facts = (jobId: string): DiaryRollupFacts => {
    let f = byJob.get(jobId);
    if (!f) {
      f = emptyFacts();
      byJob.set(jobId, f);
    }
    return f;
  };
  const keep = (jobId: string | null): jobId is string =>
    typeof jobId === "string" && jobId.length > 0 && active.has(jobId);

  for (const r of input.photos) {
    if (keep(r.job_id)) facts(r.job_id).photos++;
  }
  for (const r of input.snagsRaised) {
    if (keep(r.job_id)) facts(r.job_id).snagsRaised++;
  }
  for (const r of input.snagsResolved) {
    if (keep(r.job_id)) facts(r.job_id).snagsResolved++;
  }
  for (const r of input.deliveries) {
    if (!keep(r.job_id)) continue;
    const f = facts(r.job_id);
    f.deliveries++;
    const ref = typeof r.reference === "string" ? r.reference.trim() : "";
    if (ref) {
      let seen = refsSeen.get(r.job_id);
      if (!seen) {
        seen = new Set<string>();
        refsSeen.set(r.job_id, seen);
      }
      if (!seen.has(ref)) {
        seen.add(ref);
        f.deliveryReferences.push(ref);
      }
    }
  }
  for (const r of input.labour) {
    if (!keep(r.job_id)) continue;
    const f = facts(r.job_id);
    let users = labourUsers.get(r.job_id);
    if (!users) {
      users = new Set<string>();
      labourUsers.set(r.job_id, users);
    }
    users.add(r.user_id);
    f.labourHeadcount = users.size;
    if (r.ended_at) {
      const h = hoursBetween(r.started_at, r.ended_at);
      if (h !== null) f.labourHours = oneDp(f.labourHours + h);
    }
  }

  // Drop any job that ended up with no real activity (defensive — every path
  // above increments, but a future signal added carelessly must not leak an
  // empty entry through).
  for (const [jobId, f] of byJob) {
    if (!hasRollupActivity(f)) byJob.delete(jobId);
  }
  return byJob;
}

// ── Composition ──────────────────────────────────────────────────────────────

/** The weather suggestion for the day, supplied by the service (null when dark). */
export type RollupWeather = { text: string; attribution: string | null };

/** The fields written onto the auto diary entry. */
export type DiaryRollupComposition = {
  /** Free-text weather field — the provider suggestion, or null when dark. */
  weather: string | null;
  /** Headcount on site, or null when nobody logged time. */
  labour_count: number | null;
  /** The substance: a human-readable summary of the day's recorded activity. */
  work_summary: string;
  /** Provenance line(s): what wrote this and any attribution. */
  notes: string;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** The fixed provenance sentence stamped on every auto entry. */
export const AUTO_ROLLUP_NOTE =
  "Generated automatically by CrewFlow from the day's recorded site activity " +
  "(photos, snags, deliveries and time on site). Review, edit or delete as needed.";

/**
 * Compose the diary fields for one job's day, or `null` when the day carried no
 * activity worth a record.
 *
 * `weather` is the provider suggestion when one exists and `null` on every dark
 * build — in that case the weather field is simply left empty (never invented),
 * and when present the licence attribution is appended to the notes because the
 * suggestion IS provider-derived data.
 */
export function composeDiaryRollup(
  facts: DiaryRollupFacts,
  opts: { date: string; weather?: RollupWeather | null },
): DiaryRollupComposition | null {
  if (!hasRollupActivity(facts)) return null;

  const lines: string[] = [];
  if (facts.photos > 0) {
    lines.push(`${facts.photos} site ${plural(facts.photos, "photo")} added`);
  }
  if (facts.snagsRaised > 0 || facts.snagsResolved > 0) {
    const parts: string[] = [];
    if (facts.snagsRaised > 0) {
      parts.push(`${facts.snagsRaised} ${plural(facts.snagsRaised, "snag")} raised`);
    }
    if (facts.snagsResolved > 0) parts.push(`${facts.snagsResolved} closed`);
    lines.push(parts.join(", "));
  }
  if (facts.deliveries > 0) {
    const refs =
      facts.deliveryReferences.length > 0
        ? ` (${facts.deliveryReferences.join(", ")})`
        : "";
    lines.push(`${facts.deliveries} ${plural(facts.deliveries, "delivery", "deliveries")} received${refs}`);
  }
  if (facts.labourHeadcount > 0) {
    const hrs =
      facts.labourHours > 0
        ? ` — ${facts.labourHours} ${plural(facts.labourHours, "hr")} logged`
        : "";
    lines.push(
      `${facts.labourHeadcount} ${plural(facts.labourHeadcount, "operative")} on site${hrs}`,
    );
  }

  const heading = `Automatic daily roll-up for ${formatDiaryDate(opts.date)}.`;
  const work_summary = `${heading}\n\n${lines.map((l) => `• ${l}`).join("\n")}`;

  const weatherText =
    opts.weather && opts.weather.text.trim().length > 0 ? opts.weather.text.trim() : null;
  const attribution =
    weatherText && opts.weather?.attribution ? opts.weather.attribution.trim() : "";
  const notes = attribution ? `${AUTO_ROLLUP_NOTE}\n\n${attribution}` : AUTO_ROLLUP_NOTE;

  return {
    weather: weatherText,
    labour_count: facts.labourHeadcount > 0 ? facts.labourHeadcount : null,
    work_summary,
    notes,
  };
}
