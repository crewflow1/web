import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { getExecutorShadowFeed } from "@/server/services/executor-shadow-observations";
import type { BoardroomTask } from "@/lib/hq/boardroom-cards";
import {
  computeQaBoard,
  type QaBoard,
  type QaInput,
  type QaReplyInput,
  type QaOutcomeInput,
} from "@/lib/hq/qa";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

/**
 * CrewFlow HQ — QA AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-finance.ts`,
 * `server/services/hq-support-ai.ts`, and `server/services/hq-cto.ts`: it gathers
 * the raw AI-quality / reliability signals from the EXISTING read models and
 * hands a plain `QaInput` to the pure, deterministic `computeQaBoard`
 * (lib/hq/qa.ts). All honesty/labelling lives in the pure layer — this module
 * never duplicates quality logic; it reads the executor-shadow store, the
 * `ai_reply_audits` verdict ledger, the `receptionist_conversation_outcomes`
 * ledger, and the `hq_ai_tasks` queue, then folds each to the lean shape the
 * pure layer consumes.
 *
 * LOUD READS, HONEST DEGRADATION. Each source is read in isolation; a failure is
 * logged loudly and passed as `null`, which the pure layer renders as an honest
 * `insufficient` card rather than a fabricated zero or a broken page. The
 * genuinely absent sources (browser / regression / a11y test results, release
 * approval) have NO reader here at all — the pure layer emits them insufficient
 * by construction, because no such table exists in the schema.
 *
 * READ-ONLY BY CONSTRUCTION. Every query here is a `.select()`; the ai_reply_audits
 * and receptionist_conversation_outcomes ledgers are append-only (BEFORE
 * UPDATE/DELETE triggers reject mutation even under service_role) and this module
 * never asks — it only counts.
 */

export type QaBoardResult = {
  board: QaBoard;
  /**
   * The governed QA narrative — a short prose blurb over the deterministic
   * AI-quality figures, generated via the shared HQ narrative helper. `null`
   * until a model tier is bound (and the vendor credential + HQ budget org are
   * present), on any governor refusal, or on a provider failure. The UI shows an
   * empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/** A lean window of recent tasks — enough to keep reliability live, cheap to read. */
const TASK_WINDOW = 1000; // bounded sample; PostgREST clamps to max_rows=1000
const RELIABILITY_COLUMNS = [
  "status",
  "verification",
  "result",
  "deadline_at",
  "lease_expires_at",
  "heartbeat_at",
  "retry_count",
  "max_retries",
  "pipeline_stage",
].join(", ");

/** A lean window over the append-only reply/outcome ledgers. */
const REPLY_WINDOW = 1000; // bounded sample; PostgREST clamps to max_rows=1000
const OUTCOME_WINDOW = 1000; // bounded sample; PostgREST clamps to max_rows=1000

/**
 * Read the recent `hq_ai_tasks` window for the reliability signal. Service-role
 * read only — mirrors `hq-cto.ts` / `hq-task-pipeline.ts`. Returns `null` on a
 * read failure (loud) so the pure layer marks reliability insufficient.
 */
async function readReliabilityTasks(): Promise<ReadonlyArray<BoardroomTask> | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("hq_ai_tasks" as never)
      .select(RELIABILITY_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(TASK_WINDOW);
    if (error) {
      console.error("[hq-qa] reliability read failed", error);
      return null;
    }
    return (data ?? []) as unknown as BoardroomTask[];
  } catch (e) {
    console.error("[hq-qa] reliability read threw", e);
    return null;
  }
}

/**
 * Read the recent `ai_reply_audits` window and fold to verdict totals. The table
 * is a service-role-only HQ-internal ledger (RLS on, zero policies), not in the
 * generated Supabase types — cast past the typed client (the same `as never` shim
 * hq-cto.ts uses for hq_ai_tasks). Returns `null` on a read failure (loud) so the
 * pure layer marks the reply-quality metrics insufficient.
 */
async function readReplyVerdicts(): Promise<QaReplyInput | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ai_reply_audits" as never)
      .select("verdict")
      .order("created_at", { ascending: false })
      .limit(REPLY_WINDOW);
    if (error) {
      console.error("[hq-qa] reply-audit read failed", error);
      return null;
    }
    const rows = (data ?? []) as unknown as ReadonlyArray<{ verdict: string }>;
    let allow = 0;
    let review = 0;
    let block = 0;
    for (const r of rows) {
      if (r.verdict === "allow") allow += 1;
      else if (r.verdict === "review") review += 1;
      else if (r.verdict === "block") block += 1;
    }
    return { allow, review, block };
  } catch (e) {
    console.error("[hq-qa] reply-audit read threw", e);
    return null;
  }
}

/**
 * Read the recent `receptionist_conversation_outcomes` window and fold to a
 * recorded count. Service-role-only HQ-internal ledger; cast past the typed
 * client. Returns `null` on a read failure (loud).
 */
async function readOutcomeCount(): Promise<QaOutcomeInput | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("receptionist_conversation_outcomes" as never)
      .select("id")
      .order("created_at", { ascending: false })
      .limit(OUTCOME_WINDOW);
    if (error) {
      console.error("[hq-qa] conversation-outcome read failed", error);
      return null;
    }
    const rows = (data ?? []) as unknown as ReadonlyArray<unknown>;
    return { recorded: rows.length };
  } catch (e) {
    console.error("[hq-qa] conversation-outcome read threw", e);
    return null;
  }
}

/**
 * Assemble the deterministic QA AI-quality board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * every source cross-tenant on the service-role path and attaches the (dark)
 * narrative.
 */
export async function loadQaBoard(): Promise<QaBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const board = await gatherQaBoard();
  const narrative = await loadQaNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Build the deterministic QA board WITHOUT the page auth gate — the shared
 * derivation used by both `loadQaBoard` (super-admin page) and the QA executive
 * runner (service-role cron). Reads only; no narrative, no auth.
 */
export async function gatherQaBoard(): Promise<QaBoard> {
  const [shadow, reply, outcome, tasks] = await Promise.all([
    getExecutorShadowFeed().catch((e) => {
      console.error("[hq-qa] executor-shadow read failed", e);
      return null;
    }),
    readReplyVerdicts(),
    readOutcomeCount(),
    readReliabilityTasks(),
  ]);

  const input: QaInput = {
    shadow:
      shadow == null
        ? null
        : {
            planned: shadow.totals.planned,
            refused: shadow.totals.refused,
            error: shadow.totals.error,
          },
    reply,
    outcome,
    reliability: tasks == null ? null : { tasks },
  };

  return computeQaBoard(input, new Date());
}

/**
 * QA narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ narrative
 * helper (server/services/hq-narrative.ts), which reaches a model ONLY through
 * `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.qa_narrative` feature key (task class `drafting`), billed to the HQ budget
 * org. The model is handed the FINISHED deterministic board and may only describe
 * it — every displayed figure still comes from `computeQaBoard`.
 *
 * DARK until a generative tier is bound: with no tier bound `getTextProvider()`
 * returns `null`, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadQaNarrative(board: QaBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.qa_narrative", board);
}
