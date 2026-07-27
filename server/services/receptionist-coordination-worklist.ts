import "server-only";
import {
  listCoordinations,
  listCoordinationsForConversation,
} from "@/server/services/receptionist-coordination-view";
import {
  deriveWorklists,
  type WorklistSet,
  type WorklistEntry,
} from "@/lib/receptionist/conversation-coordination-worklist";

// =====================================================================
// THE CONVERSATION COORDINATION WORKLIST ENGINE — SERVER RUNTIME (CEO Directive #018, R38: CONVERSATION
// COORDINATION WORKLIST ENGINE).
//
// R37 shipped the Coordination Read Model — the single, authorised query surface for recorded
// Conversation Coordination decisions — and its org-scoped reader
// (`server/services/receptionist-coordination-view.ts`). R38's pure core
// (`lib/receptionist/conversation-coordination-worklist.ts`) DERIVES prioritised, read-only worklists
// from those records. This module is the RUNTIME that joins them: the SINGLE integration surface a
// future operational capability (a work queue, a dashboard, an automation) reads to obtain a
// coordination worklist.
//
// IT READS THROUGH THE READ MODEL — IT NEVER QUERIES A LEDGER OR A VIEW ITSELF. Its ONLY data source is
// the R37 reader: it fetches the org's coordination records via `listCoordinations` /
// `listCoordinationsForConversation` and hands them to the pure `deriveWorklists`. It creates no
// database client, names no relation, runs no query — so the R37 Read Model remains the SOLE query
// surface over recorded coordinations, and there is provably no second coordination-reconstruction
// path. Organisation isolation is INHERITED, not re-implemented: every function takes an `org_id` and
// passes it straight to the R37 reader, whose every query carries the mandatory `.eq("org_id", …)`, so
// one organisation can never read another's worklists.
//
// IT DERIVES WORKLISTS — IT EXECUTES NOTHING. It coordinates nothing, resolves nothing, assigns nobody,
// dispatches nothing, notifies no one, enqueues into no operational system, schedules nothing and
// retries nothing (all EXPLICIT R38 non-goals). It names NO engine write primitive and NO engine
// runtime; it opens no outbound path. It only READS (through R37) and DERIVES (through the pure core) —
// a read model over a read model, exposed for a future capability to consume.
// =====================================================================

/**
 * The full worklist set for an organisation — the three directed worklists (human-review / recovery /
 * escalation) and the unified priority-ordered backlog — derived from the org's most recent recorded
 * coordinations. Org-scoped: the `org_id` is passed straight to the R37 reader, so one org can never
 * read another's worklists. `limit` caps how many recent coordinations are read (default is the R37
 * reader's own default). Deterministic — the same coordinations always derive the same worklists.
 */
export async function getCoordinationWorklists(input: {
  org_id: string;
  limit?: number;
}): Promise<WorklistSet> {
  const records = await listCoordinations({ org_id: input.org_id, limit: input.limit });
  return deriveWorklists(records);
}

/**
 * The HUMAN-REVIEW worklist for an organisation — the coordinations whose recorded response requires a
 * human, newest-and-most-urgent first. Org-scoped through the R37 reader.
 */
export async function getHumanReviewWorklist(input: {
  org_id: string;
  limit?: number;
}): Promise<WorklistEntry[]> {
  return (await getCoordinationWorklists(input)).human_review;
}

/**
 * The RECOVERY worklist for an organisation — the coordinations on the recover path (recorded mode
 * `remediating`), newest first. Org-scoped through the R37 reader.
 */
export async function getRecoveryWorklist(input: {
  org_id: string;
  limit?: number;
}): Promise<WorklistEntry[]> {
  return (await getCoordinationWorklists(input)).recovery;
}

/**
 * The ESCALATION worklist for an organisation — the coordinations that escalated (recorded mode
 * `escalating`), newest first. Org-scoped through the R37 reader.
 */
export async function getEscalationWorklist(input: {
  org_id: string;
  limit?: number;
}): Promise<WorklistEntry[]> {
  return (await getCoordinationWorklists(input)).escalation;
}

/**
 * The unified PRIORITISED worklist for an organisation — every actionable coordination, once, ordered
 * by derived priority then recency. THE backlog a future operational capability reads to know what
 * needs attention next. Org-scoped through the R37 reader.
 */
export async function getPrioritisedWorklist(input: {
  org_id: string;
  limit?: number;
}): Promise<WorklistEntry[]> {
  return (await getCoordinationWorklists(input)).prioritised;
}

/**
 * The worklist set for ONE conversation — the same three worklists and the prioritised backlog, derived
 * from only that conversation's recorded coordinations. Org-scoped AND conversation-scoped through the
 * R37 reader, so a caller can only ever derive worklists for a conversation that belongs to it.
 */
export async function getCoordinationWorklistsForConversation(input: {
  org_id: string;
  conversation_id: string;
}): Promise<WorklistSet> {
  const records = await listCoordinationsForConversation(input);
  return deriveWorklists(records);
}
