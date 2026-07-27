-- CrewFlow HQ — Draft Generation: the immutable draft artifact + cost ledger
-- (CEO Directive 010, Phase 3).
--
-- Phase 2 built the Approval Engine: a way to GATE a proposed action behind a
-- human decision. Phase 3 builds the thing that PRODUCES what is decided on — a
-- DRAFT — and, like the Approval Engine, builds it as SHARED WORKFORCE
-- INFRASTRUCTURE, not Outreach-specific code. Every future AI employee inherits
-- this exact engine: Sales AI, Customer Success AI, Finance AI, Business Coach AI,
-- Voice AI. So nothing here names Outreach; the table is `hq_drafts`, generic over
-- a (subject_type, subject_id, kind) triple — the same shape as hq_approvals.
--
-- The objective is NOT sending, NOT delivery, NOT automation, NOT scheduling, NOT
-- follow-up. It is draft generation only: a subject + body a human reviews and the
-- Approval Engine gates. This migration wires NOTHING to any send channel and
-- imports no transport — the boundary is architectural, not conventional.
--
-- ───────────────────────────────────────────────────────────────────────────
-- The Phase-3 reuse audit (Engineering Rule 1: reuse before build)
-- ───────────────────────────────────────────────────────────────────────────
-- The immutable audit trail ALREADY EXISTS: the HQ Event Spine (hq_events) is an
-- append-only, partitioned log. Its `ai.*` run-lifecycle verbs — ai.run_completed
-- / ai.run_failed / … — were FROZEN in the registry (lib/events/registry.ts); a
-- finished draft is a completed AI run, so it narrates through ai.run_completed.
-- This migration mints NO new event vocabulary (no draft.* / outreach.* verbs) and
-- builds NO second audit store — every generated draft emits ONE canonical spine
-- event, in-transaction, exactly as hq_approvals brought the approval.* verbs alive.
--
-- The per-request COST LEDGER pattern ALREADY EXISTS: hq_embedding_runs records
-- provider / model / tokens / cost / latency per attempt (20260725000000). A draft
-- run has the same cost-accounting need, so hq_drafts carries the same columns
-- inline — the artifact IS its own ledger row (one immutable draft = one run).
--
-- So Phase 3 leaves exactly ONE thing that genuinely does not exist: a place to
-- hold a generated draft as a first-class, immutable, cost-accounted, versioned
-- artifact that the Approval Engine can later gate. That is this migration's one
-- new object:
--
--   hq_drafts — one row per generated draft. WRITE-ONCE: a draft is generated once
--               and never mutates. Regenerating SUPERSEDES (a new row pointing back
--               via supersedes_id); the prior draft stays in the permanent record.
--               It carries the content (subject+body jsonb), the provenance
--               (anthropic/openai/deterministic), the prompt VERSION + CHECKSUM (so
--               prompt drift is detectable and every draft is traceable), and the
--               cost ledger (tokens, cost_usd, latency_ms). Two layers, each doing
--               one job: this row is the artifact; the spine is the narrative.
--
-- It is RLS:hq (RLS enabled, ZERO policies → service-role only; every JWT client —
-- anon/authenticated — is denied). The draft PROSE never leaves this RLS-locked row:
-- the spine event carries identifiers + metadata only. No tenant table is touched.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why immutability is enforced in the DATABASE (architecture, not convention)
-- ───────────────────────────────────────────────────────────────────────────
-- Service code reaches this table through the service-role admin client, which
-- BYPASSES RLS — so a guard that lived only in TypeScript could be bypassed by any
-- future caller. Therefore "a draft is write-once" is enforced by a BEFORE UPDATE
-- trigger that NO caller can bypass, and the audit event is emitted by an AFTER
-- INSERT trigger in the SAME transaction as the artifact — so the draft and its
-- narrative are inseparable (P1): if the insert commits, its event commits; if it
-- rolls back, so does the event. There is no half-state.
--
-- The status/provenance pair is constrained so it can never be incoherent:
--   generated → an LLM produced it      → provenance in (anthropic, openai)  → ai.run_completed (success)
--   fallback  → the deterministic path  → provenance = deterministic          → ai.run_completed (info)
-- Both are completed runs that yielded a draft; provenance distinguishes them. The
-- pure assembler + fallback live in lib/drafts/ (the single source the service and
-- tests read); this migration is the ENFORCER of the artifact's immutability, and
-- __tests__/security/drafts-invariants.test.ts pins that they agree.

-- ===========================================================================
-- 1. hq_drafts — one immutable, cost-accounted draft per generation.
-- ===========================================================================
create table if not exists public.hq_drafts (
  id               uuid        primary key default gen_random_uuid(),

  -- WHO generated it (the AI employee). Write-once. RESTRICT: an employee with
  -- drafts on record cannot be deleted out from under its audit trail.
  ai_employee_id   uuid        not null references public.ai_employees(id) on delete restrict,

  -- WHAT the draft is about — generic over any future employee. subject_type/id
  -- mirror the spine's object addressing (e.g. 'outreach_email' + a company id);
  -- kind selects the prompt template + deterministic fallback (e.g. 'cold_email').
  subject_type     text        not null,
  subject_id       text        not null,
  kind             text        not null,

  -- The draft ITSELF — the only place the prose ever lives. { subject, body,
  -- channel }, the exact shape the Approval Engine's proposed_payload consumes.
  content          jsonb       not null default '{}'::jsonb,

  -- The run outcome + which leg produced it. The CHECK ties them together so the
  -- pair can never be incoherent (a 'generated' draft is never 'deterministic',
  -- a 'fallback' draft is always 'deterministic').
  status           text        not null
                     check (status in ('generated','fallback')),
  provenance       text        not null
                     check (provenance in ('anthropic','openai','deterministic')),
  constraint hq_drafts_status_provenance_ck check (
       (status = 'generated' and provenance in ('anthropic','openai'))
    or (status = 'fallback'  and provenance = 'deterministic')
  ),

  -- The model that actually ran (NULL on the deterministic leg — no model at all).
  model            text,

  -- Prompt PROVENANCE: the version key (`${kind}:v${rev}`) + a SHA-256 of the exact
  -- assembled prompt. Together they make every draft traceable to the template that
  -- built it and make prompt/context drift detectable. Mirrors the embeddings
  -- versioning contract (lib/ai/embeddings/versioning.ts).
  prompt_version   text        not null,
  prompt_checksum  text        not null,

  -- The cost ledger, inline (the artifact IS its run). Modelled on hq_embedding_runs:
  -- billed token split, cost in USD (NULL when the model is unpriced — cost is
  -- observability, never a correctness gate), wall-clock latency. The deterministic
  -- leg spends nothing, so tokens are 0 and cost is NULL.
  input_tokens     integer     not null default 0,
  output_tokens    integer     not null default 0,
  cost_usd         numeric,
  latency_ms       integer,

  -- Why the deterministic fallback ran, when it did (no_provider / provider_error /
  -- invalid_model_json). NULL on the generated leg. Observability, not control.
  fallback_reason  text,

  -- Threads this draft's run into one spine trace. Write-once; a caller may supply
  -- it to weave the draft into a larger intent (e.g. the task that requested it),
  -- else a fresh trace begins.
  correlation_id   uuid        not null default gen_random_uuid(),

  -- Regeneration: when this draft replaces a prior one. SET NULL defensively on the
  -- (never-happening, write-once) delete of the prior — the history is never rewritten.
  supersedes_id    uuid        references public.hq_drafts(id) on delete set null,

  created_at       timestamptz not null default now()
);

-- Observability + lookup indexes.
--   per-employee: one employee's drafts, newest first.
--   per-subject:  every draft ever generated for a given thing (the subject's story).
--   trace:        all rows in one correlation (regeneration chains, multi-step intents).
--   recency:      the spend/throughput timeline the cost dashboards read.
--   recovery:     follow supersession links.
create index if not exists hq_drafts_employee_idx
  on public.hq_drafts (ai_employee_id, created_at desc);
create index if not exists hq_drafts_subject_idx
  on public.hq_drafts (subject_type, subject_id, created_at desc);
create index if not exists hq_drafts_correlation_idx
  on public.hq_drafts (correlation_id);
create index if not exists hq_drafts_created_idx
  on public.hq_drafts (created_at desc);
create index if not exists hq_drafts_supersedes_idx
  on public.hq_drafts (supersedes_id)
  where supersedes_id is not null;

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT
-- client is denied. Drafts are HQ infrastructure; tenants never see them, and the
-- prose stays sealed in this row.
alter table public.hq_drafts enable row level security;

-- ===========================================================================
-- 2. The immutability guard — a draft is write-once.
--
-- A BEFORE UPDATE trigger that NO caller (not even the service-role admin client)
-- can bypass. A generated draft is a permanent record: its content, provenance,
-- prompt version/checksum, and cost can never be rewritten. Improving a draft is a
-- NEW generation that supersedes — never a mutation. This is the "every draft
-- auditable / immutable history" guarantee at the row level (the spine guarantees
-- it at the event level).
-- ===========================================================================
create or replace function public.hq_drafts_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_drafts %: a draft is write-once and immutable (regeneration supersedes, never mutates)', old.id
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_drafts_no_update on public.hq_drafts;
create trigger hq_drafts_no_update
  before update on public.hq_drafts
  for each row execute function public.hq_drafts_immutable();

-- ===========================================================================
-- 3. The audit emitter — every generated draft becomes one canonical spine event.
--
-- An AFTER INSERT trigger that emits through hq_emit_event() — the single validated
-- spine write primitive — IN THE SAME TRANSACTION as the draft (transactional
-- outbox; the same idiom hq_approvals_emit uses). This is the entire audit trail +
-- observability surface for generation: it reuses the FROZEN ai.* run-lifecycle
-- verbs and mints no new event vocabulary.
--
--   generated → ai.run_completed (severity success) — an LLM produced the draft.
--   fallback  → ai.run_completed (severity info)    — the deterministic path did.
-- Both are completed runs that yielded a draft; the run did not fail.
--
-- SECURITY DEFINER with a pinned empty search_path, like every spine function, so
-- it can write through hq_emit_event regardless of the acting role; fully schema-
-- qualified throughout. The payload is small and NON-PII (Ch.04): identifiers, the
-- run's metadata, and the cost ledger — NEVER the draft prose itself (the subject /
-- body, which is customer-facing content), which stays sealed in the RLS:hq row.
-- ===========================================================================
create or replace function public.hq_drafts_emit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_severity text;
begin
  -- A generated draft is a SUCCESS; a deterministic fallback is INFO. Neither is a
  -- failure — both produced a usable draft. (ai.run_failed is for a run that did
  -- not yield a draft at all, emitted by the service, not here.)
  v_severity := case when new.status = 'generated' then 'success' else 'info' end;

  perform public.hq_emit_event(
    p_actor_type     => 'ai_employee',
    p_actor_id       => new.ai_employee_id::text,
    p_verb           => 'ai.run_completed',
    p_object_type    => 'draft',
    p_object_id      => new.id::text,
    p_target_type    => new.subject_type,
    p_target_id      => new.subject_id,
    p_correlation_id => new.correlation_id,
    p_severity       => v_severity,
    p_payload        => jsonb_build_object(
                          'kind', new.kind,
                          'status', new.status,
                          'provenance', new.provenance,
                          'model', new.model,
                          'prompt_version', new.prompt_version,
                          'prompt_checksum', new.prompt_checksum,
                          'input_tokens', new.input_tokens,
                          'output_tokens', new.output_tokens,
                          'cost_usd', new.cost_usd,
                          'latency_ms', new.latency_ms,
                          'fallback_reason', new.fallback_reason,
                          'supersedes', new.supersedes_id
                        )
  );

  return new;
end;
$$;

revoke all on function public.hq_drafts_emit() from public, anon, authenticated;
grant execute on function public.hq_drafts_emit() to service_role;

drop trigger if exists hq_drafts_emit_ins on public.hq_drafts;
create trigger hq_drafts_emit_ins
  after insert on public.hq_drafts
  for each row execute function public.hq_drafts_emit();
