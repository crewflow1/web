import "server-only";

/**
 * CrewFlow HQ — the AI-assisted saga decomposition seam, GOVERNED.
 *
 * When a directive cannot be matched to a deterministic template — a genuinely
 * novel cross-department plan — this is where an AI-assisted decomposition
 * proposes the step graph. LIVE since 2026-09-10 (P15): the operator opts in by
 * choosing AI_ASSISTED_TEMPLATE_KEY in the saga picker, and createSaga
 * (server/services/hq-workflow.ts) consults this seam ONLY behind that sentinel.
 * A `null` here fails the create with an honest `ai_decomposition_unavailable`
 * error — the deterministic templates (lib/hq/workflow/decompose.ts) remain the
 * substrate for every non-sentinel key, and a template is NEVER silently
 * substituted for a plan the operator asked the AI to draft.
 *
 * THE GATE IS ACTIVATION, NOT A KEY — the governance-closure idiom
 * (server/services/receptionist.ts `extractFields`, lib/telephony/ai-turn.ts). This
 * is deliberately NOT a credential check: a vendor key with no bound cost tier must
 * change nothing. So:
 *
 *   1. gate on this class's OWN tier activation (`isTierActivated("high")`).
 *      Dark ⇒ return null before any work, and the caller surfaces the error.
 *   2. reach the model ONLY through the shared text door (`getTextProvider`), which
 *      itself refuses without a bound tier — this file constructs no SDK and reads
 *      no vendor credential, so the closure ratchet's pinned counts are untouched.
 *   3. wrap the provider leg in `invokeWithGovernor` under the registered
 *      `hq.saga_decomposition` feature (`complex`), so the £100/org ceiling, the
 *      recent-duplicate refusal and the invocation ledger are already in the path
 *      on activation day. A `blocked`/`duplicate` outcome degrades to null.
 *
 * NO NEW GOVERNOR TIER: `hq.saga_decomposition` is a FEATURE key mapping to the
 * existing `complex` task class → `high` tier. It registers no tier that maps to no
 * model (which the governance-closure ratchet forbids).
 *
 * EVERY MODEL PROPOSAL IS RE-VALIDATED against the pure model before it is trusted —
 * an untrusted graph (cycles, dangling dependencies, bad ordinals) is refused and
 * degrades to null, so the model can never introduce a malformed saga.
 */

import { getTextProvider } from "@/lib/ai/text";
import { invokeWithGovernor, isTierActivated } from "@/lib/ai/governor";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
import { validateStepGraph, type SagaStep, type StepStatus } from "./model";
import type { SagaPlan } from "./decompose";

export type AiDecomposeInput = {
  /** The free-form directive to decompose. */
  directive: string;
};

/**
 * WHY a discriminated failure reason (2026-09-10 production incident): the first
 * live attempt failed with every stage collapsed into one `null`, and the ledger
 * could not distinguish "dark model" from "budget refused" from "bad proposal" —
 * the operator saw one blended error and the on-call had nothing to trace. Each
 * refusal now names its stage. The reasons are OPERATOR-SAFE: no provider error
 * bodies, no prompt text, no secrets — stage names only (details go to the
 * server log).
 */
export const AI_DECOMPOSE_FAILURE_REASONS = [
  /** The high tier is not activated in this build/deploy (binding or credential). */
  "model_dark",
  /** CREWFLOW_INTERNAL_ORG_ID is unset/empty — HQ spend cannot be attributed. */
  "attribution_missing",
  /** The governor refused the claim: ceiling, employee limit, or the reservation
   *  store refused (outage — or the configured internal budget org does not
   *  exist, which the reserve RPC's FK turns into the same refusal). */
  "budget_refused",
  /** An identical directive is in flight or recently succeeded (dedupe window). */
  "duplicate_suppressed",
  /** The provider call itself threw (network, 4xx/5xx, timeout). */
  "provider_failure",
  /** The provider answered with no usable text. */
  "provider_invalid_response",
  /** The text was not parseable JSON (after fence-stripping). */
  "parse_failure",
  /** Parsed, but the proposal failed the pure model's graph validation. */
  "plan_validation_failure",
] as const;
export type AiDecomposeFailureReason = (typeof AI_DECOMPOSE_FAILURE_REASONS)[number];

export type AiDecomposeOutcome =
  | { plan: SagaPlan; reason: null }
  | { plan: null; reason: AiDecomposeFailureReason };

function refuse(reason: AiDecomposeFailureReason, detail?: string): AiDecomposeOutcome {
  // Server-side breadcrumb for the on-call; the operator sees only the reason
  // via the caller's error mapping. Never log the directive or provider bodies.
  console.error(`[hq.saga_decomposition] refused: ${reason}${detail ? ` (${detail})` : ""}`);
  return { plan: null, reason };
}

/**
 * Propose a saga plan for a directive with AI assistance. On failure, `plan` is
 * null and `reason` names the exact stage that refused — the caller surfaces it
 * as a distinct, honest operator error. Never throws.
 */
export async function maybeDecomposeWithAi(input: AiDecomposeInput): Promise<AiDecomposeOutcome> {
  // 1. DARK SHORT-CIRCUIT — THIS call's OWN tier must be armed, not merely
  //    "some generative tier". The global any-tier gate (isInferenceTierActivated)
  //    was the partial-binding hole: with only `cheap`/`mid` bound + a vendor key
  //    it answers true, `getTextProvider("high")` hands back a live provider, and the
  //    governor's per-tier dark short-circuit runs this `complex`/`high` call
  //    ungoverned. Gate on the high tier — the class this call declares — so a
  //    dark high tier falls back to the template decomposition before any provider.
  if (!isTierActivated("high")) return refuse("model_dark");
  const directive = input.directive.trim();
  if (!directive) return refuse("plan_validation_failure", "empty directive");

  // HQ has no tenant — attribute the spend to CrewFlow's own org, fail-closed.
  const orgId = hqBudgetOrgId();
  if (!orgId) return refuse("attribution_missing");

  // 2. The model is reachable ONLY through the shared door, which refuses without
  //    a bound tier. Null ⇒ dark.
  const provider = getTextProvider("high");
  if (!provider) return refuse("model_dark", "text door returned no provider");

  try {
    // 3. GOVERNED. The registry classes this as `complex`; the governor owns the
    //    ceiling, the ledger and the duplicate refusal.
    const outcome = await invokeWithGovernor(
      "hq.saga_decomposition",
      "complex",
      async () => {
        const res = await provider.generate(directive, {
          system: [
            "You are CrewFlow's HQ workflow planner.",
            "Decompose the directive into an ordered, cross-department step graph.",
            "Return ONE JSON object only:",
            '{ "title": "...", "steps": [ { "title": "...", "department": "...", "role": "...", "dependsOnOrdinal": number|null } ] }',
            "Rules:",
            "- steps are 1-based and listed in order; dependsOnOrdinal (if set) MUST reference an EARLIER step",
            "- every step names the department and role that owns it",
            "- do not invent work the directive does not imply",
          ].join("\n"),
          maxTokens: 1500,
        });
        return {
          value: res.text,
          usage: {
            provider: provider.info.provider,
            model: res.model,
            inputTokens: res.inputTokens,
            outputTokens: res.outputTokens,
          },
        };
      },
      { orgId, userId: null, dedupeContent: directive },
    );
    if (outcome.status === "blocked") {
      // `reason` distinguishes ceiling/employee-limit from a reservation-store
      // refusal (outage, or an internal budget org the reserve RPC's FK does
      // not recognise) — operationally very different, so name it in the log.
      return refuse("budget_refused", outcome.reason);
    }
    if (outcome.status === "duplicate") return refuse("duplicate_suppressed", outcome.reason);
    if (!outcome.value.trim()) return refuse("provider_invalid_response", "empty text");
    return parseAndValidate(outcome.value);
  } catch (e) {
    // The provider leg threw (the governor settles the claim as a failure
    // before rethrowing, so nothing is stranded). Log the message, never the
    // prompt or a response body.
    return refuse("provider_failure", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Extract the first JSON object from model text — the house pattern
 * (server/services/receptionist.ts): strip markdown code fences, then parse;
 * on failure, brace-match the first object. Models WILL fence JSON even when
 * told not to; refusing fenced-but-valid JSON is a parse defect, not a safety
 * property (the graph validation below is the safety property).
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Parse the model's JSON and re-validate it against the PURE model. Any deviation —
 * malformed JSON, missing fields, a cyclic or dangling-dependency graph — refuses
 * with the stage that failed, so a model proposal can never introduce an invalid
 * saga. PURE apart from the exception boundary.
 */
function parseAndValidate(raw: string): AiDecomposeOutcome {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return refuse("parse_failure");
  if (typeof parsed !== "object") return refuse("parse_failure", "non-object JSON");
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title || !Array.isArray(obj.steps)) {
    return refuse("plan_validation_failure", "missing title or steps");
  }

  const bornPending: StepStatus = "pending";
  const steps: SagaStep[] = [];
  obj.steps.forEach((rawStep, i) => {
    if (typeof rawStep !== "object" || rawStep === null) return;
    const s = rawStep as Record<string, unknown>;
    const stepTitle = typeof s.title === "string" ? s.title.trim() : "";
    if (!stepTitle) return;
    const dep =
      typeof s.dependsOnOrdinal === "number" && Number.isInteger(s.dependsOnOrdinal)
        ? s.dependsOnOrdinal
        : null;
    steps.push({
      ordinal: i + 1,
      title: stepTitle,
      department: typeof s.department === "string" ? s.department : null,
      role: typeof s.role === "string" ? s.role : null,
      dependsOnOrdinal: dep,
      status: bornPending,
    });
  });

  const validation = validateStepGraph(steps);
  if (!validation.ok) return refuse("plan_validation_failure", validation.errors.join("; "));

  // An AI-decomposed saga carries no deterministic template key.
  return { plan: { title, templateKey: "", status: "planned", steps }, reason: null };
}
