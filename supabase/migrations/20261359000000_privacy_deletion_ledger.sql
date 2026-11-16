-- ACCOUNT & DATA DELETION — the ledger, the tombstone, and the retained-billing
-- archive (privacy/account-deletion workstream, 1 of 4).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION ADDS
-- ═════════════════════════════════════════════════════════════════════════════
--   1. public.privacy_deletion_requests — ONE row per deletion job. It is three
--      things at once, deliberately:
--        • the REQUEST (who asked, for what, when it may run — cooling-off),
--        • the JOB LEDGER (claimed / per-step progress / attempts / lease), so a
--          crash midway is RESUMED rather than restarted or orphaned,
--        • the TOMBSTONE once completed: opaque ids, timestamps, per-table
--          counts and the actor's ROLE. It never holds a name, an email, a phone
--          number, a slug, or free text.
--   2. public.privacy_retained_billing_records — the MINIMISED copy of
--      CrewFlow's OWN accounting facts about a deleted company (amounts, dates,
--      Stripe handles). Written by the teardown primitive immediately before the
--      organisation row is removed.
--   3. The request lifecycle primitives (create / cancel / claim / step / fail /
--      complete). All service_role-only.
--
-- ── WHY THE TARGET COLUMNS ARE NOT FOREIGN KEYS ──────────────────────────────
-- target_org_id / target_user_id / actor_user_id are OPAQUE uuids with NO FK. A
-- tombstone must outlive the thing it records: an FK with ON DELETE CASCADE
-- would erase the evidence, SET NULL would blank the very id a restored backup
-- must be re-erased by, and RESTRICT would block the deletion itself. The
-- columns are also deliberately NOT named `org_id`: this is not a tenant table,
-- it must not enter the org-scoped export/erasure census, and no tenant RLS
-- predicate may ever be written against it.
--
-- ── DATA-API POSTURE ─────────────────────────────────────────────────────────
-- Both tables are SERVICE-ROLE ONLY: RLS enabled, NO policy, NO client grant.
-- data-api:exempt:privacy_deletion_requests
-- data-api:exempt:privacy_retained_billing_records
-- The app reads them through the admin client in server code, pinned to the
-- caller's own authorised org / user.
--
-- Additive and reversible (drop the functions, then the two tables).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE LEDGER / TOMBSTONE
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.privacy_deletion_requests (
  id               uuid primary key default gen_random_uuid(),
  -- user_account  : a person deleting their OWN account + profile.
  -- staff_erasure : an owner/admin removing a staff member and erasing the
  --                 personal data the company holds about them.
  -- org           : the OWNER deleting the whole company.
  kind             text not null check (kind in ('user_account', 'staff_erasure', 'org')),
  target_org_id    uuid,
  target_user_id   uuid,
  actor_user_id    uuid,
  -- The actor's ROLE at request time — evidence of authority without identity.
  actor_role       text not null check (actor_role in ('self', 'owner', 'admin', 'operator', 'restore_reapply')),
  status           text not null default 'scheduled'
                     check (status in ('scheduled', 'running', 'completed', 'cancelled', 'failed')),
  -- Earliest moment the job may run. now() for immediate kinds; now() + the
  -- cooling-off window for a company deletion.
  scheduled_for    timestamptz not null default now(),
  -- step name -> { done_at, ...counts }. A step present here is NEVER re-run.
  steps            jsonb not null default '{}'::jsonb check (jsonb_typeof(steps) = 'object'),
  -- Per-table row counts and other tallies — the tombstone's evidence.
  counts           jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  -- TRANSIENT working set captured at lockout (opaque member ids, Stripe
  -- handles). CLEARED when the request completes — see the check below.
  work             jsonb not null default '{}'::jsonb check (jsonb_typeof(work) = 'object'),
  attempts         integer not null default 0 check (attempts >= 0),
  lease_expires_at timestamptz,
  -- A short symbolic code ('<step>:<sqlstate>' or '<step>:<reason>') — never a
  -- raw error message, which could quote row data.
  last_error_code  text check (last_error_code is null or last_error_code ~ '^[a-z0-9_:.-]{1,120}$'),
  cancelled_reason text check (cancelled_reason is null or cancelled_reason in
                     ('requester_cancelled', 'requester_not_owner', 'sole_owner', 'operator_cancelled', 'target_gone')),
  -- Set when this row re-applies an earlier tombstone after a backup restore.
  reapply_of       uuid,
  -- When the retained minimal records this deletion produced may be purged.
  retention_until  date,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,

  constraint privacy_deletion_requests_target_shape check (
    case kind
      when 'org'           then target_org_id is not null and target_user_id is null
      when 'user_account'  then target_user_id is not null and target_org_id is null
      when 'staff_erasure' then target_org_id is not null and target_user_id is not null
    end
  ),
  -- A finished tombstone carries no working set.
  constraint privacy_deletion_requests_tombstone_minimal check (
    status not in ('completed', 'cancelled') or work = '{}'::jsonb
  ),
  constraint privacy_deletion_requests_terminal_stamps check (
    (status <> 'completed' or completed_at is not null)
    and (status <> 'cancelled' or (cancelled_at is not null and cancelled_reason is not null))
  )
);

-- DOUBLE-SUBMIT GUARD. At most ONE live request per target: a second submit
-- collides here and the create primitive returns the existing row instead.
create unique index if not exists privacy_deletion_requests_live_org_key
  on public.privacy_deletion_requests (target_org_id)
  where kind = 'org' and status in ('scheduled', 'running', 'failed');
create unique index if not exists privacy_deletion_requests_live_user_key
  on public.privacy_deletion_requests (target_user_id)
  where kind = 'user_account' and status in ('scheduled', 'running', 'failed');
create unique index if not exists privacy_deletion_requests_live_staff_key
  on public.privacy_deletion_requests (target_org_id, target_user_id)
  where kind = 'staff_erasure' and status in ('scheduled', 'running', 'failed');

create index if not exists privacy_deletion_requests_due_idx
  on public.privacy_deletion_requests (scheduled_for)
  where status in ('scheduled', 'running', 'failed');
create index if not exists privacy_deletion_requests_completed_idx
  on public.privacy_deletion_requests (completed_at)
  where status = 'completed';

alter table public.privacy_deletion_requests enable row level security;
revoke all on table public.privacy_deletion_requests from public, anon, authenticated;
grant select, insert, update on table public.privacy_deletion_requests to service_role;

comment on table public.privacy_deletion_requests is
  'Deletion request + resumable job ledger + completion tombstone. Opaque ids, '
  'timestamps, per-table counts and actor ROLE only — never personal data. '
  'Service-role only (RLS on, no policy, no client grant).';

-- A completed/cancelled row is EVIDENCE: it may not be edited or removed.
create or replace function public.tg_privacy_deletion_requests_tombstone()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'privacy_deletion_requests is evidence: rows are never deleted (row %)', old.id
      using errcode = 'check_violation';
  end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'privacy_deletion_requests: a % request is a sealed tombstone (row %)', old.status, old.id
      using errcode = 'check_violation';
  end if;
  if new.id is distinct from old.id
     or new.kind is distinct from old.kind
     or new.target_org_id is distinct from old.target_org_id
     or new.target_user_id is distinct from old.target_user_id
     or new.actor_user_id is distinct from old.actor_user_id
     or new.actor_role is distinct from old.actor_role
     or new.created_at is distinct from old.created_at
     or new.reapply_of is distinct from old.reapply_of then
    raise exception 'privacy_deletion_requests: the target and actor of a request are immutable (row %)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists privacy_deletion_requests_tombstone on public.privacy_deletion_requests;
create trigger privacy_deletion_requests_tombstone
  before update or delete on public.privacy_deletion_requests
  for each row execute function public.tg_privacy_deletion_requests_tombstone();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RETAINED BILLING (CrewFlow's own accounting records, minimised)
-- ─────────────────────────────────────────────────────────────────────────────
-- What CrewFlow itself must keep after a customer deletes its company: the fact
-- that it billed a (now former) customer, how much, and when — and the Stripe
-- handles that lead to the invoice of record. NO name, NO address, NO email,
-- NO notes. `former_org_id` is opaque (the organisation row is gone).
create table if not exists public.privacy_retained_billing_records (
  id                       uuid primary key default gen_random_uuid(),
  request_id               uuid not null references public.privacy_deletion_requests(id),
  former_org_id            uuid not null,
  record_kind              text not null check (record_kind in ('org_account', 'billing_invoice')),
  -- The id the source row had, so a re-run cannot archive it twice.
  source_id                uuid not null,
  plan                     text,
  stripe_customer_id       text,
  stripe_subscription_id   text,
  stripe_invoice_id        text,
  stripe_payment_intent_id text,
  invoice_kind             text,
  invoice_status           text,
  amount_gbp               numeric,
  currency                 text,
  period_start             date,
  period_end               date,
  due_date                 date,
  paid_at                  timestamptz,
  source_created_at        timestamptz,
  retention_until          date not null,
  created_at               timestamptz not null default now(),
  constraint privacy_retained_billing_records_source_key unique (request_id, record_kind, source_id)
);

create index if not exists privacy_retained_billing_records_retention_idx
  on public.privacy_retained_billing_records (retention_until);

alter table public.privacy_retained_billing_records enable row level security;
revoke all on table public.privacy_retained_billing_records from public, anon, authenticated;
grant select, insert on table public.privacy_retained_billing_records to service_role;

comment on table public.privacy_retained_billing_records is
  'Minimised copy of CrewFlow''s OWN billing facts about a deleted company '
  '(amounts, dates, Stripe handles; no identity). Retained to retention_until. '
  'Service-role only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SHARED GUARD — service_role only
-- ─────────────────────────────────────────────────────────────────────────────
-- Every primitive in this workstream is destructive or evidential, so every one
-- re-checks the caller INSIDE the body as well as by GRANT (a future
-- CREATE OR REPLACE re-applying Supabase default privileges must not open one).
create or replace function public._privacy_require_service_role(p_fn text)
returns void language plpgsql stable set search_path = pg_catalog, public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception '%: service_role only', p_fn using errcode = '42501';
  end if;
end $$;

revoke all on function public._privacy_require_service_role(text) from public;
revoke execute on function public._privacy_require_service_role(text) from anon, authenticated;
grant execute on function public._privacy_require_service_role(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CREATE — authorise, confirm, and record a request (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
-- The ROUTE/ACTION is responsible for re-authentication and the feature flag.
-- This primitive is the LAST line: it re-proves the authority and the typed
-- confirmation against the database, under row locks, so a request can never be
-- recorded for an org the actor does not own or a user they may not erase —
-- whatever a buggy or hostile caller passes.
--
--   org           actor must be an OWNER of the org; p_confirm = the org NAME.
--   user_account  actor = target; p_confirm = the account EMAIL; refused while
--                 the user is the SOLE owner of any organisation.
--   staff_erasure actor is owner/admin of the org (owner if the target is an
--                 admin); target is a non-owner member; p_confirm = the staff
--                 member's EMAIL.
--
-- Returns { request_id, status, scheduled_for, created }. A live request for the
-- same target is returned as-is with created=false (double-submit safe).
create or replace function public.privacy_request_create(
  p_kind                text,
  p_target_org_id       uuid,
  p_target_user_id      uuid,
  p_actor_user_id       uuid,
  p_confirm             text,
  p_cooling_off_seconds integer default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role  text;
  v_target_role text;
  v_name        text;
  v_email       text;
  v_existing    public.privacy_deletion_requests%rowtype;
  v_row         public.privacy_deletion_requests%rowtype;
  v_blocking    uuid;
begin
  perform public._privacy_require_service_role('privacy_request_create');

  if p_kind not in ('org', 'user_account', 'staff_erasure') then
    raise exception 'privacy_request_create: unknown kind' using errcode = 'check_violation';
  end if;
  if p_actor_user_id is null then
    raise exception 'privacy_request_create: an actor is required' using errcode = 'check_violation';
  end if;
  if p_cooling_off_seconds is null or p_cooling_off_seconds < 0 or p_cooling_off_seconds > 90 * 86400 then
    raise exception 'privacy_request_create: cooling-off out of range' using errcode = 'check_violation';
  end if;

  if p_kind = 'org' then
    if p_target_org_id is null then
      raise exception 'privacy_request_create: org required' using errcode = 'check_violation';
    end if;
    -- Lock the org and the actor's membership: a concurrent role change waits
    -- for us (and we for it), so the authority we record is the committed one.
    select name into v_name from public.organizations where id = p_target_org_id for update;
    if v_name is null then
      raise exception 'privacy_request_create: organisation not found' using errcode = 'no_data_found';
    end if;
    select role into v_actor_role from public.memberships
      where org_id = p_target_org_id and user_id = p_actor_user_id for update;
    if v_actor_role is distinct from 'owner' then
      raise exception 'privacy_request_create: only the organisation owner may delete the company'
        using errcode = '42501';
    end if;
    if p_confirm is null or btrim(p_confirm) = '' or btrim(p_confirm) <> btrim(v_name) then
      raise exception 'privacy_request_create: confirmation does not match the company name'
        using errcode = 'check_violation';
    end if;
    p_target_user_id := null;

  elsif p_kind = 'user_account' then
    if p_target_user_id is null or p_target_user_id <> p_actor_user_id then
      raise exception 'privacy_request_create: an account may only be deleted by its own user'
        using errcode = '42501';
    end if;
    select email::text into v_email from public.users where id = p_target_user_id for update;
    if v_email is null then
      raise exception 'privacy_request_create: user not found' using errcode = 'no_data_found';
    end if;
    if p_confirm is null or lower(btrim(p_confirm)) <> lower(v_email) then
      raise exception 'privacy_request_create: confirmation does not match the account email'
        using errcode = 'check_violation';
    end if;
    -- SOLE-OWNER BLOCK. Lock this user's memberships, then refuse while any org
    -- they own has no OTHER owner: deleting the account would orphan a company.
    perform 1 from public.memberships where user_id = p_target_user_id for update;
    select m.org_id into v_blocking
    from public.memberships m
    where m.user_id = p_target_user_id and m.role = 'owner'
      and not exists (
        select 1 from public.memberships o
        where o.org_id = m.org_id and o.role = 'owner' and o.user_id <> p_target_user_id
      )
    limit 1;
    if v_blocking is not null then
      raise exception 'privacy_request_create: sole owner of an organisation — transfer ownership or delete the company first'
        using errcode = 'P0001', detail = 'sole_owner';
    end if;
    v_actor_role := 'self';
    p_target_org_id := null;

  else -- staff_erasure
    if p_target_org_id is null or p_target_user_id is null then
      raise exception 'privacy_request_create: org and staff member required' using errcode = 'check_violation';
    end if;
    if p_target_user_id = p_actor_user_id then
      raise exception 'privacy_request_create: use account deletion to erase yourself' using errcode = '42501';
    end if;
    perform 1 from public.organizations where id = p_target_org_id for update;
    select role into v_actor_role from public.memberships
      where org_id = p_target_org_id and user_id = p_actor_user_id for update;
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
      raise exception 'privacy_request_create: only an owner or admin may erase a staff member'
        using errcode = '42501';
    end if;
    select role into v_target_role from public.memberships
      where org_id = p_target_org_id and user_id = p_target_user_id for update;
    if v_target_role is null then
      raise exception 'privacy_request_create: that person is not a member of this organisation'
        using errcode = '42501';
    end if;
    if v_target_role = 'owner' then
      raise exception 'privacy_request_create: an owner cannot be erased by staff erasure'
        using errcode = '42501';
    end if;
    if v_target_role = 'admin' and v_actor_role <> 'owner' then
      raise exception 'privacy_request_create: only the owner may erase an admin' using errcode = '42501';
    end if;
    select email::text into v_email from public.users where id = p_target_user_id;
    if p_confirm is null or v_email is null or lower(btrim(p_confirm)) <> lower(v_email) then
      raise exception 'privacy_request_create: confirmation does not match the staff member''s email'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Idempotent: an existing LIVE request for the same target wins.
  select * into v_existing from public.privacy_deletion_requests r
  where r.kind = p_kind
    and r.target_org_id is not distinct from p_target_org_id
    and r.target_user_id is not distinct from p_target_user_id
    and r.status in ('scheduled', 'running', 'failed')
  limit 1;
  if found then
    return jsonb_build_object('request_id', v_existing.id, 'status', v_existing.status,
                              'scheduled_for', v_existing.scheduled_for, 'created', false);
  end if;

  begin
    insert into public.privacy_deletion_requests
      (kind, target_org_id, target_user_id, actor_user_id, actor_role, scheduled_for)
    values
      (p_kind, p_target_org_id, p_target_user_id, p_actor_user_id, v_actor_role,
       now() + make_interval(secs => p_cooling_off_seconds))
    returning * into v_row;
  exception when unique_violation then
    -- Lost a race with an identical concurrent submit: return the winner.
    select * into v_existing from public.privacy_deletion_requests r
    where r.kind = p_kind
      and r.target_org_id is not distinct from p_target_org_id
      and r.target_user_id is not distinct from p_target_user_id
      and r.status in ('scheduled', 'running', 'failed')
    limit 1;
    return jsonb_build_object('request_id', v_existing.id, 'status', v_existing.status,
                              'scheduled_for', v_existing.scheduled_for, 'created', false);
  end;

  return jsonb_build_object('request_id', v_row.id, 'status', v_row.status,
                            'scheduled_for', v_row.scheduled_for, 'created', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CANCEL — only while still SCHEDULED (the cooling-off window)
-- ─────────────────────────────────────────────────────────────────────────────
-- Once a request is claimed ('running') irreversible work may have started, so
-- it can no longer be cancelled. A company deletion may be cancelled by ANY
-- current owner of that company (not only the requester).
create or replace function public.privacy_request_cancel(
  p_request_id    uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.privacy_deletion_requests%rowtype;
begin
  perform public._privacy_require_service_role('privacy_request_cancel');

  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found then
    raise exception 'privacy_request_cancel: request not found' using errcode = 'no_data_found';
  end if;

  if v_row.kind = 'org' then
    if not exists (
      select 1 from public.memberships
      where org_id = v_row.target_org_id and user_id = p_actor_user_id and role = 'owner'
    ) then
      raise exception 'privacy_request_cancel: only an owner of the company may cancel its deletion'
        using errcode = '42501';
    end if;
  elsif v_row.actor_user_id is distinct from p_actor_user_id then
    raise exception 'privacy_request_cancel: only the requester may cancel this request' using errcode = '42501';
  end if;

  if v_row.status = 'cancelled' then
    return jsonb_build_object('request_id', v_row.id, 'status', 'cancelled', 'changed', false);
  end if;
  if v_row.status <> 'scheduled' then
    raise exception 'privacy_request_cancel: the deletion has already started and cannot be cancelled'
      using errcode = 'P0001', detail = 'already_started';
  end if;

  update public.privacy_deletion_requests
     set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'requester_cancelled', work = '{}'::jsonb
   where id = p_request_id;
  return jsonb_build_object('request_id', v_row.id, 'status', 'cancelled', 'changed', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CLAIM — one runner at a time, and re-prove the authority at run time
-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic: the row lock makes two concurrent runners serialise, and the loser
-- sees status='running' with a live lease and gets NULL back. A crashed runner's
-- lease simply expires and the next claim resumes from the recorded steps.
--
-- DELETION RACING A ROLE CHANGE: a company deletion requested by an owner is
-- re-checked here, on EVERY claim. If the requester is no longer an owner of
-- that company (ownership moved, or they were removed, during the cooling-off
-- window) the request is CANCELLED instead of run — a former owner's stale
-- request can never destroy a company they no longer control. (After the lockout
-- step has run the memberships are gone by design, so the check applies only
-- until then.)
create or replace function public.privacy_request_claim(
  p_request_id    uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.privacy_deletion_requests%rowtype;
begin
  perform public._privacy_require_service_role('privacy_request_claim');
  if p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 3600 then
    raise exception 'privacy_request_claim: lease out of range' using errcode = 'check_violation';
  end if;

  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found then
    return null;
  end if;
  if v_row.status not in ('scheduled', 'failed', 'running') then
    return null;                                   -- completed / cancelled
  end if;
  if v_row.scheduled_for > now() then
    return null;                                   -- still cooling off
  end if;
  if v_row.status = 'running' and v_row.lease_expires_at is not null and v_row.lease_expires_at > now() then
    return null;                                   -- another runner holds it
  end if;

  if v_row.kind = 'org' and v_row.actor_role = 'owner' and not (v_row.steps ? 'lockout') then
    if not exists (
      select 1 from public.memberships
      where org_id = v_row.target_org_id and user_id = v_row.actor_user_id and role = 'owner'
    ) then
      update public.privacy_deletion_requests
         set status = 'cancelled', cancelled_at = now(), work = '{}'::jsonb,
             cancelled_reason = case
               when exists (select 1 from public.organizations where id = v_row.target_org_id)
                 then 'requester_not_owner' else 'target_gone' end
       where id = p_request_id;
      return jsonb_build_object('request_id', v_row.id, 'claimed', false, 'status', 'cancelled');
    end if;
  end if;

  update public.privacy_deletion_requests
     set status = 'running',
         attempts = attempts + 1,
         started_at = coalesce(started_at, now()),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = p_request_id
  returning * into v_row;

  return jsonb_build_object(
    'request_id', v_row.id, 'claimed', true, 'status', v_row.status, 'kind', v_row.kind,
    'target_org_id', v_row.target_org_id, 'target_user_id', v_row.target_user_id,
    'actor_role', v_row.actor_role, 'steps', v_row.steps, 'work', v_row.work, 'attempts', v_row.attempts
  );
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. STEP / FAIL / COMPLETE
-- ─────────────────────────────────────────────────────────────────────────────
-- Record an app-side step (Stripe, Storage, Auth) as done. First write wins: a
-- step already recorded is left untouched, so a replay cannot rewrite evidence.
create or replace function public.privacy_request_step_done(
  p_request_id uuid,
  p_step       text,
  p_detail     jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.privacy_deletion_requests%rowtype;
begin
  perform public._privacy_require_service_role('privacy_request_step_done');
  if p_step is null or p_step !~ '^[a-z0-9_:-]{1,80}$' then
    raise exception 'privacy_request_step_done: bad step name' using errcode = 'check_violation';
  end if;
  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found or v_row.status <> 'running' then
    raise exception 'privacy_request_step_done: request is not running' using errcode = 'check_violation';
  end if;
  if not (v_row.steps ? p_step) then
    update public.privacy_deletion_requests
       set steps = steps || jsonb_build_object(
             p_step, coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('done_at', now()))
     where id = p_request_id
    returning * into v_row;
  end if;
  return v_row.steps;
end;
$$;

create or replace function public.privacy_request_fail(
  p_request_id uuid,
  p_error_code text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public._privacy_require_service_role('privacy_request_fail');
  update public.privacy_deletion_requests
     set status = 'failed',
         lease_expires_at = null,
         last_error_code = left(regexp_replace(lower(coalesce(p_error_code, 'unknown')), '[^a-z0-9_:.-]', '_', 'g'), 120)
   where id = p_request_id and status = 'running';
end;
$$;

-- Seal the tombstone. `p_required_steps` must ALL be recorded — the executor
-- states what "done" means for the kind and the database refuses to seal an
-- incomplete job.
create or replace function public.privacy_request_complete(
  p_request_id     uuid,
  p_required_steps text[],
  p_retention_until date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row  public.privacy_deletion_requests%rowtype;
  v_step text;
begin
  perform public._privacy_require_service_role('privacy_request_complete');
  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found then
    raise exception 'privacy_request_complete: request not found' using errcode = 'no_data_found';
  end if;
  if v_row.status = 'completed' then
    return jsonb_build_object('request_id', v_row.id, 'status', 'completed', 'changed', false);
  end if;
  if v_row.status <> 'running' then
    raise exception 'privacy_request_complete: request is not running' using errcode = 'check_violation';
  end if;
  foreach v_step in array coalesce(p_required_steps, '{}') loop
    if not (v_row.steps ? v_step) then
      raise exception 'privacy_request_complete: step "%" has not run — refusing to seal', v_step
        using errcode = 'check_violation';
    end if;
  end loop;

  update public.privacy_deletion_requests
     set status = 'completed', completed_at = now(), lease_expires_at = null,
         last_error_code = null, work = '{}'::jsonb,
         retention_until = coalesce(p_retention_until, retention_until)
   where id = p_request_id;
  return jsonb_build_object('request_id', v_row.id, 'status', 'completed', 'changed', true);
end;
$$;

-- ── PRIVILEGE LOCKDOWN (service_role only) ───────────────────────────────────
revoke all on function public.privacy_request_create(text, uuid, uuid, uuid, text, integer) from public;
revoke execute on function public.privacy_request_create(text, uuid, uuid, uuid, text, integer) from anon, authenticated;
grant  execute on function public.privacy_request_create(text, uuid, uuid, uuid, text, integer) to service_role;

revoke all on function public.privacy_request_cancel(uuid, uuid) from public;
revoke execute on function public.privacy_request_cancel(uuid, uuid) from anon, authenticated;
grant  execute on function public.privacy_request_cancel(uuid, uuid) to service_role;

revoke all on function public.privacy_request_claim(uuid, integer) from public;
revoke execute on function public.privacy_request_claim(uuid, integer) from anon, authenticated;
grant  execute on function public.privacy_request_claim(uuid, integer) to service_role;

revoke all on function public.privacy_request_step_done(uuid, text, jsonb) from public;
revoke execute on function public.privacy_request_step_done(uuid, text, jsonb) from anon, authenticated;
grant  execute on function public.privacy_request_step_done(uuid, text, jsonb) to service_role;

revoke all on function public.privacy_request_fail(uuid, text) from public;
revoke execute on function public.privacy_request_fail(uuid, text) from anon, authenticated;
grant  execute on function public.privacy_request_fail(uuid, text) to service_role;

revoke all on function public.privacy_request_complete(uuid, text[], date) from public;
revoke execute on function public.privacy_request_complete(uuid, text[], date) from anon, authenticated;
grant  execute on function public.privacy_request_complete(uuid, text[], date) to service_role;

revoke all on function public.tg_privacy_deletion_requests_tombstone() from public;
revoke execute on function public.tg_privacy_deletion_requests_tombstone() from anon, authenticated;
