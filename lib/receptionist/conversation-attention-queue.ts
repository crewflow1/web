import type { WorklistEntry } from "@/lib/receptionist/conversation-coordination-worklist";
import type { OwnershipRecord } from "@/lib/receptionist/conversation-ownership-read-model";

// =====================================================================
// THE CONVERSATION ATTENTION QUEUE — PURE CORE (CEO Directive #018, R58: CONVERSATION ATTENTION QUEUE).
//
// R38 shipped the Coordination WORKLIST ENGINE — it DERIVES, from the coordinations the R37 Read Model
// records, the actionable worklists (human-review / recovery / escalation) and the unified `prioritised`
// backlog, in one canonical order (priority first, then the R37 recency order). R39 shipped the WORKLIST
// READ SURFACE — the single authorised query surface a future operational capability reads a worklist page
// from. R48/R51/R53 shipped the OWNERSHIP READ MODEL — the authoritative answer to "who owns this
// coordination now?" ({@link OwnershipRecord}: owned / unowned, and by whom).
//
// R58 is the ATTENTION QUEUE — the read-only view that JOINS those two authoritative reads: it takes the
// actionable, already-prioritised worklist entries (delivered through R39) and each entry's ownership
// record (delivered through R48), and presents them GROUPED BY OWNERSHIP — the coordinations no operator
// holds yet ("unowned" — they need someone to pick them up) first, the ones already in hand ("owned" — in
// progress) next — PRESERVING the R38 canonical order WITHIN each group. It answers one operational
// question the worklist alone does not: "of the work that needs attention, what is waiting to be picked up
// versus already being handled, and in what order?"
//
// IT CONSUMES EXISTING ENGINES — IT DERIVES NO CONVERSATION STATE OF ITS OWN. Every fact it shows is read,
// never re-computed: each `entry` is the R38 {@link WorklistEntry} verbatim (its coordination + conversation,
// its DERIVED priority + categories, its RECORDED mode, its SURFACED requires-human flag, its whole
// coordination record — i.e. lifecycle, resolution, coordination mode, human-required), and each `ownership`
// is the R48 {@link OwnershipRecord} verbatim (its status + current owner). This core RE-DERIVES no
// worklist (R38 alone owns that), RE-DECIDES no ownership (R48/R51 alone own that), RE-ORDERS nothing within
// a group (the R38 order is reused as given), and INVENTS no priority, no category and no business rule. Its
// SOLE contribution is the OWNERSHIP GROUPING — a stable partition of already-ordered entries by an already-
// derived status — and the counts. The Lifecycle, Resolution, Coordination and Ownership engines all stay
// authoritative; there is no second source of truth for what needs attention (the worklist's) or who owns it
// (the read model's).
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING, READS NO DB AND OPENS NO EXECUTION PATH. Like every
// core in this stack, the queue is a TOTAL, DETERMINISTIC function of already-computed inputs — the worklist
// entries and the ownership records the runtime handed in. It adds NO column and NO migration, reaches NO
// provider, NO ledger, NO DB, NO clock and NO RNG. It ASSIGNS nobody, DISPATCHES nothing, NOTIFIES no one,
// ENQUEUES into no operational system, SCHEDULES nothing, RETRIES nothing and COMPLETES nothing — assignment,
// dispatch, notification, scheduling, queue-execution, promotion, fulfilment and memory retrieval are all
// EXPLICIT R58 non-goals. WHICH org's work is read (org-scoped) is the server runtime's job, through the R39
// and R48 readers; this core only shapes what it is given.
// =====================================================================

/**
 * The closed vocabulary of ATTENTION GROUPS, in PRESENTATION ORDER — a fixed const tuple (like R38's
 * `WORKLIST_CATEGORIES` and R48's `OWNERSHIP_STATES`), so a consumer can switch exhaustively. It is a
 * PRESENTATION ORDER, NOT a priority claim: `unowned` first because work no operator holds is waiting to be
 * picked up; `owned` next because work already in hand is being handled. Grouping by this axis re-derives no
 * ownership — it reads the R48 status and buckets by it.
 */
export const ATTENTION_GROUPS = ["unowned", "owned"] as const;

/** One attention group a coordination can fall in — derived ONLY from its R48 ownership status. */
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];

/**
 * ONE row of the attention queue — an actionable worklist entry joined with its ownership record. It carries
 * NO new fact: `entry` is the R38 {@link WorklistEntry} verbatim (coordination + conversation, priority,
 * categories, mode, requires-human, the whole coordination record), `ownership` is the R48
 * {@link OwnershipRecord} verbatim (status + current owner), and `group` is which {@link ATTENTION_GROUPS}
 * bucket the row falls in — a pure relabelling of `ownership` (owned → "owned", else "unowned"). The
 * `coordination_id` and `conversation_id` are surfaced at the top level (copied from the entry) for a
 * consumer to key on without reaching into the nested record.
 */
export type AttentionQueueEntry = {
  readonly coordination_id: string;
  readonly conversation_id: string | null;
  readonly group: AttentionGroup;
  readonly entry: WorklistEntry;
  readonly ownership: OwnershipRecord;
};

/**
 * ONE group of the attention queue — its {@link ATTENTION_GROUPS} key, its rows (in the R38 canonical
 * priority-then-recency order, preserved from the input) and how many rows it holds. A group with no rows is
 * still present (its `entries` empty, its `count` 0) — the queue always names both groups, in the fixed
 * presentation order.
 */
export type AttentionQueueGroup = {
  readonly group: AttentionGroup;
  readonly entries: readonly AttentionQueueEntry[];
  readonly count: number;
};

/**
 * The whole ATTENTION QUEUE VIEW — the read-only result the queue projects:
 *   • `groups`  — the per-group breakdown, ALWAYS the two {@link ATTENTION_GROUPS} in presentation order
 *                 (unowned, owned), each with its rows and count.
 *   • `entries` — the SAME rows as one flat list in grouped order: the unowned rows (in R38 order) followed
 *                 by the owned rows (in R38 order). A consumer that wants a single sequence reads this;
 *                 a consumer that wants sections reads `groups`.
 *   • `total`   — how many rows the queue holds (the actionable worklist's size for the org).
 * Read-only and derived: every value is the worklist's or the ownership read model's, re-computed by neither.
 */
export type AttentionQueueView = {
  readonly entries: readonly AttentionQueueEntry[];
  readonly groups: readonly AttentionQueueGroup[];
  readonly total: number;
};

/**
 * Project the {@link AttentionQueueView} from the actionable, already-ordered worklist `entries` (the R38
 * `prioritised` backlog, delivered through R39) and each entry's R48 ownership record, keyed by
 * coordination id. PURE, TOTAL and DETERMINISTIC — the same entries and the same ownership map always yield
 * the same queue.
 *
 * It JOINS each entry with its ownership (a lookup by `coordination_id`), LABELS its {@link AttentionGroup}
 * from the R48 status alone, and STABLY PARTITIONS the rows into the fixed {@link ATTENTION_GROUPS} order —
 * unowned first, owned next — PRESERVING the input's (R38 canonical) order within each group. It re-derives
 * no worklist, re-decides no ownership and re-orders nothing within a group; the ONLY thing it decides is
 * the ownership bucket, and that is read straight from the record.
 *
 * The runtime MUST supply an ownership record for EVERY entry (the R48 reader is total — it returns an
 * `unowned` record for a coordination no claim names — so a well-formed call always can). A missing record
 * is a runtime contract violation and throws, so the queue never silently drops or mis-groups an entry.
 */
export function projectAttentionQueue(input: {
  entries: readonly WorklistEntry[];
  ownershipByCoordination: ReadonlyMap<string, OwnershipRecord>;
}): AttentionQueueView {
  const { entries, ownershipByCoordination } = input;
  const rows: AttentionQueueEntry[] = entries.map((entry) => {
    const ownership = ownershipByCoordination.get(entry.coordination_id);
    if (!ownership) {
      throw new Error(
        `attention queue: no ownership record supplied for coordination ${entry.coordination_id}`,
      );
    }
    return {
      coordination_id: entry.coordination_id,
      conversation_id: entry.conversation_id,
      group: ownership.owned ? "owned" : "unowned",
      entry,
      ownership,
    };
  });
  // A STABLE partition into the fixed presentation order — unowned first, owned next — that preserves the
  // R38 canonical order within each group (a filter keeps the input's relative order). The queue re-orders
  // nothing; it only buckets by the already-derived ownership status.
  const groups: AttentionQueueGroup[] = ATTENTION_GROUPS.map((group) => {
    const groupEntries = rows.filter((row) => row.group === group);
    return { group, entries: groupEntries, count: groupEntries.length };
  });
  const ordered = groups.flatMap((group) => group.entries);
  return { entries: ordered, groups, total: ordered.length };
}
