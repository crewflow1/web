-- CrewFlow HQ — the auto morning CEO briefing store (P2 HQ AI Operating System).
--
-- The HQ CEO surface (server/services/hq-ceo.ts) is a read-only aggregator: an operator
-- who opens /admin sees a fresh executive board, but nothing COMPOSES and RECORDS a
-- durable daily briefing on its own. This migration is the durable home for that
-- briefing, and a morning cron (app/api/cron/hq-ceo-briefing) composes one row per day
-- from the same real signals the CEO board already reads.
--
-- ───────────────────────────────────────────────────────────────────────────
-- DETERMINISTIC ONLY — generative prose is dark by construction
-- ───────────────────────────────────────────────────────────────────────────
-- A briefing row's `source` is CHECK-pinned to the single literal 'deterministic', and
-- the ONLY write path (hq_record_ceo_briefing) hardcodes it — mirroring the Shadow
-- Truthfulness Rule's `kind` hardcode (20260815*). The narrative is composed by pure
-- deterministic code (lib/hq/ceo-briefing.ts) from real board signals; it fabricates
-- nothing (an absent signal is reported as "insufficient", never invented). The
-- generative variant — free-form model prose over the same signals — is DARK: it would
-- write `source = 'generated'`, which this CHECK forbids, so it cannot be recorded until
-- a migration widens the contract AND a model tier is bound in the governor. Darkness is
-- structural, not a config flag.
--
-- Provably additive: a brand-new table + one write function, no tenant table touched, no
-- producer wired by this migration (the cron wires the store in TypeScript). Hardening
-- mirrors the executor-shadow store (20260815*) and the HQ Event Spine
-- (20260720000000): RLS:hq, SECURITY DEFINER write primitive, EXECUTE revoked from
-- anon/authenticated and granted only to service_role, append-only guard.

-- ---------------------------------------------------------------------------
-- 1. hq_ceo_briefings — append-only briefing facts. RLS:hq. One row per day.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_ceo_briefings (
  id             bigint      generated always as identity primary key,
  -- One briefing per calendar day — the natural key that makes the cron idempotent.
  briefing_date  date        not null,
  -- CHECK-pinned to the single literal so this table can hold NOTHING but a
  -- deterministically-composed briefing (generative prose is dark — see header).
  source         text        not null default 'deterministic'
                             check (source = 'deterministic'),
  -- The run's spine trace id — threads the briefing to the cron run that composed it.
  correlation_id uuid,
  -- The one-line executive headline (deterministic).
  headline       text        not null,
  -- The composed deterministic narrative (multi-line plain text).
  narrative      text        not null,
  -- The real signal snapshot the narrative was composed from — the honesty record: the
  -- narrative can always be re-derived from these figures, so it can never drift from them.
  signals        jsonb       not null default '{}'::jsonb,
  -- Assigned by the store, not the caller.
  generated_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint hq_ceo_briefings_one_per_day unique (briefing_date)
);

create index if not exists hq_ceo_briefings_date_idx
  on public.hq_ceo_briefings (briefing_date desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) writes/reads; every JWT
-- client (anon/authenticated) is denied. No table grant can open it — RLS denies the rows.
alter table public.hq_ceo_briefings enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a recorded briefing is a fact about one morning, never
--    updated or deleted. Reject UPDATE/DELETE even under service-role, so a briefing
--    can never be rewritten after the fact (immutable-audit). Mirrors the spine and the
--    executor-shadow store.
-- ---------------------------------------------------------------------------
create or replace function public.hq_ceo_briefings_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_ceo_briefings is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_ceo_briefings_no_update on public.hq_ceo_briefings;
create trigger hq_ceo_briefings_no_update
  before update on public.hq_ceo_briefings
  for each row execute function public.hq_ceo_briefings_block_mutation();

drop trigger if exists hq_ceo_briefings_no_delete on public.hq_ceo_briefings;
create trigger hq_ceo_briefings_no_delete
  before delete on public.hq_ceo_briefings
  for each row execute function public.hq_ceo_briefings_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. hq_record_ceo_briefing — the single validated write entry point. SECURITY
--    DEFINER, service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The
--    `source` label is HARDCODED to 'deterministic' — there is no p_source parameter,
--    so this function can write NOTHING but a deterministic briefing (the generative
--    variant is dark). Idempotent per day: `on conflict (briefing_date) do nothing`,
--    then it returns the id of the day's briefing whether this call wrote it or not
--    (first-write-wins), so a re-run of the cron never raises and never duplicates.
-- ---------------------------------------------------------------------------
create or replace function public.hq_record_ceo_briefing(
  p_briefing_date  date,
  p_headline       text,
  p_narrative      text,
  p_signals        jsonb default '{}'::jsonb,
  p_correlation_id uuid  default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.hq_ceo_briefings (
    briefing_date, source, correlation_id, headline, narrative, signals
  ) values (
    -- HARDCODED: the write path cannot emit any other source (generative prose is dark).
    p_briefing_date, 'deterministic', p_correlation_id, p_headline, p_narrative,
    coalesce(p_signals, '{}'::jsonb)
  )
  on conflict (briefing_date) do nothing
  returning id into v_id;

  -- First-write-wins: if a briefing for this day already existed, the insert wrote
  -- nothing and v_id is null — return the existing day's id so the caller is a no-op
  -- success rather than an error.
  if v_id is null then
    select id into v_id from public.hq_ceo_briefings where briefing_date = p_briefing_date;
  end if;

  return v_id;
end;
$$;

revoke all on function public.hq_record_ceo_briefing(date, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.hq_record_ceo_briefing(date, text, text, jsonb, uuid)
  to service_role;
