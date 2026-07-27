/**
 * CrewFlow HQ — Draft Generation: deterministic prompt assembly, versioning, and
 * the deterministic fallback (CEO Directive 010, Phase 3).
 *
 * The PURE core of the engine (docs/bible/decisions/0002-draft-generation.md):
 *   - `assembleDraftPrompt` builds a byte-stable { system, user } from a
 *     DraftContext. Same context in → identical prompt out, so prompt
 *     construction is DETERMINISTIC and the checksum is meaningful.
 *   - `draftPromptVersion` / `draftPromptChecksum` make every draft's prompt
 *     traceable and drift detectable — mirroring `lib/ai/embeddings/versioning.ts`
 *     (a hand-bumped SCHEMA_REVISION + a SHA-256 of the exact text).
 *   - `deterministicDraft` is the GRACEFUL FALLBACK: a real draft built with no
 *     model at all, from the same context, deterministically. It is the default
 *     path whenever no provider is configured (e.g. CI), so the engine always
 *     produces a draft and the fallback is itself reproducible.
 *
 * No `server-only`, no DB, no vendor SDK. `node:crypto` is the only dependency —
 * the same one the embeddings versioning core uses — so recall, the service, and
 * the tests can all import this. Nothing here transmits anything: the system
 * prompt forbids sending and no transport is imported.
 */

import { createHash } from "node:crypto";
import type { DraftKind, DraftContext, DraftContent } from "./model";

/**
 * Bumped BY HAND when a prompt template's wording changes in a way that should
 * invalidate prior drafts' comparability — even though the kind is unchanged.
 * The kind is part of the version key, so adding a kind never needs a bump; this
 * is the "the template itself changed" lever. Mirrors EMBEDDING_SCHEMA_REVISION.
 */
export const DRAFT_PROMPT_REVISION = 1;

/**
 * The canonical, stable version key recorded on every draft: `${kind}:v${rev}`.
 * One string so provenance/audit is a single comparison (drafts built by the
 * same kind+template share it; a template change bumps it for all).
 */
export function draftPromptVersion(kind: DraftKind): string {
  return `${kind}:v${DRAFT_PROMPT_REVISION}`;
}

/**
 * A stable SHA-256 of the EXACT assembled prompt (system + user). Two jobs,
 * exactly as the embeddings checksum: drift detection (a changed context or
 * template changes the hash) and audit (the draft row pins the hash of the
 * prompt that actually produced it). Pure and deterministic.
 */
export function draftPromptChecksum(prompt: { system: string; user: string }): string {
  return createHash("sha256")
    .update(`${prompt.system}\n----\n${prompt.user}`, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------
// The never-send doctrine, reused verbatim in spirit from the Research AI sales
// prompt (lib/research/prompts.ts): a draft is for a human to review, the model
// never sends, never fabricates, British English. This is the boundary stated
// to the model itself — one half of "drafts only", the other half being the
// absence of any transport in the service.
// ---------------------------------------------------------------------

const DRAFT_SYSTEM_RULES = [
  "You write a DRAFT for a human to review. You never send anything, and nothing you write is transmitted.",
  "Be specific to THIS recipient using only the context provided; never invent facts about them. If you lack a fact, write around it rather than fabricating one.",
  "British English. Warm, concise, credible — no hype, no false claims, no fake social proof, no invented names or numbers.",
  "Output STRICT JSON only — no prose, no markdown, no code fences.",
].join("\n");

const KIND_BRIEF: Record<DraftKind, string> = {
  cold_email:
    "You are an outreach assistant for CrewFlow, an all-in-one operating platform for UK construction companies (quoting, scheduling, job management, invoicing). Draft a first-touch cold email: a short subject line and a brief, human body that earns a reply. No attachments, no links, no pressure.",
};

/** Stable bullet block, omitted entirely when there is nothing to say. */
function section(title: string, lines: ReadonlyArray<string>): string | null {
  const kept = lines.filter((l) => l.trim().length > 0);
  if (kept.length === 0) return null;
  return `${title}:\n${kept.map((l) => `- ${l}`).join("\n")}`;
}

/**
 * Build the deterministic { system, user } prompt. Every present context source
 * is incorporated in a FIXED ORDER (subject → memory → research → qualification),
 * and absent sources are simply omitted — so the output is stable and the
 * checksum is meaningful. The model is asked for the same JSON shape the
 * deterministic fallback produces, so both legs are interchangeable downstream.
 */
export function assembleDraftPrompt(
  kind: DraftKind,
  context: DraftContext,
): { system: string; user: string } {
  const system = `${KIND_BRIEF[kind]}\n\nABSOLUTE RULES:\n${DRAFT_SYSTEM_RULES}`;

  const blocks: string[] = [];
  blocks.push(`RECIPIENT: ${context.subject.name ?? "(name unknown — address generally)"}`);

  if (context.memory && context.memory.text.trim().length > 0) {
    // Shared Memory is already ranked/budgeted/prompt-ready (recall's context.text).
    blocks.push(`WHAT WE ALREADY KNOW (from shared memory):\n${context.memory.text.trim()}`);
  }

  const r = context.research;
  if (r) {
    const research = [
      r.summary ? `SUMMARY: ${r.summary}` : "",
      r.sector ? `SECTOR: ${r.sector}` : "",
      section("PAIN POINTS", r.painPoints),
      section("BUYING SIGNALS", r.buyingSignals),
      section("RELEVANT CREWFLOW MODULES", r.recommendedModules),
    ]
      .filter((s): s is string => s !== null && s.length > 0)
      .join("\n");
    if (research.length > 0) blocks.push(`RESEARCH:\n${research}`);
  }

  const q = context.qualification;
  if (q) {
    const qual = [
      q.tier ? `TIER: ${q.tier}` : "",
      q.decision ? `DECISION: ${q.decision}` : "",
      section("WHY THEY QUALIFIED", q.rationale),
    ]
      .filter((s): s is string => s !== null && s.length > 0)
      .join("\n");
    if (qual.length > 0) blocks.push(`QUALIFICATION (internal — informs angle, never quote a score):\n${qual}`);
  }

  const schema = `Return STRICT JSON with exactly this shape (both non-empty, written for THIS recipient):
{
  "subject": string,   // a short, specific email subject line
  "body": string       // the email body, a few short paragraphs, British English
}`;

  const user = `Draft the email using this context. Keep it specific and honest.\n\n=== CONTEXT ===\n${blocks.join(
    "\n\n",
  )}\n\n=== OUTPUT ===\n${schema}`;

  return { system, user };
}

// ---------------------------------------------------------------------
// The deterministic fallback. A real, honest cold email built from structured
// context with NO model — pure string composition, stable for a given context.
// It uses only facts present in the context (never fabricates), is British
// English, and contains no link, no attachment, and no "I will call/send"
// automation language. This is what runs whenever no LLM provider is configured.
// ---------------------------------------------------------------------

const DETERMINISTIC: Record<DraftKind, (c: DraftContext) => DraftContent> = {
  cold_email: (c) => {
    const name = c.subject.name?.trim() || null;
    const r = c.research;
    const sector = r?.sector?.trim() || null;
    const firstPain = r?.painPoints.find((p) => p.trim().length > 0) ?? null;
    const firstSignal = r?.buyingSignals.find((s) => s.trim().length > 0) ?? null;
    const modules = (r?.recommendedModules ?? []).filter((m) => m.trim().length > 0);

    const subject = name
      ? `${name}: less admin, more time on the tools`
      : "Less admin, more time on the tools";

    // A fixed-order, fact-only composition → identical body for identical context.
    const greeting = name ? `Hi ${name} team,` : "Hi there,";

    const hook = firstPain
      ? `Many ${sector ?? "construction"} firms tell us that ${lower(firstPain)} quietly eats into the working week.`
      : firstSignal
        ? `It looks like an interesting time for ${name ?? "your team"} — ${lower(firstSignal)}.`
        : `Running a ${sector ?? "construction"} business means juggling quotes, scheduling, jobs and invoicing — often across too many tools.`;

    const value =
      "CrewFlow brings quoting, scheduling, job management and invoicing into one place built for UK construction" +
      (modules.length > 0 ? `, including ${joinList(modules)}.` : ".");

    const close =
      "If it's useful, I'd be glad to share a short, no-pressure overview tailored to how you work. Would that be worth a look?";

    const body = [greeting, "", hook, value, "", close, "", "Best wishes,", "The CrewFlow team"].join("\n");

    return { subject, body, channel: "email" };
  },
};

/**
 * The deterministic, model-free draft for a kind+context. Pure and total: every
 * kind has a builder, and a sparse context still yields a sensible, honest draft.
 */
export function deterministicDraft(kind: DraftKind, context: DraftContext): DraftContent {
  return DETERMINISTIC[kind](context);
}

/** Lower-case the first character so a fact reads mid-sentence; deterministic. */
function lower(s: string): string {
  const t = s.trim();
  return t.length > 0 ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/** Stable "a, b and c" join. */
function joinList(items: ReadonlyArray<string>): string {
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
