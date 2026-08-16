-- CrewFlow HQ — Decision-Centre auto-proposal provenance + saga autonomous advancement.
--
-- Two shipped capabilities that turn the Decision Centre and the Workflow-Saga engine
-- from HAND-DRIVEN into DETERMINISTICALLY-FED and AUTONOMOUSLY-ADVANCING, WITHOUT ever
-- crossing the line the whole HQ layer holds: a human keeps final decision/approval
-- authority, and nothing here executes an irreversible external action.
--
--   1. AUTO-PROPOSAL. A deterministic service (server/services/hq-decision-autoproposal.ts)
--      maps REAL system signals — the HQ alert-rules engine's CRITICAL alerts (failed
--      payments, migration stalls, churn/health risk, overdue invoices, urgent support)
--      — into DRAFT `hq_decisions` proposals, born `proposed`, stamped
--      `source = 'deterministic'`, left for a HUMAN to approve/reject/delay/delegate.
--      It NEVER auto-approves and NEVER executes: it only OPENS a proposal.
--
--   2. SAGA-DRAIN. A cron (/api/cron/saga-drain) advances saga steps whose dependencies
--      are `done`, reusing the schedule-drain optimistic-claim pattern, EXCEPT steps that
--      map to an approval-gated action — those still WAIT for a human's manual advance.
--      The manual advance control stays; the drain replaces the manual-ONLY posture.
--
-- ───────────────────────────────────────────────────────────────────────────
-- What this migration adds, and what it deliberately does NOT
-- ───────────────────────────────────────────────────────────────────────────
-- The saga-drain needs NO new schema: it reuses hq_saga_steps' existing optimistic
-- claim (update … where status = 'pending' and hq_ai_task_id is null) plus the
-- Task-Engine's stable dedupe key (`saga_step:<id>`), so two overlapping ticks can
-- never double-dispatch a step. This migration therefore touches ONE table — it adds
-- the provenance the auto-proposer stamps and the idempotency key that makes it
-- safe to run every day without ever raising a duplicate proposal for the same signal.
--
-- Additive + idempotent throughout: create-if-not-exists columns, a guarded CHECK, a
-- partial-unique index, and one extra write-once BEFORE-UPDATE trigger that runs
-- ALONGSIDE (not instead of) the existing state-machine guard from 20261091000000 —
-- so the shipped deterministic state machine, terminal immutability, GDPR-erasure
-- path and append-only history are all left byte-for-byte intact.

-- ===========================================================================
-- 1. Provenance columns on hq_decisions.
--
--   • source           — who/what raised the proposal. 'human' (a super-admin at the
--                        Decision Centre form) or 'deterministic' (the auto-proposer).
--                        Defaults 'human' so every existing row is correctly labelled.
--   • source_signal_key — the STABLE key of the originating signal (e.g. an alert's
--                        (rule_id, org_id) key). NULL for human-authored proposals.
--                        The dedupe axis: at most one auto-proposal per signal, ever.
-- ===========================================================================
alter table public.hq_decisions
  add column if not exists source text not null default 'human';

alter table public.hq_decisions
  add column if not exists source_signal_key text;

-- CHECK the source vocabulary (guarded so re-applying is a no-op — ADD CONSTRAINT has
-- no IF NOT EXISTS form).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hq_decisions_source_check'
  ) then
    alter table public.hq_decisions
      add constraint hq_decisions_source_check
      check (source in ('human','deterministic'));
  end if;
end;
$$;

-- IDEMPOTENCY, structurally: at most one auto-proposal per originating signal, EVER.
-- A partial-unique index over the non-null keys makes a second insert for the same
-- signal a clean unique-violation the service treats as a no-op — so the daily
-- auto-proposer can re-run indefinitely and never raise a duplicate, even under two
-- overlapping invocations (the DB, not caller-trust, is the arbiter).
create unique index if not exists hq_decisions_source_signal_key_uidx
  on public.hq_decisions (source_signal_key)
  where source_signal_key is not null;

-- Observability: the auto-proposal backlog (deterministic proposals still awaiting a
-- human), newest first.
create index if not exists hq_decisions_deterministic_open_idx
  on public.hq_decisions (created_at desc)
  where source = 'deterministic' and status = 'proposed';

-- ===========================================================================
-- 2. Write-once provenance guard for the new columns.
--
-- A SEPARATE BEFORE-UPDATE trigger — deliberately NOT a rewrite of the shipped
-- hq_decisions_guard() (20261091000000 §3), so that 200-line state machine, its
-- terminal-immutability jsonb compare and its GDPR-erasure exception stay untouched.
-- Both BEFORE-UPDATE triggers fire; this one only pins that `source` and
-- `source_signal_key` can never be rewritten after insert. It is compatible with the
-- erasure path: erasing a decided decision's user FK leaves source/source_signal_key
-- unchanged, so this guard passes exactly when the existing guard's compare does.
-- ===========================================================================
create or replace function public.hq_decisions_source_writeonce()
returns trigger
language plpgsql
as $$
begin
  if new.source is distinct from old.source
     or new.source_signal_key is distinct from old.source_signal_key then
    raise exception 'hq_decisions %: source / source_signal_key are write-once', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists hq_decisions_source_writeonce_upd on public.hq_decisions;
create trigger hq_decisions_source_writeonce_upd
  before update on public.hq_decisions
  for each row execute function public.hq_decisions_source_writeonce();

comment on column public.hq_decisions.source is
  'Who raised the proposal: ''human'' (a super-admin at the Decision Centre) or ''deterministic'' (the auto-proposer, which opens a DRAFT proposal from real system signals and NEVER decides).';
comment on column public.hq_decisions.source_signal_key is
  'Stable key of the originating signal for a deterministic proposal (e.g. an alert (rule_id, org_id) key); NULL for human-authored proposals. Partial-unique so at most one auto-proposal exists per signal, ever.';
