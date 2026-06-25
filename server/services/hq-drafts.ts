import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTextProvider, textCostUsd, type TextResult } from "@/lib/ai/text";
import {
  assembleDraftPrompt,
  draftPromptChecksum,
  draftPromptVersion,
  deterministicDraft,
} from "@/lib/drafts/prompt";
import {
  DRAFT_KINDS,
  type DraftKind,
  type DraftContext,
  type DraftContent,
  type DraftProvenance,
  type DraftStatus,
  type DraftSubject,
  type DraftMemoryContext,
  type DraftResearchContext,
  type DraftQualificationContext,
} from "@/lib/drafts/model";
import { createMemory } from "@/server/sdk/memory";
import { getResearchReport } from "@/server/services/hq-research";
import { getQualificationReport } from "@/server/services/hq-qualification";

/**
 * CrewFlow HQ — Draft Generation service (CEO Directive 010, Phase 3).
 *
 * The thin server API over the `hq_drafts` engine — SHARED workforce intelligence
 * every AI employee inherits (Sales, Customer Success, Finance, Business Coach,
 * Voice). It owns NO policy of its own: deterministic prompt construction, the
 * versioning, the checksum and the deterministic fallback are all PURE
 * (`lib/drafts/`), and the artifact's immutability + audit are enforced by the
 * database (migration 20260731000000). This layer is the ORCHESTRATOR — it gathers
 * context, runs the bounded LLM (or the fallback), measures cost, and persists one
 * immutable row. It is not the boundary.
 *
 * The boundary, made explicit (the load-bearing security property):
 *   • This engine GENERATES a draft; it NEVER sends, delivers, schedules, automates,
 *     or follows up. There is no mailer, no transport, no scheduler imported here. A
 *     finished draft is approval-ready (its content maps 1:1 onto the Approval
 *     Engine's proposed_payload) — submitting it for approval is a separate, later
 *     phase, and ACTING on an approval is later still.
 *   • The LLM edge is BOUNDED, not trusted: temperature 0, a pinned model, a versioned
 *     prompt, a maxTokens cap, and full provenance + cost recorded. When no provider
 *     is configured (e.g. CI) or the call throws or returns unparseable output, the
 *     DETERMINISTIC fallback runs — so generation always yields a draft and is fully
 *     reproducible end-to-end. (ADR docs/bible/decisions/0002-draft-generation.md.)
 *   • The draft PROSE never leaves the RLS-locked row: the spine event the INSERT
 *     trigger emits carries identifiers + metadata only.
 *
 * generateDraft never throws on a business outcome; it returns a discriminated result.
 */

// ---------------------------------------------------------------------
// Typed admin shim. hq_drafts is a service-role-only HQ table, not in the
// generated Supabase types — cast past the typed client (the same `as unknown as`
// shim the other HQ services use for untyped hq_* tables; typing convenience only).
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

interface DraftQuery<T> extends DbList<T> {
  select(columns: string): DraftQuery<T>;
  insert(payload: unknown): DraftQuery<T>;
  eq(column: string, value: unknown): DraftQuery<T>;
  order(column: string, options?: { ascending?: boolean }): DraftQuery<T>;
  limit(count: number): DraftQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}

function drafts<T>(admin: AdminClient): DraftQuery<T> {
  return admin.from("hq_drafts" as never) as unknown as DraftQuery<T>;
}

const ROW_COLUMNS =
  "id, ai_employee_id, subject_type, subject_id, kind, content, status, provenance, " +
  "model, prompt_version, prompt_checksum, input_tokens, output_tokens, cost_usd, " +
  "latency_ms, fallback_reason, correlation_id, supersedes_id, created_at";

/** One persisted, immutable draft row (the artifact + its inline cost ledger). */
export type DraftRow = {
  id: string;
  ai_employee_id: string;
  subject_type: string;
  subject_id: string;
  kind: DraftKind;
  content: DraftContent;
  status: DraftStatus;
  provenance: DraftProvenance;
  model: string | null;
  prompt_version: string;
  prompt_checksum: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  fallback_reason: string | null;
  correlation_id: string;
  supersedes_id: string | null;
  created_at: string;
};

export type DraftResult = { ok: true; draft: DraftRow } | { ok: false; error: string };

/**
 * Output-token cap — the cost control. A cold email is short, so a tight cap bounds
 * the spend of every generated draft (the CEO's "costs measurable + controlled").
 * Callers may override per kind; the deterministic leg ignores it (it spends nothing).
 */
const DEFAULT_MAX_TOKENS = 700;

export type GenerateDraftInput = {
  /** The generating AI employee (FK → ai_employees.id). */
  aiEmployeeId: string;
  /** What the draft is about, e.g. 'outreach_email'. */
  subjectType: string;
  /** The subject's id (e.g. a company id). */
  subjectId: string;
  /** Which template + fallback to use, e.g. 'cold_email'. */
  kind: DraftKind;
  /** The assembled, source-agnostic context (see assembleDraftContext). */
  context: DraftContext;
  /** Output-token cap; defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** Thread this run into a larger intent's trace; else a fresh trace begins. */
  correlationId?: string;
  /** Set when this draft regenerates a prior one (the prior stays in the record). */
  supersedesId?: string | null;
};

/**
 * Generate ONE draft for a kind + context and persist it as an immutable artifact.
 *
 * Deterministic prompt construction (pure) → the bounded LLM leg (temperature 0)
 * when a provider is configured and yields parseable JSON, ELSE the deterministic
 * fallback (no provider / provider threw / unparseable output). Cost is measured and
 * recorded. The INSERT trigger emits one `ai.run_completed` into the spine, in the
 * same transaction. Returns the persisted row; never throws on a business outcome.
 */
export async function generateDraft(input: GenerateDraftInput): Promise<DraftResult> {
  const subjectType = input.subjectType?.trim();
  const subjectId = input.subjectId?.trim();
  if (!input.aiEmployeeId || !subjectType || !subjectId || !input.kind) {
    return { ok: false, error: "invalid_input" };
  }
  if (!(DRAFT_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, error: "unknown_kind" };
  }

  // Pure, deterministic prompt + provenance — same context in, identical out.
  const prompt = assembleDraftPrompt(input.kind, input.context);
  const promptVersion = draftPromptVersion(input.kind);
  const promptChecksum = draftPromptChecksum(prompt);
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  const built = await buildDraft(input.kind, input.context, prompt, maxTokens);

  // Persist one immutable artifact. The AFTER INSERT trigger emits ai.run_completed.
  const admin = createAdminClient();
  const row: Record<string, unknown> = {
    ai_employee_id: input.aiEmployeeId,
    subject_type: subjectType,
    subject_id: subjectId,
    kind: input.kind,
    content: built.content,
    status: built.status,
    provenance: built.provenance,
    model: built.model,
    prompt_version: promptVersion,
    prompt_checksum: promptChecksum,
    input_tokens: built.inputTokens,
    output_tokens: built.outputTokens,
    cost_usd: built.costUsd,
    latency_ms: built.latencyMs,
    fallback_reason: built.fallbackReason,
    supersedes_id: input.supersedesId ?? null,
  };
  if (input.correlationId) row.correlation_id = input.correlationId;

  const { data, error } = await drafts<DraftRow>(admin)
    .insert(row)
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    console.error("[hq-drafts] generateDraft insert failed", error);
    return { ok: false, error: error?.message ?? "persist_failed" };
  }
  return { ok: true, draft: data };
}

/**
 * Read one immutable draft by id, or null when it does not exist. This is the Draft
 * Engine's READ SEAM: the Communication Layer (Phase 4) resolves a `draft_id` through
 * THIS function, so no other system re-queries hq_drafts — the two engines stay
 * separate, joined only by the draft id and this public read.
 */
export async function getDraft(id: string): Promise<DraftRow | null> {
  if (!id?.trim()) return null;
  const admin = createAdminClient();
  const { data } = await drafts<DraftRow>(admin)
    .select(ROW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return data ?? null;
}

// ---------------------------------------------------------------------
// The leg selector — LLM (bounded) or the deterministic fallback.
// ---------------------------------------------------------------------

type BuiltDraft = {
  content: DraftContent;
  status: DraftStatus;
  provenance: DraftProvenance;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  fallbackReason: string | null;
};

async function buildDraft(
  kind: DraftKind,
  context: DraftContext,
  prompt: { system: string; user: string },
  maxTokens: number,
): Promise<BuiltDraft> {
  const provider = getTextProvider();

  // No provider configured → deterministic fallback (the DEFAULT path in CI, where
  // no LLM key is set — so generation is reproducible end-to-end).
  if (!provider) return fallbackBuilt(kind, context, "no_provider");

  const genProvenance = generatedProvenance(provider.info.provider);
  if (!genProvenance) return fallbackBuilt(kind, context, "unsupported_provider");

  const startedAt = Date.now();
  let result: TextResult;
  try {
    result = await provider.generate(prompt.user, {
      system: prompt.system,
      temperature: 0, // bounded determinism (ADR 0002): temperature 0 + pinned model.
      maxTokens,
    });
  } catch (err) {
    // A transient provider failure degrades to the deterministic draft — generation
    // never fails. The reason is recorded for observability.
    return fallbackBuilt(kind, context, `provider_error: ${errMessage(err)}`);
  }
  const latencyMs = Date.now() - startedAt;

  const content = parseDraftJson(result.text);
  if (!content) {
    // The model returned something we cannot trust as a draft → deterministic.
    return fallbackBuilt(kind, context, "invalid_model_json");
  }

  return {
    content,
    status: "generated",
    provenance: genProvenance,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: textCostUsd(provider.info, result),
    latencyMs,
    fallbackReason: null,
  };
}

/** The deterministic, model-free leg — always available, always reproducible. */
function fallbackBuilt(kind: DraftKind, context: DraftContext, reason: string): BuiltDraft {
  return {
    content: deterministicDraft(kind, context),
    status: "fallback",
    provenance: "deterministic",
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    latencyMs: null,
    fallbackReason: reason,
  };
}

/** Only the two known LLM vendors yield a 'generated' draft; else fall back. */
function generatedProvenance(provider: string): "anthropic" | "openai" | null {
  return provider === "anthropic" || provider === "openai" ? provider : null;
}

/**
 * Parse the model's STRICT JSON into a DraftContent, or null when it cannot be
 * trusted (so the caller falls back). Defensively strips a code fence the prompt
 * forbids but a model might still add, and requires both subject and body non-empty.
 */
function parseDraftJson(text: string): DraftContent | null {
  const trimmed = stripFences(text).trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const subject = typeof obj.subject === "string" ? obj.subject.trim() : "";
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  if (!subject || !body) return null;
  return { subject, body, channel: "email" };
}

/** Strip a single ```json … ``` fence if present (defensive; the prompt forbids it). */
function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m && m[1] !== undefined ? m[1] : t;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------
// Context adapter. Compose a DraftContext from the three EXISTING read APIs —
// Shared Memory recall, the Research report, the Qualification verdict. Each source
// is INDEPENDENTLY GUARDED: a missing or erroring source degrades the draft to null
// for that slice, never fails the whole assembly (graceful degradation, §Directive).
// The pure assembler never knows where the context came from, so the engine is
// generic across employees — this adapter is the only employee-specific seam.
// ---------------------------------------------------------------------

export type DraftContextRefs = {
  /** The AI employee whose memory facet recalls context. */
  employeeId: string;
  /** Who/what the draft is about. */
  subject: DraftSubject;
  /** What to recall from Shared Memory; defaults to the subject name, else its label. */
  memoryQuery?: string;
  /** The Research AI task whose report informs the draft, if any. */
  researchTaskId?: string | null;
  /** The Qualification task whose verdict informs the draft, if any. */
  qualificationTaskId?: string | null;
  /** Bind recall to a running task (working memory), if any. */
  currentTaskId?: string | null;
};

/**
 * Gather a DraftContext from the live read APIs. Reads run concurrently; each is
 * guarded so the slowest/missing source never blocks or breaks the others.
 */
export async function assembleDraftContext(refs: DraftContextRefs): Promise<DraftContext> {
  const [memory, research, qualification] = await Promise.all([
    safeMemory(refs),
    safeResearch(refs.researchTaskId ?? null),
    safeQualification(refs.qualificationTaskId ?? null),
  ]);
  return { subject: refs.subject, memory, research, qualification };
}

async function safeMemory(refs: DraftContextRefs): Promise<DraftMemoryContext | null> {
  const query = (refs.memoryQuery ?? refs.subject.name ?? refs.subject.label).trim();
  if (!query) return null;
  try {
    const memory = createMemory({
      employeeId: refs.employeeId,
      currentTaskId: refs.currentTaskId ?? null,
    });
    const result = await memory.recall({ query });
    const text = result.context.text.trim();
    if (!text) return null;
    return { text, count: result.context.memoryCount };
  } catch (err) {
    console.error("[hq-drafts] memory recall failed (degrading)", errMessage(err));
    return null;
  }
}

async function safeResearch(taskId: string | null): Promise<DraftResearchContext | null> {
  if (!taskId) return null;
  try {
    const report = await getResearchReport(taskId);
    if (!report) return null;
    const intel = report.intelligence;
    return {
      summary: intel?.overview ?? null,
      sector: intel?.constructionSector ?? intel?.industry ?? null,
      painPoints: intel?.painPoints ?? [],
      buyingSignals: intel?.buyingSignals ?? [],
      score: report.summary?.score ?? null,
      // Research AI does not yet emit CrewFlow module recommendations; this is the
      // forward-looking seam a future module-recommender fills (graceful empty now).
      recommendedModules: [],
    };
  } catch (err) {
    console.error("[hq-drafts] research read failed (degrading)", errMessage(err));
    return null;
  }
}

async function safeQualification(
  taskId: string | null,
): Promise<DraftQualificationContext | null> {
  if (!taskId) return null;
  try {
    const report = await getQualificationReport(taskId);
    const verdict = report?.verdict;
    if (!verdict) return null;
    return {
      tier: verdict.tier,
      score: verdict.score,
      decision: verdict.decision,
      rationale: verdict.rationale,
    };
  } catch (err) {
    console.error("[hq-drafts] qualification read failed (degrading)", errMessage(err));
    return null;
  }
}
