import type { ResolvedCapabilitySet } from "./tasks";

/**
 * CrewFlow HQ — the doorman: the PURE permission gate
 * (CEO Directive #014 / D-04, Phase B; ADR 0008 Decisions 4 & 8; Bible Volume XIII §8;
 * substrate README §P4).
 *
 * The single enforcement predicate every PROPOSED AI action passes — the point the substrate
 * names "the most important" in the SDK (Volume XIII §8). It composes the doorman's three
 * layers — (1) employee posture, (2) capability scope, (3) the P4 autonomy test — into ONE
 * explainable verdict, and it is a PURE FUNCTION: same inputs → same verdict; no I/O, no
 * clock, no client, and it imports NO facet (not `events`, not `comms`, not `memory`, not the
 * Approval Engine). It is the {@link import("./output")} discipline applied to enforcement —
 * deliberately NO `server-only`, so the timeline / Boardroom UI may import the verdict types
 * exactly as it imports the output envelope. Because it is pure, the most security-critical
 * code in the SDK is also the most testable: deny-by-default is a matter of SOURCE, not
 * discipline (every branch is provable by a table of inputs, with no mocks and no transport).
 *
 * POLICY, never MECHANISM (the Policy vs Mechanism rule — Kernel Contract Map §2, set on the
 * #014 Phase B review). The gate answers only "what is permitted under the current policy?"
 * and returns a DECLARATIVE {@link GateVerdict} (`{ decision, reasons }`). It does NOT request
 * an approval, emit an event, or send a communication; the RUNTIME (the runner, Phase B B2)
 * consumes the verdict and determines the appropriate mechanism — an audit emit for an
 * autonomous decision, `requestApproval` for one that needs human approval. The gate never
 * knows how any of those happen.
 *
 * SOURCE-INDIFFERENT INPUTS (#013 threads · #014 enforces · #015 sources). The gate reads a
 * capability set and a posture it is GIVEN; it never decides where they come from. The
 * Capability Registry (#015) becomes another information source — it repoints WHERE the
 * inputs originate, leaving the gate's interface and responsibilities unchanged (CEO #014
 * Phase B review, future-compatibility: "its inputs may evolve; its responsibilities should
 * not").
 */

/**
 * The acting employee's coarse stance — the Built, default-locked floor (`can_execute=false`,
 * `requires_approval=true`). The runtime resolves it from the Capability Registry (#015 / D-05,
 * via {@link import("./registry-parity").resolveServedAuthority}, with the default-deny floor as
 * the automatic fail-safe) and HANDS it to the gate. Scope tokens fold into the resolved
 * capability set, so posture carries only the two booleans layer 1 reads.
 */
export interface EmploymentPosture {
  /** The registry-served execute stance — `false` by the Built default (the floor). */
  canExecute: boolean;
  /** The registry-served approval stance — `true` by the Built default. */
  requiresApproval: boolean;
}

/**
 * A description of intent an employee PROPOSES — never an execution (the Phase A `AiAction`
 * from `output.ts`, carried into Phase B with the fields P4 reads). Every proposed action is
 * a CANDIDATE side effect (substrate README §10); the gate classifies it, and nothing here
 * runs it.
 */
export interface ProposedAction {
  /** A capability-style verb naming what is proposed (becomes the approval `action`). */
  type: string;
  /** The capability token layer 2 / P4 atom 4 matches against the resolved set. */
  capability?: string;
  /** The subject's type — for the typed-target atom and the approval hand-off. */
  subjectType: string;
  /** The subject's id — a concrete, single subject keeps the blast radius bounded (atom 2). */
  subjectId: string;
  /** Atom 1: writes only HQ-internal, append-or-correctable state (Phase C: a tool property). */
  reversible: boolean;
  /** Atom 3: acts on a typed, validated target, not an open-ended one. */
  typedTarget: boolean;
  /** Atom 5: the action's estimated cost in micros, weighed against the run's budget. */
  estimatedCostMicros?: number;
  /** Structured parameters carried into the approval request — never executed by the gate. */
  payload?: Record<string, unknown>;
}

/**
 * Why the gate reached its decision — one tag per layer/atom that forced a non-autonomous
 * outcome. This is what makes deny-by-default AUDITABLE: a needs-approval verdict records its
 * reasons, and the runtime's audit event records the basis on which autonomy was permitted.
 * The taxonomy is part of the gate's STABLE interface; #015 enriches the inputs that make a
 * reason fire, it does not change the set.
 */
export type GateReason =
  // Layer 1 — employee posture (the default-locked stance; either forces approval on its own).
  | "posture.can_execute"
  | "posture.requires_approval"
  // Layer 2 — capability scope (the employee does not hold the action's capability token).
  | "scope.missing_capability"
  // Layer 3 — the five P4 autonomy atoms (substrate README §P4, :241-255).
  | "p4.irreversible"
  | "p4.blast_radius"
  | "p4.untyped_target"
  | "p4.out_of_scope"
  | "p4.over_budget";

/**
 * The doorman's verdict — DECLARATIVE policy, never a mechanism instruction (the Policy vs
 * Mechanism rule). `decision` is the policy outcome; `reasons` explains it. The runtime maps
 * the verdict to a mechanism; the gate performs none.
 */
export interface GateVerdict {
  /** `autonomous` iff every layer and atom passed; otherwise `needs_approval`. */
  decision: "autonomous" | "needs_approval";
  /** The layers/atoms that forced the outcome — empty iff `autonomous`. */
  reasons: GateReason[];
}

/**
 * Bounded blast radius (P4 atom 2): the action names a concrete, single subject — a known set
 * of size one — rather than an empty or wildcard (`*`) subject that would fan out to an
 * open-ended set. Absent the typed tool registry (Phase C), the descriptor's subject id is the
 * gate's bound; an unbounded subject biases to approval (deny-by-default).
 */
function isBoundedSubject(action: ProposedAction): boolean {
  const id = action.subjectId.trim();
  return id.length > 0 && id !== "*";
}

/**
 * Evaluate ONE proposed action against the current policy and return the doorman's verdict.
 * PURE and TOTAL: it returns a verdict for any input — deny-by-default falls out, since a
 * malformed or unbounded action simply accrues reasons and routes to approval — and it
 * triggers no side effect and mutates no input.
 *
 * An action is `autonomous` iff ALL hold: the posture permits autonomy (layer 1), the employee
 * holds the action's capability (layer 2), and every P4 atom passes (layer 3) — reversible ∧
 * bounded ∧ type-bounded ∧ in-scope ∧ in-budget (substrate README §P4). Each failing check
 * adds a {@link GateReason} and makes the decision `needs_approval`. The verdict is `autonomous`
 * exactly when `reasons` is empty.
 *
 * Posture failure is decisive on its own: `can_execute=false` (the Built floor) or
 * `requires_approval=true` routes to approval REGARDLESS of the atoms (Volume XIII §16). P4 only
 * GRANTS autonomy to an action the posture already permits — it never overrides the floor. The
 * gate collects ALL applicable reasons (it does not stop at the first) so the verdict is a
 * complete, declarative explanation rather than an order-dependent one.
 */
export function evaluateAction(
  action: ProposedAction,
  posture: EmploymentPosture,
  capabilities: ResolvedCapabilitySet,
  budget: number,
): GateVerdict {
  const reasons: GateReason[] = [];

  // ── Layer 1 — employee posture. A proposed action is a candidate side effect, so the
  //    coarse stance gates every one: the Built floor (can_execute=false) and an explicit
  //    requires_approval each force approval on their own, regardless of the P4 atoms below.
  if (!posture.canExecute) reasons.push("posture.can_execute");
  if (posture.requiresApproval) reasons.push("posture.requires_approval");

  // ── Layer 2 — capability scope. If the action names a capability the employee's resolved
  //    set does not hold, it is out of scope. (#015 will source per-capability PARAMETER
  //    scope; Phase B checks token possession only — see `p4.out_of_scope` below.)
  if (action.capability && !capabilities.tokens.includes(action.capability)) {
    reasons.push("scope.missing_capability");
  }

  // ── Layer 3 — the five P4 autonomy atoms (substrate README §P4, :241-255).
  if (!action.reversible) reasons.push("p4.irreversible"); // atom 1: reversible
  if (!isBoundedSubject(action)) reasons.push("p4.blast_radius"); // atom 2: low blast radius
  if (!action.typedTarget) reasons.push("p4.untyped_target"); // atom 3: type-bounded target
  // atom 4 (within capability scope): token possession is layer 2 above. The parameter-level
  // scope check (`p4.out_of_scope`) is sourced by the Capability Registry (#015) — it is part
  // of the stable reason taxonomy now, emitted once #015 enriches the inputs (the interface
  // stays stable; its inputs evolve — CEO #014 Phase B review).
  if ((action.estimatedCostMicros ?? 0) > budget) reasons.push("p4.over_budget"); // atom 5: in-budget

  return {
    decision: reasons.length === 0 ? "autonomous" : "needs_approval",
    reasons,
  };
}
