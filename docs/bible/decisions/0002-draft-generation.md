# ADR 0002 — Draft Generation

> **Status:** Accepted · **Date:** 2026-06-25 · **Directive:** CEO Directive 010,
> Phase 3 (Draft Generation) · **Supersedes:** none · **Superseded by:** none
>
> Second ADR under the [`../README.md`](../README.md) *document-before-you-build*
> rule, recorded in the same PR as the code. Phase 3 is a **major** architectural
> decision: the first reusable **intelligence layer** — deterministic, auditable,
> cost-accounted draft generation — that every future AI employee inherits.
> Builds on the Approval Engine ([ADR 0001](./0001-approval-engine.md)).

---

## Context

Phase 2 gave the workforce a way to gate an action behind a human decision. Phase
3 gives it a way to **produce** the thing being decided on — a *draft* — without
ever acting. The CEO's constraint is explicit:

> "The objective is not to send emails. The objective is to build deterministic
> draft generation. Generate drafts only. Do not build delivery, automation,
> scheduling, or follow-up logic."

The first consumer is the Outreach AI (seeded in Phase 1: slug `outreach-ai`,
`requires_approval = true`, scopes `["read","draft","memory"]` — **no `send`
scope**, guarded by `__tests__/security/outreach-ai-invariants.test.ts`). But the
directive is emphatic that this is **not an Outreach feature**:

> "We are no longer building Outreach AI. We are building reusable intelligence
> for the entire AI workforce. Every future AI employee should eventually reuse
> this draft-generation architecture."

So the question this ADR answers is: *what is the one generation substrate the
whole workforce inherits — deterministic, cost-controlled, and auditable — built
by composing what already exists rather than duplicating it?*

The reuse audit found the pieces already present: an LLM provider seam
(`lib/ai/text/`), per-call cost accounting (`lib/ai/text/cost.ts`), a cost-ledger
precedent (`hq_embedding_runs`), an embeddings **versioning** pattern
(`lib/ai/embeddings/versioning.ts`), prompt-build machinery and a draft content
shape with a "you never send anything" doctrine (`lib/research/prompts.ts`,
`CommsDrafts`), the three context sources (Shared Memory recall, Research report,
Qualification verdict), and the `ai.*` run-lifecycle event vocabulary. What was
**missing** was a deterministic, versioned, auditable generation engine that
composes them into a first-class, immutable, cost-accounted draft artifact.

## Decision

Build a generic **Draft Generation** engine in three mirrored layers — the same
shape as the Approval Engine: a pure deterministic core, a DB-enforced immutable
artifact, and a thin orchestrating service.

1. **A pure core** (`lib/drafts/`). No I/O, no `server-only`.
   - `assembleDraftPrompt(kind, context) → { system, user }` — **deterministic
     prompt construction** from an assembled `DraftContext`. Same context in →
     byte-identical prompt out. The system message reuses the established
     never-send doctrine ("these are DRAFTS… you never send anything").
   - **Versioning**, mirroring `lib/ai/embeddings/versioning.ts`: a hand-bumped
     `DRAFT_PROMPT_REVISION`, `draftPromptVersion(kind)` (a stable key like
     `cold_email:v1`), and `draftPromptChecksum(prompt)` (SHA-256). Every draft
     records both, so prompt versions are traceable and drift is detectable.
   - `deterministicDraft(kind, context) → DraftContent` — the **graceful
     fallback**: a pure, template-filled draft built with no model at all. Same
     context in → same draft out. This is the default path when no provider is
     configured.

2. **A generic, RLS-locked artifact + cost ledger** (`hq_drafts`, migration
   `supabase/migrations/20260731000000_hq_drafts.sql`). Generic by design
   (`subject_type`/`subject_id`/`kind`), exactly like `hq_approvals`. It carries
   the draft `content` (jsonb), provenance (`anthropic`/`openai`/`deterministic`),
   `model`, `prompt_version` + `prompt_checksum`, the cost ledger
   (`input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, modelled on
   `hq_embedding_runs`), `status` (`generated`/`fallback`), and
   `supersedes_id`. A `BEFORE` trigger makes a draft **write-once** (an immutable
   record — regeneration supersedes, never mutates). An `AFTER INSERT` trigger
   emits one canonical `ai.*` event into the append-only spine, in the same
   transaction.

3. **A thin service** (`server/services/hq-drafts.ts`). `generateDraft(input)`:
   gather context from the three existing read APIs (Shared Memory
   `recall(...)`, Research `getResearchReport(...)`/`getCompany(...)`,
   Qualification `getQualificationReport(...)` — each guarded, so a missing source
   degrades rather than fails) → assemble the versioned prompt (pure) → call the
   `lib/ai/text` seam with **`temperature: 0`** and a `maxTokens` cap, **or** take
   the deterministic fallback when `getTextProvider()` is `null` or the call
   throws → measure cost via `textCostUsd` → persist one immutable `hq_drafts`
   row. The service is the orchestrator, not the boundary.

**Determinism, honestly scoped.** LLMs are not bit-deterministic, so the
guarantee is precise: prompt **construction** and the **fallback** draft are pure
and exhaustively unit-tested; the LLM edge is *bounded* (temperature 0, pinned
model, a versioned prompt, and full provenance + cost recorded). Because CI runs
with no provider key, `getTextProvider()` returns `null` and the **deterministic
path is what integration exercises end-to-end** — fully reproducible, the same
way the Approval state machine was.

**The draft is approval-ready, not auto-submitted.** A finished draft carries
everything `requestApproval({ subjectType, subjectId, action, proposedPayload })`
needs, so Phase 4 can wire generation → approval. Generation does **not** submit
it — auto-submission is automation, which is out of scope.

**One event vocabulary.** A run narrates through the existing `ai.*` verbs —
**no new verbs minted**, per the directive. Both a generated and a fallback draft
are *completed* runs (each produces a usable draft), so both emit
`ai.run_completed` (severity `success` vs `info`); `ai.run_failed` stays reserved
in the frozen vocabulary for a genuinely failed run — a later concern, since Phase
3 always degrades to a deterministic fallback rather than failing, so it has no
terminal `failed` status. As in Phase 2, the spine payload carries identifiers and
metadata only; the **draft prose never leaves the RLS-locked row**.

## Alternatives weighed

- **Reuse Research AI's draft byproduct directly.** Rejected. `research-llm.ts`
  already emits `CommsDrafts`, but as a *side-output* of a research run — coupled
  to `SalesPromptInput`, sales-specific, with no prompt versioning, no cost
  ledger, and no immutable first-class artifact. Phase 3 needs a standalone,
  generic layer. We **reuse its content shape and never-send doctrine**, not its
  run coupling.
- **Persist drafts in `hq_sales_ai_tasks.result` jsonb** (where research/
  qualification persist). Rejected as the same duplication trap ADR 0001 rejected:
  it is sales-task-coupled, not generic, and has no first-class immutability,
  cost, version, or RLS surface. A generic `hq_drafts` table is the workforce-wide
  substrate.
- **Mint new `draft.*` / `outreach.*` event verbs.** Rejected. The `ai.*`
  run-lifecycle vocabulary already exists; the directive mandates one vocabulary
  on one spine.
- **Force LLM determinism via seeding/caching.** Rejected as dishonest — vendors
  give no bit-exact guarantee. The deterministic core lives where it can be
  *proven* (construction + fallback); the model edge is bounded and audited.
- **Build a global cost-budget enforcer now.** Deferred. Per the seam's own
  doctrine, cost is *observability, never a correctness gate*. Phase 3 bounds the
  call (`maxTokens`) and measures + persists every cost; cross-employee budget
  enforcement is a later concern.

## Consequences

**What the workforce inherits.** One generic generation substrate: assemble a
`DraftContext` and pick a `kind`, and an employee gets a deterministic, versioned,
cost-accounted, immutable, spine-audited draft — and never re-implements prompt
assembly, versioning, cost accounting, fallback, or audit.

**Security boundary.** Drafts only: the engine imports no mailer or transport, the
seed grants no `send` scope, and the system prompt forbids sending. The artifact
is RLS-locked and write-once; the prose never reaches the event spine.

**What this explicitly does NOT do.** No sending, no delivery, no automation, no
scheduling, no follow-up. It produces approval-ready drafts and stops.

**Validation bar.** The full six-gate suite: the pure core unit-pinned
(deterministic prompt + checksum + fallback), security invariants (no send/
automation/scheduling; RLS; one vocabulary; prose off-spine), and the lifecycle
against real Postgres.

**Follow-ups (not in this PR).** The generation → approval submission wiring; the
autonomous task-runner that invokes generation; richer run telemetry
(`ai.run_started`, `ai.budget_warned`/`ai.budget_exceeded`); cross-employee budget
enforcement; and additional draft `kind`s and employee context adapters. Each is
its own reviewable change.
