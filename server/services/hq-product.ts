import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { listFeatureSignalRowsForHq } from "@/server/services/hq-support-snapshot";
import { buildAnalyticsSnapshot } from "@/server/services/hq-analytics-snapshot";
import {
  computeCustomerAnalytics,
  computeRevenueAnalytics,
} from "@/lib/hq/analytics";
import {
  computeProductBoard,
  mapDemandThemesToProposals,
  type ProductBoard,
  type ProductInput,
} from "@/lib/hq/product";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";
import { openDeterministicProposal } from "@/server/services/hq-decisions";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  resolveExecIdentity,
  normaliseExecOutcome,
  type ExecRunOutcome,
} from "@/server/services/hq-exec-runner-kit";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

/**
 * CrewFlow HQ — Product AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-cto.ts` and
 * `server/services/hq-support-ai.ts`: it gathers the raw voice-of-customer /
 * product signals from the EXISTING read models and hands a plain `ProductInput`
 * to the pure, deterministic `computeProductBoard` (lib/hq/product.ts). All
 * honesty/labelling lives in the pure layer — this module never duplicates it; it
 * reads the lean feature-request/support-ticket rows and the HQ analytics
 * snapshot, then folds each to the lean shape the pure layer consumes.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as an honest
 * `insufficient` card rather than a fabricated zero or a broken page. The genuinely
 * absent sources (competitor monitoring, roadmap prioritisation) have NO reader
 * here at all — the pure layer emits them insufficient by construction.
 */

export type ProductBoardResult = {
  board: ProductBoard;
  /**
   * The governed product narrative — a short prose blurb over the deterministic
   * product-signal figures, generated via the shared HQ narrative helper. `null`
   * until a model tier is bound (and the vendor credential + HQ budget org are
   * present), on any governor refusal, or on a provider failure. The UI shows an
   * empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/**
 * Assemble the deterministic Product AI board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadProductBoard(): Promise<ProductBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const board = await gatherProductBoard();
  const narrative = await loadProductNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Build the deterministic Product board WITHOUT the page auth gate — the shared
 * derivation used by both `loadProductBoard` (super-admin page) and the Product
 * executive runner (service-role cron). Reads only; no narrative, no auth.
 */
export async function gatherProductBoard(): Promise<ProductBoard> {
  const [tickets, snapshot] = await Promise.all([
    listFeatureSignalRowsForHq().catch((e) => {
      console.error("[hq-product] feature-signal read threw", e);
      return null;
    }),
    buildAnalyticsSnapshot().catch((e) => {
      console.error("[hq-product] analytics snapshot read failed", e);
      return null;
    }),
  ]);

  const input: ProductInput = {
    demand:
      tickets == null
        ? null
        : {
            tickets: tickets.map((t) => ({
              category: t.category,
              status: t.status,
              created_at: t.created_at,
            })),
          },
    adoption:
      snapshot == null
        ? null
        : (() => {
            const cust = computeCustomerAnalytics(snapshot);
            const rev = computeRevenueAnalytics(snapshot);
            const activeOrgs = snapshot.orgs.filter(
              (o) => o.status === "active",
            ).length;
            const trialOrgs = snapshot.orgs.filter(
              (o) => o.status === "trial",
            ).length;
            return {
              activeOrgs,
              trialOrgs,
              usageActive30d: cust.usage.activeLast30Days,
              usageNeverLoggedIn: cust.usage.neverLoggedIn,
              payingOrTrialBase: activeOrgs + trialOrgs,
              growthPct: rev.growthPct,
            };
          })(),
  };

  return computeProductBoard(input, new Date());
}

/**
 * Product narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ narrative
 * helper (server/services/hq-narrative.ts), which reaches a model ONLY through
 * `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.product_narrative` feature key (task class `drafting`), billed to the HQ
 * budget org. The model is handed the FINISHED deterministic board and may only
 * describe it — every displayed figure still comes from `computeProductBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadProductNarrative(board: ProductBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.product_narrative", board);
}

// ---------------------------------------------------------------------
// P11 — Product AI proposes to the Decision Centre.
//
// The `product_proposal` task: the same deterministic demand distribution the
// product board already reads (real feature_request / support-ticket rows) is
// mapped — pure, mapDemandThemesToProposals — into DRAFT hq_decisions
// proposals, opened through the Decision Centre's ONE sanctioned system entry
// point (openDeterministicProposal, exactly as hq-decision-autoproposal does).
// Every proposal is born `proposed` with no decider: a HUMAN approves/rejects/
// delays/delegates at the console. Cross-run idempotency is the Decision
// Centre's source_signal_key unique index — a theme proposes ONCE, ever, so the
// sweep can run daily (and overlap itself) without double-proposing.
// ---------------------------------------------------------------------

const PRODUCT_AI_SLUG = "product-ai";
/** The durable task_type of the demand→proposal sweep on the generic engine. */
const PRODUCT_PROPOSAL_TASK_TYPE = "product_proposal";

export type ProductProposalSweep = {
  /** Whether the demand source was readable this cycle. */
  demandRead: boolean;
  /** Draft proposals produced from the themes (post-mapping). */
  evaluated: number;
  /** Proposals newly opened this run. */
  created: number;
  /** Themes that already had a proposal (idempotent skip). */
  skipped_existing: number;
  /** Failures (logged; the sweep continues). */
  errors: number;
  /** The evidence trail: each mapped theme's key + title, for the artifact. */
  proposals: Array<{ sourceSignalKey: string; title: string; outcome: string }>;
};

/**
 * Read the live demand distribution and open a DRAFT proposal for each top
 * theme that clears the deterministic floor. Never decides, never executes;
 * a failed open is counted and logged, never thrown (the sweep is total).
 */
export async function sweepProductDemandProposals(): Promise<ProductProposalSweep> {
  const board = await gatherProductBoard();
  if (board.demand == null) {
    // The demand source was unreadable — an honest empty sweep, not a guess.
    return {
      demandRead: false,
      evaluated: 0,
      created: 0,
      skipped_existing: 0,
      errors: 0,
      proposals: [],
    };
  }

  const mapped = mapDemandThemesToProposals(
    board.demand.themes,
    board.demand.totalTickets,
  );

  let created = 0;
  let skippedExisting = 0;
  let errors = 0;
  const proposals: ProductProposalSweep["proposals"] = [];

  for (const p of mapped) {
    let outcome: string;
    try {
      outcome = await openDeterministicProposal({
        title: p.title,
        problem: p.problem,
        revenueImpact: p.revenueImpact,
        risk: p.risk,
        demand: p.demand,
        recommendation: p.recommendation,
        sourceSignalKey: p.sourceSignalKey,
      });
    } catch (e) {
      console.error(
        "[hq-product] demand proposal failed",
        p.sourceSignalKey,
        e instanceof Error ? e.message : String(e),
      );
      outcome = "error";
    }
    if (outcome === "created") created++;
    else if (outcome === "exists") skippedExisting++;
    else errors++;
    proposals.push({ sourceSignalKey: p.sourceSignalKey, title: p.title, outcome });
  }

  return {
    demandRead: true,
    evaluated: mapped.length,
    created,
    skipped_existing: skippedExisting,
    errors,
    proposals,
  };
}

/** The Task-Engine handler: the sweep's result IS the task artifact. */
const productProposalHandler: TaskHandler = async () => {
  const sweep = await sweepProductDemandProposals();
  return { ...sweep, generatedAt: new Date().toISOString() };
};

export async function enqueueProductProposalSweep(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(PRODUCT_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: PRODUCT_PROPOSAL_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${PRODUCT_PROPOSAL_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-product] proposal-sweep enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runProductProposalTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(PRODUCT_AI_SLUG);
  registerTaskHandler(PRODUCT_PROPOSAL_TASK_TYPE, identity, productProposalHandler);
  return normaliseExecOutcome(
    await runReadyTask(PRODUCT_PROPOSAL_TASK_TYPE, productProposalHandler, identity),
  );
}

export async function drainProductProposalTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(PRODUCT_AI_SLUG);
  registerTaskHandler(PRODUCT_PROPOSAL_TASK_TYPE, identity, productProposalHandler);
  const summary = await drainTaskType(
    PRODUCT_PROPOSAL_TASK_TYPE,
    productProposalHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { PRODUCT_PROPOSAL_TASK_TYPE };
