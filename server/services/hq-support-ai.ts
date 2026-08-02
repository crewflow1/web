import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { listSupportTicketRowsForHq } from "@/server/services/hq-support-snapshot";
import {
  computeSupportBoard,
  type SupportBoard,
  type SupportBoardInput,
  type SupportBoardTicket,
} from "@/lib/hq/support-ai";

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
   * The governed reply-draft / triage narrative. DARK for now (see
   * `loadSupportNarrative`) — always `null` until a model tier is bound. The UI
   * shows an empty state.
   */
  narrative: string | null;
  generatedAt: string;
};

/**
 * Assemble the deterministic support triage board. Super-admin gated
 * (`requireHqPage` → /login for anonymous, 404 for non-allowlisted), then reads
 * the tickets cross-tenant on the service-role path and attaches the (dark)
 * narrative. Loud reads: the underlying snapshot logs and degrades rather than
 * throwing on a read error.
 */
export async function loadSupportBoard(): Promise<SupportBoardResult> {
  await requireHqPage(); // HQ-only; never mixes with tenant auth.

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

  const board = computeSupportBoard(input, new Date());
  const narrative = await loadSupportNarrative();

  return { board, narrative, generatedAt: new Date().toISOString() };
}

/**
 * Board narrative / reply-draft — DARK STUB. Returns `null` and constructs NO
 * SDK.
 *
 * A governed triage summary or a per-ticket reply draft belongs behind
 * `invokeWithGovernor` (lib/ai/governor.ts), under registered AI feature keys
 * (e.g. a `classification` triage pass and a `drafting` reply pass) whose tier
 * the registry arms. Neither is registered today, and reusing a tenant-facing
 * key (e.g. `receptionist.reply_draft`) would misattribute HQ spend in the
 * governor ledger. Rather than mis-key a governed call, this stays dark: it
 * returns `null` and imports no model SDK, so the dark path can construct
 * nothing that could spend money.
 *
 * DEFERRED: the drafts need registered feature/task_class bindings (registry
 * entries + a bound model tier, each WIRED at an `invokeWithGovernor` call
 * site per the registry doctrine) before they can be wired. Until then the
 * board is fully honest on the deterministic triage alone, and the page shows a
 * "populates once a model tier is bound" empty state.
 */
async function loadSupportNarrative(): Promise<string | null> {
  return null;
}
