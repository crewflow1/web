-- Job cost baseline — the figure every other cost number on a job is measured
-- against, and which CrewFlow has never had.
--
-- THE GAP THIS CLOSES. Across 231 migrations there is no `budget`,
-- `estimated_cost` or `planned_cost` column anywhere. So /jobs/[id]/commercial
-- can show ACTUAL cost, gross profit and margin — but only ever against
-- REVENUE. There is no budget-vs-actual, no cost-value reconciliation, and no
-- forecast final cost, which means the two questions a builder actually asks
-- mid-job ("am I over?", "where does this land?") have no answer in the product.
-- `marginBand()`'s 30 %/15 % thresholds are hardcoded universals because there
-- was nothing per-job to compare against.
--
-- Worse, the ONE place a cost estimate is already computed throws it away:
-- `computeVariation()` (lib/variations/schema.ts) derives `total_cost` and a
-- four-bucket breakdown from the operator's own figures, uses them only to
-- apportion revenue across `quote_line_items.unit_price`, and persists neither.
-- The operator types their cost plan into the product every time they raise a
-- variation and the product forgets it.
--
-- ── THE ACCOUNTING BOUNDARY ─────────────────────────────────────────────────
-- NEITHER TABLE HERE POSTS TO `finances`, AND NEITHER MAY EVER.
--
-- A budget is a PLAN, not a transaction. `finances` is the actual-cost ledger
-- that job profitability, VAT and CIS all read. If a baseline (or a variation's
-- cost estimate) ever landed there it would be double-counted the moment the
-- real supplier bill arrived — the estimate once when it was planned, the spend
-- again when it was incurred — and every affected job's cost would be silently
-- inflated with no way to tell the plan from the money. That is the same
-- double-count hazard the operational-stock milestone was allowed to ship on
-- (CEO decision D1 is still undecided there, and stock still posts nothing);
-- the rule is identical here and the reason is stronger, because a plan is not
-- even a claim that money moved.
--
-- Structurally, not just by convention: there is no trigger on `finances`, no
-- writer of it, and no money column on either table that any process could
-- mistake for an incurred cost. The boundary is swept by
-- __tests__/security/job-budgets.test.ts (an extension of the D1 sweep in
-- __tests__/security/operational-stock.test.ts).
--
-- ── GRANULARITY: PER-JOB TOTAL, WITH OPTIONAL FOUR-BUCKET DETAIL ────────────
-- The four buckets are the ones that already exist and are already mapped from
-- live data — `labour` / `materials` / `subcontractors` / `misc`
-- (lib/profitability/compute.ts COST_BUCKETS + mapToCostBucket). No new cost
-- category is invented, and bucket detail is OPTIONAL: a total-only budget is
-- complete and useful on day one.
--
-- Four NULLABLE COLUMNS rather than a `job_budget_lines` child table, because
-- the bucket set is CLOSED and of fixed arity 4. A child table would need a
-- CHECK to stop a fifth category, a unique index to stop a duplicate bucket
-- row, a trigger to keep Σ(lines) honest against the header, and a second read
-- and composite FK — all to model four numbers. As columns, "no detail" and
-- "detail" are structurally distinct (all four NULL vs all four set), a fifth
-- category is unrepresentable, and Σ = total is one row-level CHECK. The shape
-- also already exists in the product: the variation form has captured exactly
-- these four fields since 20260520180000.
--
-- Detail is ALL FOUR OR NONE, and when present it sums EXACTLY to total_cost.
-- Partial detail would leave an unallocated remainder that no tile could name
-- honestly, and a builder who cannot place a pound has `misc` — which is
-- exactly where mapToCostBucket() sends every unrecognised ACTUAL cost, so the
-- plan and the actual land in the same bucket by construction.
--
-- A per-QUOTE-LINE baseline is NOT foreclosed by this: it would be a child of
-- quote_line_items rolling up INTO these same four buckets, and this table
-- would remain the job-level header it computes against.
--
-- ── REVISIONS: WRITE-ONCE + SUPERSEDE, NOT UPDATE-IN-PLACE ──────────────────
-- Budgets get revised — that is the whole point of having one. The question is
-- whether a revision overwrites its predecessor or supersedes it.
--
-- This codebase answers that consistently for every figure people revise, and
-- always the same way: quotes preserve the original and DERIVE the revised
-- value from accepted variations (lib/jobs/commercial-position.ts);
-- job_billing_plans keep one ACTIVE plan per job behind a partial unique index
-- and require the old one to be cancelled (20261039); stock_movements are
-- append-only and corrected by a new row (20261064); a billing stage freezes
-- once invoiced (20261039); a CIS bill value freezes once filed (20261053).
--
-- A cost baseline is the strongest case of all, because it is the DENOMINATOR
-- of a judgement about someone's performance. "We said £40k, we spent £52k" is
-- a conversation; an UPDATE turns it into "we always said £52k" and destroys
-- the only evidence the plan moved. So:
--
--   * every revision is a NEW ROW (revision 1, 2, 3 …);
--   * exactly one row per job is CURRENT (superseded_at IS NULL), enforced by a
--     partial unique index — the job_billing_plans mechanism exactly;
--   * a written row is immutable for every role except for the single act of
--     stamping superseded_at, enforced by trigger, so history cannot be edited;
--   * revision 1 needs no justification, but EVERY LATER REVISION STRUCTURALLY
--     REQUIRES A NOTE (a CHECK, not form validation) — a silent re-baseline is
--     the one thing this design exists to prevent.
--
-- There is no `superseded_by` column, deliberately: the superseding row's
-- `created_by` already records who revised it, and a second FK to public.users
-- would make a bare `users(...)` embed on this table ambiguous (PGRST201 — the
-- incident pinned by __tests__/security/postgrest-embed-ambiguity.test.ts).
-- One FK to users, so no new reviewed pair.
--
-- ── TENANCY IS STRUCTURAL ───────────────────────────────────────────────────
-- Both tables bind their parent by COMPOSITE FK — (job_id, org_id) →
-- jobs (id, org_id) and (quote_id, org_id) → quotes (id, org_id) — so a forged
-- parent id cannot cross tenants even for service_role, and even if an app-layer
-- active-org filter is ever forgotten. Neither parent had an (id, org_id)
-- candidate key, so this migration adds them, which is the same additive step
-- 20261056 (assets), 20261059 (purchase_orders), 20261063/64 (stock, sites,
-- goods_received_lines) and 20261046 (suppliers) each took. It can never reject
-- a row: `id` is already the PRIMARY KEY of both tables, so (id, org_id) is
-- unique by construction and the constraint validates instantly against
-- existing data.
--
-- NOTE 20261039 chose a SECURITY DEFINER guard trigger for exactly this job↔org
-- binding, and said why: "jobs has no (id, org_id) candidate key, so a composite
-- FK isn't available for job_id". That is no longer true after this migration.
-- Its trigger is left alone (behaviour-preserving); new tables get the stronger
-- form.
--
-- ON DELETE CASCADE is correct on both, and is what makes them teardown-safe.
-- A plan for a job that no longer exists is not history, it is litter; and
-- unlike stock_movements (a ledger that must outlive its job) there is nothing
-- here to preserve. CASCADE also cannot block `delete from organizations` the
-- way `RESTRICT` would — RESTRICT can never be deferred, which is precisely how
-- the 20261052 org-teardown P1 happened. There is NO `ON DELETE RESTRICT` and
-- NO `AFTER DELETE` activity trigger anywhere in this file.
--
-- Additive and reversible. To roll back:
--   drop table public.quote_cost_estimates;
--   drop table public.job_budgets;
--   drop function public.tg_job_budget_immutable();
--   drop function public.tg_job_budget_no_targeted_delete();
--   drop function public.tg_quote_cost_estimate_immutable();
--   alter table public.jobs   drop constraint jobs_id_org_key;
--   alter table public.quotes drop constraint quotes_id_org_key;
-- Migrate-first safe: the app reads both tables best-effort; absent → no
-- baseline, and every surface degrades to exactly today's behaviour.

-- ── 1. candidate keys the composite FKs need (additive; cannot reject a row) ──
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_id_org_key'
  ) then
    alter table public.jobs add constraint jobs_id_org_key unique (id, org_id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_id_org_key'
  ) then
    alter table public.quotes add constraint quotes_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 2. job_budgets — the append-only cost baseline ───────────────────────────
create table if not exists public.job_budgets (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  job_id              uuid not null,
  revision            int not null default 1 check (revision >= 1),
  -- EX-VAT, like `finances.amount` (the ACTUAL side) and unlike the cash rows.
  -- Budgeting gross against a net actual would report a ~20 % variance on a job
  -- that is exactly on plan.
  total_cost          numeric(12,2) not null default 0 check (total_cost >= 0),
  -- OPTIONAL detail, in the FOUR EXISTING buckets. All four or none (see header).
  labour_cost         numeric(12,2) check (labour_cost is null or labour_cost >= 0),
  materials_cost      numeric(12,2) check (materials_cost is null or materials_cost >= 0),
  subcontractors_cost numeric(12,2) check (subcontractors_cost is null or subcontractors_cost >= 0),
  misc_cost           numeric(12,2) check (misc_cost is null or misc_cost >= 0),
  -- OPTIONAL per-job margin target. When set, lib/profitability/compute.ts
  -- marginBand() bands against it instead of the universal 30/15; when NULL the
  -- universal thresholds apply unchanged. Capped at 95 to match the variation
  -- form's margin ceiling, floored at 0 because a "target" loss is not a target.
  target_margin_pct   numeric(5,2) check (
                        target_margin_pct is null
                        or (target_margin_pct >= 0 and target_margin_pct <= 95)
                      ),
  note                text check (note is null or length(note) <= 2000),
  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  -- NULL = this is the CURRENT baseline. Stamped when a later revision lands.
  superseded_at       timestamptz,
  constraint job_budgets_job_fk
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,
  -- Detail is all four or none — never a partial breakdown with an unnameable
  -- remainder.
  constraint job_budgets_detail_all_or_none check (
    num_nulls(labour_cost, materials_cost, subcontractors_cost, misc_cost) in (0, 4)
  ),
  -- …and when it is present it accounts for every pound of the total.
  constraint job_budgets_detail_sums_to_total check (
    labour_cost is null
    or round(labour_cost + materials_cost + subcontractors_cost + misc_cost, 2)
       = round(total_cost, 2)
  ),
  -- A row that budgets nothing and targets nothing is noise.
  constraint job_budgets_not_empty check (
    total_cost > 0 or target_margin_pct is not null
  ),
  -- The first baseline needs no defence. Moving it does.
  constraint job_budgets_revision_needs_reason check (
    revision = 1 or (note is not null and length(trim(note)) > 0)
  ),
  -- Composite-FK target for any future child (e.g. a per-quote-line baseline).
  constraint job_budgets_id_org_key unique (id, org_id)
);

-- Exactly ONE current baseline per job — the job_billing_plans_one_active
-- mechanism. A concurrent double-submit loses the race at the index rather than
-- leaving two live baselines and a coin-flip variance.
create unique index if not exists job_budgets_one_current
  on public.job_budgets (job_id) where superseded_at is null;
-- The revision chain is dense and unambiguous.
create unique index if not exists job_budgets_job_revision_uniq
  on public.job_budgets (job_id, revision);
create index if not exists job_budgets_org_job_idx
  on public.job_budgets (org_id, job_id);

-- ── 3. history is immutable; only the supersede stamp may be written ─────────
-- For EVERY role, including service_role. A baseline that can be edited after
-- the fact is not a baseline. The single legal UPDATE is setting superseded_at
-- on the current row as the next revision lands.
create or replace function public.tg_job_budget_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.superseded_at is not null then
    raise exception 'budget revision % is history and cannot be changed', old.revision
      using errcode = 'check_violation';
  end if;
  if new.superseded_at is null
     or new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.job_id is distinct from old.job_id
     or new.revision is distinct from old.revision
     or new.total_cost is distinct from old.total_cost
     or new.labour_cost is distinct from old.labour_cost
     or new.materials_cost is distinct from old.materials_cost
     or new.subcontractors_cost is distinct from old.subcontractors_cost
     or new.misc_cost is distinct from old.misc_cost
     or new.target_margin_pct is distinct from old.target_margin_pct
     or new.note is distinct from old.note
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'a budget revision is immutable — record a new revision instead'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists job_budgets_immutable on public.job_budgets;
create trigger job_budgets_immutable before update on public.job_budgets
  for each row execute function public.tg_job_budget_immutable();

-- ── 4. a targeted delete is refused; every CASCADE still works ──────────────
-- The 20261047 / 20261064 idiom, extended one level. During a cascade the
-- PARENT ROW IS ALREADY GONE (PostgreSQL deletes the referenced row, then runs
-- the referential action), so:
--
--   delete from organizations …  → org absent  → allowed  (GDPR teardown)
--   delete from jobs …           → job absent  → allowed  (job removal)
--   delete from job_budgets …    → both present → REFUSED (history is not
--                                                 deletable, for any role)
--
-- This is the trap 20261052 documents: a BEFORE DELETE guard that only asks
-- about the organisation would have blocked ordinary job deletion outright,
-- because a job dies while its org is very much alive.
--
-- SECURITY DEFINER is load-bearing, for the reason 20261052 sets out at length:
-- both existence checks must be TRUE facts about the database, not facts about
-- what the caller may see. A caller whose RLS hides the organisation or the job
-- would make the check say "already gone" and the guard would silently permit
-- the delete it exists to refuse. Owned by postgres, which bypasses RLS, so the
-- answer is the same for every caller.
create or replace function public.tg_job_budget_no_targeted_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id)
     and exists (select 1 from public.jobs where id = old.job_id) then
    raise exception 'a budget revision cannot be deleted — the baseline history is the audit trail'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;
drop trigger if exists job_budgets_no_targeted_delete on public.job_budgets;
create trigger job_budgets_no_targeted_delete before delete on public.job_budgets
  for each row execute function public.tg_job_budget_no_targeted_delete();

-- ── 5. RLS — members read, admins write (job-level commercial configuration) ─
-- The 20261039 posture, and DB-enforced for the same reason: an app-only gate
-- leaves /rest/v1/job_budgets open to any member holding a JWT. There is NO
-- delete policy at all, so a tenant delete is refused twice over (no policy,
-- then the trigger).
alter table public.job_budgets enable row level security;

drop policy if exists "job_budgets: members can select" on public.job_budgets;
create policy "job_budgets: members can select" on public.job_budgets
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_budgets: admins can insert" on public.job_budgets;
create policy "job_budgets: admins can insert" on public.job_budgets
  for insert to authenticated with check (public.is_org_admin(org_id));
drop policy if exists "job_budgets: admins can supersede" on public.job_budgets;
create policy "job_budgets: admins can supersede" on public.job_budgets
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ── 6. set_job_budget — supersede + insert, ATOMICALLY ──────────────────────
-- Recording a revision is TWO statements: stamp the current row, insert the
-- next. Split across two PostgREST round trips they cannot be atomic, and the
-- order is a choice between two bad failure modes — insert first and
-- `job_budgets_one_current` refuses it (two live baselines are unrepresentable,
-- which is the point); supersede first and a failed insert leaves the job with
-- NO current baseline, i.e. the plan silently deleted. One function is one
-- transaction, so neither is reachable.
--
-- SECURITY INVOKER, deliberately: the caller's RLS still applies, so the
-- admins-only insert/update policies above are the real authorisation and this
-- is not a privileged back door around them (the stock-RPC rule, 20261065).
--
-- A per-job advisory lock serialises two admins saving at once. The partial
-- unique index would already refuse the second one, but with a raw constraint
-- error; under the lock the loser instead re-reads the row it must supersede and
-- gets a sentence. Same reason the stock write paths take one.
create or replace function public.set_job_budget(
  p_job_id              uuid,
  p_org_id              uuid,
  p_total_cost          numeric,
  p_labour_cost         numeric default null,
  p_materials_cost      numeric default null,
  p_subcontractors_cost numeric default null,
  p_misc_cost           numeric default null,
  p_target_margin_pct   numeric default null,
  p_note                text    default null
)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_current  public.job_budgets;
  v_revision int := 1;
  v_total    numeric(12,2);
  v_id       uuid;
begin
  if p_job_id is null or p_org_id is null then
    raise exception 'a job and an organisation are required';
  end if;

  -- WHEN BUCKET DETAIL IS SUPPLIED THE TOTAL IS DERIVED FROM IT, never taken
  -- from the caller. Two authorities for one number is one too many: the
  -- job_budgets_detail_sums_to_total CHECK would refuse a mismatch, but refusing
  -- is worse than making the mismatch unrepresentable — a caller that computed
  -- the total slightly differently (a rounding step, a stale field) would fail at
  -- the constraint with nothing an operator could act on.
  if num_nulls(p_labour_cost, p_materials_cost, p_subcontractors_cost, p_misc_cost)
     not in (0, 4) then
    raise exception 'a cost breakdown must give all four figures or none of them';
  end if;
  if p_labour_cost is not null then
    v_total := round(
      p_labour_cost + p_materials_cost + p_subcontractors_cost + p_misc_cost, 2);
  else
    v_total := round(coalesce(p_total_cost, 0), 2);
  end if;

  perform pg_advisory_xact_lock(hashtext('job_budget'), hashtext(p_job_id::text));

  select * into v_current
    from public.job_budgets
   where job_id = p_job_id
     and org_id = p_org_id
     and superseded_at is null
   for update;

  if found then
    v_revision := v_current.revision + 1;
    update public.job_budgets set superseded_at = now() where id = v_current.id;
  end if;

  insert into public.job_budgets (
    org_id, job_id, revision, total_cost,
    labour_cost, materials_cost, subcontractors_cost, misc_cost,
    target_margin_pct, note, created_by
  ) values (
    p_org_id, p_job_id, v_revision, v_total,
    round(p_labour_cost, 2), round(p_materials_cost, 2),
    round(p_subcontractors_cost, 2), round(p_misc_cost, 2),
    p_target_margin_pct, nullif(btrim(p_note), ''), auth.uid()
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.set_job_budget(
  uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric, text
) from public, anon;
grant execute on function public.set_job_budget(
  uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric, text
) to authenticated;

-- ── 7. quote_cost_estimates — stop discarding computeVariation()'s figures ───
-- One row per quote, holding the four-bucket cost estimate the operator entered
-- and the margin they asked for. This is the SUPPLY side of the cost baseline:
-- an ACCEPTED variation's estimate is a committed addition to the plan, exactly
-- as its `total` is a committed addition to the contract value
-- (lib/jobs/commercial-position.ts). Without this row the product could add
-- scope to the revenue side and had nothing to add to the cost side, so a
-- variation always improved the apparent margin.
--
-- WRITE-ONCE. It records what was estimated AT THE TIME the variation was
-- raised, which is the only thing a later variance can be measured against, and
-- the product has no path that re-prices a variation's cost breakdown (the
-- form is create-only). No update policy, and a trigger refuses one anyway.
-- STATED RESIDUAL: editing the quote's line items afterwards can move its
-- `total` without moving this estimate. That is the honest failure mode — the
-- estimate goes stale and visibly so, rather than being silently rewritten to
-- match a number it did not produce.
create table if not exists public.quote_cost_estimates (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  quote_id            uuid not null,
  -- Ex-VAT, and the same four buckets. NOT NULL here (unlike job_budgets):
  -- computeVariation() always produces all four, so an absent bucket would mean
  -- a lossy write, not an operator choice.
  labour_cost         numeric(12,2) not null default 0 check (labour_cost >= 0),
  materials_cost      numeric(12,2) not null default 0 check (materials_cost >= 0),
  subcontractors_cost numeric(12,2) not null default 0 check (subcontractors_cost >= 0),
  misc_cost           numeric(12,2) not null default 0 check (misc_cost >= 0),
  total_cost          numeric(12,2) not null check (total_cost >= 0),
  -- The margin the operator asked for, for the record. -50..95 mirrors
  -- variationFormSchema exactly.
  margin_pct          numeric(5,2) check (
                        margin_pct is null or (margin_pct >= -50 and margin_pct <= 95)
                      ),
  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint quote_cost_estimates_quote_fk
    foreign key (quote_id, org_id) references public.quotes (id, org_id) on delete cascade,
  constraint quote_cost_estimates_sums_to_total check (
    round(labour_cost + materials_cost + subcontractors_cost + misc_cost, 2)
      = round(total_cost, 2)
  ),
  constraint quote_cost_estimates_one_per_quote unique (quote_id)
);
create index if not exists quote_cost_estimates_org_idx
  on public.quote_cost_estimates (org_id);

create or replace function public.tg_quote_cost_estimate_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'a quote cost estimate records what was estimated at the time and cannot be changed'
    using errcode = 'check_violation';
end $$;
drop trigger if exists quote_cost_estimates_immutable on public.quote_cost_estimates;
create trigger quote_cost_estimates_immutable before update on public.quote_cost_estimates
  for each row execute function public.tg_quote_cost_estimate_immutable();

alter table public.quote_cost_estimates enable row level security;

drop policy if exists "quote_cost_estimates: members can select" on public.quote_cost_estimates;
create policy "quote_cost_estimates: members can select" on public.quote_cost_estimates
  for select to authenticated using (org_id in (select public.current_org_ids()));
-- Written by whoever may raise the variation, which is any member (the quotes
-- insert policy). Narrower than job_budgets on purpose: this is a byproduct of
-- creating the variation, not a management decision about the job's plan.
drop policy if exists "quote_cost_estimates: members can insert" on public.quote_cost_estimates;
create policy "quote_cost_estimates: members can insert" on public.quote_cost_estimates
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
-- No update policy, no delete policy. It goes when its quote goes (CASCADE).
