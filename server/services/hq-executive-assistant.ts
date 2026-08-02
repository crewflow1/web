import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { listPendingApprovals } from "@/server/services/hq-approvals";
import { listDecisions } from "@/server/services/hq-decisions";
import { buildAlertsSnapshot } from "@/server/services/hq-alerts-snapshot";
import { runAlertRules, applyStateToAlerts } from "@/lib/hq/alert-rules";
import {
  computeExecutiveAssistantBoard,
  type ExecutiveAssistantBoard,
  type ExecutiveAssistantInput,
} from "@/lib/hq/executive-assistant";

/**
 * CrewFlow HQ — Executive-Assistant AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-operations.ts`: it gathers the raw
 * "what needs the human" signals from the EXISTING HQ queues and hands a plain
 * `ExecutiveAssistantInput` to the pure, deterministic
 * `computeExecutiveAssistantBoard` (lib/hq/executive-assistant.ts). All
 * honesty/labelling/prioritisation lives in the pure layer — this module never
 * duplicates digest logic; it reads the Approval Engine (open approvals), the
 * Decision Centre (proposed + delayed decisions), the generic Task Engine (active
 * tasks, for the overdue/stall checks), and the deterministic HQ alerts rules
 * engine, then folds each to the lean shape the pure layer consumes.
 *
 * NO NEW DATA CAPABILITY. This is a pure cross-board PROJECTION over queues other
 * HQ surfaces already own — it composes over already-shipped substrate and adds no
 * table, no migration, and no write path. It NEVER decides, approves, or acts.
 *
 * SCOPE #456 — HQ-GLOBAL ONLY. Every source here is HQ infrastructure
 * (hq_approvals, hq_decisions, hq_ai_tasks, the estate-wide alerts engine), read
 * on the service-role path. No tenant-org table is touched, so no tenant data is
 * ever blended onto this super-admin surface.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as honest
 * `insufficient` cards AND — critically — prevents the board from ever showing
 * "all clear" over a source it could not read. An EMPTY but readable queue is a
 * legitimate factual zero here ("nothing pending"), so it is passed as an empty
 * array, never null.
 */

export type ExecutiveAssistantBoardResult = {
  board: ExecutiveAssistantBoard;
  /**
   * The governed executive-assistant narrative. DARK for now (see
   * `loadExecutiveAssistantNarrative`) — always `null` until a model tier is
   * bound. The UI shows an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/**
 * Read the Approval Engine's open review queue (pending + escalated) and fold it to
 * the pure layer's shape. Returns `null` on failure (loud) so the board marks the
 * approvals digest insufficient rather than fabricating an empty queue.
 */
async function readApprovals(): Promise<ExecutiveAssistantInput["approvals"]> {
  try {
    const rows = await listPendingApprovals(200);
    return {
      approvals: rows.map((r) => ({
        // listPendingApprovals returns only ACTIVE_STATES (pending | escalated).
        state: r.state === "escalated" ? "escalated" : "pending",
        requestedAt: r.requested_at,
      })),
    };
  } catch (e) {
    console.error("[hq-executive-assistant] approvals read failed", e);
    return null;
  }
}

/**
 * Read the Decision Centre's non-terminal queue — proposed (awaiting a call) and
 * delayed (parked for revisit). Returns `null` on failure (loud).
 */
async function readDecisions(): Promise<ExecutiveAssistantInput["decisions"]> {
  try {
    const [proposed, delayed] = await Promise.all([
      listDecisions({ status: "proposed", limit: 200 }),
      listDecisions({ status: "delayed", limit: 200 }),
    ]);
    return {
      decisions: [
        ...proposed.map((r) => ({
          status: "proposed" as const,
          createdAt: r.created_at,
          delayUntil: null,
        })),
        ...delayed.map((r) => ({
          status: "delayed" as const,
          createdAt: r.created_at,
          delayUntil: r.delay_until,
        })),
      ],
    };
  } catch (e) {
    console.error("[hq-executive-assistant] decisions read failed", e);
    return null;
  }
}

/** The active execution states an overdue/stall check applies to. */
const ACTIVE_TASK_STATES = [
  "pending",
  "running",
  "blocked",
  "claimed",
  "waiting_approval",
  "verifying",
] as const;

/** A bounded window of active tasks — enough for the digest, cheap to read. */
const TASK_WINDOW = 5000;

type TaskRow = {
  status: string;
  deadline_at: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  pipeline_stage: string | null;
};

/**
 * Read the generic Task Engine's ACTIVE tasks (the only ones an overdue/stall check
 * applies to) and fold them to the pure layer's shape. Service-role read over
 * `hq_ai_tasks` (RLS:hq — RLS enabled, ZERO policies), READ-ONLY: this issues
 * nothing but `.select()`, never a write, so it stays inside the task-engine-spine
 * security posture. Returns `null` on failure (loud).
 */
async function readTasks(): Promise<ExecutiveAssistantInput["tasks"]> {
  try {
    const admin = createAdminClient();
    const { data, error } = await (
      admin.from("hq_ai_tasks" as never) as unknown as {
        select: (c: string) => {
          in: (
            k: string,
            v: ReadonlyArray<unknown>,
          ) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => {
              limit: (
                n: number,
              ) => PromiseLike<{ data: TaskRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      }
    )
      .select("status, deadline_at, lease_expires_at, heartbeat_at, pipeline_stage")
      .in("status", ACTIVE_TASK_STATES as unknown as string[])
      .order("created_at", { ascending: false })
      .limit(TASK_WINDOW);

    if (error) {
      console.error("[hq-executive-assistant] tasks read failed", error);
      return null;
    }
    const rows = (data ?? []) as TaskRow[];
    return {
      tasks: rows.map((r) => ({
        status: r.status,
        deadlineAt: r.deadline_at,
        leaseExpiresAt: r.lease_expires_at,
        heartbeatAt: r.heartbeat_at,
        pipelineStage: r.pipeline_stage,
      })),
    };
  } catch (e) {
    console.error("[hq-executive-assistant] tasks read failed", e);
    return null;
  }
}

/**
 * Run the deterministic HQ alerts rules engine and reduce to the lean list the
 * digest buckets. Applies alert lifecycle state so RESOLVED and SNOOZED alerts are
 * excluded — the digest counts what is genuinely OPEN. Returns `null` on failure.
 */
async function readAlerts(): Promise<ExecutiveAssistantInput["alerts"]> {
  try {
    const { snapshot, states } = await buildAlertsSnapshot();
    const alerts = runAlertRules(snapshot);
    const withState = applyStateToAlerts(alerts, states, snapshot.now);
    const open = withState.filter((a) => !a.resolved && !a.snoozed);
    return {
      alerts: open.map((a) => ({ severity: a.severity, occurredAt: a.occurredAt })),
    };
  } catch (e) {
    console.error("[hq-executive-assistant] alerts read failed", e);
    return null;
  }
}

/**
 * Assemble the deterministic "what needs the human" digest. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadExecutiveAssistantBoard(): Promise<ExecutiveAssistantBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const [approvals, decisions, tasks, alerts] = await Promise.all([
    readApprovals(),
    readDecisions(),
    readTasks(),
    readAlerts(),
  ]);

  const input: ExecutiveAssistantInput = { approvals, decisions, tasks, alerts };

  const board = computeExecutiveAssistantBoard(input, new Date());
  const narrative = await loadExecutiveAssistantNarrative();

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Executive-assistant narrative — DARK STUB. Returns `null` and constructs NO SDK.
 *
 * A governed prose summary of the "what needs the human" digest belongs behind
 * `invokeWithGovernor` (lib/ai/governor.ts), under a registered AI feature whose
 * tier the registry arms. There is no registered feature/task_class for an HQ
 * executive-assistant narrative today, and reusing a tenant-facing key would
 * misattribute HQ spend in the governor ledger.
 *
 * Deliberately NO governor registry key is added for it: an unwired registry entry
 * is a permission granted to nothing, which the governance-closure ratchet
 * (__tests__/security/ai-governance-closure.test.ts) treats as drift — the
 * Operations AI, CTO AI, and Support AI all deferred their keys for exactly this
 * reason, and the Executive-Assistant AI follows suit.
 *
 * Rather than mis-key a governed call, this stays dark: it returns `null` and
 * imports no model SDK, so the dark path can construct nothing that could spend
 * money. The page shows a "populates once a model tier is bound" empty state.
 */
async function loadExecutiveAssistantNarrative(): Promise<string | null> {
  return null;
}
