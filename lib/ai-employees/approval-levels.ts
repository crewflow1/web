/**
 * CrewFlow HQ — the explicit 1 to 5 AI approval-level ladder (pure derivation).
 *
 * The AI Employee spec mandates a GRADED approval ladder — Level 1 Observe, 2 Recommend,
 * 3 Draft, 4 Execute-with-approval, 5 Autonomous. The runtime already HAS every posture
 * this ladder names; what it lacked was a first-class, named representation of it. Today an
 * employee's autonomy is carried as two booleans on the served posture
 * (`can_execute` / `requires_approval` — see {@link import("@/server/sdk/gate").EmploymentPosture})
 * plus the capability-registry token grant. The gate (server/sdk/gate.ts) reads those and
 * returns a `needs_approval` / `autonomous` verdict; the platform mechanisms that realise each
 * rung already exist — executor-shadow (observe), the approval engine (draft → approve), and
 * gate verdicts + autonomous-apply (execute / autonomous).
 *
 * This module DERIVES the named level from that existing state. It grants NO new authority and
 * reads NO new state: it is a total, deterministic CLASSIFICATION of a posture the registry
 * already serves. Same inputs → same level, always.
 *
 * Pure + server/client-safe — NO Supabase / server-only imports, exactly like
 * `lib/ai-employees/model.ts` and `lib/hq/boardroom-cards.ts`. The service layer, the boardroom
 * pages, and the unit tests all share this one vocabulary. The Tailwind class strings that paint
 * a level live in `app/admin/ai-boardroom/_styles.ts` (so the JIT scanner picks them up); this
 * module stays free of presentation classes so it remains a portable data layer.
 *
 * FRAMEWORK ONLY. Deriving a level changes nothing: every production employee sits at the
 * default-deny floor (can_execute=false), and the execution lock is unchanged. The ladder only
 * makes the CURRENT posture legible.
 */

// ---------------------------------------------------------------------
// The five levels
// ---------------------------------------------------------------------

/** The explicit approval level, 1 (least autonomy) → 5 (most). */
export type ApprovalLevel = 1 | 2 | 3 | 4 | 5;

/** The stable machine key for each level (safe for URLs, style maps, and tests). */
export type ApprovalLevelKey =
  | "observe"
  | "recommend"
  | "draft"
  | "execute_with_approval"
  | "autonomous";

/** The static, human-readable definition of one rung on the ladder. */
export interface ApprovalLevelDefinition {
  /** The numeric level, 1 to 5. */
  readonly level: ApprovalLevel;
  /** The stable machine key. */
  readonly key: ApprovalLevelKey;
  /** The short display label, e.g. "Draft". */
  readonly label: string;
  /** A one-line description of what an employee at this level does. */
  readonly summary: string;
  /** The existing platform mechanism that realises this rung (no new machinery). */
  readonly mechanism: string;
}

/**
 * The ladder, in ascending order. This is the single source of the level vocabulary — the badge,
 * the legend, and the detail panel all read it.
 */
export const AI_APPROVAL_LEVELS: readonly ApprovalLevelDefinition[] = Object.freeze([
  Object.freeze({
    level: 1,
    key: "observe",
    label: "Observe",
    summary: "Watches and reports; produces no output that changes state.",
    mechanism: "Executor shadow — records what an action would do, never applies it.",
  }),
  Object.freeze({
    level: 2,
    key: "recommend",
    label: "Recommend",
    summary: "Surfaces recommendations from what it can read; frames no draft action.",
    mechanism: "Read-only capability scope — advice only, no proposed action.",
  }),
  Object.freeze({
    level: 3,
    key: "draft",
    label: "Draft",
    summary: "Prepares draft actions for a human to approve; cannot execute.",
    mechanism: "Approval engine — draft → human approval.",
  }),
  Object.freeze({
    level: 4,
    key: "execute_with_approval",
    label: "Execute with approval",
    summary: "May execute, but every action is held for human approval first.",
    mechanism: "Gate verdict needs_approval → apply-on-approval.",
  }),
  Object.freeze({
    level: 5,
    key: "autonomous",
    label: "Autonomous",
    summary: "Executes cleared actions without human approval.",
    mechanism: "Gate autonomous verdict → autonomous-apply.",
  }),
]) as readonly ApprovalLevelDefinition[];

const DEFINITION_BY_KEY: Readonly<Record<ApprovalLevelKey, ApprovalLevelDefinition>> =
  Object.freeze(
    Object.fromEntries(AI_APPROVAL_LEVELS.map((d) => [d.key, d])) as Record<
      ApprovalLevelKey,
      ApprovalLevelDefinition
    >,
  );

const DEFINITION_BY_LEVEL: Readonly<Record<ApprovalLevel, ApprovalLevelDefinition>> =
  Object.freeze(
    Object.fromEntries(AI_APPROVAL_LEVELS.map((d) => [d.level, d])) as Record<
      ApprovalLevel,
      ApprovalLevelDefinition
    >,
  );

/** The static definition for a level number (1 to 5). */
export function approvalLevelDefinition(level: ApprovalLevel): ApprovalLevelDefinition {
  return DEFINITION_BY_LEVEL[level];
}

// ---------------------------------------------------------------------
// Token classification — what KIND of capability a grant token is
// ---------------------------------------------------------------------

/**
 * Scope tokens that grant only READ / CONTEXT access — they let an employee SEE state but frame
 * no action. Sourced from the capability catalogue's own descriptions: `read` ("Read context the
 * employee is permitted to see.") and `memory` ("Access the employee's own memory scope.").
 * Holding only these (and unable to execute) is the Recommend rung.
 */
export const READ_SCOPE_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set(["read", "memory"]),
);

/**
 * Scope tokens that grant DRAFTING authority — preparing an artifact for human review, never a
 * final act. The catalogue defines `draft` as exactly that ("Prepare a draft artifact for human
 * review (never a final act)."). Holding this (and unable to execute) is the Draft rung.
 */
export const DRAFT_SCOPE_TOKENS: ReadonlySet<string> = Object.freeze(new Set(["draft"]));

/**
 * Classify a single capability token into one of three coarse classes.
 *
 *   • `read`  — a known read-only / context scope (surfaces information only).
 *   • `draft` — a known drafting scope (prepares an artifact for approval).
 *   • `action` — everything ELSE: a tool-permission or an unknown token. Treated as actionable so
 *     an unrecognised grant biases the classification UP (holds more capability), never down —
 *     the honest, non-understating default for a descriptive posture read.
 */
export function classifyToken(token: string): "read" | "draft" | "action" {
  const t = token.trim().toLowerCase();
  if (DRAFT_SCOPE_TOKENS.has(t)) return "draft";
  if (READ_SCOPE_TOKENS.has(t)) return "read";
  return "action";
}

// ---------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------

/**
 * The existing posture an approval level is derived FROM — exactly the state the Capability
 * Registry already serves (see {@link import("@/server/sdk/registry-parity").resolveServedAuthority}):
 * the two coarse autonomy booleans and the served capability token set. `source` records whether
 * the registry served the authority or the default-deny floor did (the fail-safe) — it is
 * informational evidence, never itself a level input.
 */
export interface ApprovalPostureInput {
  /** The served execute stance — `false` by the Built default (the floor). */
  readonly canExecute: boolean;
  /** The served approval stance — `true` by the Built default. */
  readonly requiresApproval: boolean;
  /** The served capability tokens the employee holds. */
  readonly tokens: readonly string[];
  /** Which side served the authority — the registry, or the default-deny floor (fail-safe). */
  readonly source?: "registry" | "floor";
}

/** The derived level for an employee — a static definition plus the evidence that produced it. */
export interface ApprovalLevelResult extends ApprovalLevelDefinition {
  /** The ordered, deterministic facts that classified this posture — the audit for the badge. */
  readonly evidence: readonly string[];
}

/**
 * Derive the explicit 1 to 5 approval level from an employee's served posture. TOTAL and
 * DETERMINISTIC: every combination of (`canExecute`, `requiresApproval`, tokens) maps to exactly
 * one level, with no I/O and no clock.
 *
 * The classification, in precedence order:
 *
 *   1. `canExecute && !requiresApproval` → **5 Autonomous.** Posture permits autonomy outright;
 *      the gate can reach an `autonomous` verdict and autonomous-apply may apply without a human.
 *   2. `canExecute` (with `requiresApproval`) → **4 Execute with approval.** It may execute, but
 *      every proposed action routes through human approval first.
 *   3. `!canExecute` AND holds drafting-or-actionable capability → **3 Draft.** It cannot execute,
 *      so a held action capability can only be prepared as a draft for approval.
 *   4. `!canExecute` AND holds only read/context capability → **2 Recommend.** It can surface
 *      recommendations from what it reads, but frames no draft action.
 *   5. `!canExecute` AND holds no capability → **1 Observe.** It can only observe (executor shadow).
 *
 * Execution stance (`canExecute`) DOMINATES the token classes — it is the gate's decisive layer 1
 * (Volume XIII §16), so an employee that can execute is at an execute rung (4/5) regardless of
 * which tokens it holds; tokens gate WHICH actions, not the autonomy tier. Below the execute line,
 * the token classes separate Draft / Recommend / Observe.
 */
export function deriveApprovalLevel(input: ApprovalPostureInput): ApprovalLevelResult {
  const { canExecute, requiresApproval } = input;
  // Normalise the token set once: trimmed, lowercased, de-duplicated, sorted — so the evidence
  // is stable and classification never depends on incidental ordering or casing.
  const tokens = Array.from(
    new Set(input.tokens.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
  ).sort();

  const draftTokens = tokens.filter((t) => classifyToken(t) === "draft");
  const actionTokens = tokens.filter((t) => classifyToken(t) === "action");
  const readTokens = tokens.filter((t) => classifyToken(t) === "read");
  const hasDraftAuthority = draftTokens.length > 0 || actionTokens.length > 0;

  const evidence: string[] = [
    `Posture: can_execute=${canExecute}, requires_approval=${requiresApproval}`,
    tokens.length > 0
      ? `Capability tokens: ${tokens.join(", ")}`
      : "Capability tokens: none",
  ];
  if (input.source === "floor") {
    evidence.push(
      "Authority served from the default-deny floor (registry silent or unavailable).",
    );
  }

  let key: ApprovalLevelKey;
  if (canExecute && !requiresApproval) {
    key = "autonomous";
    evidence.push(
      "Executes without human approval — the gate can return an autonomous verdict.",
    );
  } else if (canExecute) {
    key = "execute_with_approval";
    evidence.push(
      "Can execute, but requires approval — every action is held for a human first.",
    );
  } else if (hasDraftAuthority) {
    key = "draft";
    if (actionTokens.length > 0) {
      evidence.push(`Holds actionable capability: ${actionTokens.join(", ")}.`);
    }
    if (draftTokens.length > 0) {
      evidence.push(`Holds drafting capability: ${draftTokens.join(", ")}.`);
    }
    evidence.push("Cannot execute — prepares drafts for human approval.");
  } else if (readTokens.length > 0) {
    key = "recommend";
    evidence.push(`Holds read/context capability only: ${readTokens.join(", ")}.`);
    evidence.push("Cannot execute or draft — surfaces recommendations from what it reads.");
  } else {
    key = "observe";
    evidence.push("Holds no capability tokens — observes only (executor shadow).");
  }

  return Object.freeze({
    ...DEFINITION_BY_KEY[key],
    evidence: Object.freeze(evidence) as readonly string[],
  });
}
