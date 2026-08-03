import "server-only";

/**
 * CrewFlow HQ — the AI-assisted saga decomposition seam, GOVERNED and DARK.
 *
 * When a directive cannot be matched to a deterministic template — a genuinely
 * novel cross-department plan — this is where an AI-assisted decomposition WOULD
 * propose the step graph. It is dark today and returns `null`, so the caller falls
 * back to the DETERMINISTIC template decomposition (lib/hq/workflow/decompose.ts),
 * which is the substrate and is always available. No saga is ever left unplanned.
 *
 * THE GATE IS ACTIVATION, NOT A KEY — the governance-closure idiom
 * (server/services/receptionist.ts `extractFields`, lib/telephony/ai-turn.ts). This
 * is deliberately NOT a credential check: a vendor key with no bound cost tier must
 * change nothing. So:
 *
 *   1. gate on the EXISTING generative tier activation (`isInferenceTierActivated`).
 *      Dark ⇒ return null before any work, and the deterministic path runs.
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
import { invokeWithGovernor } from "@/lib/ai/governor";
import { isInferenceTierActivated } from "@/lib/ai/governor/readiness";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
import { validateStepGraph, type SagaStep, type StepStatus } from "./model";
import type { SagaPlan } from "./decompose";

export type AiDecomposeInput = {
  /** The free-form directive to decompose. */
  directive: string;
};

/**
 * Propose a saga plan for a directive with AI assistance, or `null` when the seam
 * is dark, blocked, deduplicated, the provider failed, or the model's proposal did
 * not validate. Never throws — the caller must always be able to fall back to the
 * deterministic template decomposition.
 */
export async function maybeDecomposeWithAi(input: AiDecomposeInput): Promise<SagaPlan | null> {
  // 1. DARK SHORT-CIRCUIT — the generative modality must be armed. A key alone
  //    does not satisfy this; nothing below runs until a tier is bound.
  if (!isInferenceTierActivated()) return null;
  const directive = input.directive.trim();
  if (!directive) return null;

  // HQ has no tenant — attribute the spend to CrewFlow's own org, fail-closed.
  const orgId = hqBudgetOrgId();
  if (!orgId) return null;

  // 2. The model is reachable ONLY through the shared door, which refuses without
  //    a bound tier. Null ⇒ dark ⇒ deterministic fallback.
  const provider = getTextProvider();
  if (!provider) return null;

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
    if (outcome.status !== "ran") return null; // blocked / duplicate → deterministic fallback
    return parseAndValidate(outcome.value);
  } catch (e) {
    console.error("[hq-workflow] AI decomposition failed", e);
  }
  // blocked / duplicate / provider error / parse failure → deterministic fallback.
  return null;
}

/**
 * Parse the model's JSON and re-validate it against the PURE model. Any deviation —
 * malformed JSON, missing fields, a cyclic or dangling-dependency graph — yields
 * null, so a model proposal can never introduce an invalid saga. PURE apart from
 * the exception boundary.
 */
function parseAndValidate(raw: string): SagaPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title || !Array.isArray(obj.steps)) return null;

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
  if (!validation.ok) return null;

  // An AI-decomposed saga carries no deterministic template key.
  return { title, templateKey: "", status: "planned", steps };
}
