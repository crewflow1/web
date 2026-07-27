import "server-only";
import { queryOrgWorklist } from "@/server/services/receptionist-worklist-read-surface";
import { getOwnership } from "@/server/services/receptionist-ownership-read-model";
import {
  projectAttentionQueue,
  type AttentionQueueView,
} from "@/lib/receptionist/conversation-attention-queue";

// =====================================================================
// THE CONVERSATION ATTENTION QUEUE — SERVER RUNTIME (CEO Directive #018, R58: CONVERSATION ATTENTION QUEUE).
//
// R58's pure core (`lib/receptionist/conversation-attention-queue.ts`) JOINS an org's actionable worklist
// entries with their ownership records and GROUPS them by ownership (unowned / owned), preserving the R38
// canonical order. This module is the RUNTIME that FEEDS it: for one organisation it reads the actionable,
// already-prioritised worklist THROUGH the R39 read surface and each entry's ownership THROUGH the R48
// ownership read model, then hands both to the pure core. It is the single org-scoped entry point a
// (future, explicitly-authorised) operator surface reads the attention queue from.
//
// IT READS THROUGH THE AUTHORISED SEAMS — IT NEVER DERIVES A WORKLIST, DECIDES AN OWNERSHIP, QUERIES A
// LEDGER OR A VIEW ITSELF. Its ONLY two data sources are authoritative read surfaces:
//   • the R39 WORKLIST READ SURFACE (`queryOrgWorklist`, the `prioritised` view) — which reads the org's
//     worklist THROUGH the R38 engine (which reads THROUGH the R37 Read Model). R58 never names the R38
//     reader `getCoordinationWorklists` and never `deriveWorklists`; it reads the derived page, so the
//     Worklist Engine stays the SOLE derivation of worklists and R58 is provably not a read path around R39.
//   • the R48 OWNERSHIP READ MODEL (`getOwnership`) — the authoritative per-coordination ownership state;
//     R58 never touches a claim / release / reassignment ledger, so the read model stays the SOLE ownership
//     answer.
// It creates NO database client, names NO relation, runs NO query and calls NO engine write primitive.
//
// ORGANISATION ISOLATION IS INHERITED, NOT RE-IMPLEMENTED. The single `org_id` argument is passed straight
// to BOTH readers — into `queryOrgWorklist` (org-scoped through R39 → R38 → R37's mandatory `.eq("org_id",
// …)`) and into EVERY `getOwnership` read (org-scoped through R48) — so one organisation can never read
// another's attention queue. R58 sources an org from nowhere else.
//
// IT SERVES A READ-ONLY VIEW — IT EXECUTES NOTHING. It assigns nobody, dispatches nothing, notifies no one,
// enqueues into no operational system, schedules nothing, retries nothing, promotes nobody, fulfils nothing,
// retrieves no memory and completes nothing — all EXPLICIT R58 non-goals. It only READS (through R39 and
// R48) and PROJECTS (through the pure core): a read over two read models, exposed for a future capability to
// consume.
// =====================================================================

/**
 * Read the ATTENTION QUEUE for an ORGANISATION — the actionable, prioritised worklist grouped by ownership
 * (unowned first, owned next), in the R38 canonical order within each group. Org-scoped: the `org_id` is
 * passed straight to the R39 read surface AND to every R48 ownership read, so one org can never read
 * another's queue. `limit` caps how many recent coordinations the worklist engine reads before deriving
 * (the R37 reader's window), bounding the queue. Deterministic — the same coordinations and ownership always
 * yield the same queue.
 */
export async function getConversationAttentionQueue(input: {
  org_id: string;
  limit?: number;
}): Promise<AttentionQueueView> {
  // 1. Read the org's actionable, prioritised worklist THROUGH the R39 read surface — never the R38 reader,
  //    never a ledger. The page's items are the R38 canonical (priority-then-recency) order.
  const page = await queryOrgWorklist({
    org_id: input.org_id,
    limit: input.limit,
    view: "prioritised",
  });
  // 2. Read each entry's ownership THROUGH the R48 ownership read model — org-scoped, per coordination, in
  //    parallel. The reader is total (an unowned coordination yields an `unowned` record), so every entry
  //    gets exactly one record, keyed by its coordination id.
  const ownershipByCoordination = new Map(
    await Promise.all(
      page.items.map(
        async (entry) =>
          [
            entry.coordination_id,
            await getOwnership({ org_id: input.org_id, coordination_id: entry.coordination_id }),
          ] as const,
      ),
    ),
  );
  // 3. Join + group + order — PURELY, in the R58 core. The runtime derives, decides and orders nothing.
  return projectAttentionQueue({ entries: page.items, ownershipByCoordination });
}
