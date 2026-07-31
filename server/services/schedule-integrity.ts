import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  detectScheduleConflicts,
  summariseScheduleConflicts,
  type AssetCustodyRow,
  type LeaveRow,
  type RotaShiftRow,
  type ScheduleConflict,
  type ScheduleConflictInput,
  type ScheduledJobRow,
  type ScheduleIntegritySummary,
} from "@/lib/schedule/conflicts";
import {
  buildScheduleWindow,
  ROTA_LOOKBACK_MS,
  SCHEDULE_WINDOW_DAYS,
  type ScheduleWindow,
} from "@/lib/schedule/window";
import {
  recommendForConflicts,
  summariseRecommendations,
  type RecommendationInput,
  type RecommendationSummary,
  type RosterMember,
  type ScheduleRecommendation,
} from "@/lib/schedule/recommendations";

/**
 * Schedule Integrity — the read layer behind the conflict detector.
 *
 * This module FETCHES; it never decides and it NEVER WRITES. Every statement it
 * issues is a `select` — there is no insert/update/delete/rpc anywhere in the
 * file, and the client type below (`ScheduleClient`) structurally exposes only
 * read verbs, so a write cannot be added here without also widening the type. A
 * scheduling problem is surfaced and explained; moving the shift stays a human's
 * decision on the rota page.
 *
 * That holds with RECOMMENDATIONS attached (lib/schedule/recommendations.ts).
 * A recommendation is a sentence and a pre-filled link, computed in a pure
 * module from the rows below; applying one is a human pressing Assign, which
 * runs `createRotaEntry` with its own admin gate. Nothing in this file's read
 * path gained the ability to move a shift, and nothing here calls a model.
 *
 * SCOPING — belt and braces, deliberately:
 *   1. RLS: reads run on the caller's client (the user's JWT in the app).
 *   2. `org_id` PINNED on every single read. `current_org_ids()` returns EVERY
 *      org the viewer belongs to, so an RLS-only read BLENDS tenants for a
 *      dual-org member — the class fixed in #456 and twice before that. RLS is
 *      the floor here, never the scoping mechanism.
 *   3. Name lookups are resolved from THIS org's `memberships`, so a co-worker
 *      in the viewer's OTHER org can never be named on this org's page.
 *
 * PAGING: `fetchAllRows` requires a UNIQUE total order — a non-unique sort key
 * (a timestamp, an FK) can drop or duplicate rows at a 500-row page edge. Every
 * read therefore orders by the primary key `id`. Chronology is the pure core's
 * job, not the query's.
 *
 * BOUNDING: reads are windowed to a fortnight (see lib/schedule/window.ts) and
 * hit the existing indexes — `rota_entries (org_id, starts_at)`,
 * `jobs (org_id, scheduled_date)`, `leave_requests (org_id, status)` — so this
 * never scans a year of rota to render a dashboard line.
 *
 * TESTABILITY: `gatherScheduleFacts` takes the Supabase client as an argument
 * rather than creating it, so the integration suite drives the EXACT same
 * queries with a real user JWT against real Postgres.
 */

type Row = Record<string, unknown>;

/**
 * Minimal, self-returning, READ-ONLY view of the PostgREST builder — enough for
 * the chains below without fighting the generated `Database` types (neither
 * `asset_assignments` nor the embedded customer join is in lib/supabase/types.ts).
 * Mirrors server/services/job-site-hub.ts.
 */
export type ScheduleClient = {
  from: (t: string) => ScheduleBuilder;
};
type ScheduleBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => ScheduleBuilder;
  eq: (k: string, v: unknown) => ScheduleBuilder;
  in: (k: string, v: readonly unknown[]) => ScheduleBuilder;
  gte: (k: string, v: unknown) => ScheduleBuilder;
  lt: (k: string, v: unknown) => ScheduleBuilder;
  lte: (k: string, v: unknown) => ScheduleBuilder;
  order: (k: string, o: { ascending: boolean }) => ScheduleBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

/**
 * How far back asset custody is read. Custody records are long-lived and sparse
 * (tens of assets × a few movements each), so a quarter is both cheap and enough
 * for an overlap to have two parties inside the read.
 */
const CUSTODY_LOOKBACK_DAYS = 90;

/** Hard ceiling on the rendered list — the page shows "N of M" beyond it. */
export const SCHEDULE_CONFLICTS_PAGE_LIMIT = 60;

/**
 * Page an org-pinned read to completion, ordered by the unique primary key.
 * `build` adds the window filters; a read error degrades to whatever was
 * gathered, matching the briefing's best-effort posture.
 */
async function pagedRows<T>(
  db: ScheduleClient,
  table: string,
  cols: string,
  orgId: string,
  build: (b: ScheduleBuilder) => ScheduleBuilder,
  pageSize?: number,
): Promise<T[]> {
  const { data } = await fetchAllRows<Row>(
    (from, to) =>
      build(db.from(table).select(cols).eq("org_id", orgId))
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return data as unknown as T[];
}

export interface ScheduleFacts {
  window: ScheduleWindow;
  rota: RotaShiftRow[];
  jobs: ScheduledJobRow[];
  leave: LeaveRow[];
  custody: AssetCustodyRow[];
  people: Map<string, string>;
  assets: Map<string, string>;
  /**
   * EVERY member of the active org, name-resolved and ordered.
   *
   * Detection only ever needed the handful of people a conflict already names.
   * Recommendation needs the OPPOSITE set — the colleague who appears in no
   * conflict at all is exactly the person who is free — so the membership read
   * became the roster rather than a name filter. It stays the same single
   * org-pinned read, so the widened set cannot widen the tenant.
   */
  roster: RosterMember[];
}

/**
 * Read every fact the detector needs, for ONE org, inside ONE window.
 *
 * Two waves, never N+1. Wave 1 reads the four windowed scheduling tables plus
 * this org's membership list in parallel; wave 2 resolves display names for the
 * user and asset ids wave 1 actually produced, with one read each.
 */
export async function gatherScheduleFacts(
  db: ScheduleClient,
  orgId: string,
  window: ScheduleWindow,
  pageSize?: number,
): Promise<ScheduleFacts> {
  const winEndIso = new Date(window.interval.end).toISOString();
  // The pad exists because `ends_at` is unindexed: a shift that began before the
  // window but runs into it must still be read, and padding the INDEXED lower
  // bound on `starts_at` is what keeps that an index range scan.
  const rotaFromIso = new Date(window.interval.start - ROTA_LOOKBACK_MS).toISOString();
  const custodyFromIso = new Date(
    window.interval.start - CUSTODY_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();

  const [rota, jobRows, leave, custody, members] = await Promise.all([
    pagedRows<RotaShiftRow>(
      db,
      "rota_entries",
      "id, user_id, job_id, starts_at, ends_at",
      orgId,
      (b) => b.gte("starts_at", rotaFromIso).lt("starts_at", winEndIso),
      pageSize,
    ),
    pagedRows<{ id: string; assigned_to: string | null; scheduled_date: string | null; status: string | null; customers: { name: string | null } | { name: string | null }[] | null }>(
      db,
      "jobs",
      "id, assigned_to, scheduled_date, status, customers(name)",
      orgId,
      (b) => b.gte("scheduled_date", window.fromDay).lte("scheduled_date", window.toDay),
      pageSize,
    ),
    // Approved leave only — a pending request is not a commitment, and the
    // (org_id, status) index makes this the cheapest possible read.
    pagedRows<LeaveRow>(
      db,
      "leave_requests",
      "id, user_id, type, status, starts_at, ends_at",
      orgId,
      (b) => b.eq("status", "approved").gte("ends_at", window.fromDay).lte("starts_at", window.toDay),
      pageSize,
    ),
    pagedRows<AssetCustodyRow>(
      db,
      "asset_assignments",
      "id, asset_id, status, assigned_at, actual_return_at",
      orgId,
      (b) => b.gte("assigned_at", custodyFromIso).lt("assigned_at", winEndIso),
      pageSize,
    ),
    // `role` rides along for display only. It is memberships.role — owner /
    // admin / staff, an AUTHORISATION role — and the recommender is explicitly
    // forbidden from scoring it, because CrewFlow stores no competency data and
    // a role is not a proxy for one.
    pagedRows<{ user_id: string; role: string | null }>(
      db,
      "memberships",
      "id, user_id, role",
      orgId,
      (b) => b,
      pageSize,
    ),
  ]);

  // `jobs` carries no title, so the customer name IS the label. PostgREST returns
  // an embedded to-one as an object, but older shapes hand back a single-element
  // array — normalise both rather than trusting one.
  const jobs: ScheduledJobRow[] = jobRows.map((j) => {
    const c = Array.isArray(j.customers) ? j.customers[0] : j.customers;
    return {
      id: j.id,
      assigned_to: j.assigned_to,
      scheduled_date: j.scheduled_date,
      status: j.status,
      customer_name: c?.name ?? null,
    };
  });

  // THE ORG PIN ON NAMES. `users` RLS lets a viewer read the profile of anyone
  // sharing ANY of their orgs, so resolving names straight from the ids in hand
  // would name an org-B colleague on org A's page. THIS org's membership list is
  // the only id set names are ever resolved for — which is also, exactly, the
  // roster the recommender is allowed to propose from. Both guarantees come from
  // the one pin: nobody outside this org can be named, and nobody outside this
  // org can be suggested.
  const memberIds = [...new Set(members.map((m) => m.user_id))].sort();
  const assetIds = [...new Set(custody.map((c) => c.asset_id).filter(Boolean))];

  const [userRows, assetRows] = await Promise.all([
    memberIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; full_name: string | null; email: string | null }>)
      : (async () => {
          const { data } = await fetchAllRows<Row>(
            (from, to) =>
              db
                .from("users")
                .select("id, full_name, email")
                .in("id", memberIds)
                .order("id", { ascending: true })
                .range(from, to),
            pageSize,
          );
          return data as unknown as Array<{ id: string; full_name: string | null; email: string | null }>;
        })(),
    assetIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; name: string | null }>)
      : pagedRows<{ id: string; name: string | null }>(
          db,
          "assets",
          "id, name",
          orgId,
          (b) => b.in("id", assetIds),
          pageSize,
        ),
  ]);

  const people = new Map<string, string>();
  for (const u of userRows) {
    const label = (u.full_name ?? "").trim() || (u.email ?? "").trim();
    if (label) people.set(u.id, label);
  }
  const assets = new Map<string, string>();
  for (const a of assetRows) if (a.name) assets.set(a.id, a.name);

  // One row per member, deduped (a corrupt double-membership must not double a
  // person's odds of being proposed) and ordered by NAME so the roster — and
  // therefore every tie-broken candidate list built from it — is reproducible.
  const seen = new Set<string>();
  const roster: RosterMember[] = [];
  for (const m of members) {
    if (seen.has(m.user_id)) continue;
    seen.add(m.user_id);
    roster.push({
      userId: m.user_id,
      name: people.get(m.user_id) ?? "A team member",
      role: (m.role ?? "").trim() || "staff",
    });
  }
  roster.sort((a, b) =>
    a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.userId < b.userId ? -1 : 1,
  );

  return { window, rota, jobs, leave, custody, people, assets, roster };
}

export interface ScheduleIntegrityReport {
  window: ScheduleWindow;
  /** Ranked findings, capped for display. */
  conflicts: ScheduleConflict[];
  /** Total found BEFORE the display cap — drives "showing N of M". */
  total: number;
  summary: ScheduleIntegritySummary;
  /**
   * Resolutions for the DISPLAYED conflicts, keyed by `ScheduleConflict.key`.
   *
   * Computed for the capped list only: the uncapped list can run to hundreds,
   * every one of which would walk the roster, and a proposal nobody will see is
   * work nobody asked for. A key that is absent means the class carries no
   * staffing question at all (`asset_double_booked`), which is NOT the same as
   * "we looked and found nobody" — that case is a present entry with an empty
   * `candidates` and a populated `impossible`.
   */
  recommendations: Map<string, ScheduleRecommendation>;
  recommendationSummary: RecommendationSummary;
  generatedAt: string;
}

function emptyReport(window: ScheduleWindow, generatedAt: string): ScheduleIntegrityReport {
  const recommendations = new Map<string, ScheduleRecommendation>();
  return {
    window,
    conflicts: [],
    total: 0,
    summary: summariseScheduleConflicts([]),
    recommendations,
    recommendationSummary: summariseRecommendations(recommendations),
    generatedAt,
  };
}

/**
 * Build the full report for one org.
 *
 * Best-effort by contract: any read failure degrades to an EMPTY report rather
 * than throwing. This renders as an additive section beside others, and a hiccup
 * must cost this section, never the page. An empty report is honestly presented
 * as "nothing found", never as a guarantee that nothing is wrong.
 */
export async function buildScheduleIntegrity(
  orgId: string,
  options: { now?: Date; days?: number; limit?: number } = {},
): Promise<ScheduleIntegrityReport> {
  const now = options.now ?? new Date();
  const window = buildScheduleWindow(now, options.days ?? SCHEDULE_WINDOW_DAYS);
  const generatedAt = now.toISOString();
  const limit = options.limit ?? SCHEDULE_CONFLICTS_PAGE_LIMIT;
  try {
    const supabase = await createClient();
    const facts = await gatherScheduleFacts(supabase as unknown as ScheduleClient, orgId, window);
    const input: ScheduleConflictInput = facts;
    const all = detectScheduleConflicts(input);
    const shown = all.slice(0, limit);
    // PURE, and passed the SAME facts the detection ran on — so a proposal can
    // never cite a row the finding above it did not see.
    const recommendations = recommendForConflicts(shown, facts satisfies RecommendationInput);
    return {
      window,
      conflicts: shown,
      total: all.length,
      summary: summariseScheduleConflicts(all),
      recommendations,
      recommendationSummary: summariseRecommendations(recommendations),
      generatedAt,
    };
  } catch (err) {
    console.warn("[schedule-integrity] build failed; reporting no conflicts", err);
    return emptyReport(window, generatedAt);
  }
}

/**
 * The COMPLETE ranked list, uncapped — what the Daily Briefing consumes.
 *
 * The briefing counts classes rather than listing rows, and a count taken from a
 * display-capped list would silently under-report ("2 clashes" when there are
 * 80). Same best-effort contract: a failure yields an empty list.
 */
export async function loadScheduleConflicts(
  orgId: string,
  now: Date = new Date(),
): Promise<ScheduleConflict[]> {
  const { conflicts } = await buildScheduleIntegrity(orgId, {
    now,
    limit: Number.MAX_SAFE_INTEGER,
  });
  return conflicts;
}
