-- Tenant teardown fix — make `delete from organizations` possible again.
--
-- BUG (P1, pre-existing): deleting an organisation raised
--   ERROR: insert or update on table "activity_log" violates foreign key
--          constraint "activity_log_org_id_fkey"
-- for any org holding a row in a table that has BOTH an AFTER-DELETE activity
-- trigger AND `on delete cascade` to organizations. Since every real org
-- records expenses (public.finances), this blocked tenant teardown and GDPR
-- erasure for essentially every tenant.
--
-- WHY: `delete from organizations` removes the org row first, then runs the FK
-- cascade. Each cascaded child DELETE fires its `_tg_*_activity` trigger, which
-- calls public._record_activity(), which INSERTs into public.activity_log —
-- a table whose own org_id FK points at the organisation that the cascade has
-- ALREADY removed. The insert can never satisfy that FK, so the whole
-- transaction aborts. It is not a race: the failure is guaranteed.
--
-- Audited blast radius — six triggers reach this path:
--   customers, finances, invoice_payments, jobs, leads, rota_entries
--
-- That list is EXHAUSTIVE, established by catalogue query rather than by grep:
-- a recursive closure over pg_proc.prosrc for every function that reaches
-- _record_activity OR writes activity_log directly returns 14 functions
-- (_record_activity plus 13 _tg_*_activity triggers) and finds no indirect
-- caller — every one calls the chokepoint directly, so there is no deeper layer
-- to miss. Intersecting those with pg_trigger rows that fire on DELETE
-- (tgtype & 8) on a table whose FK to organizations is ON DELETE CASCADE
-- (confdeltype = 'c') yields exactly the six above. The other seven activity
-- triggers (imports, invoice_reminders, invoices, leave_requests, payroll_runs,
-- quotes, time_entries) fire only on INSERT/UPDATE and are never reached by a
-- cascade. There is no direct-insert variant: the only two `insert into
-- public.activity_log` statements in the whole migration history are the two
-- successive definitions of _record_activity itself.
--
-- _record_activity does have non-trigger callers (the service-role RPC in
-- app/admin/actions.ts and app/(app)/quotes/actions.ts). None can depend on the
-- old behaviour: they always pass a live org, and for a dead org the old
-- behaviour was an exception that wrote nothing. No caller loses a row.
--
-- FIX: one early guard at the top of _record_activity — if the organisation no
-- longer exists, return without writing. Fixing the chokepoint fixes all six
-- triggers at once, which is why this is a function change and not six trigger
-- changes.
--
-- BEHAVIOUR-PRESERVING on every path that currently succeeds. The guard can
-- only be true when the org row is absent, and an activity_log row for an
-- absent org is *by definition* unwritable (its FK forbids it). So the guard
-- converts a guaranteed ERROR into a no-op and changes nothing else:
--   - Ordinary deletes (org alive) still log exactly as before — deleting one
--     finances row keeps writing its 'finance.deleted' entry.
--   - The guard cannot silently drop live rows, and RLS cannot make the
--     existence check lie, for TWO independent reasons: public.organizations is
--     owned by `postgres` with RLS enabled but NOT forced (an owner bypasses a
--     non-forced policy), and `postgres` additionally holds rolbypassrls. This
--     function is SECURITY DEFINER owned by postgres, so it sees every
--     organisation whether the caller is authenticated or service_role. The one
--     SELECT policy on organizations (membership via current_org_ids()) is
--     therefore never applied to this check.
--   - The HQ event spine is untouched. The trailing hq_emit_from_activity()
--     call is skipped only when the guard fires, i.e. only for '*.deleted'
--     actions during a cascade. Verified against the live mapper: its curated
--     set is customer.created, customer.updated, job.created, job.completed
--     (from job.status_changed), quote.sent, quote.accepted — no '*.deleted'
--     action maps to a verb, so not one spine event is lost. (hq_events also
--     carries no FK to organizations, so the spine could not have been the
--     source of this FK failure either.)
--   - Cost is a primary-key lookup per activity write.
--   - NOT a concurrency fix, and not a regression in one: an activity write
--     racing a concurrent org DELETE still resolves exactly as it does today.
--     The guard is a snapshot read; the FK check behind it still takes its KEY
--     SHARE lock and still refuses the row if the org commits away underneath.
--     The guard only converts the DETERMINISTIC same-transaction cascade case.
--
-- Reproduction that fails before this migration and succeeds after:
--   begin;
--   insert into organizations (id, name, slug)
--     values ('33333333-3333-3333-3333-333333333333','PreExist','pre-exist');
--   insert into finances (org_id, amount, vat_rate)
--     values ('33333333-3333-3333-3333-333333333333', 100, 0);
--   delete from organizations where id='33333333-3333-3333-3333-333333333333';
--   rollback;
--
-- Regression cover: __tests__/integration/rls/org-teardown-cascade.test.ts.
--
-- Reproduced from 20260720010000_hq_event_spine_producers.sql — the current
-- definition of this function, confirmed to be the last one in migration order —
-- with the guard as the ONLY change; the signature, actor resolution,
-- activity_log insert and the spine dual-write call are otherwise byte-for-byte
-- identical. Idempotent (CREATE OR REPLACE); re-application is safe.
--
-- PRIVILEGES: 20260708000001_secdef_rpc_tenant_guards.sql revoked EXECUTE on
-- this function from public/anon/authenticated, locking it to the owner and
-- service_role. CREATE OR REPLACE preserves the existing ACL — it does not
-- reset privileges — and this repo already proves it: 20260720010000 replaced
-- this same function AFTER that revoke, and the live catalogue still reports
-- proacl = {postgres=X/postgres,service_role=X/postgres}. The revoke is
-- nevertheless re-asserted below so the lock-down is a property of the current
-- migration and not an inherited side effect. It is idempotent (revoking an
-- absent privilege is a no-op).

create or replace function public._record_activity(
  p_org_id        uuid,
  p_action        text,
  p_target_table  text,
  p_target_id     uuid,
  p_metadata      jsonb default null,
  p_actor_override text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid;
  v_actor_name text;
begin
  -- Cascade guard (see header). When the organisation is already gone — which
  -- is the case for every child row deleted by `delete from organizations` —
  -- there is no writable activity row to record, so return before touching
  -- activity_log or the event spine.
  if not exists (select 1 from public.organizations where id = p_org_id) then
    return;
  end if;

  v_actor_id := auth.uid();
  if p_actor_override is not null and p_actor_override <> '' then
    v_actor_name := p_actor_override;
  elsif v_actor_id is not null then
    select coalesce(full_name, email)
    into v_actor_name
    from public.users
    where id = v_actor_id;
  else
    v_actor_name := 'System';
  end if;

  insert into public.activity_log (
    org_id, actor_id, actor_name, action,
    target_table, target_id, metadata
  )
  values (
    p_org_id, v_actor_id, v_actor_name, p_action,
    p_target_table, p_target_id, p_metadata
  );

  -- PR2 (Module 1): dual-write the canonical HQ event in THIS transaction so
  -- state and narrative are inseparable (D1, Ch.04). No-op while the spine flag
  -- is dark or the action is outside the curated OPERATIONS subset, so existing
  -- activity logging is byte-for-byte unchanged until an operator opts in.
  perform public.hq_emit_from_activity(
    p_org_id, v_actor_id, v_actor_name,
    p_action, p_target_table, p_target_id, p_metadata
  );
end;
$$;

-- Re-assert the internal-only lock from 20260708000001 (idempotent; see header).
revoke execute on function public._record_activity(uuid, text, text, uuid, jsonb, text)
  from public, anon, authenticated;
