import "server-only";
import { requireHqPage } from "@/server/auth/hq";
import { listSupportTicketRowsForHq } from "@/server/services/hq-support-snapshot";
import {
  computeSupportBoard,
  type SupportBoard,
  type SupportBoardInput,
  type SupportBoardTicket,
} from "@/lib/hq/support-ai";
import { generateHqBoardNarrative } from "@/server/services/hq-narrative";

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
