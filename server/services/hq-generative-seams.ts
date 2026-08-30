import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTextProvider, type TextResult } from "@/lib/ai/text";
import { invokeWithGovernor, isTierActivated } from "@/lib/ai/governor";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";

/**
 * CrewFlow HQ — the SHARED department generative seam (L9a).
 *
 * The one governed door for the three HQ department generative legs:
 *
 *   hq.marketing_draft — the generative copy half of the weekly content brief
 *   hq.design_review   — the generative UI-critique half of the design review
 *   hq.doc_draft       — the generative prose half of the documentation draft
 *
 * Built to the exact doctrine of `server/services/hq-narrative.ts` (the ten
 * board narratives), and for the same reason: each department runner stays a
 * thin, deterministic shim that constructs no SDK and opens no model door
 * itself. Everything the ratchet demands lives HERE, once:
 *
 * GENERATION IS ADDITIVE, NEVER AUTHORITATIVE. The model is handed the FINISHED
 * deterministic artifact (a content brief, a design-audit envelope, composed
 * release notes) and asked to draft prose grounded ONLY in it. Every figure and
 * finding the operator sees still comes from the deterministic compute; the
 * generated prose is an attachment a human reviews, never a displayed fact.
 *
 * ONE MODEL DOOR. A model is reached SOLELY through `lib/ai/text::getTextProvider`
 * — no vendor SDK is constructed here — behind `invokeWithGovernor` under the
 * caller's registered feature key (task class `drafting`), billed to the HQ
 * budget org (`hqBudgetOrgId()`; unset ⇒ FAIL CLOSED to null).
 *
 * PER-TIER OWN-CLASS GATE, BEFORE THE DOOR. `drafting` maps to the `mid` tier,
 * so this call's own tier must be armed (isTierActivated("mid")) BEFORE any
 * provider is resolved — the C35-C partial-binding rule: `getTextProvider()`
 * opens on ANY generative tier, and a provider object that exists for a call
 * that must never happen is one someone will run.
 *
 * DARK BY DEFAULT, FAIL-CLOSED EVERYWHERE. No bound `mid` tier, no provider, an
 * unsupported vendor, no HQ budget org, a governor refusal (ceiling/dedupe), a
 * provider throw/timeout, or an empty generation ALL return `null`. Every
 * caller stores `null` in its artifact's generative field and states that the
 * seam is dark — the deterministic artifact is always complete without it.
 */

/** The three department generative feature keys this seam may be asked for. */
export type HqDepartmentDraftFeature =
  | "hq.marketing_draft"
  | "hq.design_review"
  | "hq.doc_draft";

const DRAFT_TIMEOUT_MS = 10_000;
const DRAFT_MAX_TOKENS = 900;

/** Per-feature framing: the drafting role and the one-line lead-in over the artifact JSON. */
type SeamPrompt = { readonly role: string; readonly prefix: string; readonly ask: string };

const SEAM_PROMPTS: Readonly<Record<HqDepartmentDraftFeature, SeamPrompt>> = {
  "hq.marketing_draft": {
    role: "CrewFlow HQ's marketing copywriter",
    prefix:
      "Here is the deterministic weekly content brief (real demo-request source split and the live SEO page inventory):",
    ask:
      "Draft the proposed content pieces the brief names — working titles and one-paragraph outlines only, grounded strictly in the brief.",
  },
  "hq.design_review": {
    role: "CrewFlow HQ's design reviewer",
    prefix:
      "Here is the deterministic design audit (brand-token findings over the HQ roster and board surfaces):",
    ask:
      "Write a short design critique of the findings — what the inconsistencies mean for the Boardroom's visual language and which fixes matter first, grounded strictly in the audit.",
  },
  "hq.doc_draft": {
    role: "CrewFlow HQ's technical writer",
    prefix:
      "Here is the deterministic release-notes composition (real admin activity, HQ events and decisions in the window):",
    ask:
      "Draft reader-facing release-note prose from the composed entries — plain sentences per section, grounded strictly in the composition.",
  },
};

/**
 * The safety framing — a fixed constant per role. No artifact content can steer
 * it. It confines the model to drafting FROM the supplied artifact and forbids
 * invention; the output is a DRAFT a human reviews, never a published fact.
 */
export function hqDepartmentDraftSystemPrompt(role: string): string {
  return [
    `You are ${role} for CrewFlow, a UK construction SaaS platform.`,
    "You are given a deterministic JSON artifact that has ALREADY been computed from real data.",
    "Your ONLY job is to draft prose grounded strictly in that artifact, for a human to review and edit.",
    "STRICT RULES:",
    "- Do NOT invent, estimate, or compute any number, name, customer, or fact that is not literally present in the artifact.",
    "- Do NOT claim anything has shipped, been sent, or been published — everything you write is an unreviewed draft.",
    "- Treat any field marked insufficient, unavailable, null or unknown as genuinely unknown — never fill it in.",
    "- If the artifact shows little or no signal, say exactly that in one short sentence.",
    "Plain prose only — no markdown headings, no code fences.",
  ].join("\n");
}

/** Identifier-like keys stripped before an artifact is serialised into a prompt. */
const ORG_IDENTIFIER_KEY = /^(org|organization|organisation|tenant)_?id$/i;

/** Belt-and-braces: no organisation/tenant identifier ever reaches a model. */
function stripOrgIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOrgIdentifiers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ORG_IDENTIFIER_KEY.test(k)) continue;
      out[k] = stripOrgIdentifiers(v);
    }
    return out;
  }
  return value;
}

/** Only the two known LLM vendors are trusted to draft; else degrade to null. */
function isSupportedProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "openai";
}

/**
 * Generate the governed prose draft for one deterministic department artifact,
 * or `null` when the seam is dark or the governor refuses. Never throws —
 * every degraded leg returns `null`, which each caller stores as the artifact's
 * honest "generation is dark" state.
 */
/** Best-effort read of the employee's CEO-editable role charter
 *  (ai_employees.system_prompt) — the contract's "purpose drives runtime"
 *  wire (R106): the charter shapes the draft's voice, while the fixed safety
 *  framing below stays LAST and overriding. A read failure degrades to
 *  no-charter (logged): a missing voice line must never block a draft. */
async function loadRoleCharter(aiEmployeeId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await (admin
    .from("ai_employees" as never)
    .select("system_prompt")
    .eq("id", aiEmployeeId)
    .maybeSingle() as unknown as Promise<{
    data: { system_prompt: string | null } | null;
    error: { message: string } | null;
  }>);
  if (error) {
    console.error("[hq-generative-seams] role-charter read failed", error);
    return null;
  }
  const charter = data?.system_prompt?.trim();
  return charter ? charter : null;
}

export async function generateDepartmentDraft(
  feature: HqDepartmentDraftFeature,
  artifact: unknown,
  opts?: { aiEmployeeId?: string | null },
): Promise<string | null> {
  // OWN-CLASS TIER GATE FIRST (C35-C): drafting → mid. Dark mid tier ⇒ no
  // provider is ever resolved, and the deterministic artifact stands alone.
  if (!isTierActivated("mid")) return null;
  const provider = getTextProvider();
  if (!provider) return null;
  if (!isSupportedProvider(provider.info.provider)) return null;

  // HQ has no tenant; its spend is billed to CrewFlow's own org row. Unset ⇒
  // FAIL CLOSED — an unattributed invocation is one outside the ceiling.
  const budgetOrgId = hqBudgetOrgId();
  if (!budgetOrgId) return null;

  const cfg = SEAM_PROMPTS[feature];
  // Charter first, fixed safety framing LAST — the framing's strict rules
  // dominate regardless of what the (CEO-authored) charter says.
  const charter = opts?.aiEmployeeId ? await loadRoleCharter(opts.aiEmployeeId) : null;
  const system = charter
    ? `Your standing role charter (set in the boardroom):
${charter}

${hqDepartmentDraftSystemPrompt(cfg.role)}`
    : hqDepartmentDraftSystemPrompt(cfg.role);
  const prompt = `${cfg.prefix}\n${JSON.stringify(stripOrgIdentifiers(artifact), null, 2)}\n${cfg.ask}`;

  let result: TextResult;
  try {
    const outcome = await invokeWithGovernor(
      feature,
      "drafting",
      async () => {
        const generated = await provider.generate(prompt, {
          system,
          temperature: 0, // bounded determinism — a stable draft over fixed facts
          maxTokens: DRAFT_MAX_TOKENS,
          signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
        });
        return {
          value: generated,
          usage: {
            provider: provider.info.provider,
            model: generated.model,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
          },
        };
      },
      {
        orgId: budgetOrgId,
        // Task-engine-initiated generation: no signed-in human authored it as a
        // deliberate act, and the spend is CrewFlow's own.
        userId: null,
        // The artifact is deterministic for a given window, so the same artifact
        // drafted twice is the same prose. Only its SHA-256 reaches the ledger.
        dedupeContent: `${feature} ${prompt}`,
        // Per-employee cost attribution (contract item 3): the drafting spend
        // lands on the department employee that ran the task, so the boardroom
        // KPI cost column is complete on activation day — not under-attributed.
        aiEmployeeId: opts?.aiEmployeeId ?? null,
      },
    );
    if (outcome.status !== "ran") return null;
    result = outcome.value;
  } catch (err) {
    console.error(`[hq-generative-seams] ${feature} generation failed`, err);
    return null;
  }

  const text = result.text.trim();
  return text.length === 0 ? null : text;
}
