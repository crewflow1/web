// =====================================================================
// THE CONVERSATION WORK CLAIM — PURE CORE (CEO Directive #018; R46: CONVERSATION WORK CLAIM).
//
// R37–R45 built the READ spine over recorded coordinations (Read Model → Worklist Engine → Read Surface → API →
// Client → Session → View Model → Operator Surface → Detail Surface). Every one of those layers is READ-ONLY: they
// LIST and INSPECT the conversations the receptionist has coordinated, and NOTHING on any of them claims, mutates or
// executes work. R46 is the NEXT increment — and, in this whole stack, the FIRST that lets a HUMAN OPERATOR WRITE: it
// is the single, canonical authority over ONE question, asked of a recorded coordination and the operator asking —
// "may THIS operator take ownership of THIS Conversation Worklist item, and if so, under whose identity?" — the CLAIM
// DECISION.
//
// IT RECORDS AN OWNERSHIP CLAIM — AND ONLY AN OWNERSHIP CLAIM. A claim is a human operator taking RESPONSIBILITY for a
// coordinated conversation so two operators do not work the same item. It is emphatically NOT an assignment, a
// dispatch, a notification, a schedule, a fulfilment, a promotion, a completion or a conversation close — every one of
// those is an EXPLICIT R46 non-goal. The claim decision is the GO-AHEAD to RECORD that an operator has claimed an
// item; it carries out no business operation, and there is no path from a claim to executing, dispatching or
// completing any work. The claim is a fact about WHO owns the item, nothing more.
//
// THE COORDINATION ENGINE REMAINS AUTHORITATIVE — THE CLAIM CONSUMES ITS RECORD, IT NEVER RE-DERIVES IT. A claim is
// filed AGAINST an already-recorded coordination (identified by its `coordination_id`); this core neither derives a
// coordination, re-decides one, nor asserts one exists — WHETHER the named coordination is real, and whether it
// belongs to the claiming operator's organisation, is the runtime's guard (over the R36 coordinations ledger, which
// stays the single source of truth for a recorded coordination). The pure core VALIDATES the SHAPE of a claim request
// — that it names an organisation, a coordination and an operator identity — and STOPS. It adds no column and no
// migration, reaches no ledger, no DB, no clock, no RNG, no org lookup, no env read and — the cardinal rule shared
// with the whole stack — NO MODEL: the same claim request always yields the same claim decision.
//
// ORGANISATION ISOLATION IS PRESERVED — TRANSITIVELY, THROUGH THE RUNTIME IT DEFERS TO. This core names no tenant and
// selects none: it carries the `org_id` a claim is scoped to as an OPAQUE input and validates only that one is
// present. The claim can be filed ONLY against a coordination in that organisation — but that guard is the runtime's
// (and the database SECURITY DEFINER writer's), because only they can see the coordinations ledger. The core makes
// isolation POSSIBLE (it demands an org on every request); the runtime makes it TRUE.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND CLAIMS NOTHING ITSELF. Like every pure core in this stack,
// the claim DECISION is a TOTAL, DETERMINISTIC function of its single request input. WHETHER a decided claim is
// RECORDED (as an append-only claim-ledger row), whether it CONFLICTS with an existing active claim, and how a
// conflict is resolved is the server runtime's job, behind its own append-only, service-role-only, conflict-guarded
// ledger. The pure core validates the request, names the claim and stops.
//
// EXPLICIT R46 NON-GOALS no layer here performs: automatic assignment, work dispatch, user notification, scheduling,
// quote fulfilment, customer promotion, memory retrieval, customer-portal conversations, voice / WhatsApp / email,
// business execution, work completion and conversation closing. The claim R46 records is the durable, auditable fact
// that a human operator has taken OWNERSHIP of a coordinated conversation — the fact a future, explicitly-authorised
// operator capability (a queue, a dashboard) reads to know who owns what. It records ownership; it carries nothing out.
// =====================================================================

// ---------------------------------------------------------------------
// The CLAIM vocabulary — the closed set of claim types, the recorded outcome and the recorded status.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of CLAIM TYPES — the kinds of ownership an operator can take. R46 ships exactly ONE:
 *   • claim_conversation_work — a human operator takes OWNERSHIP of a coordinated Conversation Worklist item, so it
 *                               is worked once and by one person. It records ownership; it never assigns, dispatches,
 *                               schedules, completes or closes (all EXPLICIT R46 non-goals).
 * Every future claim type is an explicit R46 non-goal, so it is deliberately ABSENT — a future increment ADDS it here
 * (and to the ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ClaimType} is exactly
 * these members and a consumer can switch exhaustively.
 */
export const CLAIM_TYPES = ["claim_conversation_work"] as const;

/** One claim type an operator can take. */
export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * The closed vocabulary of CLAIM OUTCOMES — the recorded result of taking a claim. R46 ships exactly ONE:
 *   • work_claimed — the operator took ownership of the coordinated conversation. This is the fact R46 records: the
 *                    durable statement that a human operator owns this work item. It is deliberately NOT
 *                    "work_assigned", "work_dispatched" or "work_completed" — those are R46 non-goals.
 * A closed union so a consumer can switch exhaustively over every recorded result.
 */
export type ClaimOutcome = "work_claimed";

/**
 * The closed vocabulary of CLAIM STATUS — the recorded state of a claim row. R46 ships exactly ONE:
 *   • claimed — the operator holds the claim. There is no "released", "reassigned" or "completed" status: R46 records
 *               the taking of a claim only; releasing, reassigning and completing are all explicit non-goals for a
 *               later increment.
 * A closed union so the status can never drift from what R46 records.
 */
export type ClaimStatus = "claimed";

/**
 * The closed vocabulary of CLAIM RESOLUTIONS — how the RUNTIME resolved a claim attempt against its ledger. This is
 * NOT the pure decision (that is {@link ClaimDecision}); it is the shape of what the runtime reports after attempting
 * the write, named here so both the runtime and its consumers share one closed set:
 *   • claimed         — the claim was recorded (or the same operator re-claimed their own item; idempotent).
 *   • already_claimed — a DIFFERENT operator already holds an active claim on this item; the attempt was refused and
 *                       nothing was written. Conflicting active claims are prevented, structurally.
 *   • unavailable     — the claim could not be recorded: the request was ill-shaped, the coordination does not exist
 *                       in the operator's organisation, or the ledger write failed. Best-effort — never an exception.
 * A closed union so a consumer can switch exhaustively over every resolution the runtime can report.
 */
export const CLAIM_RESOLUTIONS = ["claimed", "already_claimed", "unavailable"] as const;

/** One resolution the runtime can report for a claim attempt. */
export type ClaimResolution = (typeof CLAIM_RESOLUTIONS)[number];

// ---------------------------------------------------------------------
// The OPERATOR identity — WHO is taking the claim.
// ---------------------------------------------------------------------

/**
 * The identity of the human operator taking a claim — the stable operator id (the authenticated user's id, an opaque
 * uuid to this core) plus the operator's email (the DENORMALISED, human-readable attribution the audit records
 * alongside the id, so an operator without a tenant-membership row is still attributable). The email is nullable
 * because an id is the load-bearing identity; the email is best-effort attribution. This core validates only that the
 * id is present — it resolves no user, and it trusts the caller (the runtime, behind the HQ auth gate) to have
 * authenticated the operator.
 */
export type OperatorIdentity = {
  readonly id: string;
  readonly email: string | null;
};

// ---------------------------------------------------------------------
// The CLAIM model — the request an operator makes and the decision this core derives.
// ---------------------------------------------------------------------

/**
 * The CLAIM REQUEST — everything the pure core needs to decide whether a well-formed claim can be named: the
 * organisation the claim is scoped to (`org_id`), the recorded coordination it is filed against (`coordination_id`),
 * and the operator taking it (`operator`). The conversation and correlation ids are OPTIONAL provenance the runtime
 * threads onto the audit row for cross-reference; they are not part of the decision. The core validates SHAPE only —
 * it asserts none of these ids resolves to a real row (that is the runtime's guard).
 */
export type ClaimRequest = {
  readonly org_id: string;
  readonly coordination_id: string;
  readonly operator: OperatorIdentity;
  readonly conversation_id?: string | null;
  readonly correlation_id?: string | null;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the core named NO claim. An abstention is not an error; it is
 * the honest "this request cannot name a claim":
 *   • missing_organisation          — the request carries no organisation. A claim is ALWAYS org-scoped (isolation is
 *                                      structural), so a request without one can name no claim.
 *   • missing_coordination          — the request names no coordination. A claim is ALWAYS filed against a specific
 *                                      recorded coordination, so a request without one can name no claim.
 *   • incomplete_operator_identity  — the request carries no operator id. A claim ALWAYS records WHO took it, so a
 *                                      request without an operator id can name no claim.
 * A closed union so {@link ClaimDecision}'s abstention arm is exhaustive.
 */
export type ClaimAbstention =
  | "missing_organisation"
  | "missing_coordination"
  | "incomplete_operator_identity";

/**
 * The CLAIM-GRANTED decision — the first (and only R46) claim decision. It is the GO-AHEAD to RECORD an ownership
 * claim, carrying the recorded {@link ClaimOutcome} (`work_claimed`), the operator taking it, and the organisation +
 * coordination it is scoped to (so the decision is self-describing for the claim ledger). It is emitted ONLY for a
 * well-formed request — it can carry no partial identity, and it names no coordination that was not requested.
 */
export type ClaimGranted = {
  readonly kind: ClaimType;
  readonly outcome: ClaimOutcome;
  readonly operator: OperatorIdentity;
  readonly org_id: string;
  readonly coordination_id: string;
};

/**
 * The CLAIM DECISION — a discriminated union the runtime reads:
 *   • the GRANTED arm ({@link ClaimGranted}) — the go-ahead to record an ownership claim. Its `kind` IS its
 *     {@link ClaimType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no claim, tagged with WHY ({@link ClaimAbstention}).
 * Every field is a total, deterministic function of the request; the whole object is derived, never persisted or
 * recorded by this core.
 */
export type ClaimDecision =
  | ClaimGranted
  | { readonly kind: "none"; readonly reason: ClaimAbstention };

// ---------------------------------------------------------------------
// RESOLUTION — the single derived claim decision. Validates shape; total over the input.
// ---------------------------------------------------------------------

/** Whether a value is a present, non-blank string — the shape gate for every load-bearing id. */
function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The abstention decision for a reason — the single shape of "no claim". */
function abstain(reason: ClaimAbstention): ClaimDecision {
  return { kind: "none", reason };
}

/**
 * Resolve the CLAIM DECISION for a claim request — THE single entry point the runtime reads. Validates the SHAPE of
 * the request in a fixed order (organisation, then coordination, then operator identity), abstaining with the precise
 * reason on the first gate that fails, and otherwise naming the `claim_conversation_work` claim.
 *
 * Pure, TOTAL over any request, and DETERMINISTIC — the same request always yields the same decision. It asserts NO
 * fact about the world: it does not check that the coordination exists, that it belongs to the organisation, or that
 * the operator may claim it — those guards are the runtime's and the database's, because only they can see the
 * coordinations ledger. This core proves the request is WELL-FORMED and names the claim; it persists nothing and
 * records nothing. THE single source of truth for what a well-formed claim looks like — every consumer resolves it
 * through this function and no other way; no feature implements independent claim-shaping logic.
 */
export function resolveClaim(request: ClaimRequest): ClaimDecision {
  // ORGANISATION FIRST — a claim is always org-scoped, so a request without an organisation can name no claim. This
  // is the shape gate behind organisation isolation: the core demands an org on every request; the runtime scopes the
  // write by it.
  if (!isNonEmpty(request.org_id)) return abstain("missing_organisation");

  // A claim is always filed against a specific recorded coordination — a request that names none can name no claim.
  if (!isNonEmpty(request.coordination_id)) return abstain("missing_coordination");

  // A claim always records WHO took it — a request without an operator id can name no claim. The email is best-effort
  // attribution and is not gated here; the id is the load-bearing identity.
  if (!isNonEmpty(request.operator?.id)) return abstain("incomplete_operator_identity");

  // The request is well-formed — name the claim. Self-describing (it carries the operator, org and coordination) so
  // the claim ledger row can never drift from the decision it records.
  return {
    kind: "claim_conversation_work",
    outcome: "work_claimed",
    operator: request.operator,
    org_id: request.org_id,
    coordination_id: request.coordination_id,
  };
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is GRANTED (a go-ahead to record a concrete claim), as opposed to an abstention. A type guard:
 * it narrows a {@link ClaimDecision} to its granted arm, so the runtime records ONLY a real decision and an abstention
 * is a total no-op. THE predicate the runtime gates the write on — there is no other "should we record a claim?" rule.
 */
export function isClaimDecided(decision: ClaimDecision): decision is ClaimGranted {
  return decision.kind !== "none";
}

/**
 * The {@link ClaimType} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and total —
 * the granted arm's `kind` IS its claim type, so the mapping is the identity on the granted arm and `null` on the
 * abstention.
 */
export function claimTypeOf(decision: ClaimDecision): ClaimType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link ClaimOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and total —
 * the recorded result the runtime folds onto the ledger row alongside the claim type.
 */
export function claimOutcomeOf(decision: ClaimDecision): ClaimOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}
