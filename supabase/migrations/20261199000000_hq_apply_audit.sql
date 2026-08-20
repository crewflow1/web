-- CrewFlow HQ — the immutable apply-attempt audit (P2 HQ Autonomous Apply)
-- (CEO Directive #014 / D-04, Phase C; ADR 0009 Decisions 3, 8, 9; the Executor Boundary Rule).
--
-- The apply substrate (server/sdk/executor.ts, server/sdk/autonomous-apply.ts,
-- server/services/hq-apply-drain.ts) completes the autonomous-apply capability: a cleared/approved,
-- DETERMINISTIC action is planned, executed through a sanctioned SECURITY DEFINER boundary, VERIFIED,
-- and ROLLED BACK on a failed verification. This migration gives that lifecycle its permanent,
-- append-only home — a record of EVERY attempt and the ordered stage trail it took
-- (approved · executed · verified · rolled_back · refused · failed) — exactly as 20261106000000 gave
-- the apply-once "applied" marker its durable home. It exists so activating the capability is a
-- CONFIG FLIP (inject the durable sink + a bound registry, flip FEATURE_HQ_AUTONOMOUS_APPLY), not an
-- engineering change.
--
-- WHAT IT IS, AND IS NOT.
--   • It IS the immutable audit of what the apply machinery attempted: which path (autonomous inline
--     vs the approval sweep), which tool + action identity, the terminal stage, the ordered step
--     trail, and a human-readable detail.
--   • It is DISTINCT from the apply-once ground truth (hq_application_records, 20261106000000): that
--     table is the idempotency key store the sweep reads to avoid a double-apply; THIS table is the
--     forensic trail of every attempt regardless of fate (including pre-boundary REFUSALS, which
--     never touch the apply-once store at all).
--   • It is NOT the authority to apply. Recording an attempt happens only when a bound authority
--     crosses (or declines) the boundary; the authority to cross into a real effect stays gated by
--     FEATURE_HQ_AUTONOMOUS_APPLY (off in prod) on top of the sweep kill-switch and the posture floor.
--
-- PRODUCTION-INERT TODAY. Nothing writes here in production: the shipped authorities resolve every
-- descriptor to null while FEATURE_HQ_AUTONOMOUS_APPLY is off, so no attempt is ever recorded. The
-- table is proven behind the flag (in-memory sink in unit tests; this durable home for activation).
--
-- HQ-GLOBAL SCOPING, consistent with every other hq_* table (hq_application_records,
-- hq_ai_executor_shadow_observations). HQ has no tenant org: this is HQ infrastructure, not tenant
-- data, so there is no org_id to pin (not org-scoped ⇒ outside the GDPR org-census). RLS ENABLED,
-- ZERO policies: service_role (BYPASSRLS) writes through the SECURITY DEFINER function; every JWT
-- client (anon/authenticated) is denied.
--
-- Provably additive: a brand-new table + function, no tenant table touched, no producer wired by this
-- migration (the runtime injects the durable sink behind the default-off build flag in TypeScript).
-- Hardening mirrors 20261106000000: RLS:hq, a SECURITY DEFINER write primitive with EXECUTE revoked
-- from anon/authenticated and granted only to service_role, and an append-only guard.

-- ---------------------------------------------------------------------------
-- 1. hq_apply_audit — append-only apply-attempt audit. RLS:hq.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_apply_audit (
  id             bigint      generated always as identity primary key,

  -- Which apply path produced the attempt.
  path           text        not null check (path in ('autonomous','approval')),

  -- The registered tool the attempt applied (or would have) and the action's stable identity.
  tool_label     text        not null,
  action_id      text        not null,
  -- The run's spine trace id — threads the attempt into its originating run.
  correlation_id text        not null,

  -- The attempt's TERMINAL stage — the single word that says how it ended.
  stage          text        not null check (
    stage in ('approved','refused','executed','verified','rolled_back','failed')
  ),

  -- The ordered stage trail (ApplyAuditStep[]) — an array of {stage, detail} objects. Empty for a
  -- pre-boundary refusal (the boundary was never crossed).
  steps          jsonb       not null default '[]'::jsonb,

  -- A human-readable summary of the terminal stage.
  detail         text        not null,

  -- Assigned by the store, not the pure record builder (mirrors hq_application_records.applied_at).
  recorded_at    timestamptz not null default now()
);

-- Observability: the audit for one run, and for one action across attempts.
create index if not exists hq_apply_audit_corr_idx
  on public.hq_apply_audit (correlation_id);
create index if not exists hq_apply_audit_action_idx
  on public.hq_apply_audit (action_id, id desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) writes; every JWT client
-- (anon/authenticated) is denied. No table grant can open it — RLS denies the rows.
alter table public.hq_apply_audit enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — an audit entry is a fact about one apply attempt, never updated or deleted.
--    Reject UPDATE/DELETE even under service-role, so the forensic trail is permanent. Mirrors the
--    hq_application_records / shadow store / event-spine guards.
-- ---------------------------------------------------------------------------
create or replace function public.hq_apply_audit_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_apply_audit is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_apply_audit_no_update on public.hq_apply_audit;
create trigger hq_apply_audit_no_update
  before update on public.hq_apply_audit
  for each row execute function public.hq_apply_audit_block_mutation();

drop trigger if exists hq_apply_audit_no_delete on public.hq_apply_audit;
create trigger hq_apply_audit_no_delete
  before delete on public.hq_apply_audit
  for each row execute function public.hq_apply_audit_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. hq_record_apply_audit — the single validated write entry point.
--    SECURITY DEFINER, service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). It takes
--    NO uuid/org argument and is not anon/authenticated-executable, so it is outside the
--    secdef-org-rpc membership-guard class (20261116000000) by construction. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.hq_record_apply_audit(
  p_path           text,
  p_tool_label     text,
  p_action_id      text,
  p_correlation_id text,
  p_stage          text,
  p_detail         text,
  p_steps          jsonb default '[]'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.hq_apply_audit (
    path, tool_label, action_id, correlation_id, stage, steps, detail
  ) values (
    p_path, p_tool_label, p_action_id, p_correlation_id, p_stage,
    coalesce(p_steps, '[]'::jsonb), p_detail
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.hq_record_apply_audit(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.hq_record_apply_audit(
  text, text, text, text, text, text, jsonb
) to service_role;
