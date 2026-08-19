import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  projectBriefingRow,
  type CeoBriefingRecord,
  type CeoBriefingRow,
} from "@/lib/hq/ceo-briefing-record";

/**
 * CrewFlow HQ — the auto morning CEO briefing, the READ side (P2 HQ AI Operating System).
 *
 * server/services/hq-ceo-briefing.ts gave the daily briefing a durable, append-only,
 * deterministic home (hq_ceo_briefings, migration 20261128) and deliberately stayed
 * WRITE-ONLY. This module is its read-only counterpart: it SELECTs the recorded
 * briefings for /admin/ceo/briefings — the reader that finally surfaces what the cron
 * has been composing every morning.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * READ-ONLY, LOUD, PAGED — the three house rules for a new HQ read
 * ───────────────────────────────────────────────────────────────────────────
 * READ-ONLY BY CONSTRUCTION: this module issues nothing but `.select()` — never
 * insert/update/delete, never the write RPC. The table's append-only triggers would
 * refuse a mutation even under service-role; this module simply never asks, so the
 * composition it reads can never be perturbed by reading it.
 *
 * LOUD: a failed select THROWS via readFailure rather than degrading to an empty
 * archive that would misreport "no briefings yet" when the read actually failed
 * (the silent-empty-state class). The route-group error boundary renders the fault.
 *
 * PAGED (F-1 safe): the archive is read through fetchAllRows under a stable total
 * order (briefing_date desc, id desc), so it can never be silently truncated at the
 * PostgREST row cap as the daily history accumulates over the years.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

const BRIEFING_COLUMNS =
  "id, briefing_date, source, correlation_id, headline, narrative, signals, " +
  "generated_at, created_at";

// hq_ceo_briefings is a service-role-only HQ table (RLS:hq, zero policies) and is
// NOT in the generated Supabase types — cast past the typed client, the same shim
// executor-shadow-observations.ts / hq-approvals.ts use for their HQ tables.
type ReadQuery<T> = {
  select(columns: string): ReadQuery<T>;
  order(column: string, options?: { ascending?: boolean }): ReadQuery<T>;
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: unknown }>;
};

function reads<T>(admin: AdminClient, table: string): ReadQuery<T> {
  return admin.from(table as never) as unknown as ReadQuery<T>;
}

/** The recorded briefings, newest day first — the whole archive, paged and loud. */
export type CeoBriefingArchive = {
  /** The most recent briefing, or null when none has been recorded yet. */
  readonly latest: CeoBriefingRecord | null;
  /** Every prior briefing after the latest, newest first (may be empty). */
  readonly history: ReadonlyArray<CeoBriefingRecord>;
  /** The complete archive newest-first (latest + history), for callers that want it flat. */
  readonly all: ReadonlyArray<CeoBriefingRecord>;
};

/**
 * Read the full CEO-briefing archive, newest day first. Paged under the PostgREST
 * cap and LOUD on failure (throws — never a silently-empty archive). Ordered by
 * (briefing_date desc, id desc): briefing_date is unique per day (the store's
 * one-per-day key), and id is a total tiebreaker, so pages never shift.
 */
export async function getCeoBriefingArchive(): Promise<CeoBriefingArchive> {
  const admin = createAdminClient();

  const { data, error } = await fetchAllRows<CeoBriefingRow>((from, to) =>
    reads<CeoBriefingRow>(admin, "hq_ceo_briefings")
      .select(BRIEFING_COLUMNS)
      .order("briefing_date", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  // LOUD: fetchAllRows returns { data, error } best-effort; a new HQ read must not
  // render a partial/empty archive on a failed page — surface it.
  if (error) throw readFailure("hq-ceo-briefing-reader: archive", error as never);

  const all = (data ?? []).map(projectBriefingRow);
  return { latest: all[0] ?? null, history: all.slice(1), all };
}

/**
 * Resolve one briefing by its calendar day (ISO `YYYY-MM-DD`) from a loaded archive.
 * Pure selection over the already-read set — no extra query — so a page that has the
 * archive can drill into any day without re-reading. Returns null for an unknown day.
 */
export function selectBriefingByDate(
  archive: CeoBriefingArchive,
  briefingDate: string | null | undefined,
): CeoBriefingRecord | null {
  if (!briefingDate) return archive.latest;
  return archive.all.find((b) => b.briefingDate === briefingDate) ?? archive.latest;
}
