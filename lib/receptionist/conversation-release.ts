import type { OperatorIdentity } from "./conversation-claim";

// =====================================================================
// THE CONVERSATION WORK RELEASE — PURE CORE (CEO Directive #018; R50: CONVERSATION WORK RELEASE).
//
// R46 gave a human operator the FIRST write in this stack: the CLAIM — taking OWNERSHIP of a coordinated Conversation
// Worklist item so it is worked once and by one person. R47 surfaced it, R48 established the canonical Ownership Read
// Model, and R49 listed an operator their own claims. Ownership, until now, has been a ONE-WAY door: an operator could
// take an item but never put it back. R50 is that door's other side — the FIRST governed RELINQUISH: the single,
// canonical authority over ONE question, asked of a claimed coordination and the operator asking — "may THIS operator
// RELEASE their ownership of THIS item, returning it to the unclaimed state?" — the RELEASE DECISION.
//
// IT RELINQUISHES AN OWNERSHIP CLAIM — AND ONLY THAT. A release is a human operator handing an item they hold back to
// the unclaimed pool, so it can be picked up afresh. It is emphatically NOT a reassignment, an assignment, a dispatch,
// a notification, a schedule, a quote fulfilment, a customer promotion, a completion or a conversation close — every one
// of those is an EXPLICIT R50 non-goal. The release decision is the GO-AHEAD to RECORD that an operator has let go of an
// item; it moves the work to NO OTHER operator, hands it to no queue and carries out no business operation. Release is a
// fact about an owner STEPPING BACK, nothing more — the item simply becomes unclaimed again.
//
// THE CLAIM RUNTIME REMAINS AUTHORITATIVE — RELEASE CONSUMES THE OWNERSHIP FACT, IT NEVER RE-DERIVES IT. A release is
// filed AGAINST an already-recorded claim on a coordination (identified by its `coordination_id`); this core neither
// derives ownership, re-decides a claim, nor asserts a claim exists — WHETHER the named coordination is really OWNED BY
// THE RELEASING OPERATOR in their organisation is the runtime's guard (over the R46 claim ledger, which stays the single
// source of truth for who holds what). The pure core VALIDATES the SHAPE of a release request — that it names an
// organisation, a coordination and an operator identity — and STOPS. It reaches no ledger, no DB, no clock, no RNG, no
// org lookup, no env read and — the cardinal rule shared with the whole stack — NO MODEL: the same release request
// always yields the same release decision.
//
// ORGANISATION ISOLATION IS PRESERVED — TRANSITIVELY, THROUGH THE RUNTIME IT DEFERS TO. This core names no tenant and
// selects none: it carries the `org_id` a release is scoped to as an OPAQUE input and validates only that one is
// present. A release can be filed ONLY against a coordination the operator's organisation actually owns — but that
// guard is the runtime's (and the database SECURITY DEFINER writer's), because only they can see the claim ledger. The
// core makes isolation POSSIBLE (it demands an org on every request); the runtime makes it TRUE.
//
// IT PREVENTS INVALID RELEASES — BY DEFERRING THE OWNERSHIP GUARD, NOT BY WEAKENING IT. The core proves a request is
// WELL-FORMED; the runtime + database prove it is VALID: an item with no claim, or a claim held by a DIFFERENT operator,
// cannot be released (the storage writer refuses and records nothing). "You can only release what you actually hold" is
// enforced where ownership is visible — the ledger — never here on trust.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND RELEASES NOTHING ITSELF. Like every pure core in this stack,
// the release DECISION is a TOTAL, DETERMINISTIC function of its single request input. WHETHER a decided release is
// RECORDED (as an append-only release-ledger row), whether the operator actually OWNS the item, and how a non-owner
// attempt is refused is the server runtime's job, behind its own append-only, service-role-only, ownership-guarded
// ledger. The pure core validates the request, names the release and stops.
//
// EXPLICIT R50 NON-GOALS no layer here performs: reassignment, automatic assignment, work dispatch, user notification,
// scheduling, quote fulfilment, customer promotion, memory retrieval, customer-portal conversations, voice / WhatsApp /
// email, and business execution. The release R50 records is the durable, auditable fact that a human operator has
// RELINQUISHED ownership of a coordinated conversation — the fact the Ownership Read Model reads to return the item to
// the unclaimed state. It records a relinquish; it carries nothing out.
// =====================================================================

// ---------------------------------------------------------------------
// The RELEASE vocabulary — the closed set of release types, the recorded outcome and the recorded status.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of RELEASE TYPES — the kinds of relinquish an operator can make. R50 ships exactly ONE:
 *   • release_conversation_work — a human operator RELINQUISHES ownership of a coordinated Conversation Worklist item
 *                                 they hold, returning it to the unclaimed state. It records a relinquish; it never
 *                                 reassigns, assigns, dispatches, schedules, completes or closes (all EXPLICIT R50
 *                                 non-goals).
 * Every future release type is an explicit R50 non-goal, so it is deliberately ABSENT — a future increment ADDS it here
 * (and to the ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ReleaseType} is exactly
 * these members and a consumer can switch exhaustively.
 */
export const RELEASE_TYPES = ["release_conversation_work"] as const;

/** One release type an operator can make. */
export type ReleaseType = (typeof RELEASE_TYPES)[number];

/**
 * The closed vocabulary of RELEASE OUTCOMES — the recorded result of relinquishing ownership. R50 ships exactly ONE:
 *   • work_released — the operator let go of the coordinated conversation. This is the fact R50 records: the durable
 *                     statement that a human operator relinquished this work item, returning it to the unclaimed state.
 *                     It is deliberately NOT "work_reassigned" or "work_completed" — those are R50 non-goals.
 * A closed union so a consumer can switch exhaustively over every recorded result.
 */
export type ReleaseOutcome = "work_released";

/**
 * The closed vocabulary of RELEASE STATUS — the recorded state of a release row. R50 ships exactly ONE:
 *   • released — the operator has relinquished the claim. There is no "reassigned" or "completed" status: R50 records
 *                the RELINQUISHING of ownership only; reassigning and completing are explicit non-goals for a later
 *                increment.
 * A closed union so the status can never drift from what R50 records.
 */
export type ReleaseStatus = "released";

/**
 * The closed vocabulary of RELEASE RESOLUTIONS — how the RUNTIME resolved a release attempt against its ledger. This is
 * NOT the pure decision (that is {@link ReleaseDecision}); it is the shape of what the runtime reports after attempting
 * the write, named here so both the runtime and its consumers share one closed set:
 *   • released     — the release was recorded (or the same operator re-released their own item; idempotent). The item
 *                    is returned to the unclaimed state.
 *   • not_owned    — the item cannot be released by this operator: it has no active claim, or its claim is held by a
 *                    DIFFERENT operator. The attempt was refused and nothing was written. Invalid releases are
 *                    prevented, structurally — you can only release what you hold.
 *   • unavailable  — the release could not be recorded: the request was ill-shaped, the coordination does not exist in
 *                    the operator's organisation, or the ledger write failed. Best-effort — never an exception.
 * A closed union so a consumer can switch exhaustively over every resolution the runtime can report.
 */
export const RELEASE_RESOLUTIONS = ["released", "not_owned", "unavailable"] as const;

/** One resolution the runtime can report for a release attempt. */
export type ReleaseResolution = (typeof RELEASE_RESOLUTIONS)[number];

// ---------------------------------------------------------------------
// The RELEASE model — the request an operator makes and the decision this core derives.
// ---------------------------------------------------------------------

/**
 * The RELEASE REQUEST — everything the pure core needs to decide whether a well-formed release can be named: the
 * organisation the release is scoped to (`org_id`), the recorded coordination it is filed against (`coordination_id`),
 * and the operator making it (`operator`). The conversation and correlation ids are OPTIONAL provenance the runtime
 * threads onto the audit row for cross-reference; they are not part of the decision. The core validates SHAPE only —
 * it asserts none of these ids resolves to a real row, and it asserts NO ownership (that is the runtime's guard).
 *
 * Reuses {@link OperatorIdentity} — the canonical operator identity the claim core defines — so a release records WHO
 * relinquished it exactly as a claim records who took it.
 */
export type ReleaseRequest = {
  readonly org_id: string;
  readonly coordination_id: string;
  readonly operator: OperatorIdentity;
  readonly conversation_id?: string | null;
  readonly correlation_id?: string | null;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the core named NO release. An abstention is not an error; it is
 * the honest "this request cannot name a release":
 *   • missing_organisation          — the request carries no organisation. A release is ALWAYS org-scoped (isolation is
 *                                      structural), so a request without one can name no release.
 *   • missing_coordination          — the request names no coordination. A release is ALWAYS filed against a specific
 *                                      recorded coordination, so a request without one can name no release.
 *   • incomplete_operator_identity  — the request carries no operator id. A release ALWAYS records WHO relinquished it,
 *                                      so a request without an operator id can name no release.
 * A closed union so {@link ReleaseDecision}'s abstention arm is exhaustive.
 */
export type ReleaseAbstention =
  | "missing_organisation"
  | "missing_coordination"
  | "incomplete_operator_identity";

/**
 * The RELEASE-GRANTED decision — the first (and only R50) release decision. It is the GO-AHEAD to RECORD a relinquish,
 * carrying the recorded {@link ReleaseOutcome} (`work_released`), the operator making it, and the organisation +
 * coordination it is scoped to (so the decision is self-describing for the release ledger). It is emitted ONLY for a
 * well-formed request — it can carry no partial identity, and it names no coordination that was not requested. It is
 * NOT an assertion that the operator owns the item: that guard is the runtime's, over the claim ledger.
 */
export type ReleaseGranted = {
  readonly kind: ReleaseType;
  readonly outcome: ReleaseOutcome;
  readonly operator: OperatorIdentity;
  readonly org_id: string;
  readonly coordination_id: string;
};

/**
 * The RELEASE DECISION — a discriminated union the runtime reads:
 *   • the GRANTED arm ({@link ReleaseGranted}) — the go-ahead to record a relinquish. Its `kind` IS its
 *     {@link ReleaseType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no release, tagged with WHY ({@link ReleaseAbstention}).
 * Every field is a total, deterministic function of the request; the whole object is derived, never persisted or
 * recorded by this core.
 */
export type ReleaseDecision =
  | ReleaseGranted
  | { readonly kind: "none"; readonly reason: ReleaseAbstention };

// ---------------------------------------------------------------------
// RESOLUTION — the single derived release decision. Validates shape; total over the input.
// ---------------------------------------------------------------------

/** Whether a value is a present, non-blank string — the shape gate for every load-bearing id. */
function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The abstention decision for a reason — the single shape of "no release". */
function abstain(reason: ReleaseAbstention): ReleaseDecision {
  return { kind: "none", reason };
}

/**
 * Resolve the RELEASE DECISION for a release request — THE single entry point the runtime reads. Validates the SHAPE of
 * the request in a fixed order (organisation, then coordination, then operator identity), abstaining with the precise
 * reason on the first gate that fails, and otherwise naming the `release_conversation_work` release.
 *
 * Pure, TOTAL over any request, and DETERMINISTIC — the same request always yields the same decision. It asserts NO
 * fact about the world: it does not check that the coordination exists, that it belongs to the organisation, or that
 * the operator OWNS it — those guards are the runtime's and the database's, because only they can see the claim ledger.
 * This is where "prevent invalid releases" is MADE POSSIBLE (the core demands a complete, org-scoped, operator-named
 * request) but not where it is DECIDED (the ownership guard is the runtime's). This core proves the request is
 * WELL-FORMED and names the release; it persists nothing and records nothing. THE single source of truth for what a
 * well-formed release looks like — every consumer resolves it through this function and no other way.
 */
export function resolveRelease(request: ReleaseRequest): ReleaseDecision {
  // ORGANISATION FIRST — a release is always org-scoped, so a request without an organisation can name no release. This
  // is the shape gate behind organisation isolation: the core demands an org on every request; the runtime scopes the
  // write by it.
  if (!isNonEmpty(request.org_id)) return abstain("missing_organisation");

  // A release is always filed against a specific recorded coordination — a request that names none can name no release.
  if (!isNonEmpty(request.coordination_id)) return abstain("missing_coordination");

  // A release always records WHO relinquished it — a request without an operator id can name no release. The email is
  // best-effort attribution and is not gated here; the id is the load-bearing identity.
  if (!isNonEmpty(request.operator?.id)) return abstain("incomplete_operator_identity");

  // The request is well-formed — name the release. Self-describing (it carries the operator, org and coordination) so
  // the release ledger row can never drift from the decision it records. It is NOT an assertion of ownership.
  return {
    kind: "release_conversation_work",
    outcome: "work_released",
    operator: request.operator,
    org_id: request.org_id,
    coordination_id: request.coordination_id,
  };
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is GRANTED (a go-ahead to record a concrete release), as opposed to an abstention. A type guard:
 * it narrows a {@link ReleaseDecision} to its granted arm, so the runtime records ONLY a real decision and an
 * abstention is a total no-op. THE predicate the runtime gates the write on — there is no other "should we record a
 * release?" rule.
 */
export function isReleaseDecided(decision: ReleaseDecision): decision is ReleaseGranted {
  return decision.kind !== "none";
}

/**
 * The {@link ReleaseType} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and total —
 * the granted arm's `kind` IS its release type, so the mapping is the identity on the granted arm and `null` on the
 * abstention.
 */
export function releaseTypeOf(decision: ReleaseDecision): ReleaseType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link ReleaseOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and total —
 * the recorded result the runtime folds onto the ledger row alongside the release type.
 */
export function releaseOutcomeOf(decision: ReleaseDecision): ReleaseOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}
