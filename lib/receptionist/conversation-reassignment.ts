import type { OperatorIdentity } from "./conversation-claim";

// =====================================================================
// THE CONVERSATION WORK REASSIGNMENT — PURE CORE (CEO Directive #018; R52: CONVERSATION WORK REASSIGNMENT).
//
// R46 gave a human operator the FIRST write in this stack: the CLAIM — taking OWNERSHIP of a coordinated Conversation
// Worklist item so it is worked once and by one person. R50 gave that door its other side — the RELEASE, an owner
// stepping back and returning the item to the unclaimed pool. R51 made the Ownership State Engine the single authority
// over ownership STATE folded from those two ledgers. Ownership, until now, has moved in only two directions: an operator
// could TAKE an item (R46) or PUT IT BACK (R50), but never HAND IT TO ANOTHER OPERATOR. R52 is that third door — the
// single, canonical authority over ONE question, asked of a held coordination and the two operators named — "may the
// operator who HOLDS this item TRANSFER their ownership of it to ANOTHER named operator?" — the REASSIGNMENT DECISION.
//
// IT TRANSFERS AN OWNERSHIP CLAIM — AND ONLY THAT. A reassignment is a human operator handing a coordinated item they
// hold to ANOTHER human operator, who now holds it. It is emphatically NOT an automatic assignment (a queue picking a
// worker), a dispatch, a notification, a schedule, a quote fulfilment, a customer promotion, a completion or a
// conversation close — every one of those is an EXPLICIT R52 non-goal. The reassignment decision is the GO-AHEAD to
// RECORD that ownership passed from one operator to another; it moves the work through NO system, hands it to no queue,
// and carries out no business operation. A reassignment is a fact about ownership CHANGING HANDS between two named
// operators, nothing more — the item stays claimed throughout; only WHO holds it changes.
//
// THE CLAIM, RELEASE AND OWNERSHIP STATE ENGINES ALL REMAIN AUTHORITATIVE — REASSIGNMENT CONSUMES THE OWNERSHIP FACT, IT
// NEVER RE-DERIVES IT. A reassignment is filed AGAINST an already-recorded claim on a coordination (identified by its
// `coordination_id`); this core neither derives ownership, re-decides a claim, re-decides a release, nor asserts a claim
// exists — WHETHER the named coordination is really HELD BY THE REASSIGNING OPERATOR in their organisation is the
// runtime's guard (over the R46 claim ledger, the R50 release ledger and this ledger's own transfer chain, which
// together are the single source of truth for who currently holds what). The pure core VALIDATES the SHAPE of a
// reassignment request — that it names an organisation, a coordination, a source operator and a DISTINCT target operator
// — and STOPS. It reaches no ledger, no DB, no clock, no RNG, no org lookup, no env read and — the cardinal rule shared
// with the whole stack — NO MODEL: the same reassignment request always yields the same reassignment decision.
//
// ORGANISATION ISOLATION IS PRESERVED — TRANSITIVELY, THROUGH THE RUNTIME IT DEFERS TO. This core names no tenant and
// selects none: it carries the `org_id` a reassignment is scoped to as an OPAQUE input and validates only that one is
// present. A reassignment can be filed ONLY against a coordination the operator's organisation actually owns and holds —
// but that guard is the runtime's (and the database SECURITY DEFINER writer's), because only they can see the ledgers.
// The core makes isolation POSSIBLE (it demands an org on every request); the runtime makes it TRUE.
//
// IT PREVENTS INVALID TRANSFERS — BY DEFERRING THE OWNERSHIP GUARD, NOT BY WEAKENING IT. The core proves a request is
// WELL-FORMED; the runtime + database prove it is VALID: an item with no claim, a released item, or an item held by a
// DIFFERENT operator than the named source, cannot be reassigned (the storage writer refuses and records nothing). "You
// can only reassign what you actually hold" is enforced where ownership is visible — the ledgers — never here on trust.
// The one validity gate this core DOES own is structural: a reassignment must move the item to a DIFFERENT operator, so
// a request whose source and target are the same operator names no transfer.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND TRANSFERS NOTHING ITSELF. Like every pure core in this stack,
// the reassignment DECISION is a TOTAL, DETERMINISTIC function of its single request input. WHETHER a decided
// reassignment is RECORDED (as an append-only reassignment-ledger row), whether the source operator actually HOLDS the
// item, and how a non-owner attempt is refused is the server runtime's job, behind its own append-only, service-role-only,
// ownership-guarded ledger. The pure core validates the request, names the reassignment and stops.
//
// EXPLICIT R52 NON-GOALS no layer here performs: automatic assignment, work dispatch, user notification, scheduling,
// quote fulfilment, customer promotion, memory retrieval, customer-portal conversations, voice / WhatsApp / email, and
// business execution. The reassignment R52 records is the durable, auditable fact that a human operator has TRANSFERRED
// ownership of a coordinated conversation to another operator — recorded once per transfer, append-only, so the complete
// ownership history (claimed by A, THEN reassigned to B, THEN to C) is preserved in full. It records a transfer; it
// carries nothing out.
// =====================================================================

// ---------------------------------------------------------------------
// The REASSIGNMENT vocabulary — the closed set of reassignment types, the recorded outcome and the recorded status.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of REASSIGNMENT TYPES — the kinds of transfer an operator can make. R52 ships exactly ONE:
 *   • reassign_conversation_work — a human operator TRANSFERS ownership of a coordinated Conversation Worklist item they
 *                                  hold to ANOTHER named operator, who now holds it. It records a transfer; it never
 *                                  automatically assigns, dispatches, schedules, completes or closes (all EXPLICIT R52
 *                                  non-goals).
 * Every future reassignment type is an explicit R52 non-goal, so it is deliberately ABSENT — a future increment ADDS it
 * here (and to the ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ReassignmentType} is
 * exactly these members and a consumer can switch exhaustively.
 */
export const REASSIGNMENT_TYPES = ["reassign_conversation_work"] as const;

/** One reassignment type an operator can make. */
export type ReassignmentType = (typeof REASSIGNMENT_TYPES)[number];

/**
 * The closed vocabulary of REASSIGNMENT OUTCOMES — the recorded result of transferring ownership. R52 ships exactly ONE:
 *   • work_reassigned — the operator handed the coordinated conversation to another operator. This is the fact R52
 *                       records: the durable statement that a human operator transferred this work item to a named other
 *                       operator, who now holds it. It is deliberately NOT "work_released" or "work_completed" — those
 *                       are other increments' outcomes and R52 non-goals.
 * A closed union so a consumer can switch exhaustively over every recorded result.
 */
export type ReassignmentOutcome = "work_reassigned";

/**
 * The closed vocabulary of REASSIGNMENT STATUS — the recorded state of a reassignment row. R52 ships exactly ONE:
 *   • reassigned — the operator has transferred the claim to another operator. There is no "released" or "completed"
 *                  status: R52 records the TRANSFERRING of ownership only; releasing and completing are other increments'
 *                  concerns and explicit R52 non-goals.
 * A closed union so the status can never drift from what R52 records.
 */
export type ReassignmentStatus = "reassigned";

/**
 * The closed vocabulary of REASSIGNMENT RESOLUTIONS — how the RUNTIME resolved a reassignment attempt against its
 * ledger. This is NOT the pure decision (that is {@link ReassignmentDecision}); it is the shape of what the runtime
 * reports after attempting the write, named here so both the runtime and its consumers share one closed set:
 *   • reassigned   — the transfer was recorded (or the same request was replayed; idempotent). The item is now held by
 *                    the target operator.
 *   • not_owned    — the item cannot be transferred by this operator: it has no active claim, it has been released, or
 *                    its ownership is currently held by a DIFFERENT operator than the named source. The attempt was
 *                    refused and nothing was written. Invalid transfers are prevented, structurally — you can only
 *                    reassign what you hold.
 *   • unavailable  — the transfer could not be recorded: the request was ill-shaped, the coordination does not exist in
 *                    the operator's organisation, or the ledger write failed. Best-effort — never an exception.
 * A closed union so a consumer can switch exhaustively over every resolution the runtime can report.
 */
export const REASSIGNMENT_RESOLUTIONS = ["reassigned", "not_owned", "unavailable"] as const;

/** One resolution the runtime can report for a reassignment attempt. */
export type ReassignmentResolution = (typeof REASSIGNMENT_RESOLUTIONS)[number];

// ---------------------------------------------------------------------
// The REASSIGNMENT model — the request an operator makes and the decision this core derives.
// ---------------------------------------------------------------------

/**
 * The REASSIGNMENT REQUEST — everything the pure core needs to decide whether a well-formed transfer can be named: the
 * organisation the reassignment is scoped to (`org_id`), the recorded coordination it is filed against
 * (`coordination_id`), the SOURCE operator giving the item up (`from_operator`, the PREVIOUS owner) and the TARGET
 * operator receiving it (`to_operator`, the NEW owner). The conversation and correlation ids are OPTIONAL provenance the
 * runtime threads onto the audit row for cross-reference; they are not part of the decision. The core validates SHAPE
 * only — it asserts none of these ids resolves to a real row, and it asserts NO ownership (that is the runtime's guard).
 *
 * Reuses {@link OperatorIdentity} — the canonical operator identity the claim core defines — for BOTH operators, so a
 * reassignment records WHO gave the item up and WHO received it exactly as a claim records who took it.
 */
export type ReassignmentRequest = {
  readonly org_id: string;
  readonly coordination_id: string;
  readonly from_operator: OperatorIdentity;
  readonly to_operator: OperatorIdentity;
  readonly conversation_id?: string | null;
  readonly correlation_id?: string | null;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the core named NO reassignment. An abstention is not an error; it
 * is the honest "this request cannot name a transfer":
 *   • missing_organisation        — the request carries no organisation. A reassignment is ALWAYS org-scoped (isolation
 *                                    is structural), so a request without one can name no transfer.
 *   • missing_coordination        — the request names no coordination. A reassignment is ALWAYS filed against a specific
 *                                    recorded coordination, so a request without one can name no transfer.
 *   • incomplete_source_operator  — the request carries no SOURCE operator id. A reassignment ALWAYS records WHO it came
 *                                    from, so a request without a source operator id can name no transfer.
 *   • incomplete_target_operator  — the request carries no TARGET operator id. A reassignment ALWAYS records WHO it went
 *                                    to, so a request without a target operator id can name no transfer.
 *   • same_operator               — the source and target are the SAME operator. A reassignment always moves the item to
 *                                    a DIFFERENT operator; a self-transfer is a no-op and names no transfer.
 * A closed union so {@link ReassignmentDecision}'s abstention arm is exhaustive.
 */
export type ReassignmentAbstention =
  | "missing_organisation"
  | "missing_coordination"
  | "incomplete_source_operator"
  | "incomplete_target_operator"
  | "same_operator";

/**
 * The REASSIGNMENT-GRANTED decision — the first (and only R52) reassignment decision. It is the GO-AHEAD to RECORD a
 * transfer, carrying the recorded {@link ReassignmentOutcome} (`work_reassigned`), the SOURCE operator giving the item
 * up, the TARGET operator receiving it, and the organisation + coordination it is scoped to (so the decision is
 * self-describing for the reassignment ledger). It is emitted ONLY for a well-formed request — it can carry no partial
 * identity, it names no coordination that was not requested, and its source and target are always DISTINCT. It is NOT an
 * assertion that the source operator holds the item: that guard is the runtime's, over the claim + release + reassignment
 * ledgers.
 */
export type ReassignmentGranted = {
  readonly kind: ReassignmentType;
  readonly outcome: ReassignmentOutcome;
  readonly from_operator: OperatorIdentity;
  readonly to_operator: OperatorIdentity;
  readonly org_id: string;
  readonly coordination_id: string;
};

/**
 * The REASSIGNMENT DECISION — a discriminated union the runtime reads:
 *   • the GRANTED arm ({@link ReassignmentGranted}) — the go-ahead to record a transfer. Its `kind` IS its
 *     {@link ReassignmentType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no transfer, tagged with WHY ({@link ReassignmentAbstention}).
 * Every field is a total, deterministic function of the request; the whole object is derived, never persisted or
 * recorded by this core.
 */
export type ReassignmentDecision =
  | ReassignmentGranted
  | { readonly kind: "none"; readonly reason: ReassignmentAbstention };

// ---------------------------------------------------------------------
// RESOLUTION — the single derived reassignment decision. Validates shape; total over the input.
// ---------------------------------------------------------------------

/** Whether a value is a present, non-blank string — the shape gate for every load-bearing id. */
function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The abstention decision for a reason — the single shape of "no reassignment". */
function abstain(reason: ReassignmentAbstention): ReassignmentDecision {
  return { kind: "none", reason };
}

/**
 * Resolve the REASSIGNMENT DECISION for a reassignment request — THE single entry point the runtime reads. Validates the
 * SHAPE of the request in a fixed order (organisation, then coordination, then source operator identity, then target
 * operator identity, then the source-and-target-differ rule), abstaining with the precise reason on the first gate that
 * fails, and otherwise naming the `reassign_conversation_work` reassignment.
 *
 * Pure, TOTAL over any request, and DETERMINISTIC — the same request always yields the same decision. It asserts NO fact
 * about the world: it does not check that the coordination exists, that it belongs to the organisation, or that the
 * source operator HOLDS it — those guards are the runtime's and the database's, because only they can see the ledgers.
 * The one validity rule it DOES own is structural and shape-level: the source and target operators must DIFFER (a
 * self-transfer names no transfer). This is where "prevent invalid transfers" is MADE POSSIBLE (the core demands a
 * complete, org-scoped, two-distinct-operators request) but not where the OWNERSHIP part is DECIDED (that guard is the
 * runtime's). This core proves the request is WELL-FORMED and names the reassignment; it persists nothing and records
 * nothing. THE single source of truth for what a well-formed reassignment looks like — every consumer resolves it
 * through this function and no other way.
 */
export function resolveReassignment(request: ReassignmentRequest): ReassignmentDecision {
  // ORGANISATION FIRST — a reassignment is always org-scoped, so a request without an organisation can name no transfer.
  // This is the shape gate behind organisation isolation: the core demands an org on every request; the runtime scopes
  // the write by it.
  if (!isNonEmpty(request.org_id)) return abstain("missing_organisation");

  // A reassignment is always filed against a specific recorded coordination — a request that names none can name no
  // transfer.
  if (!isNonEmpty(request.coordination_id)) return abstain("missing_coordination");

  // A reassignment always records WHO it came from — a request without a source operator id can name no transfer. The
  // email is best-effort attribution and is not gated here; the id is the load-bearing identity.
  if (!isNonEmpty(request.from_operator?.id)) return abstain("incomplete_source_operator");

  // A reassignment always records WHO it went to — a request without a target operator id can name no transfer.
  if (!isNonEmpty(request.to_operator?.id)) return abstain("incomplete_target_operator");

  // A TRANSFER ALWAYS MOVES THE ITEM — the source and target must DIFFER. A self-transfer is a no-op and names no
  // transfer. This is the one validity rule the pure core owns; every OWNERSHIP guard is the runtime's.
  if (request.from_operator.id === request.to_operator.id) return abstain("same_operator");

  // The request is well-formed — name the reassignment. Self-describing (it carries both operators, the org and the
  // coordination) so the reassignment ledger row can never drift from the decision it records. It is NOT an assertion of
  // ownership.
  return {
    kind: "reassign_conversation_work",
    outcome: "work_reassigned",
    from_operator: request.from_operator,
    to_operator: request.to_operator,
    org_id: request.org_id,
    coordination_id: request.coordination_id,
  };
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is GRANTED (a go-ahead to record a concrete reassignment), as opposed to an abstention. A type
 * guard: it narrows a {@link ReassignmentDecision} to its granted arm, so the runtime records ONLY a real decision and
 * an abstention is a total no-op. THE predicate the runtime gates the write on — there is no other "should we record a
 * reassignment?" rule.
 */
export function isReassignmentDecided(
  decision: ReassignmentDecision,
): decision is ReassignmentGranted {
  return decision.kind !== "none";
}

/**
 * The {@link ReassignmentType} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and
 * total — the granted arm's `kind` IS its reassignment type, so the mapping is the identity on the granted arm and
 * `null` on the abstention.
 */
export function reassignmentTypeOf(decision: ReassignmentDecision): ReassignmentType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link ReassignmentOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and
 * total — the recorded result the runtime folds onto the ledger row alongside the reassignment type.
 */
export function reassignmentOutcomeOf(
  decision: ReassignmentDecision,
): ReassignmentOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}
