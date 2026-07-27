import type {
  AttentionGroup,
  AttentionQueueEntry,
  AttentionQueueGroup,
  AttentionQueueView,
} from "@/lib/receptionist/conversation-attention-queue";

// =====================================================================
// THE CONVERSATION ATTENTION QUEUE SURFACE — PURE VIEW CORE (CEO Directive #018, R59: CONVERSATION ATTENTION QUEUE
// SURFACE — building on R58's ATTENTION QUEUE runtime).
//
// R58 shipped the ATTENTION QUEUE: a pure JOIN/GROUP core plus an org-scoped, read-only server runtime
// (`getConversationAttentionQueue`) that JOINS the org's actionable, already-prioritised worklist (delivered through
// the R39 read surface, derived by the R38 engine) with each entry's ownership (delivered through the R48 read model),
// and GROUPS it by ownership — unowned first (waiting to be picked up), owned next (in progress) — preserving the R38
// canonical order within each group. R59 is the FIRST operator-facing SURFACE built on that runtime: the read-only
// Conversation Attention Queue an HQ operator reads to see, at a glance, "of the work that needs attention, what is
// waiting to be picked up versus already being handled, and in what order?".
//
// This module is that surface's PURE PRESENTATION CORE. It consumes ONLY the runtime's already-composed output — the
// R58 {@link AttentionQueueView} — and PROJECTS the display model the page renders: each group titled + described +
// counted, each row's already-derived facts (its DERIVED priority, its RECORDED mode + categories, its SURFACED
// requires-human flag, and its R48 ownership status + current owner) HUMANISED for display, and the queue's headline
// summary. It is total, deterministic and dependency-free: it reaches NO I/O, holds NO clock and NO RNG, RECORDS
// NOTHING and DECIDES NO CONVERSATION STATE.
//
// IT DERIVES NO CONVERSATION STATE INDEPENDENTLY. Every fact it presents is the R58 view's — which itself derives none
// (the worklist is R38's, the ownership R48's, the join/group R58's). This core RE-DERIVES no worklist, RE-DECIDES no
// ownership, RE-ORDERS nothing (it renders the groups + rows in the order the view hands it) and INVENTS no priority,
// no category and no business rule. It humanises the recorded tokens, formats the instants, writes the group headings
// and the summary sentence, and buckets each row's tone for styling — a presentation re-shaping of already-read facts.
// It imports the R58 view TYPES only (erased at runtime), so it is provably a projection over an already-composed view,
// not a second reader — and it names no engine, no seam, no ledger, no database client and no organisation of its own.
//
// IT REACHES NO I/O, NO CLOCK AND NO RNG — the SAME view always projects to the SAME surface model. Timestamps are
// rendered by SLICING the ISO string (never a `Date` parse), so the projection is deterministic and zone-stable.
// Organisation scoping is the RUNTIME's concern (the queue runtime threads the org into both seam reads); this core is
// org-agnostic, projecting only the view it is handed. It records nothing, decides nothing, grants no affordance and
// introduces NO execution path: it dispatches nothing, notifies no one, schedules nothing, assigns nobody, promotes no
// customer, retrieves no memory and completes nothing — every one an explicit R59 non-goal. (R60 reads ONE more fact
// off this same view — `canClaim`, the pure `!owned` eligibility the operator surface uses to decide whether to offer
// the EXISTING R46 claim; it is inert data — this core still grants no affordance, records nothing and runs nothing.
// R61 reads ONE further fact — `canRelease`, the VIEWER-SCOPED eligibility (the row is owned AND its owner IS the
// current viewer) the operator surface reads to decide whether to offer the EXISTING R50 release. Unlike `canClaim`,
// which is viewer-independent, `canRelease` needs the viewer's operator id, threaded in as a pure option; absent it no
// row is releasable. It too is inert data — this core still grants no affordance, records nothing and runs nothing. R62
// reads a LAST fact — `canReassign`, the SAME viewer-scoped predicate as `canRelease` (an operator may hand on only a
// row they hold), the operator surface reads to decide whether to offer the EXISTING R52 reassignment; whether a
// destination exists is a roster question decided downstream, not here. It too is inert data.)
// =====================================================================

/** The placeholder shown for any absent (null / empty) value — the surface never invents a fact. */
const EM_DASH = "—";

/** The recorded vocabularies, referenced by INDEXED ACCESS off the R58 view's own row type, so this core pins the exact
 *  priority / mode / ownership-status vocabulary WITHOUT importing a third module (the engines' vocabulary reaches the
 *  surface only through the view it reads). */
type PriorityValue = AttentionQueueEntry["entry"]["priority"];
type ModeValue = AttentionQueueEntry["entry"]["mode"];
type OwnershipStatusValue = AttentionQueueEntry["ownership"]["status"];

/** The tone a row's human-required fact styles with — required (a human must act) or autonomous (no human needed). */
export type AttentionQueueHumanTone = "required" | "autonomous";

/** The tone a row's ownership fact styles with — held (an operator owns it now) or unheld (no one does). */
export type AttentionQueueOwnershipTone = "held" | "unheld";

/**
 * Humanise a recorded vocabulary token (a priority, a mode, a worklist category) into a display label — split on
 * `_`/`-`, trim, and Title-Case each word. An absent token collapses to the em dash. Pure and total; it re-labels a
 * value the authoritative view already fixed, it re-derives nothing.
 */
function humaniseToken(token: string | null | undefined): string {
  if (token === null || token === undefined) return EM_DASH;
  const spaced = token.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return EM_DASH;
  return spaced
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Render an ISO-8601 instant as `YYYY-MM-DD HH:MM` by SLICING the calendar date and wall-clock minute directly — never
 * a `Date` parse — so the projection is deterministic and zone-stable (the same moment always renders identically). An
 * absent instant collapses to the em dash; a date-only value renders as the date alone. Pure and total.
 */
function formatInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return EM_DASH;
  const date = iso.slice(0, 10);
  const t = iso.indexOf("T");
  if (t === -1) return date;
  const time = iso.slice(t + 1, t + 6); // HH:MM
  return time ? `${date} ${time}` : date;
}

/** The short form of a ledger id — the first 8 chars, for a compact reference. Pure; an empty id stays empty. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * ONE row of the attention queue surface — an actionable worklist item, its facts humanised for display. Carries NO
 * new fact: every field is copied from the R58 {@link AttentionQueueView}'s row (its worklist entry + its ownership
 * record) and relabelled. The `coordinationId` is the full id (a consumer keys on it and links to the R45 detail
 * surface); `coordinationIdShort` / `conversationIdShort` are compact display forms.
 *   • group           — which {@link AttentionGroup} bucket the row is in (from the R48 status alone).
 *   • priority        — the DERIVED operational priority (raw) + its humanised label; the page styles by the raw value.
 *   • mode            — the RECORDED coordination mode (raw) + its humanised label.
 *   • categoryLabels  — the DERIVED worklists the coordination is on, humanised.
 *   • requiresHuman   — the SURFACED human-required flag + its label + its tone.
 *   • ownershipStatus — the R48 ownership status (raw) + its label + its tone.
 *   • ownerLabel      — WHO holds it now (owner email, else operator id), or null when unowned.
 *   • reassigned      — whether the current holder was reached BY a transfer rather than the original claim.
 *   • heldSince       — WHEN the current owner took hold, formatted (or the em dash when unowned).
 *   • recordedAt      — WHEN the coordination was recorded, formatted.
 *   • ownershipSummary — a ready human sentence describing the present ownership.
 *   • canClaim         — whether the row is claimable NOW: TRUE iff no operator holds it yet (the unowned state). A pure
 *                        `!owned` derivation mirroring the R47 detail surface's `canClaim`; the operator surface reads it
 *                        to decide whether to offer the EXISTING R46 claim, and the R46 runtime stays the final gate (it
 *                        refuses an already-owned coordination). This flag is inert — the core grants no affordance.
 *   • canRelease       — whether the VIEWER can release the row NOW: TRUE iff the row is owned AND its owner IS the
 *                        current viewer. Unlike `canClaim` (viewer-independent), this needs the viewer's operator id,
 *                        threaded into the projection; absent it, no row is releasable. The EXISTING R50 release runtime
 *                        stays the final gate (it refuses a row the caller does not hold). Inert — the core grants no
 *                        affordance.
 *   • canReassign      — whether the VIEWER can reassign (transfer) the row NOW: the SAME viewer-scoped eligibility as
 *                        `canRelease` — TRUE iff the row is owned AND its owner IS the current viewer — because an operator
 *                        may hand on only a row they themselves hold. The two differ only in what they enable (release vs
 *                        transfer), not in who is eligible. Whether a DESTINATION exists (another authorised operator to
 *                        receive it) is decided downstream from the org roster, not here. The EXISTING R52 reassignment
 *                        runtime stays the final gate (it refuses a row the source does not hold). Inert — the core grants
 *                        no affordance.
 */
export type AttentionQueueRowView = {
  readonly coordinationId: string;
  readonly coordinationIdShort: string;
  readonly conversationId: string | null;
  readonly conversationIdShort: string | null;
  readonly group: AttentionGroup;
  readonly priority: PriorityValue;
  readonly priorityLabel: string;
  readonly mode: ModeValue;
  readonly modeLabel: string;
  readonly categoryLabels: readonly string[];
  readonly requiresHuman: boolean;
  readonly humanLabel: string;
  readonly humanTone: AttentionQueueHumanTone;
  readonly ownershipStatus: OwnershipStatusValue;
  readonly ownershipLabel: string;
  readonly ownershipTone: AttentionQueueOwnershipTone;
  readonly ownerLabel: string | null;
  readonly reassigned: boolean;
  readonly heldSince: string;
  readonly recordedAt: string;
  readonly ownershipSummary: string;
  readonly canClaim: boolean;
  readonly canRelease: boolean;
  readonly canReassign: boolean;
};

/**
 * ONE group section of the attention queue surface — its {@link AttentionGroup} key, its display title + description,
 * its rows (in the R38 canonical order the view preserved) and its count. A group with no rows is still present (its
 * `rows` empty, its `count` 0) — the surface always names both groups, in the fixed presentation order.
 */
export type AttentionQueueGroupView = {
  readonly group: AttentionGroup;
  readonly title: string;
  readonly description: string;
  readonly count: number;
  readonly rows: readonly AttentionQueueRowView[];
};

/**
 * The whole attention queue SURFACE MODEL — the read-only display the page renders:
 *   • groups        — the per-group breakdown, ALWAYS the two {@link AttentionGroup}s in presentation order (unowned,
 *                     owned), each titled, described, counted and holding its rows.
 *   • rows          — the SAME rows as one flat list in grouped order (unowned rows then owned rows), for a consumer
 *                     that wants a single sequence.
 *   • total         — how many rows the queue holds.
 *   • unownedCount / ownedCount — the two group counts, surfaced for the headline.
 *   • isEmpty       — whether the queue holds no rows at all.
 *   • summaryLabel  — a ready human sentence describing the queue's size + split.
 * Read-only and derived: every value is the R58 view's, re-computed by neither this core nor the page.
 */
export type AttentionQueueSurfaceView = {
  readonly groups: readonly AttentionQueueGroupView[];
  readonly rows: readonly AttentionQueueRowView[];
  readonly total: number;
  readonly unownedCount: number;
  readonly ownedCount: number;
  readonly isEmpty: boolean;
  readonly summaryLabel: string;
};

/** The fixed display heading + description for each {@link AttentionGroup}. TOTAL over the vocabulary (the `Record`
 *  makes exhaustiveness a compile-time guarantee), so a new group cannot be added without titling it here. */
const GROUP_META: Readonly<Record<AttentionGroup, { readonly title: string; readonly description: string }>> = {
  unowned: {
    title: "Waiting to be picked up",
    description: "Conversations no operator holds yet — first in the queue, in priority order.",
  },
  owned: {
    title: "In progress",
    description: "Conversations an operator has already claimed and is handling.",
  },
};

/** The present-ownership sentence for a row — who holds it now, or that it is waiting. Pure and total. */
function ownershipSummaryOf(owned: boolean, reassigned: boolean, ownerLabel: string | null): string {
  if (owned && ownerLabel) {
    return reassigned ? `Held by ${ownerLabel}, by transfer.` : `Held by ${ownerLabel}.`;
  }
  return "Waiting to be picked up — no operator holds this yet.";
}

/**
 * Whether the VIEWER holds this row — the pure, viewer-scoped release eligibility. TRUE iff an operator owns the row AND
 * that owner IS the viewer (`ownership.owner.operatorId === viewerOperatorId`). With NO viewer id (a viewer-agnostic
 * projection) no row is releasable, so the surface never offers a release it cannot scope to the caller. Pure and total;
 * it re-decides no ownership — it compares the view's already-recorded owner against the operator id it is handed.
 */
function viewerHoldsRow(ownership: AttentionQueueEntry["ownership"], viewerOperatorId: string | null): boolean {
  return (
    ownership.owned &&
    ownership.owner !== null &&
    viewerOperatorId !== null &&
    ownership.owner.operatorId === viewerOperatorId
  );
}

/**
 * Project ONE R58 queue row into a display row. Pure — a straight relabelling: each fact is copied from the row's
 * worklist entry (priority, mode, categories, requires-human, recorded instant, ids) or its ownership record (status,
 * current owner, transfer flag, held-since), humanised for display. It re-derives no worklist and re-decides no
 * ownership; it only re-shapes the view's facts. The `viewerOperatorId` scopes the row's `canRelease` eligibility to
 * the caller — it is compared against the recorded owner, never re-decided.
 */
function projectRow(row: AttentionQueueEntry, viewerOperatorId: string | null): AttentionQueueRowView {
  const { entry, ownership } = row;
  const ownerLabel =
    ownership.owned && ownership.owner ? ownership.owner.operatorEmail ?? ownership.owner.operatorId : null;
  return {
    coordinationId: row.coordination_id,
    coordinationIdShort: shortId(row.coordination_id),
    conversationId: row.conversation_id,
    conversationIdShort: row.conversation_id ? shortId(row.conversation_id) : null,
    group: row.group,
    priority: entry.priority,
    priorityLabel: humaniseToken(entry.priority),
    mode: entry.mode,
    modeLabel: humaniseToken(entry.mode),
    categoryLabels: entry.categories.map((category) => humaniseToken(category)),
    requiresHuman: entry.requires_human,
    humanLabel: entry.requires_human ? "Required" : "Not required",
    humanTone: entry.requires_human ? "required" : "autonomous",
    ownershipStatus: ownership.status,
    ownershipLabel: ownership.owned ? "Owned" : "Unowned",
    ownershipTone: ownership.owned ? "held" : "unheld",
    ownerLabel,
    reassigned: ownership.reassigned,
    heldSince: formatInstant(ownership.heldSince),
    recordedAt: formatInstant(entry.at),
    ownershipSummary: ownershipSummaryOf(ownership.owned, ownership.reassigned, ownerLabel),
    // R60 claim-from-queue eligibility — a pure `!owned` mirror of the R47 detail surface's `canClaim`. A row is
    // claimable iff no operator holds it yet; the R46 claim runtime remains the final gate on the actual claim.
    canClaim: !ownership.owned,
    // R61 release-from-queue eligibility — VIEWER-SCOPED: releasable iff the row is owned AND the viewer IS its owner.
    // Threaded from the caller (never re-decided here); the R50 release runtime remains the final gate on the release.
    canRelease: viewerHoldsRow(ownership, viewerOperatorId),
    // R62 reassign-from-queue eligibility — the SAME viewer-scoped predicate: an operator may transfer only a row they
    // hold. Whether a destination operator exists is decided downstream from the org roster; the R52 reassignment runtime
    // remains the final gate on the transfer.
    canReassign: viewerHoldsRow(ownership, viewerOperatorId),
  };
}

/** Project ONE R58 queue group into a display group — titled, described, its rows relabelled. Pure and total. The
 *  `viewerOperatorId` is threaded straight into each row's projection to scope its `canRelease` eligibility. */
function projectGroup(group: AttentionQueueGroup, viewerOperatorId: string | null): AttentionQueueGroupView {
  const meta = GROUP_META[group.group];
  return {
    group: group.group,
    title: meta.title,
    description: meta.description,
    count: group.count,
    rows: group.entries.map((entry) => projectRow(entry, viewerOperatorId)),
  };
}

/** The headline sentence describing the queue's size and its unowned / owned split. Pure and total. */
function summaryLabelOf(total: number, unowned: number, owned: number): string {
  if (total === 0) return "No conversations need attention right now.";
  const noun = total === 1 ? "conversation" : "conversations";
  const verb = total === 1 ? "needs" : "need";
  return `${total} ${noun} ${verb} attention — ${unowned} waiting to be picked up, ${owned} in progress.`;
}

/**
 * Project the {@link AttentionQueueSurfaceView} from the R58 {@link AttentionQueueView} the queue runtime composed.
 * Pure, total and deterministic — the same view (and same viewer) always yields the same surface model. It titles +
 * describes + counts each of the two groups (in the view's presentation order), humanises every row's already-derived
 * facts, flattens the grouped rows into one list, and writes the headline summary. It RE-DERIVES no worklist,
 * RE-DECIDES no ownership, RE-ORDERS nothing and names no organisation — it presents the composed view it is handed.
 *
 * The optional `viewerOperatorId` scopes each row's viewer-dependent `canRelease` eligibility (R61): the operator id of
 * the caller reading the queue, compared against each row's recorded owner. It is OPTIONAL and defaults to `null`, so a
 * viewer-agnostic caller still gets a valid surface (with no row releasable). It never widens what the view exposes —
 * it only decides, per row, whether THIS viewer holds it.
 */
export function projectAttentionQueueSurface(
  view: AttentionQueueView,
  options?: { readonly viewerOperatorId?: string | null },
): AttentionQueueSurfaceView {
  const viewerOperatorId = options?.viewerOperatorId ?? null;
  const groups = view.groups.map((group) => projectGroup(group, viewerOperatorId));
  const rows = groups.flatMap((group) => group.rows);
  const unownedCount = groups.find((group) => group.group === "unowned")?.count ?? 0;
  const ownedCount = groups.find((group) => group.group === "owned")?.count ?? 0;
  return {
    groups,
    rows,
    total: view.total,
    unownedCount,
    ownedCount,
    isEmpty: view.total === 0,
    summaryLabel: summaryLabelOf(view.total, unownedCount, ownedCount),
  };
}
