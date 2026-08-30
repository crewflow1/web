import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listSupportTicketRowsForHq,
  loadSupportTicketDetailForHq,
  type HqSupportTicketDetail,
} from "@/server/services/hq-support-snapshot";
import {
  computeSupportBoard,
  type SupportBoard,
  type SupportBoardInput,
  type SupportBoardTicket,
} from "@/lib/hq/support-ai";
import {
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_STATUS_LABEL,
  type SupportCategory,
  type SupportPriority,
  type SupportStatus,
} from "@/lib/hq/support";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";
import { getTextProvider } from "@/lib/ai/text";
import { invokeWithGovernor, isTierActivated } from "@/lib/ai/governor";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  resolveExecIdentity,
  normaliseExecOutcome,
  type ExecRunOutcome,
} from "@/server/services/hq-exec-runner-kit";
import {
  drainTaskType,
  NonRetryableError,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

/**
 * CrewFlow HQ — SUPPORT AI aggregator (super-admin surface). Service-role only.
 *
 * A thin shim, exactly like `server/services/hq-finance.ts`: it gathers the raw
 * ticket rows from the existing HQ support snapshot (`listSupportTicketRowsForHq`
 * — a lean, message-free read) and hands a plain `SupportBoardInput` to the
 * pure, deterministic `computeSupportBoard` (lib/hq/support-ai.ts). All
 * honesty/labelling lives in the pure layer, which derives the open-ticket count
 * from the active rows themselves — no separate head-count query that could
 * swallow a DB error into a fabricated zero.
 *
 * NOTHING is fabricated: with zero tickets the pure layer returns an all
 * `insufficient` board rather than a queue of fake zeros.
 */

export type SupportBoardResult = {
  board: SupportBoard;
  /**
   * The governed triage narrative — a short prose blurb over the deterministic
   * support-triage figures, generated via the shared HQ narrative helper. `null`
   * until a model tier is bound (and the vendor credential + HQ budget org are
   * present), on any governor refusal, or on a provider failure. The UI shows an
   * empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/**
 * Assemble the deterministic support triage board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * the tickets cross-tenant on the service-role path and attaches the (dark)
 * narrative. Loud reads: the underlying snapshot (`listSupportTicketRowsForHq`)
 * pages the full cross-tenant set and THROWS `readFailure` on a read error — a
 * silently-partial (or empty) triage board is never presented as fact.
 */
export async function loadSupportBoard(): Promise<SupportBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

  const board = await gatherSupportBoard();
  const narrative = await loadSupportNarrative(board);

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Build the deterministic Support board WITHOUT the page auth gate — the shared
 * derivation used by both `loadSupportBoard` (super-admin page) and the Support
 * executive runner (service-role cron). Reads only; no narrative, no auth.
 */
export async function gatherSupportBoard(): Promise<SupportBoard> {
  const rows = await listSupportTicketRowsForHq();

  const tickets: SupportBoardTicket[] = rows.map((t) => ({
    status: t.status,
    priority: t.priority,
    category: t.category,
    createdAt: t.created_at,
    resolvedAt: t.resolved_at,
    closedAt: t.closed_at,
    lastReplyAt: t.last_reply_at,
    lastReplyKind: t.last_reply_kind,
  }));

  const input: SupportBoardInput = { tickets };

  return computeSupportBoard(input, new Date());
}

/**
 * Board triage narrative — GOVERNED, FAIL-CLOSED. Delegates to the shared HQ
 * narrative helper (server/services/hq-narrative.ts), which reaches a model ONLY
 * through `invokeWithGovernor` → `getTextProvider` under the registered
 * `hq.support_ai_narrative` feature key (task class `drafting`), billed to the HQ
 * budget org. The model is handed the FINISHED deterministic board and may only
 * describe it — every displayed figure still comes from `computeSupportBoard`.
 *
 * This narrates the triage board only. A per-ticket AI REPLY draft is a separate,
 * still-unbuilt capability (it needs its own registered key and a per-ticket
 * context assembly); it is not part of this loader.
 *
 * DARK until a generative tier is bound: with no tier bound the shared provider
 * door returns null, so this returns `null` and the page shows its
 * "populates once a model tier is bound" empty state — now honest, because
 * binding a tier (plus the credential + HQ budget org) is the only switch.
 */
async function loadSupportNarrative(board: SupportBoard): Promise<string | null> {
  return generateHqBoardNarrative("hq.support_ai_narrative", board);
}

// ---------------------------------------------------------------------
// P13 — Support AI reply capability: the GOVERNED, DARK draft-reply seam.
//
// For a given tenant support ticket (HQ side), the `support_reply_draft` task
// produces a DRAFT reply artifact:
//   • DETERMINISTIC FALLBACK (total): a structured acknowledgement built from
//     the ticket's REAL fields — number, subject, category, priority, status,
//     age of the latest customer message. It states what is known and promises
//     nothing the data does not show.
//   • GENERATIVE LEG (dark): a governed model attempt under the EXISTING
//     registered `hq.draft` feature key (task class `drafting` — customer prose
//     a human approves before it goes anywhere), through the ONE model door
//     (getTextProvider) + invokeWithGovernor, billed to the HQ budget org.
//     Unbound tier / missing credential / governor refusal / provider failure
//     ALL degrade to the deterministic draft. Nothing switches it on but
//     binding the tier.
//   • NEVER SENT: the artifact is a draft a HUMAN reads and copies into the
//     reply box. This module imports no transport and writes no
//     support_messages row — pinned by test.
// ---------------------------------------------------------------------

const SUPPORT_AI_SLUG = "support-ai";
/** The durable task_type of the draft-reply work on the generic engine. */
const SUPPORT_REPLY_DRAFT_TASK_TYPE = "support_reply_draft";

const REPLY_DRAFT_TIMEOUT_MS = 8000;
const REPLY_DRAFT_MAX_TOKENS = 500;

/** The draft-reply artifact — the task result the panel renders. */
export type SupportReplyDraftArtifact = {
  ticketId: string;
  ticketNumber: number;
  subject: string;
  /** The draft reply body — for a HUMAN to review, edit, and send themselves. */
  body: string;
  /** Which leg produced the body — honest provenance for the panel badge. */
  provenance: "deterministic" | "anthropic" | "openai";
  model: string | null;
  generatedAt: string;
  /** Structural pin: this artifact is never transmitted automatically. */
  neverSent: true;
};

/** The real ticket fields the deterministic acknowledgement is built from. */
export type SupportReplyDraftInput = {
  ticketNumber: number;
  subject: string;
  status: string;
  priority: string;
  category: string;
  orgName: string | null;
  ownerName: string | null;
  /** Creation time of the latest NON-internal customer message, if any. */
  lastCustomerMessageAt: string | null;
};

/**
 * The deterministic draft reply — PURE, exported for the unit tests. A
 * structured acknowledgement referencing only the ticket's REAL fields: it
 * confirms receipt, restates what the ticket says (category/priority/status),
 * and sets an honest expectation (a human will follow up) without inventing
 * any diagnosis, timeline, or promise.
 */
export function composeSupportReplyDraft(input: SupportReplyDraftInput): string {
  const statusLabel =
    SUPPORT_STATUS_LABEL[input.status as SupportStatus] ?? input.status;
  const priorityLabel =
    SUPPORT_PRIORITY_LABEL[input.priority as SupportPriority] ?? input.priority;
  const categoryLabel =
    SUPPORT_CATEGORY_LABEL[input.category as SupportCategory] ?? input.category;
  const greeting = input.ownerName ? `Hi ${input.ownerName},` : "Hi,";
  const lastSeen = input.lastCustomerMessageAt
    ? `We have your latest message from ${input.lastCustomerMessageAt.slice(0, 10)} and it is with the team now.`
    : "Your ticket is with the team now.";
  return [
    greeting,
    "",
    `Thanks for getting in touch about "${input.subject}" (ticket #${input.ticketNumber}).`,
    "",
    `${lastSeen} It is logged as a ${categoryLabel.toLowerCase()} request at ${priorityLabel.toLowerCase()} priority, and its current status is ${statusLabel.toLowerCase()}.`,
    "",
    "A member of the CrewFlow team is reviewing it and will reply here with the next step. If anything has changed in the meantime, just reply to this ticket and it will reach us directly.",
    "",
    "Best regards,",
    "CrewFlow Support",
  ].join("\n");
}

/** Fold a loaded ticket detail into the compose input — the real fields only. */
function draftInputFromDetail(detail: HqSupportTicketDetail): SupportReplyDraftInput {
  const lastCustomer = [...detail.messages]
    .filter((m) => m.author_kind === "customer" && !m.internal)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return {
    ticketNumber: detail.ticket_number,
    subject: detail.subject,
    status: detail.status,
    priority: detail.priority,
    category: detail.category,
    orgName: detail.org_name,
    ownerName: detail.owner_name,
    lastCustomerMessageAt: lastCustomer?.created_at ?? null,
  };
}

/**
 * The governed generative leg — DARK by default, mirroring hq-narrative.ts:
 * per-tier own-class gate first, then the one model door, then the governor.
 * Returns null on ANY refusal/failure so the caller degrades to the
 * deterministic draft. The model is confined to rewriting the deterministic
 * acknowledgement over the ticket's stated fields — never to inventing
 * diagnoses, promises, or timelines.
 */
async function generateReplyDraftViaModel(
  input: SupportReplyDraftInput,
  deterministicBody: string,
): Promise<{ body: string; provenance: "anthropic" | "openai"; model: string } | null> {
  if (!isTierActivated("mid")) return null; // dark mid tier → deterministic only
  const provider = getTextProvider();
  if (!provider) return null;
  const vendor = provider.info.provider;
  if (vendor !== "anthropic" && vendor !== "openai") return null;
  const budgetOrgId = hqBudgetOrgId();
  if (!budgetOrgId) return null;

  const system = [
    "You are CrewFlow HQ's support agent drafting a reply to a customer support ticket.",
    "You are given the ticket's recorded fields and a deterministic acknowledgement draft.",
    "Rewrite the draft into a warmer, natural reply. STRICT RULES:",
    "- State ONLY facts present in the supplied fields; never invent a diagnosis, fix, timeline, or promise.",
    "- Never claim the issue is resolved or being worked on beyond 'the team is reviewing it'.",
    "- Keep it short (under 150 words), plain prose, British English.",
    "- This is a DRAFT for a human agent to review — do not add placeholders needing substitution.",
  ].join("\n");
  const prompt = [
    `Ticket fields: ${JSON.stringify({
      ticketNumber: input.ticketNumber,
      subject: input.subject,
      status: input.status,
      priority: input.priority,
      category: input.category,
    })}`,
    "",
    "Deterministic acknowledgement draft:",
    deterministicBody,
  ].join("\n");

  try {
    const outcome = await invokeWithGovernor(
      "hq.draft",
      "drafting",
      async () => {
        const generated = await provider.generate(prompt, {
          system,
          temperature: 0,
          maxTokens: REPLY_DRAFT_MAX_TOKENS,
          signal: AbortSignal.timeout(REPLY_DRAFT_TIMEOUT_MS),
        });
        return {
          value: generated,
          usage: {
            provider: vendor,
            model: generated.model,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
          },
        };
      },
      {
        orgId: budgetOrgId,
        userId: null,
        // The same ticket drafted twice within the window is the same draft;
        // only its SHA-256 reaches the ledger — never the ticket content.
        dedupeContent: `hq.draft support_reply ${prompt}`,
      },
    );
    // Over the ceiling / duplicate / blocked → the deterministic draft stands.
    if (outcome.status !== "ran") return null;
    const text = outcome.value.text.trim();
    if (!text) return null;
    return { body: text, provenance: vendor, model: outcome.value.model };
  } catch (e) {
    console.error(
      "[hq-support-ai] governed reply-draft leg degraded",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/**
 * Produce the draft-reply artifact for one ticket — the service path the task
 * handler (and only the task handler) completes with. Deterministic fallback
 * is TOTAL: a draft always exists; the governed leg only ever upgrades it.
 */
export async function draftSupportReply(
  ticketId: string,
): Promise<SupportReplyDraftArtifact | null> {
  const detail = await loadSupportTicketDetailForHq(ticketId);
  if (!detail) return null;
  const input = draftInputFromDetail(detail);
  const deterministicBody = composeSupportReplyDraft(input);
  const generated = await generateReplyDraftViaModel(input, deterministicBody);
  return {
    ticketId: detail.id,
    ticketNumber: detail.ticket_number,
    subject: detail.subject,
    body: generated?.body ?? deterministicBody,
    provenance: generated?.provenance ?? "deterministic",
    model: generated?.model ?? null,
    generatedAt: new Date().toISOString(),
    neverSent: true,
  };
}

/** The Task-Engine handler: the draft artifact IS the task result. */
const supportReplyDraftHandler: TaskHandler = async (ctx) => {
  const ticketId = ctx.task.subject_id;
  if (!ticketId) throw new NonRetryableError("support_reply_draft task has no ticket.");
  const artifact = await draftSupportReply(ticketId);
  if (!artifact) throw new NonRetryableError("Ticket not found for reply draft.");
  return artifact;
};

/**
 * Enqueue a draft-reply task for a ticket. Deduped on the LIVE task (a
 * double-click while one is pending/running returns the same task); a fresh
 * regenerate after completion creates a new task — drafts are cheap artifacts
 * and each keeps its provenance.
 */
export async function enqueueSupportReplyDraft(
  ticketId: string,
  createdBy: string | null,
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(SUPPORT_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const enq = await enqueueTask({
    taskType: SUPPORT_REPLY_DRAFT_TASK_TYPE,
    subjectKind: "support_ticket",
    subjectId: ticketId,
    priority: "high",
    maxRetries: 1,
    assignedEmployeeId: employeeId,
    dedupeKey: `${SUPPORT_REPLY_DRAFT_TASK_TYPE}:${ticketId}`,
    origin: "manual",
    createdBy,
  });
  if (!enq.ok) {
    console.error("[hq-support-ai] reply-draft enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runSupportReplyDraftTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(SUPPORT_AI_SLUG);
  registerTaskHandler(SUPPORT_REPLY_DRAFT_TASK_TYPE, identity, supportReplyDraftHandler);
  return normaliseExecOutcome(
    await runReadyTask(SUPPORT_REPLY_DRAFT_TASK_TYPE, supportReplyDraftHandler, identity),
  );
}

export async function drainSupportReplyDraftTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(SUPPORT_AI_SLUG);
  registerTaskHandler(SUPPORT_REPLY_DRAFT_TASK_TYPE, identity, supportReplyDraftHandler);
  const summary = await drainTaskType(
    SUPPORT_REPLY_DRAFT_TASK_TYPE,
    supportReplyDraftHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

/**
 * The latest COMPLETED draft artifact for a ticket — the panel's read. A
 * direct service-role SELECT on hq_ai_tasks (RLS:hq — reads are sanctioned;
 * only writes must go through the entry-point RPCs).
 */
export async function getLatestSupportReplyDraft(
  ticketId: string,
): Promise<SupportReplyDraftArtifact | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("hq_ai_tasks" as never)
    .select("result, finished_at" as never)
    .eq("task_type", SUPPORT_REPLY_DRAFT_TASK_TYPE)
    .eq("subject_id", ticketId)
    .eq("status", "completed")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[hq-support-ai] reply-draft read failed", error.message);
    return null;
  }
  const result = (data as unknown as { result?: unknown } | null)?.result;
  if (!result || typeof result !== "object") return null;
  const artifact = result as SupportReplyDraftArtifact;
  return typeof artifact.body === "string" && artifact.neverSent === true
    ? artifact
    : null;
}

export { SUPPORT_REPLY_DRAFT_TASK_TYPE };
