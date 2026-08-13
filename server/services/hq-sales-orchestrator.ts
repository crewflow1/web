import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  computeSalesOrchestratorBoard,
  type SalesOrchestratorBoard,
  type SalesOrchestratorDrainsInput,
  type SalesOrchestratorInput,
} from "@/lib/hq/sales-orchestrator";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

/**
 * CrewFlow HQ — Sales-Orchestrator AI aggregator (super-admin surface).
 * Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-customer-success.ts` and
 * `server/services/hq-marketing.ts`: it gathers the raw cross-stage sales
 * signals from the EXISTING read models and hands a plain
 * `SalesOrchestratorInput` to the pure, deterministic
 * `computeSalesOrchestratorBoard` (lib/hq/sales-orchestrator.ts). All
 * honesty/labelling lives in the pure layer — this module never duplicates it;
 * it reads CrewFlow's OWN sales pipeline, the three drain queues on the HQ task
 * engine, and the outreach cadence on the permanent timeline, then folds each to
 * the lean shape the pure layer consumes.
 *
 * WHY these sources? The Sales AI platform already runs three drains (Research /
 * Qualification / Outreach). This board UNIFIES them:
 *   · `hq_sales_companies` — CrewFlow's OWN deal pipeline (status + timestamps);
 *   · `hq_ai_tasks`        — the three drains' task queues, keyed by task_type;
 *   · `hq_sales_timeline_events` — outbound outreach touches, for cadence health.
 * All three are HQ-GLOBAL tables (the `hq_sales_*` set + the HQ queue), read on
 * the service-role path. NO tenant-scoped product table is queried — summing a
 * tenant table across orgs on this HQ surface would be the #456 leak class, so it
 * is deliberately NOT read. Only lean columns are selected (status + timestamps,
 * event_type/direction/occurred_at) — no company names, no contact PII.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as honest
 * `insufficient` cards rather than fabricated zeros or a broken page. The
 * genuinely absent sources (cohort deal velocity, forecast win probability) have
 * NO reader here at all — the pure layer emits them insufficient by construction.
 */

export type SalesOrchestratorBoardResult = {
  board: SalesOrchestratorBoard;
  /**
   * The governed sales-orchestrator narrative — a short prose blurb over the
   * deterministic pipeline-health figures, generated via the shared HQ narrative
   * helper. `null` until a model tier is bound (and the vendor credential + HQ
   * budget org are present), on any governor refusal, or on a provider failure.
   * The UI shows an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

// ---------------------------------------------------------------------
// The three drains, keyed by their durable hq_ai_tasks task_type. NOT minted
// here — these are the exact task types the three runners drain (see
// server/services/hq-{research,qualification,outreach}.ts).
// ---------------------------------------------------------------------

const DRAIN_TASK_TYPES = {
  research: "research_company",
  qualification: "qualify_company",
  outreach: "generate_email",
} as const;

/** The post-qualification, still-open statuses expected in an outreach cadence. */
const ACTIVE_OUTREACH_STATUSES = [
  "outreach_ready",
  "contacted",
  "replied",
  "demo_booked",
] as const;

/** The outreach cadence window (days) — a live deal should be touched inside it. */
const CADENCE_DAYS = 7;

// ---------------------------------------------------------------------
// Minimal typed shim over the (still-untyped) hq_sales_* / hq_ai_tasks query
// builder — mirrors hq-sales.ts / hq-research.ts. These HQ-global tables have
// RLS enabled with ZERO policies, so every read here is only ever visible to the
// service-role client (the caller has already confirmed super-admin via
// requireHqPage). The shim exposes reads ONLY — no insert/update/delete.
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;
type DbError = { message: string } | null;
type ListResult<T> = { data: T[] | null; error: DbError };

interface HqQuery<T> extends PromiseLike<ListResult<T>> {
  select(columns: string): HqQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): HqQuery<T>;
  eq(column: string, value: unknown): HqQuery<T>;
  gte(column: string, value: unknown): HqQuery<T>;
  limit(count: number): HqQuery<T>;
  order(column: string, opts: { ascending: boolean }): HqQuery<T>;
  range(from: number, to: number): PromiseLike<ListResult<T>>;
}

type CompanyRow = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

/**
 * Read CrewFlow's own sales pipeline, lean (status + timestamps + id for the
 * cadence join — no name / contact PII). Returns `null` on failure (loud) so the
 * pure layer marks the pipeline figures insufficient rather than fabricating a
 * zero funnel. The `id` is used only to join outbound touches for cadence; it is
 * stripped before the rows reach the pure board.
 */
async function readPipeline(): Promise<CompanyRow[] | null> {
  try {
    const admin: AdminClient = createAdminClient();
    // PAGED (F-1): the estate-wide sales pipeline is mapped into CompanyRow[] and
    // reduced into orchestration counts — the old `.limit(1000)` sat exactly on
    // the PostgREST max_rows boundary, indistinguishable from silent truncation,
    // so a >1000-company pipeline was capped with no error. Page the complete set.
    const { data, error } = await fetchAllRows<CompanyRow>(
      (from, to) =>
        (admin.from("hq_sales_companies" as never) as unknown as HqQuery<CompanyRow>)
          .select("id, status, created_at, updated_at")
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<CompanyRow>>,
    );
    if (error) throw readFailure("hq sales-orchestrator: pipeline", error);
    return (data ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  } catch (e) {
    console.error("[hq-sales-orchestrator] pipeline read failed", e);
    return null;
  }
}

type TaskRow = { task_type: string; status: string; created_at: string };

/**
 * Read the three drains' task queues in one bounded window and fold them per
 * drain (pending/running/completed/failed + the oldest pending created_at).
 * Returns `null` on failure (loud) so the pure layer marks the drain figures
 * insufficient rather than fabricating an all-idle split.
 */
async function readDrains(): Promise<SalesOrchestratorDrainsInput | null> {
  try {
    const admin: AdminClient = createAdminClient();
    const { data, error } = await (
      admin.from("hq_ai_tasks" as never) as unknown as HqQuery<TaskRow>
    )
      .select("task_type, status, created_at")
      .in("task_type", Object.values(DRAIN_TASK_TYPES))
      .limit(1000);
    if (error) throw readFailure("hq sales-orchestrator: drains", error);
    const rows = data ?? [];

    const foldOne = (taskType: string) => {
      let pending = 0;
      let running = 0;
      let completed = 0;
      let failed = 0;
      let oldestPendingAt: string | null = null;
      for (const r of rows) {
        if (r.task_type !== taskType) continue;
        switch (r.status) {
          case "pending":
            pending += 1;
            if (
              r.created_at &&
              (oldestPendingAt == null || r.created_at < oldestPendingAt)
            ) {
              oldestPendingAt = r.created_at;
            }
            break;
          case "running":
            running += 1;
            break;
          case "completed":
            completed += 1;
            break;
          case "failed":
            failed += 1;
            break;
          default:
            break;
        }
      }
      return { pending, running, completed, failed, oldestPendingAt };
    };

    return {
      research: foldOne(DRAIN_TASK_TYPES.research),
      qualification: foldOne(DRAIN_TASK_TYPES.qualification),
      outreach: foldOne(DRAIN_TASK_TYPES.outreach),
    };
  } catch (e) {
    console.error("[hq-sales-orchestrator] drains read failed", e);
    return null;
  }
}

/**
 * Compute outreach cadence over the open, post-qualification deals: how many were
 * touched (an OUTBOUND timeline event) within the cadence window, and how many
 * have gone silent. Depends on the pipeline read (for the active deal ids); when
 * the pipeline could not be read, cadence is `null` too. A timeline read failure
 * is loud and yields `null` (insufficient), never a fabricated cadence.
 */
async function readCadence(
  companies: CompanyRow[] | null,
): Promise<SalesOrchestratorInput["cadence"]> {
  if (companies == null) return null;
  const activeStatuses = new Set<string>(ACTIVE_OUTREACH_STATUSES);
  const activeIds = companies
    .filter((c) => activeStatuses.has(c.status))
    .map((c) => c.id);
  const activeOutreachDeals = activeIds.length;
  if (activeOutreachDeals === 0) {
    return { activeOutreachDeals: 0, touchedWithinWindow: 0, overdue: 0 };
  }

  try {
    const admin: AdminClient = createAdminClient();
    const cutoff = new Date(
      Date.now() - CADENCE_DAYS * 86_400_000,
    ).toISOString();
    const { data, error } = await (
      admin.from("hq_sales_timeline_events" as never) as unknown as HqQuery<{
        company_id: string;
      }>
    )
      .select("company_id, occurred_at, direction")
      .in("company_id", activeIds)
      .eq("direction", "outbound")
      .gte("occurred_at", cutoff)
      .limit(1000);
    if (error) throw readFailure("hq sales-orchestrator: cadence", error);
    const events = data ?? [];
    const touched = new Set<string>();
    for (const ev of events) touched.add(ev.company_id);
    const touchedWithinWindow = touched.size;
    return {
      activeOutreachDeals,
      touchedWithinWindow,
      overdue: activeOutreachDeals - touchedWithinWindow,
    };
  } catch (e) {
    console.error("[hq-sales-orchestrator] cadence read failed", e);
    return null;
  }
}

/**
 * Assemble the deterministic Sales-Orchestrator AI board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-stage on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadSalesOrchestratorBoard(): Promise<SalesOrchestratorBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const [companies, drains] = await Promise.all([readPipeline(), readDrains()]);
  const cadence = await readCadence(companies);

  const input: SalesOrchestratorInput = {
    pipeline:
      companies == null
        ? null
        : {
            companies: companies.map((c) => ({
              status: c.status,
              created_at: c.created_at,
              updated_at: c.updated_at,
            })),
          },
    drains,
    cadence,
  };

  const board = computeSalesOrchestratorBoard(input, new Date());
  const narrative = await loadSalesOrchestratorNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Sales-orchestrator narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared
 * HQ narrative helper (server/services/hq-narrative.ts), which reaches a model
 * ONLY through `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.sales_orchestrator_narrative` feature key (task class `drafting`), billed to
 * the HQ budget org. The model is handed the FINISHED deterministic board and may
 * only describe it — every displayed figure still comes from
 * `computeSalesOrchestratorBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadSalesOrchestratorNarrative(
  board: SalesOrchestratorBoard,
): Promise<string | null> {
  return generateHqBoardNarrative("hq.sales_orchestrator_narrative", board);
}
