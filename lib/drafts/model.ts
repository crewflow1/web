/**
 * CrewFlow HQ — Draft Generation: the shared vocabulary (CEO Directive 010, Phase 3).
 *
 * The deterministic, auditable draft-generation engine every AI employee inherits
 * (see docs/bible/decisions/0002-draft-generation.md). This module is the pure
 * data contract — NO `server-only`, NO I/O — so the prompt assembler, the service,
 * and the tests share one vocabulary without dragging a vendor SDK or a DB client
 * into their bundle. It mirrors `lib/approvals/state.ts`'s role for Phase 2: the
 * pure core the rest of the engine is built around.
 *
 * A draft is generated, never sent. The engine produces an approval-READY artifact
 * (a subject + body a human reviews and the Approval Engine gates); it performs no
 * delivery, automation, scheduling, or follow-up. That boundary is architectural,
 * not conventional — the system prompt forbids sending, the seed grants no `send`
 * scope, and this module imports no mailer or transport.
 */

// ---------------------------------------------------------------------
// Kinds. The kind selects the prompt template and the deterministic fallback.
// V1 ships the Outreach cold email; the union is the seam every future kind
// (follow-up, reply, summary, proposal, …) slots into — one engine, many kinds.
// ---------------------------------------------------------------------

export const DRAFT_KINDS = ["cold_email"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** Provenance of a finished draft — which leg produced it. Mirrors `ResearchProvenance`. */
export const DRAFT_PROVENANCES = ["anthropic", "openai", "deterministic"] as const;
export type DraftProvenance = (typeof DRAFT_PROVENANCES)[number];

/**
 * The run outcome recorded on the row and mapped to a spine verb by the trigger.
 *   generated — an LLM produced it (ai.run_completed, success)
 *   fallback  — the deterministic path produced it (ai.run_completed, info)
 * Both are completed runs that yielded a draft; provenance distinguishes them.
 */
export const DRAFT_STATUSES = ["generated", "fallback"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

// ---------------------------------------------------------------------
// Context. The normalised, source-agnostic inputs a draft is built from. Each
// source is INDEPENDENTLY OPTIONAL: a missing source degrades the draft, never
// fails it (graceful degradation, §Directive). The service's context adapter
// fills these from the three existing read APIs (Shared Memory recall, Research
// report, Qualification verdict); the pure assembler never knows where they came
// from, so the engine is generic across employees.
// ---------------------------------------------------------------------

/** Who/what the draft is about. */
export type DraftSubject = {
  /** The company/person name, or null when unknown (the assembler writes around it). */
  name: string | null;
  /** The subject_type label (e.g. "outreach_email"), informational for the prompt. */
  label: string;
};

/** Assembled Shared Memory — already ranked, budgeted, and prompt-ready (recall's `context.text`). */
export type DraftMemoryContext = {
  text: string;
  count: number;
};

/** The slice of Research AI output a draft incorporates. All fields nullable/empty-safe. */
export type DraftResearchContext = {
  summary: string | null;
  sector: string | null;
  painPoints: string[];
  buyingSignals: string[];
  score: number | null;
  recommendedModules: string[];
};

/** The slice of the (deterministic) Qualification verdict a draft incorporates. */
export type DraftQualificationContext = {
  tier: string | null;
  score: number | null;
  decision: string | null;
  rationale: string[];
};

export type DraftContext = {
  subject: DraftSubject;
  memory: DraftMemoryContext | null;
  research: DraftResearchContext | null;
  qualification: DraftQualificationContext | null;
};

// ---------------------------------------------------------------------
// Content. What a finished draft IS: a subject line + body, plus the channel.
// Deliberately minimal and channel-shaped so it maps 1:1 onto the Approval
// Engine's `proposedPayload` ({ subject, body }) when Phase 4 wires generation →
// approval. Nothing here is ever transmitted.
// ---------------------------------------------------------------------

export type DraftContent = {
  /** The email subject line (or channel-equivalent headline). */
  subject: string;
  /** The draft body. */
  body: string;
  /** The channel this draft targets. V1: "email". */
  channel: "email";
};
