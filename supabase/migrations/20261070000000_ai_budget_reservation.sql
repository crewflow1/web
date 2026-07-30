-- AI Cost Governor — THE ATOMIC BUDGET RESERVATION.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  WHAT WAS BROKEN, IN ONE SENTENCE EACH.                                  ║
-- ║                                                                          ║
-- ║  1. The £100/org/month ceiling was a START GATE, not a reserve.          ║
-- ║     `invokeWithGovernor` read the month's total, ran the provider call,   ║
-- ║     then recorded the cost. N calls issued in the same tick all read the  ║
-- ║     SAME pre-spend total, all found themselves under the ceiling, and all ║
-- ║     spent. Overshoot was bounded only by (in-flight x per-call cost).     ║
-- ║     Sequential traffic was exact; concurrent traffic was not governed.    ║
-- ║                                                                          ║
-- ║  2. Dedupe raced identically. The recent-duplicate probe was a READ, so   ║
-- ║     ten SIMULTANEOUS identical submits all missed and all paid. One       ║
-- ║     impatient double-click could cost ten times.                         ║
-- ║                                                                          ║
-- ║  Both defects had one root cause — a READ-THEN-ACT decision in the        ║
-- ║  application — and therefore one fix: move the decision INTO the          ║
-- ║  database, under a lock, in a single transaction. That is this file.      ║
-- ║  They were measured and pinned as findings before being fixed; see        ║
-- ║  __tests__/ai/quote-writer-governor.test.ts for the before/after.         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── WHY A SIBLING TABLE AND NOT A NEW STATE ON `ai_invocations` ─────────────
-- `ai_invocations` (20261062000000) is UPDATE-IMMUTABLE by trigger, carries
-- `success boolean not null`, and enforces "a success has nothing to explain, a
-- failure must carry a code". Every one of those properties is correct and
-- load-bearing, and every one of them is INCOMPATIBLE with an in-flight row: a
-- reservation has no outcome yet, and it must transition when it gets one.
--
-- Bolting a lifecycle onto that table would have meant weakening its
-- immutability trigger — the single strongest thing it has. So the split is:
--
--   ai_invocations       COMMITTED spend. Immutable. A fact that happened.
--   ai_cost_reservations IN-FLIGHT claims. A short-lived state machine.
--
-- The budget is the SUM OF BOTH: committed + live-reserved. That is the number
-- the ceiling is enforced against, and it is why no set of concurrent callers
-- can exceed it: a caller's own claim is visible to every other caller from the
-- instant it commits, which is the property a post-hoc ledger row can never
-- have.
--
-- ── THE SERIALISATION POINT: A PER-ORG ADVISORY XACT LOCK ───────────────────
-- A conditional `insert ... select ... where (committed + reserved + this) <=
-- ceiling` is NOT sufficient on its own. At READ COMMITTED two concurrent
-- transactions both evaluate that predicate against a snapshot taken before
-- either inserted, both find room, and both commit — the textbook aggregate
-- race. No unique constraint can help, because reservations are not unique.
--
-- So `ai_reserve_invocation` takes `pg_advisory_xact_lock` on the ORG before it
-- reads. This is the codebase's established idiom for exactly this shape:
-- per-(item, site) in 20261065000000 (operational stock), per-purchase-order in
-- 20261060000000 (GRN posting), per-contract in 20261051000000 (CIS). The lock
-- is transaction-scoped, so a crashed backend releases it automatically and no
-- stuck lock can wedge an org's AI.
--
-- WHY PER-ORG AND NOT PER-(ORG, MONTH), which would be the narrower key:
-- because the dedupe decision is serialised by this same lock, and the dedupe
-- window (15 minutes) can straddle a month boundary. A per-month key would open
-- a once-a-month hole in which two simultaneous identical submits either side
-- of midnight-on-the-1st took different locks and both paid. Per-org closes it.
-- The cost is nil in practice: the lock is held only for a bounded aggregate
-- and one insert (microseconds), NEVER across the provider call, and two
-- DIFFERENT orgs never contend.
--
-- ALTERNATIVES CONSIDERED AND REJECTED:
--   * SERIALIZABLE isolation — cannot be set per-request through PostgREST, and
--     converts the race into serialisation failures the application must retry.
--     A budget control whose refusal path needs a retry loop is worse.
--   * A unique-constrained `ai_budget_months` counter row locked FOR UPDATE —
--     works, but introduces a mutable aggregate that can drift from the ledger
--     it summarises, and a drifted counter is either invisible over-blocking or
--     invisible over-spend. Re-summing one org-month is index-served against
--     `ai_invocations_org_created_idx` and costs nothing at the <=10,000 rows a
--     £100 ceiling can buy, so the ledger stays the single source of truth.
--   * A per-call unique key for dedupe (unique on org+feature+content_hash) —
--     would make dedupe PERMANENT rather than a 15-minute window, refusing a
--     genuine re-ask forever. A tumbling-window generated column instead lets
--     two identical submits either side of a bucket edge both pay. Serialising
--     the sliding-window probe under the lock preserves the exact existing
--     semantics with no new false positives OR false negatives.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
-- It activates NOTHING. Every cost tier still maps to no model
-- (lib/ai/governor/registry.ts), so on production this file creates a correct
-- and permanently EMPTY table. It introduces no provider, no credential, no
-- network call and no cron. Nothing here can be switched on from an
-- environment variable.
--
-- Additive, idempotent, reversible. To roll back:
--   drop function if exists public.ai_release_reservation(uuid, text);
--   drop function if exists public.ai_settle_reservation(uuid, boolean, integer, text, text, integer, integer, integer, text);
--   drop function if exists public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer);
--   drop function if exists public.ai_reservations_month_totals(uuid, date);
--   drop trigger if exists ai_cost_reservations_lifecycle on public.ai_cost_reservations;
--   drop function if exists public.tg_ai_cost_reservations_lifecycle();
--   drop table if exists public.ai_cost_reservations;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE RESERVATION TABLE
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.ai_cost_reservations (
  id      uuid primary key default gen_random_uuid(),
  org_id  uuid not null references public.organizations(id) on delete cascade,

  -- NULLABLE, and `on delete set null`, for the identical reason as the ledger:
  -- a system job (a webhook turn, a scheduled sweep) has an org but no human,
  -- and a departed employee's deletion must not erase the org's spend history.
  user_id uuid references public.users(id) on delete set null,

  feature    text not null check (length(trim(feature)) between 1 and 120),

  -- 'deterministic' is DELIBERATELY ABSENT, exactly as in `ai_invocations`. A
  -- deterministic task reaches no model by definition, so a reservation
  -- claiming budget for one is a contradiction. Refused in TypeScript, refused
  -- again here for every role including service_role.
  task_class text not null check (task_class in ('classification', 'drafting', 'complex')),

  -- THE CLAIM: the pessimistic ceiling cost of this call, in integer pence.
  --
  -- >= 1 IS A DELIBERATE FLOOR, not a formality. `estimateCostPence` returns 0
  -- for an unpriced or unbound model, and a claim of 0 consumes no budget — so
  -- N concurrent unpriced calls would all pass the gate no matter how many
  -- there were, which is precisely the hole this migration exists to close. One
  -- penny per in-flight call bounds worst-case concurrency at the ceiling
  -- itself. Note this floors the CLAIM, never the recorded cost: `ai_invocations`
  -- still records exactly what the estimator says a call cost.
  estimate_pence integer not null check (estimate_pence >= 1),

  -- The state machine. `reserved` is the only non-terminal state.
  --   reserved  claim is live and counts against the ceiling
  --   settled   the call happened; `ai_invocations` holds the committed cost
  --   released  no provider was reached (the caller degraded internally)
  --   expired   TTL elapsed without settlement — a crashed process
  state text not null default 'reserved'
    check (state in ('reserved', 'settled', 'released', 'expired')),

  -- SHA-256 of (feature, task_class, content). The dedupe identity. Nullable:
  -- a caller that cannot cheaply hash its input still gets full accounting, it
  -- simply forgoes dedupe. The content itself is NEVER stored.
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),

  -- Settlement facts. Null until the reservation leaves `reserved`.
  success       boolean,
  cost_pence    integer check (cost_pence is null or cost_pence >= 0),
  -- The committed ledger row this reservation became. `set null` rather than
  -- cascade: losing the telemetry row must not erase the audit trail of the
  -- claim that authorised it.
  invocation_id uuid references public.ai_invocations(id) on delete set null,
  release_reason text check (release_reason is null or length(trim(release_reason)) between 1 and 120),

  created_at timestamptz not null default now(),

  -- THE TTL. A crashed process must not consume budget until the month rolls.
  -- Reclaim is LAZY: every arithmetic path below counts only reservations with
  -- `expires_at > now()`, so an abandoned claim stops consuming budget the
  -- instant its TTL passes — with no cron, no sweeper and no external
  -- dependency in the refusal path. `ai_reserve_invocation` additionally STAMPS
  -- lapsed rows to 'expired' so the audit view tells the truth, but the ceiling
  -- is correct whether or not that stamp ever runs.
  expires_at timestamptz not null,
  settled_at timestamptz,

  constraint ai_cost_reservations_ttl_check check (expires_at > created_at),

  -- STATE <-> SETTLEMENT COHERENCE. A `reserved` row with a cost, or a
  -- `settled` row without one, is not a state this system has a meaning for.
  -- NOT named `..._state_check`: Postgres auto-names the column-level CHECK on
  -- `state` exactly that, and the two collide inside one CREATE TABLE.
  constraint ai_cost_reservations_settlement_check check (
    (state = 'reserved'
      and settled_at is null and success is null and cost_pence is null
      and release_reason is null and invocation_id is null)
    or (state = 'settled'
      and settled_at is not null and success is not null and cost_pence is not null)
    or (state in ('released', 'expired')
      and settled_at is not null and success is null and cost_pence is null
      and invocation_id is null)
  )
);

-- ── indexes ──────────────────────────────────────────────────────────────────
-- THE gate's own read: one org's live claims. Partial, because a settled or
-- expired row is dead weight to the ceiling arithmetic and this is the index
-- the refusal path depends on.
create index if not exists ai_cost_reservations_live_idx
  on public.ai_cost_reservations (org_id, expires_at)
  where state = 'reserved';
-- The dedupe probe: most recent identical request for this org+feature.
create index if not exists ai_cost_reservations_dedupe_idx
  on public.ai_cost_reservations (org_id, feature, content_hash, created_at desc)
  where content_hash is not null;
-- The audit view: one org-month, every state.
create index if not exists ai_cost_reservations_org_created_idx
  on public.ai_cost_reservations (org_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE LIFECYCLE GUARD — a claim cannot be rewritten to free budget
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ai_invocations` is flatly immutable. A reservation cannot be, because
-- settlement IS an update. So the guard is a STATE MACHINE rather than a
-- refusal:
--
--   * `reserved` may become 'settled', 'released' or 'expired'. Once.
--   * A terminal state is TERMINAL. Nothing walks a settled row back to
--     'reserved' — which would double-count committed spend against a claim
--     that is already in the ledger — and nothing re-settles it, which would
--     write the invocation row twice.
--   * The identity columns (org, feature, task class, claim, hash, created_at)
--     are FROZEN. A claim whose amount could be edited after the fact is not a
--     claim.
--
-- TWO NARROW HOLES, both FK-driven erasure rather than edits, cut exactly as
-- 20261062000000 cut its one: `user_id -> null` (a departed employee) and
-- `invocation_id -> null` (a deleted telemetry row) are permitted when every
-- other column is byte-identical. `IS NOT DISTINCT FROM`, never `=`, because
-- row equality involving a NULL field yields NULL and would refuse every
-- legitimate anonymisation of a row with a null content_hash.
--
-- DELETE is deliberately NOT guarded, so `organizations ... on delete cascade`
-- still tears an org down. A BEFORE DELETE guard here would abort tenant
-- teardown and GDPR erasure — the exact failure 20261052 was written to fix.
create or replace function public.tg_ai_cost_reservations_lifecycle()
returns trigger language plpgsql as $$
declare
  v_expected public.ai_cost_reservations%rowtype;
begin
  -- (a) The FK-driven anonymisation holes.
  if (old.user_id is not null and new.user_id is null)
     or (old.invocation_id is not null and new.invocation_id is null) then
    v_expected := old;
    if old.user_id is not null and new.user_id is null then
      v_expected.user_id := null;
    end if;
    if old.invocation_id is not null and new.invocation_id is null then
      v_expected.invocation_id := null;
    end if;
    if new is not distinct from v_expected then
      return new;
    end if;
  end if;

  -- (b) The identity columns are frozen.
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.feature is distinct from old.feature
     or new.task_class is distinct from old.task_class
     or new.estimate_pence is distinct from old.estimate_pence
     or new.content_hash is distinct from old.content_hash
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception
      'ai_cost_reservations: a claim''s identity is frozen — settle or release it, never rewrite it'
      using errcode = 'check_violation';
  end if;

  -- (c) Only `reserved` may transition, and only to a terminal state.
  if old.state <> 'reserved' then
    raise exception
      'ai_cost_reservations: reservation % is already %, and a settled claim is terminal',
      old.id, old.state
      using errcode = 'check_violation';
  end if;
  if new.state not in ('settled', 'released', 'expired') then
    raise exception
      'ai_cost_reservations: % is not a terminal state', new.state
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists ai_cost_reservations_lifecycle on public.ai_cost_reservations;
create trigger ai_cost_reservations_lifecycle before update on public.ai_cost_reservations
  for each row execute function public.tg_ai_cost_reservations_lifecycle();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. RLS — the identical posture to `ai_invocations`
-- ═══════════════════════════════════════════════════════════════════════════
-- ADMIN-READ-ONLY per org. In-flight AI usage reveals how heavily a firm leans
-- on AI and how it works, which is owner/admin information, not crew
-- information — so SELECT is gated on `is_org_admin(org_id)`, never membership.
--
-- There is NO insert/update/delete policy at all. The governor writes through
-- the service-role client, so a tenant client structurally cannot forge a
-- reservation. That matters more here than on the ledger: a forged reservation
-- is a DENIAL OF SERVICE primitive — claim 10,000p against your own org (or, if
-- tenancy could be forged, someone else's) and every AI call is refused until
-- the TTL lapses. The RPCs below are SECURITY INVOKER precisely so that a
-- tenant calling them directly is refused by these policies rather than
-- inheriting the function owner's rights.
alter table public.ai_cost_reservations enable row level security;

drop policy if exists ai_cost_reservations_select on public.ai_cost_reservations;
create policy ai_cost_reservations_select on public.ai_cost_reservations
  for select using (public.is_org_admin(org_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ai_reserve_invocation — THE ATOMIC GATE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Returns exactly one row, whose `outcome` is one of:
--   'reserved'  — a live claim exists; the caller may reach the provider ONCE
--                 and must then settle or release it.
--   'blocked'   — the ceiling refuses this call. No claim was created.
--   'duplicate' — an identical request is in flight or recently succeeded.
--
-- THE TWO GATES, and why both are needed:
--
--   (a) committed + reserved  <  ceiling
--       The BAND gate. It is the existing `evaluateBudget` rule restated in
--       SQL: reaching the ceiling exactly must refuse, because "the ceiling was
--       only exceeded by the call that noticed it" is not a control. Without
--       this, a call whose claim is 0 would slip through at exactly 100%.
--
--   (b) committed + reserved + this_claim  <=  ceiling
--       The RESERVE gate, and the actual fix. A call that cannot fit is refused
--       BEFORE it reaches a provider rather than after. This is a real
--       behaviour change from the start-gate version, and it is the point: one
--       penny of headroom no longer admits a pound of inference.
--
-- Both are evaluated INSIDE the advisory lock and the claim is written by a
-- conditional `insert ... select ... where`, so the check and the write are one
-- indivisible act. `v_reservation_id is null` after that statement means the
-- predicate refused — belt and braces against the aggregates having been read
-- into variables a statement earlier.
--
-- SECURITY INVOKER (note the absence of `security definer`). The caller's RLS,
-- every CHECK and the lifecycle trigger all still apply, so this is not a back
-- door: it exists for the one thing a client statement sequence cannot do,
-- which is to decide and write atomically.
create or replace function public.ai_reserve_invocation(
  p_org_id                 uuid,
  p_feature                text,
  p_task_class             text,
  p_estimate_pence         integer,
  p_user_id                uuid    default null,
  p_content_hash           text    default null,
  p_ceiling_pence          integer default 10000,
  p_ttl_seconds            integer default 600,
  p_dedupe_window_seconds  integer default 900
)
returns table (
  outcome          text,
  reservation_id   uuid,
  committed_pence  bigint,
  reserved_pence   bigint,
  ceiling_pence    integer,
  duplicate_reason text
)
language plpgsql
set search_path = ''
as $$
declare
  v_month_start   timestamptz;
  v_month_end     timestamptz;
  v_committed     bigint  := 0;
  v_reserved      bigint  := 0;
  v_claim         integer;
  v_ttl           integer;
  v_window        integer;
  v_reservation   uuid;
  v_dup           text;
begin
  if p_org_id is null or p_feature is null or p_task_class is null then
    raise exception 'organisation, feature and task class are all required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The claim floor, restated here rather than trusted from the caller: a
  -- reservation of 0 or NULL would consume no budget and make the gate a no-op.
  v_claim  := greatest(1, coalesce(p_estimate_pence, 1));
  v_ttl    := greatest(1, coalesce(p_ttl_seconds, 600));
  v_window := greatest(0, coalesce(p_dedupe_window_seconds, 900));

  -- A non-positive ceiling means "no AI spend permitted at all", NOT
  -- "unlimited" — the failure-safe reading, and the same one policy.ts takes.
  if p_ceiling_pence is null or p_ceiling_pence <= 0 then
    return query select 'blocked'::text, null::uuid, 0::bigint, 0::bigint,
                        coalesce(p_ceiling_pence, 0), null::text;
    return;
  end if;

  -- ── THE SERIALISATION POINT ────────────────────────────────────────────────
  -- Everything from here to COMMIT is serialised per org. Two concurrent
  -- callers for the same org cannot both read a pre-claim total; the second
  -- waits and sees the first's claim. Different orgs never contend.
  perform pg_advisory_xact_lock(hashtext('ai_budget_reservation'), hashtext(p_org_id::text));

  -- The EUROPE/LONDON budget month, identical to `ai_invocations_month_totals`
  -- and to `ukMonthKeyOf` in TypeScript. A UTC month would spend August's
  -- budget out of July for the first hour of every BST month.
  v_month_start := (date_trunc('month', (now() at time zone 'Europe/London'))
                      at time zone 'Europe/London');
  v_month_end   := ((date_trunc('month', (now() at time zone 'Europe/London'))
                      + interval '1 month') at time zone 'Europe/London');

  -- LAZY TTL RECLAIM. Cosmetic only — every aggregate below filters on
  -- `expires_at > now()`, so the ceiling is already correct without this. It
  -- exists so the audit view shows 'expired' rather than a stale 'reserved'.
  update public.ai_cost_reservations
     set state = 'expired', settled_at = now()
   where org_id = p_org_id
     and state = 'reserved'
     and expires_at <= now();

  -- The month's budget position, read ONCE, before any refusal path — so every
  -- outcome this function can return carries truthful figures rather than
  -- zeroes the audit view would then have to guess at.
  --
  -- COMMITTED: the immutable ledger, this UK month.
  select coalesce(sum(i.estimated_cost_pence), 0)::bigint
    into v_committed
    from public.ai_invocations i
   where i.org_id = p_org_id
     and i.created_at >= v_month_start
     and i.created_at <  v_month_end;

  -- RESERVED: live claims only. An expired claim consumes nothing.
  select coalesce(sum(r.estimate_pence), 0)::bigint
    into v_reserved
    from public.ai_cost_reservations r
   where r.org_id = p_org_id
     and r.state = 'reserved'
     and r.expires_at > now()
     and r.created_at >= v_month_start
     and r.created_at <  v_month_end;

  -- ── DEDUPE, SERIALISED BY THE LOCK ABOVE ─────────────────────────────────
  -- This is the second defect's fix and it needs no new constraint: the probe
  -- is inside the same critical section as the insert, so ten simultaneous
  -- identical submits queue on the lock and the nine losers all see the
  -- winner's LIVE claim.
  --
  -- A live claim ('reserved', unexpired) OR a recent SUCCESS suppresses. A
  -- failed, released or expired attempt does NOT — which preserves the existing
  -- rule that only successes deduplicate, so a retry after a genuine failure is
  -- never refused.
  if p_content_hash is not null then
    select case when r.state = 'reserved' then 'in_flight' else 'recent_success' end
      into v_dup
      from public.ai_cost_reservations r
     where r.org_id = p_org_id
       and r.feature = p_feature
       and r.content_hash = p_content_hash
       and r.created_at >= now() - make_interval(secs => v_window)
       and (
         (r.state = 'reserved' and r.expires_at > now())
         or (r.state = 'settled' and r.success)
       )
     order by r.created_at desc
     limit 1;

    if v_dup is not null then
      return query select 'duplicate'::text, null::uuid, v_committed, v_reserved,
                          p_ceiling_pence, v_dup;
      return;
    end if;
  end if;

  -- ── THE CONDITIONAL INSERT: the gate and the write, one statement ────────
  insert into public.ai_cost_reservations (
    org_id, user_id, feature, task_class, estimate_pence, content_hash, expires_at
  )
  select p_org_id, p_user_id, p_feature, p_task_class, v_claim, p_content_hash,
         now() + make_interval(secs => v_ttl)
   where v_committed + v_reserved < p_ceiling_pence                 -- (a) band
     and v_committed + v_reserved + v_claim <= p_ceiling_pence      -- (b) reserve
  returning id into v_reservation;

  if v_reservation is null then
    return query select 'blocked'::text, null::uuid, v_committed, v_reserved,
                        p_ceiling_pence, null::text;
    return;
  end if;

  return query select 'reserved'::text, v_reservation, v_committed, v_reserved,
                      p_ceiling_pence, null::text;
end $$;

revoke all on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer) from public;
grant execute on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ai_settle_reservation — commit the real cost and free the claim, ATOMICALLY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One transaction writes the immutable `ai_invocations` row AND flips the
-- claim. That is not tidiness: two round trips would leave a window in which
-- the claim was freed but the spend unrecorded (an under-count that re-opens
-- the ceiling), or the spend recorded while the claim still stood (a
-- double-count that over-blocks). Atomic settlement has neither.
--
-- IDEMPOTENT. Only a `reserved` row settles; a second call returns
-- 'already_settled' with the invocation id the first one wrote, so a retry
-- after a network blip cannot double-charge. A vanished reservation (an org
-- torn down mid-flight) returns 'not_found' and writes nothing, leaving the
-- caller to record the spend best-effort through the ordinary ledger path.
--
-- THE FAILED-CALL POLICY LIVES IN TYPESCRIPT, NOT HERE. This function records
-- whatever cost it is given; `lib/ai/governor.ts` decides what a failure costs
-- and documents why. Keeping the judgement in one place, beside the estimator
-- that produced the number, is what stops the two disagreeing.
create or replace function public.ai_settle_reservation(
  p_reservation_id uuid,
  p_success        boolean,
  p_cost_pence     integer,
  p_provider       text,
  p_model          text,
  p_input_tokens   integer default 0,
  p_output_tokens  integer default 0,
  p_latency_ms     integer default 0,
  p_error_code     text    default null
)
returns table (
  outcome       text,
  invocation_id uuid,
  cost_pence    integer
)
language plpgsql
set search_path = ''
as $$
declare
  v_res        public.ai_cost_reservations%rowtype;
  v_cost       integer;
  v_invocation uuid;
begin
  if p_reservation_id is null or p_success is null then
    raise exception 'reservation id and outcome are both required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE: two settlements of one claim serialise on the row itself, so
  -- the lifecycle trigger's "terminal is terminal" rule is reached by exactly
  -- one of them rather than raced by both.
  select * into v_res
    from public.ai_cost_reservations
   where id = p_reservation_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  if v_res.state <> 'reserved' then
    return query select 'already_settled'::text, v_res.invocation_id, v_res.cost_pence;
    return;
  end if;

  v_cost := greatest(0, coalesce(p_cost_pence, 0));

  -- The committed fact. Immutable from the moment it lands. The ledger's own
  -- CHECK requires an error code on failure and none on success, so the
  -- coalesce below is the same guarantee the TypeScript writer makes.
  insert into public.ai_invocations (
    org_id, user_id, feature, task_class, provider, model,
    input_tokens, output_tokens, estimated_cost_pence, latency_ms,
    success, error_code, content_hash
  ) values (
    v_res.org_id, v_res.user_id, v_res.feature, v_res.task_class,
    coalesce(nullif(trim(coalesce(p_provider, '')), ''), 'unknown'),
    coalesce(nullif(trim(coalesce(p_model, '')), ''), 'unknown'),
    greatest(0, coalesce(p_input_tokens, 0)),
    greatest(0, coalesce(p_output_tokens, 0)),
    v_cost,
    greatest(0, coalesce(p_latency_ms, 0)),
    p_success,
    case when p_success then null
         else coalesce(nullif(trim(coalesce(p_error_code, '')), ''), 'unknown_error') end,
    v_res.content_hash
  )
  returning id into v_invocation;

  update public.ai_cost_reservations
     set state = 'settled',
         success = p_success,
         cost_pence = v_cost,
         invocation_id = v_invocation,
         settled_at = now()
   where id = v_res.id;

  return query select 'settled'::text, v_invocation, v_cost;
end $$;

revoke all on function public.ai_settle_reservation(uuid, boolean, integer, text, text, integer, integer, integer, text) from public;
grant execute on function public.ai_settle_reservation(uuid, boolean, integer, text, text, integer, integer, integer, text)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. ai_release_reservation — no provider was reached, so nothing is owed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The `usage: null` path: the governed function took its own degraded leg and
-- never called a model. There is nothing to account for, so no ledger row is
-- written — inventing a phantom invocation is exactly what
-- `GovernedCall.usage === null` exists to prevent. The claim is simply given
-- back, immediately, rather than being left to time out.
create or replace function public.ai_release_reservation(
  p_reservation_id uuid,
  p_reason         text default 'no_provider_call'
)
returns table (outcome text)
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
begin
  if p_reservation_id is null then
    raise exception 'reservation id is required' using errcode = 'invalid_parameter_value';
  end if;

  select state into v_state
    from public.ai_cost_reservations
   where id = p_reservation_id
     for update;

  if not found then
    return query select 'not_found'::text;
    return;
  end if;
  if v_state <> 'reserved' then
    return query select 'already_settled'::text;
    return;
  end if;

  update public.ai_cost_reservations
     set state = 'released',
         settled_at = now(),
         release_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'no_provider_call')
   where id = p_reservation_id;

  return query select 'released'::text;
end $$;

revoke all on function public.ai_release_reservation(uuid, text) from public;
grant execute on function public.ai_release_reservation(uuid, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. ai_reservations_month_totals — the audit rollup
-- ═══════════════════════════════════════════════════════════════════════════
-- The HQ cost view must stay TRUTHFUL now that headroom is committed + live
-- claims rather than committed alone. Without this, /admin/ai-costs would show
-- an org at 40% while it was in fact refusing calls at 100%.
--
-- SECURITY INVOKER and an empty search_path, exactly as the two rollups in
-- 20261062000000: a definer-rights aggregate over an org-scoped table is a
-- cross-tenant read primitive, which is the defect class the 20261031-37
-- storage wave existed to eliminate. `p_org_id` NULL means "every org the
-- CALLER may see", so RLS has already decided what is visible.
--
-- `live_pence` counts unexpired 'reserved' rows ONLY, so a crashed process's
-- claim disappears from the headroom figure the moment its TTL lapses —
-- whether or not the lazy stamp has run.
create or replace function public.ai_reservations_month_totals(
  p_org_id uuid default null,
  p_month  date default current_date
)
returns table (
  org_id          uuid,
  month_start     date,
  live_pence      bigint,
  live_count      bigint,
  settled_count   bigint,
  released_count  bigint,
  expired_count   bigint,
  overrun_count   bigint
)
language sql
stable
set search_path = ''
as $$
  with bounds as (
    select
      date_trunc('month', p_month::timestamp)                      as naive_start,
      date_trunc('month', p_month::timestamp) + interval '1 month' as naive_end
  )
  select
    r.org_id,
    (select naive_start from bounds)::date as month_start,
    coalesce(sum(r.estimate_pence) filter (
      where r.state = 'reserved' and r.expires_at > now()), 0)::bigint as live_pence,
    count(*) filter (where r.state = 'reserved' and r.expires_at > now()) as live_count,
    count(*) filter (where r.state = 'settled')                          as settled_count,
    count(*) filter (where r.state = 'released')                         as released_count,
    count(*) filter (where r.state = 'expired'
                        or (r.state = 'reserved' and r.expires_at <= now())) as expired_count,
    -- THE CALIBRATION ALARM. A settled claim whose real cost exceeded the
    -- estimate is the ONE way committed spend can pass the ceiling: the gate
    -- admitted the call on a number that turned out to be too small. It cannot
    -- be prevented from here (the true cost is only known afterwards), so it is
    -- counted and surfaced. A non-zero figure means the reservation envelope in
    -- lib/ai/governor/registry.ts is too tight for the bound model.
    count(*) filter (where r.state = 'settled' and r.cost_pence > r.estimate_pence) as overrun_count
  from public.ai_cost_reservations r, bounds b
  where (p_org_id is null or r.org_id = p_org_id)
    and r.created_at >= (b.naive_start at time zone 'Europe/London')
    and r.created_at <  (b.naive_end   at time zone 'Europe/London')
  group by r.org_id;
$$;

revoke all on function public.ai_reservations_month_totals(uuid, date) from public;
grant execute on function public.ai_reservations_month_totals(uuid, date)
  to anon, authenticated, service_role;

comment on table public.ai_cost_reservations is
  'AI Cost Governor atomic budget reservations. Live claims count against the £100/org/month ceiling alongside committed ai_invocations spend. Admin-read-only per org; service-role write only; reserved->terminal only; TTL reclaimed lazily; DELETE left open so org teardown cascades.';
