-- Variation completeness — extension of time (EoT) + the priced cost basis.
--
-- Variations are NOT a table. They are rows in public.quotes carrying a
-- per-job `variation_number` (20260520180000). Everything below is therefore
-- additive columns on `quotes`, scoped by CHECK to the variation case where the
-- meaning demands it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE LIVE SEMANTIC DEFECT THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- The variation form captures a "Target completion date" — a request to extend
-- the contract programme. `createVariation` wrote it into `quotes.valid_until`,
-- which is the QUOTE EXPIRY column. Two unrelated commercial meanings shared
-- one column, and the expiry meaning is the one the system acts on:
--
--   • acceptQuoteByToken refuses any quote whose `valid_until` is in the past
--     and force-writes status='expired'. A variation asking "please let us
--     finish by 30 Sept" therefore DESTROYS ITSELF on 1 Oct — the client can
--     no longer accept it, and no operator action put it in that state.
--   • The customer-facing PDF (lib/pdf/quote-pdf.tsx) and portal
--     (app/q/[token]/page.tsx) print that date under the label
--     "Valid until" — telling the client the offer lapses on the date they
--     were asked to accept as a completion date.
--   • /quotes/[id] pre-fills the builder's "Valid until" input from it, so any
--     later save re-commits the misfiled date as a genuine expiry.
--
-- An EoT is contractual. It gets its own columns, and `valid_until` goes back
-- to meaning only "this offer lapses on".
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. NO AUTOMATIC PROGRAMME MOVE (deliberate, product decision pending)
-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing here touches `jobs`. Whether an agreed EoT shifts a job's programme
-- (and which of a job's dates it would shift) is a PRODUCT decision, not a
-- schema one: under JCT/NEC an agreed extension changes the completion date for
-- damages purposes without necessarily re-baselining the works programme, and
-- getting that wrong silently re-dates live jobs. So: we store the REQUESTED
-- date and the AGREED date, surface both, and propose nothing. There is no
-- trigger, no derived job date, and no default.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE COST BASIS THAT WAS BEING DISCARDED
-- ─────────────────────────────────────────────────────────────────────────────
-- computeVariation() derives revenue from cost + target margin, then used the
-- cost ONLY to apportion revenue across line-item unit_price. The cost itself
-- was persisted nowhere, so the moment a variation was created the margin the
-- business priced it at became unrecoverable — subtotal alone cannot yield it,
-- and margin_pct was not stored either.
--
-- These four columns are the PRICED DOCUMENT's own cost basis, the same class
-- of fact as its subtotal/vat_total/total. They are deliberately NOT a job
-- budget: a job-level budget is a plan that may legitimately CONSUME this
-- number, and must read it rather than re-key it. `cost_total` is a GENERATED
-- column precisely so no writer can make the parts and the total disagree, and
-- margin is left DERIVED (subtotal − cost_total) rather than stored, so there
-- is exactly one number for each fact.
--
-- Additive, reversible, no `finances` postings, no RESTRICT on any cascade path
-- (the only new FK is ON DELETE SET NULL to public.users — the 20261052
-- org-teardown lesson concerned AFTER DELETE triggers writing activity_log;
-- nothing here adds a DELETE-path trigger).

-- ── 1. EoT columns ───────────────────────────────────────────────────────────
alter table public.quotes
  -- What was asked for. Part of the submitted variation document.
  add column if not exists eot_requested_completion_date date,
  -- What was actually agreed. NULL until a human records it. Never derived.
  add column if not exists eot_agreed_completion_date date,
  add column if not exists eot_agreed_at timestamptz,
  add column if not exists eot_agreed_by uuid references public.users(id) on delete set null;

-- ── 2. Cost basis columns ────────────────────────────────────────────────────
alter table public.quotes
  add column if not exists cost_labour numeric(12,2),
  add column if not exists cost_materials numeric(12,2),
  add column if not exists cost_subcontractors numeric(12,2),
  add column if not exists cost_misc numeric(12,2);

-- Generated so the total can never drift from the parts. NULL (not 0) when no
-- basis was recorded at all, so "not priced" stays distinguishable from
-- "priced at zero cost" — a distinction any margin report needs.
alter table public.quotes
  add column if not exists cost_total numeric(12,2)
    generated always as (
      case
        when cost_labour is null
         and cost_materials is null
         and cost_subcontractors is null
         and cost_misc is null
        then null
        else coalesce(cost_labour, 0) + coalesce(cost_materials, 0)
           + coalesce(cost_subcontractors, 0) + coalesce(cost_misc, 0)
      end
    ) stored;

comment on column public.quotes.eot_requested_completion_date is
  'Extension-of-time REQUEST recorded on a variation: the completion date asked for. NOT an expiry (see valid_until) and never auto-applied to the job.';
comment on column public.quotes.eot_agreed_completion_date is
  'Extension of time as AGREED. Written only by an explicit operator action; the job programme is never moved automatically.';
comment on column public.quotes.cost_total is
  'GENERATED sum of the four cost_* parts; NULL when none recorded. The single per-variation cost figure — a job budget must read this, not re-key it.';

-- ── 3. Semantic constraints ──────────────────────────────────────────────────
do $$
begin
  -- An EoT extends an EXISTING contract, so it only means anything on a
  -- variation. A plain quote has nothing to extend.
  if not exists (
    select 1 from pg_constraint
    where conname = 'quotes_eot_variation_only'
      and conrelid = 'public.quotes'::regclass
  ) then
    alter table public.quotes
      add constraint quotes_eot_variation_only check (
        variation_number is not null
        or (eot_requested_completion_date is null
            and eot_agreed_completion_date is null
            and eot_agreed_at is null
            and eot_agreed_by is null)
      );
  end if;

  -- An agreed date is a contractual determination: it must carry when it was
  -- recorded, so it can never appear without provenance.
  if not exists (
    select 1 from pg_constraint
    where conname = 'quotes_eot_agreed_audited'
      and conrelid = 'public.quotes'::regclass
  ) then
    alter table public.quotes
      add constraint quotes_eot_agreed_audited check (
        eot_agreed_completion_date is null or eot_agreed_at is not null
      );
  end if;

  -- Cost is money.
  if not exists (
    select 1 from pg_constraint
    where conname = 'quotes_cost_basis_non_negative'
      and conrelid = 'public.quotes'::regclass
  ) then
    alter table public.quotes
      add constraint quotes_cost_basis_non_negative check (
        coalesce(cost_labour, 0) >= 0
        and coalesce(cost_materials, 0) >= 0
        and coalesce(cost_subcontractors, 0) >= 0
        and coalesce(cost_misc, 0) >= 0
      );
  end if;
end $$;

-- ── 4. Extend the accepted-document freeze ───────────────────────────────────
-- The existing freeze (20261004, hardened 20261007) keys on accepted_at and
-- covers subtotal/vat_total/total + accepted_at itself. Those clauses are
-- reproduced BYTE-FOR-BYTE below — the accepted-quote immutability invariant
-- and its integration suite must not move.
--
-- Added: the two facts that form part of the agreed document.
--   • eot_requested_completion_date — what the client was asked to agree.
--   • the cost basis                — the margin the business agreed to.
--
-- Both are WRITE-ONCE rather than absolutely frozen: a NULL→value write is a
-- data COMPLETION (every variation created before this migration has NULL in
-- all five, and the remediation path for a misfiled date must be able to reach
-- accepted rows — those are exactly the rows the defect trapped), while
-- value→different-value is a REWRITE of an agreed figure and is refused.
--
-- Deliberately NOT frozen: eot_agreed_completion_date / eot_agreed_at /
-- eot_agreed_by. An extension is agreed AFTER the variation is accepted; that
-- is the whole point of the field, so post-acceptance writes are the normal
-- path.
create or replace function public.tg_quotes_freeze_accepted()
returns trigger language plpgsql as $$
begin
  if old.accepted_at is not null then
    if new.subtotal is distinct from old.subtotal
       or new.vat_total is distinct from old.vat_total
       or new.total is distinct from old.total then
      raise exception 'quote % has been accepted; its amounts are frozen', old.id
        using errcode = 'check_violation';
    end if;
    -- accepted_at is the freeze key — it must not be cleared or moved.
    if new.accepted_at is distinct from old.accepted_at then
      raise exception 'quote % has been accepted; accepted_at is frozen', old.id
        using errcode = 'check_violation';
    end if;
    -- Write-once: the requested completion date the client agreed to.
    if old.eot_requested_completion_date is not null
       and new.eot_requested_completion_date
           is distinct from old.eot_requested_completion_date then
      raise exception
        'quote % has been accepted; its requested completion date is frozen', old.id
        using errcode = 'check_violation';
    end if;
    -- Write-once: the cost basis behind the agreed margin.
    if (old.cost_labour is not null
        and new.cost_labour is distinct from old.cost_labour)
       or (old.cost_materials is not null
        and new.cost_materials is distinct from old.cost_materials)
       or (old.cost_subcontractors is not null
        and new.cost_subcontractors is distinct from old.cost_subcontractors)
       or (old.cost_misc is not null
        and new.cost_misc is distinct from old.cost_misc) then
      raise exception 'quote % has been accepted; its cost basis is frozen', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. BACKFILL — PROPOSED, NOT EXECUTED. DO NOT UNCOMMENT WITHOUT A HUMAN.
-- ─────────────────────────────────────────────────────────────────────────────
-- Rows created by the buggy path carry a COMPLETION date in `valid_until`. They
-- cannot be told apart from rows where an operator later set a GENUINE expiry
-- through the /quotes/[id] builder, because:
--   • there is no column-level history (_tg_quotes_activity records only
--     sent/viewed/accepted/declined, never a generic update), and
--   • the builder PRE-FILLS its "Valid until" input from the same column, so an
--     operator editing anything else re-submits the misfiled date unchanged.
-- A blind UPDATE would therefore relabel some real expiries as completion
-- dates. That is a guess, so this migration does not make it.
--
-- Sizing query (run read-only first; the third bucket is the ambiguous one):
--
--   select count(*) filter (where valid_until is null)             as no_date,
--          count(*) filter (where accepted_at is not null
--                             and valid_until is not null)         as accepted_with_date,
--          count(*) filter (where accepted_at is null
--                             and valid_until is not null)         as open_with_date
--     from public.quotes
--    where variation_number is not null;
--
-- Proposed remediation, in preference order:
--   (a) PER ROW, BY THE OPERATOR WHO KNOWS — shipped in this change. Any
--       variation with `valid_until` set and `eot_requested_completion_date`
--       NULL renders a warning on /quotes/[id] with a one-click
--       "reclassifyVariationValidUntilAsEot" action. Correct by construction:
--       the human who raised it decides, and the write is audited.
--   (b) BULK, ONLY IF A HUMAN CONFIRMS no operator ever set a real expiry on a
--       variation:
--         update public.quotes
--            set eot_requested_completion_date = valid_until,
--                valid_until = null
--          where variation_number is not null
--            and valid_until is not null
--            and eot_requested_completion_date is null;
--       (This is legal even on accepted rows: the write-once clause above
--        permits NULL→value, and valid_until has never been frozen.)
