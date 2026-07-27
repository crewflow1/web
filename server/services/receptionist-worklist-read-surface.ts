import "server-only";
import {
  getCoordinationWorklists,
  getCoordinationWorklistsForConversation,
} from "@/server/services/receptionist-coordination-worklist";
import {
  queryWorklist,
  type WorklistQuery,
  type WorklistPage,
} from "@/lib/receptionist/conversation-worklist-read-surface";

// =====================================================================
// THE CONVERSATION WORKLIST READ SURFACE — SERVER RUNTIME (CEO Directive #018, R39: CONVERSATION
// WORKLIST READ SURFACE).
//
// R38 shipped the Conversation Coordination Worklist Engine — its pure core
// (`lib/receptionist/conversation-coordination-worklist.ts`) DERIVES the worklists, and its org-scoped
// runtime (`server/services/receptionist-coordination-worklist.ts`) reads the org's coordinations
// (through the R37 Read Model) and derives the {@link WorklistSet}. R39's pure core
// (`lib/receptionist/conversation-worklist-read-surface.ts`) QUERIES that set: it selects a worklist,
// filters it and returns a bounded, stably-ordered page. This module is the RUNTIME that joins them: the
// SINGLE authorised query surface a future operational capability reads a worklist page from.
//
// IT READS THROUGH THE WORKLIST ENGINE — IT NEVER DERIVES A WORKLIST, QUERIES A LEDGER OR A VIEW ITSELF.
// Its ONLY data source is the R38 engine reader: it fetches the org's derived {@link WorklistSet} via
// `getCoordinationWorklists` / `getCoordinationWorklistsForConversation` and hands it to the pure
// `queryWorklist`. It creates no database client, names no relation, runs no query, calls no engine
// write primitive — so the Worklist Engine remains the SOLE derivation of worklists, the R37 Read Model
// remains the SOLE query surface over recorded coordinations, and there is provably no second worklist-
// derivation path. Organisation isolation is INHERITED, not re-implemented: every function takes an
// `org_id` and passes it straight to the R38 reader (whose read is org-scoped through R37's mandatory
// `.eq("org_id", …)`), so one organisation can never read another's worklist pages.
//
// IT SERVES READ-ONLY PAGES — IT EXECUTES NOTHING. It assigns nobody, dispatches nothing, notifies no
// one, enqueues into no operational system, schedules nothing and retries nothing (all EXPLICIT R39
// non-goals). It names NO engine write primitive and NO engine runtime; it opens no outbound path. It
// only READS (through R38) and QUERIES (through the pure core) — a read surface over a read model over a
// read model, exposed for a future capability to consume.
// =====================================================================

/**
 * Answer a worklist query for an ORGANISATION — reads the org's derived worklist set through the R38
 * engine, then selects / filters / pages it. Org-scoped: the `org_id` is passed straight to the R38
 * reader, so one org can never read another's worklist pages. `limit` caps how many recent coordinations
 * the engine reads before deriving (the R37 reader's window); the query's own `page` bounds the returned
 * entries. Deterministic — the same coordinations and the same query always yield the same page.
 */
export async function queryOrgWorklist(
  input: { org_id: string; limit?: number } & WorklistQuery,
): Promise<WorklistPage> {
  const set = await getCoordinationWorklists({ org_id: input.org_id, limit: input.limit });
  return queryWorklist(set, input);
}

/**
 * Answer a worklist query for ONE conversation — reads the worklist set derived from only that
 * conversation's coordinations (through the R38 engine), then selects / filters / pages it. Org-scoped
 * AND conversation-scoped through the R38 → R37 readers, so a caller can only ever query a worklist for a
 * conversation that belongs to it.
 */
export async function queryConversationWorklist(
  input: { org_id: string; conversation_id: string } & WorklistQuery,
): Promise<WorklistPage> {
  const set = await getCoordinationWorklistsForConversation({
    org_id: input.org_id,
    conversation_id: input.conversation_id,
  });
  return queryWorklist(set, input);
}
