import "server-only";

/**
 * Rota — the read layer behind the staff rota page and the shift-conflict
 * check in `createRotaEntry`.
 *
 * Every read here is PINNED to the active org as well as running under RLS.
 * `current_org_ids()` returns EVERY org the viewer belongs to, so an RLS-only
 * read blends orgs for a dual-org member: their other company's shifts render
 * inside this org's grid, the job picker lists the other company's jobs (and
 * customers' names), and the overlap check refuses a legitimate shift because
 * of a clash in the other org. Same class as the job-domain fixes in #456.
 *
 * These functions take the Supabase client as an argument (mirrors
 * job-site-hub.ts) so the integration suite can drive the EXACT same queries
 * with a real user JWT against real Postgres — removing a pin here goes red
 * in __tests__/integration/rls/rota-isolation.test.ts, not just in review.
 */

import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

type Row = Record<string, unknown>;

export type RotaClient = {
  from: (t: string) => RotaBuilder;
};
type RotaBuilder = PromiseLike<{ data: Row[] | null; error: SupabaseReadError | null }> & {
  select: (c: string) => RotaBuilder;
  eq: (k: string, v: unknown) => RotaBuilder;
  gte: (k: string, v: unknown) => RotaBuilder;
  lte: (k: string, v: unknown) => RotaBuilder;
  order: (k: string, o: { ascending: boolean; nullsFirst?: boolean }) => RotaBuilder;
  limit: (n: number) => RotaBuilder;
};

export type RotaEntryRow = {
  id: string;
  user_id: string;
  job_id: string | null;
  starts_at: string;
  ends_at: string;
  notes: string | null;
};

export type RotaJobOption = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

export type ShiftWindow = { starts_at: string; ends_at: string };

/** A row the generated-rota approval writes into `rota_entries`. */
export type RotaInsertRow = {
  org_id: string;
  user_id: string;
  job_id: string | null;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  created_by: string;
};

/**
 * Write-capable client shape for the bulk rota insert. Kept separate from the
 * read `RotaClient` so the read surface stays read-only, and typed minimally so
 * the integration suite can drive the EXACT same call with a real user JWT.
 */
export type RotaWriteClient = {
  from: (t: string) => {
    insert: (rows: RotaInsertRow[]) => {
      select: (c: string) => PromiseLike<{
        data: Row[] | null;
        error: SupabaseReadError | null;
      }>;
    };
  };
};

/** How many jobs the assign-shift picker offers. */
export const ROTA_JOB_PICKER_LIMIT = 50;

/** The rota grid's weekly read — active-org rows only. */
export async function listWeekRotaEntries(
  db: RotaClient,
  orgId: string,
  startIso: string,
  endIso: string,
): Promise<RotaEntryRow[]> {
  const { data, error } = await db
    .from("rota_entries")
    .select("id, user_id, job_id, starts_at, ends_at, notes")
    .eq("org_id", orgId)
    .gte("starts_at", startIso)
    .lte("starts_at", endIso)
    .order("starts_at", { ascending: true });
  if (error) throw readFailure("rota: week entries", error);
  return (data ?? []) as unknown as RotaEntryRow[];
}

/** The assign-shift form's job picker — active-org jobs only. */
export async function listRotaJobOptions(
  db: RotaClient,
  orgId: string,
): Promise<RotaJobOption[]> {
  const { data, error } = await db
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    .eq("org_id", orgId)
    .order("scheduled_date", { ascending: false, nullsFirst: false })
    .limit(ROTA_JOB_PICKER_LIMIT);
  if (error) throw readFailure("rota: job options", error);
  return (data ?? []) as unknown as RotaJobOption[];
}

/**
 * The overlap-check window for `createRotaEntry` — the user's shifts on one
 * day IN THE ACTIVE ORG. A clash in the user's other org must neither block
 * a shift here nor leak that the other org's rota exists.
 */
export async function listUserShiftsOnDay(
  db: RotaClient,
  orgId: string,
  userId: string,
  dayStart: string,
): Promise<ShiftWindow[]> {
  const { data, error } = await db
    .from("rota_entries")
    .select("starts_at, ends_at")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .gte("starts_at", `${dayStart}T00:00:00Z`)
    .lte("starts_at", `${dayStart}T23:59:59Z`);
  // A failed overlap read must BLOCK the shift write — an empty result here
  // would let a double-booked shift through.
  if (error) throw readFailure("rota: user shifts on day", error);
  return (data ?? []) as unknown as ShiftWindow[];
}

/**
 * Write the approved generated rota — ALL-OR-NOTHING.
 *
 * Every row is written in ONE `insert([...])`, which Postgres runs as a single
 * `INSERT … VALUES (…),(…),…` statement: if any row fails a constraint (the
 * `rota_entries_check` on `ends_at > starts_at`, a foreign key, or RLS's admin
 * `WITH CHECK`) the whole statement rolls back and NOTHING is written. There is
 * no partial save to reconcile, so no transaction wrapper or RPC is needed.
 *
 * The caller (`persistGeneratedRota`) has already deduplicated against the live
 * rota (idempotency) and dropped clashes (never overwrite), so the rows handed
 * here are the clean set to add. RLS still enforces admin-only INSERT underneath
 * — this function is the write path a non-admin can never reach.
 *
 * Returns the inserted rows. An empty input writes nothing and returns [].
 */
export async function insertRotaEntries(
  db: RotaWriteClient,
  rows: RotaInsertRow[],
): Promise<RotaEntryRow[]> {
  if (rows.length === 0) return [];
  const { data, error } = await db
    .from("rota_entries")
    .insert(rows)
    .select("id, user_id, job_id, starts_at, ends_at, notes");
  if (error) throw readFailure("rota: bulk insert", error);
  return (data ?? []) as unknown as RotaEntryRow[];
}
