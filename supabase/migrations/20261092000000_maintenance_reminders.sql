-- Maintenance reminders — the PROACTIVE-SEND engine for warranty servicing and
-- warranty expiry, built BUILT-BUT-DARK.
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
-- Phase 7 shipped warranties (20261079) and a customer portal that DISPLAYS the
-- servicing schedule and the expiry date — and says, in as many words, that
-- "we don't send warranty or service reminders, so please diarise anything you
-- need to act on" (app/customer-portal/[token]/warranties/page.tsx). Every date
-- on that page is DERIVED at read time by lib/warranties/schedule.ts; there is
-- no queue, no job and no email. This migration adds the log the send engine
-- writes so that turning the sends on is a CONFIG FLIP — a feature flag plus the
-- already-live Resend email seam — not an engineering project.
--
-- ── WHAT THIS TABLE IS, AND IS NOT ──────────────────────────────────────────
-- `maintenance_reminder_log` is an AUDIT of reminder INTENT and OUTCOME, one row
-- per (warranty, reminder-kind, due date). It is NOT a schedule and NOT a source
-- of truth for dates: every due date is still DERIVED from the issued completion
-- certificate by lib/warranties/schedule.ts and merely COPIED here at the moment
-- a reminder becomes due, so the log records exactly what a customer was (or
-- would have been) reminded about. A dropped or changed warranty term changes
-- future reminders; it never rewrites a row already logged.
--
-- ── DARK BY DEFAULT — THE SEND IS GATED IN CODE, NOT HERE ───────────────────
-- This migration adds no sender and flips no switch. The drain
-- (server/services/maintenance-reminders.ts) UPSERTS a due reminder as `pending`
-- and then, ONLY IF the feature flag is on AND email is genuinely sendable,
-- sends it and marks `sent`. With the flag off it marks `skipped_dark` and sends
-- NOTHING. The `status` vocabulary below is what makes "we computed a reminder
-- but deliberately sent nothing" a first-class, observable outcome rather than a
-- silent gap. Until the flag flips, every row this table ever gets is
-- `skipped_dark`.
--
-- ── IDEMPOTENCY IS STRUCTURAL ───────────────────────────────────────────────
-- A cron drain runs repeatedly; a warranty's servicing due date sits inside the
-- lead-time window for many days. Without a uniqueness key the same reminder
-- would be re-created — and, once live, re-SENT — on every tick. The dedupe key
-- is (org_id, warranty_id, kind, due_date): the DUE DATE is the window identity,
-- so at most one reminder row exists per warranty per due occurrence, forever.
-- The drain writes with ON CONFLICT DO NOTHING, so a re-run is a no-op.
--
-- ── TENANCY + RLS ───────────────────────────────────────────────────────────
-- Org-pinned, RLS enabled, members read / admins write — the expense_budgets
-- (20261089) posture, DB-enforced for the same reason: an app-only gate leaves
-- /rest/v1/maintenance_reminder_log open to any member holding a JWT. The drain
-- itself runs on the service-role client (createAdminClient), which BYPASSES
-- RLS, so it can write across tenants from the cron; the RLS policies govern the
-- authenticated PostgREST surface only.
--
-- Additive and reversible. To roll back:
--   drop table public.maintenance_reminder_log;
-- Migrate-first safe: nothing reads this table on the hot path; absent → the
-- drain simply has nowhere to write and the portal is unaffected.

-- ── 1. maintenance_reminder_log — one row per (warranty, kind, due date) ─────
create table if not exists public.maintenance_reminder_log (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  -- The warranty this reminder is about. Bound by the composite (id, org_id)
  -- FK job_warranties exposes (20261079 job_warranties_id_org_key), so the
  -- reminder's org can never drift from its warranty's org.
  warranty_id  uuid not null,
  -- Denormalised for the send path (job → customer email) and for a human
  -- reading the log; the (job_id, org_id) composite FK keeps it honest.
  job_id       uuid not null,

  -- What the reminder is FOR. 'service' = a servicing occurrence inside the
  -- warranty term; 'expiry' = the warranty's own end date approaching. Both are
  -- derived by lib/warranties/schedule.ts.
  kind         text not null default 'service'
               check (kind in ('service', 'expiry')),

  -- The DERIVED due date this reminder concerns (YYYY-MM-DD). Part of the dedupe
  -- key — it is the window identity, so one reminder exists per occurrence.
  due_date     date not null,
  -- When the reminder became eligible to send: due_date minus the lead-time
  -- cadence (lib/maintenance/reminders.ts REMINDER_LEAD_DAYS). Recorded for
  -- audit; the drain does not re-derive it.
  scheduled_for date not null,

  -- The transport. Only email exists today; CHECK-restricted so a second channel
  -- is a migration, not a free-text drift.
  channel      text not null default 'email'
               check (channel in ('email')),

  -- The lifecycle. `pending` is the transient state between upsert and the
  -- drain's send decision. On the LIVE path a drain first CLAIMS a row
  -- pending → `sending` (see claim_due_maintenance_reminders below), sends, then
  -- marks `sent` (flag on + email sendable) — or, on a provider refusal, releases
  -- it back to `pending` for a later drain. On the DARK path (the default) it
  -- resolves straight to `skipped_dark` — computed but deliberately not sent.
  -- `sending` is the in-flight claim marker that makes double-send
  -- unrepresentable: a row already `sending`/`sent` can never be re-claimed.
  -- `dismissed` is a manual suppression so a reminder is not re-created for a
  -- handled occurrence.
  status       text not null default 'pending'
               check (status in ('pending', 'sending', 'sent', 'skipped_dark', 'dismissed')),

  -- The Resend message id when actually sent; null on every non-sent status.
  -- Kept alongside sent_at so a `sent` row can never claim delivery with no
  -- evidence of it.
  provider_message_id text,
  sent_at      timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- IDEMPOTENCY. At most one reminder per warranty per kind per due occurrence,
  -- for all time. The drain relies on this via INSERT … ON CONFLICT DO NOTHING.
  constraint maintenance_reminder_log_dedupe_uniq
    unique (org_id, warranty_id, kind, due_date),
  -- A `sent` row must carry evidence; a non-`sent` row must not claim it. Makes
  -- "marked sent but nothing went out" unrepresentable.
  constraint maintenance_reminder_log_sent_has_evidence check (
    (status = 'sent') = (sent_at is not null)
  ),
  -- Composite candidate key for any future child (the additive precedent).
  constraint maintenance_reminder_log_id_org_key unique (id, org_id),
  -- The warranty must belong to the same org as the reminder.
  constraint maintenance_reminder_log_warranty_fk
    foreign key (warranty_id, org_id)
    references public.job_warranties (id, org_id) on delete cascade,
  -- The job must belong to the same org as the reminder.
  constraint maintenance_reminder_log_job_fk
    foreign key (job_id, org_id)
    references public.jobs (id, org_id) on delete cascade
);

create index if not exists maintenance_reminder_log_org_idx
  on public.maintenance_reminder_log (org_id);
-- The drain's hot path: find this org's rows still awaiting a send decision.
create index if not exists maintenance_reminder_log_org_status_idx
  on public.maintenance_reminder_log (org_id, status);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists maintenance_reminder_log_set_updated_at on public.maintenance_reminder_log;
create trigger maintenance_reminder_log_set_updated_at before update on public.maintenance_reminder_log
  for each row execute function public.tg_set_updated_at();

-- ── 2. RLS — members read, admins write (the expense_budgets posture) ────────
-- Members READ so the team can see what was (or would have been) reminded; only
-- admins may write from the authenticated surface. The cron drain writes via the
-- service-role client, which bypasses RLS entirely.
alter table public.maintenance_reminder_log enable row level security;

drop policy if exists "maintenance_reminder_log: members can select" on public.maintenance_reminder_log;
create policy "maintenance_reminder_log: members can select" on public.maintenance_reminder_log
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "maintenance_reminder_log: admins can insert" on public.maintenance_reminder_log;
create policy "maintenance_reminder_log: admins can insert" on public.maintenance_reminder_log
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "maintenance_reminder_log: admins can update" on public.maintenance_reminder_log;
create policy "maintenance_reminder_log: admins can update" on public.maintenance_reminder_log
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "maintenance_reminder_log: admins can delete" on public.maintenance_reminder_log;
create policy "maintenance_reminder_log: admins can delete" on public.maintenance_reminder_log
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── 3. claim_due_maintenance_reminders — the send engine's once-only guard ────
-- The proactive-send drain (server/services/maintenance-reminders.ts) runs on
-- the service-role client and, once live, must send each due reminder AT MOST
-- ONCE even if two drains overlap or a mark fails mid-flight. A naive
-- read-pending-then-send is at-least-once (a failed `sent` mark re-sends on the
-- next tick) and double-sends under concurrency (two drains read the same
-- `pending` rows). This function is the fix, mirroring the ai_reserve_invocation
-- serialisation idiom (20261070):
--
--   • pg_advisory_xact_lock on the org SERIALISES overlapping drains for the
--     same tenant — the second waits for the first's claim to commit; different
--     orgs never contend.
--   • the conditional UPDATE pending → 'sending' … RETURNING atomically CLAIMS
--     the rows THIS call won and hands them back. A row already 'sending'/'sent'
--     is not matched, so it can never be claimed — and therefore sent — twice.
--
-- The caller sends only the returned rows, then marks each 'sent' (with
-- evidence) or, on a provider refusal, releases it back to 'pending'. Because
-- the claim happens BEFORE the send, a failed 'sent' mark strands the row in
-- 'sending' (never re-claimed), never re-sends it — the safe direction.
--
-- The DARK path never calls this: it sends nothing, so an overlapping dark drain
-- marking the same rows skipped_dark is harmless and needs no lock.
--
-- SECURITY INVOKER (no `security definer`): the service-role caller bypasses RLS
-- already; this exists only for the atomic claim a client statement sequence
-- cannot express. Additive and reversible: drop function … to roll back.
create or replace function public.claim_due_maintenance_reminders(p_org_id uuid)
returns table (
  id           uuid,
  warranty_id  uuid,
  job_id       uuid,
  kind         text,
  due_date     date
)
language plpgsql
set search_path = ''
as $$
begin
  if p_org_id is null then
    raise exception 'organisation is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serialise overlapping drains for this org; different orgs never contend.
  perform pg_advisory_xact_lock(hashtext('maintenance_reminders_drain'), hashtext(p_org_id::text));

  return query
    update public.maintenance_reminder_log m
       set status = 'sending', updated_at = now()
     where m.org_id = p_org_id
       and m.status = 'pending'
    returning m.id, m.warranty_id, m.job_id, m.kind, m.due_date;
end;
$$;

revoke all on function public.claim_due_maintenance_reminders(uuid) from public;
grant execute on function public.claim_due_maintenance_reminders(uuid) to service_role;
