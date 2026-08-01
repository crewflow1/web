-- Expense budgets — an ORG / CATEGORY operational spend target, and the
-- budget-vs-actual overlay CrewFlow has never had for its expense ledger.
--
-- THE GAP THIS CLOSES. STATUS.md Phase 5 marks Expenses PRODUCTION, but
-- "Budget tracking specifically remains NOT BUILT". Expenses post to `finances`
-- (the actual-cost ledger) via the receipt-draft approval flow and the manual
-- /finances entry path, and every surface can show what was SPENT — but there
-- is nowhere to record what the business PLANNED to spend on materials, fuel,
-- subcontractors and the rest, so "are we over on fuel this month?" has no
-- answer in the product. This table is that plan.
--
-- ── DISTINCT FROM `job_budgets` (20261072) — DO NOT CONFLATE ─────────────────
-- `job_budgets` is a PER-JOB cost baseline: the priced cost of ONE job, revised
-- with a write-once revision chain, compared against that job's actual cost and
-- forecast final cost. It is the denominator of a judgement about a single job's
-- performance, so it is immutable history.
--
-- `expense_budgets` is a different concept entirely: an ORG-WIDE, PER-CATEGORY
-- OPERATIONAL spend target ("£5,000 of materials a month across the business"),
-- not tied to any job. It is a standing management target that admins tune as
-- circumstances change, so it is EDITABLE IN PLACE with an `updated_at` — the
-- opposite of the job-baseline's immutability, and correctly so: nobody is being
-- held to "what did we say materials would be in March"; they are steering
-- ongoing spend. The two never share a row, a column or a code path.
--
-- ── THE ACCOUNTING BOUNDARY ─────────────────────────────────────────────────
-- THIS TABLE DOES NOT POST TO `finances`, AND MAY NEVER.
--
-- A budget is a PLAN, not a transaction. `finances` is the actual-cost ledger
-- that job profitability, VAT and CIS all read. A planned figure landing there
-- would be double-counted the moment the real spend was entered — the same
-- double-count hazard operational stock shipped on (CEO decision D1) and the one
-- `job_budgets` was built to avoid. Structurally, not by convention: there is no
-- trigger on `finances` in this migration, no writer of it, and no money column
-- here any process could mistake for an incurred cost. The whole
-- budget-vs-actual computation is a READ OVERLAY — it SUMS `finances` and
-- COMPARES; it never writes it. Swept by
-- __tests__/security/expense-budgets.test.ts.
--
-- ── THE PERIOD MODEL: ONE STANDING TARGET PER CATEGORY, RECURRING ───────────
-- The simplest honest model. A budget is ONE row per (org, category) carrying
-- an `amount_pence` and a `period_type` in {monthly, quarterly, annual}. The
-- amount is the target for ONE period of that cadence, and it RECURS — there is
-- no per-period anchor row and no per-period amount. "Materials: £5,000/month"
-- is one row; the CURRENT period's actual is summed from `finances` and compared
-- against it.
--
-- The period is anchored to the CALENDAR, Europe/London: monthly = the current
-- London calendar month, quarterly = the current London calendar quarter
-- (Jan-Mar / Apr-Jun / Jul-Sep / Oct-Dec), annual = the current London calendar
-- YEAR. It is deliberately NOT the UK tax year (which starts 6 April): a
-- calendar anchor is what an operator means by "this month/quarter/year" when
-- steering spend, and pretending otherwise would silently mis-bucket April. A
-- tax-year anchor is a documented deferral, not a hidden assumption.
--
-- Why not per-period anchor rows? Because a recurring target needs no history to
-- be correct — unlike the job baseline, nobody audits "what was the materials
-- budget in a past month", they set a standing figure and steer against it. A
-- per-period-row model would multiply rows without adding a question the product
-- can answer, and would need a uniqueness key per (category, period) plus a
-- back-fill for periods nobody set. One editable row per category is the honest
-- floor.
--
-- ── AMOUNT IN INTEGER PENCE ─────────────────────────────────────────────────
-- `amount_pence` is a BIGINT of pence, not a numeric of pounds. A budget is a
-- round management figure a human types ("£5,000"), never the product of VAT
-- arithmetic, so pence-as-integer is the exact representation with no rounding
-- surface. The ACTUAL side (`finances.amount`, numeric pounds) is converted to
-- pence at the read boundary in the PURE layer (lib/expenses/budget.ts), so the
-- comparison is integer-vs-integer. `amount_pence > 0`: a £0 budget would make
-- every category with any spend read "over budget" off a target nobody set — the
-- "£0 budget, 100 % over" lie a default tells (same rule as
-- job_budgets_not_empty).
--
-- ── CATEGORY VOCABULARY: REUSE, NEVER INVENT ───────────────────────────────
-- `category` is CHECK-constrained to the EXISTING expense category vocabulary —
-- lib/finances/schema.ts FINANCE_CATEGORIES (materials, labor, fuel,
-- subcontractor, tools, office, vehicle, misc), the same set the finance form
-- and the receipt-draft approval write to `finances.category`. A parallel
-- category set here would silently fail to line up with the actuals it is meant
-- to be compared against. `finances.category` is free text and nullable, so a
-- posted expense may carry a category outside this set or none at all; the
-- overlay SURFACES that spend honestly as "no budget set" rather than dropping
-- it — see the PURE layer — but a BUDGET may only be set against a known
-- category.
--
-- ── TENANCY IS STRUCTURAL ───────────────────────────────────────────────────
-- Org-pinned, and the composite candidate key `(id, org_id)` is added so any
-- future child binds by composite FK — the additive step 20261056 / 20261059 /
-- 20261063 / 20261072 each took. `id` is already the PRIMARY KEY, so
-- `(id, org_id)` is unique by construction and validates instantly.
--
-- ON DELETE CASCADE on the org FK makes teardown safe. There is NO
-- `ON DELETE RESTRICT` and NO `AFTER DELETE` activity trigger anywhere in this
-- file (the 20261052 org-teardown P1 rule). A budget is an operational target,
-- not evidence, so admins may DELETE one — there is no immutability trigger and
-- no no-targeted-delete guard, deliberately unlike `job_budgets`.
--
-- Additive and reversible. To roll back:
--   drop function public.set_expense_budget(uuid, text, bigint, text, text);
--   drop table public.expense_budgets;
-- Migrate-first safe: every surface reads this table best-effort; absent → no
-- budgets, and the overlay degrades to "no budget set" everywhere.

-- ── 1. expense_budgets — one editable standing target per (org, category) ────
create table if not exists public.expense_budgets (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- The EXISTING expense category vocabulary (lib/finances/schema.ts). Reused,
  -- never a parallel set, so a budget lines up with the actuals it is compared
  -- against.
  category     text not null check (category in (
                 'materials', 'labor', 'fuel', 'subcontractor',
                 'tools', 'office', 'vehicle', 'misc'
               )),
  -- Integer pence. A round management figure, never VAT-derived, so no numeric
  -- rounding surface. > 0: a £0 target is the "100 % over" lie a default tells.
  amount_pence bigint not null check (amount_pence > 0),
  -- The recurring calendar cadence this target applies to.
  period_type  text not null default 'monthly'
               check (period_type in ('monthly', 'quarterly', 'annual')),
  note         text check (note is null or length(note) <= 2000),
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- ONE standing target per category per org. A second row for the same
  -- category is a coin-flip over which target the overlay compares against, so
  -- it is unrepresentable: an edit UPDATEs the existing row (set_expense_budget
  -- upserts on this key).
  constraint expense_budgets_org_category_uniq unique (org_id, category),
  -- Composite-FK target for any future child.
  constraint expense_budgets_id_org_key unique (id, org_id)
);

create index if not exists expense_budgets_org_idx
  on public.expense_budgets (org_id);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists expense_budgets_set_updated_at on public.expense_budgets;
create trigger expense_budgets_set_updated_at before update on public.expense_budgets
  for each row execute function public.tg_set_updated_at();

-- ── 2. RLS — members read, admins write (org-level financial configuration) ──
-- The job_budgets posture, DB-enforced for the same reason: an app-only gate
-- leaves /rest/v1/expense_budgets open to any member holding a JWT. A budget is
-- a management target, so setting it is an admin act; every member may READ the
-- target so the whole team sees where spend stands against plan.
alter table public.expense_budgets enable row level security;

drop policy if exists "expense_budgets: members can select" on public.expense_budgets;
create policy "expense_budgets: members can select" on public.expense_budgets
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "expense_budgets: admins can insert" on public.expense_budgets;
create policy "expense_budgets: admins can insert" on public.expense_budgets
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "expense_budgets: admins can update" on public.expense_budgets;
create policy "expense_budgets: admins can update" on public.expense_budgets
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "expense_budgets: admins can delete" on public.expense_budgets;
create policy "expense_budgets: admins can delete" on public.expense_budgets
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── 3. set_expense_budget — upsert the standing target, ATOMICALLY ───────────
-- Setting a budget is "insert if new, update if it exists". Split into a read
-- then a write across two PostgREST round trips there is a race where two admins
-- both see "no row" and both insert, and the second loses at
-- expense_budgets_org_category_uniq with a raw constraint error. One INSERT …
-- ON CONFLICT is one atomic statement, so neither is reachable, and `created_by`
-- / `created_at` are PRESERVED across an edit — only the target itself, the
-- period and the note move, and `updated_at` follows via the trigger.
--
-- SECURITY INVOKER, deliberately: the caller's RLS still applies, so the
-- admins-only insert/update policies above are the real authorisation and this
-- is not a privileged back door around them (the stock-RPC rule, 20261065).
create or replace function public.set_expense_budget(
  p_org_id       uuid,
  p_category     text,
  p_amount_pence bigint,
  p_period_type  text default 'monthly',
  p_note         text default null
)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
begin
  if p_org_id is null then
    raise exception 'an organisation is required';
  end if;

  insert into public.expense_budgets (
    org_id, category, amount_pence, period_type, note, created_by
  ) values (
    p_org_id, p_category, p_amount_pence, coalesce(p_period_type, 'monthly'),
    nullif(btrim(p_note), ''), auth.uid()
  )
  on conflict (org_id, category) do update
    set amount_pence = excluded.amount_pence,
        period_type  = excluded.period_type,
        note         = excluded.note,
        updated_at   = now()
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.set_expense_budget(uuid, text, bigint, text, text)
  from public, anon;
grant execute on function public.set_expense_budget(uuid, text, bigint, text, text)
  to authenticated;
