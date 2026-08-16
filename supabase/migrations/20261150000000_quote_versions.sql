-- Quote version history — an append-only snapshot chain for quotes.
--
-- The gap (recon)
-- ----------------
-- Quotes have NO revision/supersede chain. Editing an approved/sent quote just
-- reverts it to pending_approval (updateQuote, 20260522000000), and once a quote
-- is accepted its money + scope are frozen AT THE DATABASE (20261004/20261007) —
-- but nothing preserves what the figures WERE at each commercial milestone. A
-- customer who was sent £4,000, then re-approved at £4,500 after a scope change,
-- leaves no trace of the £4,000 they first saw. This adds that history.
--
-- The pattern — MIRRORS invoice_line_item_snapshot (20260916000000)
-- -----------------------------------------------------------------
-- Like invoices, the snapshot is created by a TRIGGER that is the SOLE creation
-- authority, running in the writer's OWN transaction. For invoices the event is
-- INSERT; for a quote the commercial milestones are its STATUS TRANSITIONS into
-- 'sent' and 'approved' (the send + re-approval points in
-- app/(app)/quotes/actions.ts — sendQuote() and reviewQuote()). Keying on the
-- transition covers EVERY writer automatically (owner UI, public token path,
-- imports, a direct PostgREST write) with no app-code snapshot call to forget or
-- duplicate — exactly the invoice rationale.
--
-- Append-only, mirroring the accepted-quote immutability hardening
-- ---------------------------------------------------------------
-- A version, once captured, is history: it must never change. Enforced two ways,
-- belt-and-braces like the CIS snapshot ledger (20261051000000):
--   * RLS grants members SELECT only — no INSERT/UPDATE/DELETE policy exists, so
--     no tenant DML can write the table at all; and
--   * BEFORE UPDATE / BEFORE DELETE backstop triggers raise for EVERY role,
--     service_role included, so even a privileged direct write can't rewrite or
--     erase a captured version. The DELETE backstop yields only to the parent
--     quote's ON DELETE CASCADE (it allows the delete once the parent quote row
--     is already gone), so deleting a quote still tears its history down.
--
-- Tenant integrity: composite FK (quote_id, org_id) -> quotes(id, org_id), the
-- #351/#357 pattern, so a version can reference only a quote in its own org.
--
-- Prod-data safety: this migration is ADDITIVE (new table + triggers) and its
-- backfill is written to be safe + idempotent regardless of environment — prod
-- was NOT measured (no DB access from this build). Reversible:
--   drop trigger quotes_capture_version on public.quotes;
--   drop table public.quote_versions;  -- (drops its own triggers)
--   drop function public._tg_quotes_capture_version();
--   drop function public.tg_quote_versions_frozen();
--   drop function public.tg_quote_versions_no_delete();

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. Parent candidate key the composite FK targets
-- ═══════════════════════════════════════════════════════════════════════════
-- quotes_id_org_key (id, org_id) already exists (20261084000000); re-asserted
-- introspection-guarded so this migration is self-contained.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_id_org_key') then
    alter table public.quotes add constraint quotes_id_org_key unique (id, org_id);
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The snapshot table
-- ═══════════════════════════════════════════════════════════════════════════
-- Each row is a self-contained, immutable snapshot of the quote at one milestone:
-- its captured money figures + a jsonb array of its line items exactly as they
-- stood. No FK from the snapshot's line items back to quote_line_items — a
-- snapshot must not point at the mutable source (same rule as invoice_line_items
-- omitting quote_id).
create table if not exists public.quote_versions (
  id              uuid primary key default gen_random_uuid(),
  quote_id        uuid not null,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- Monotonic per quote. Assigned by the capture trigger as max+1. The unique
  -- (quote_id, version_number) key below is the idempotency guarantee.
  version_number  integer not null,
  -- Why this version was captured: the status transition that fired it.
  captured_reason text not null,
  -- The quote's live status at capture (the value it transitioned INTO).
  status          text not null,
  -- Captured money figures, mirroring quotes' own precision.
  currency        text not null,
  subtotal        numeric(12, 2) not null,
  vat_total       numeric(12, 2) not null,
  total           numeric(12, 2) not null,
  -- The line items as they stood, as a jsonb array. Elements carry exactly the
  -- fields needed to reproduce + diff a line: description, qty, unit, unit_price,
  -- vat_rate, line_total, sort_order.
  line_items      jsonb not null default '[]'::jsonb,
  captured_at     timestamp with time zone not null default now(),
  -- captured_reason is a closed vocabulary — deterministic, no free text.
  constraint quote_versions_reason_check
    check (captured_reason in ('sent', 'approved', 're-approved')),
  -- line_items must be a JSON array (never an object/scalar), so readers can rely
  -- on jsonb_array_elements without a shape check.
  constraint quote_versions_line_items_is_array
    check (jsonb_typeof(line_items) = 'array'),
  -- Idempotency: at most one snapshot per (quote, version). The capture trigger
  -- inserts ON CONFLICT DO NOTHING against this key.
  constraint quote_versions_quote_version_key unique (quote_id, version_number),
  -- Tenant integrity (#351/#357): a version may reference only a quote in the
  -- SAME org. quotes_id_org_key (id, org_id) is the candidate key. ON DELETE
  -- CASCADE ties a version's lifecycle to its quote.
  constraint quote_versions_quote_org_fkey
    foreign key (quote_id, org_id)
    references public.quotes (id, org_id)
    on delete cascade
);

comment on table public.quote_versions is
  'Append-only version history for quotes: an immutable snapshot (captured money '
  'figures + line_items jsonb) taken at each SEND and (re-)APPROVAL milestone. '
  'Mirrors invoice_line_item_snapshot (trigger is sole creation authority) and '
  'the CIS snapshot ledger (RLS select-only + service-role backstop triggers).';

comment on constraint quote_versions_quote_org_fkey on public.quote_versions is
  'Tenant integrity: a version may reference only a quote in the same org '
  '(composite FK, #351/#357). CASCADE ties the version lifecycle to the quote.';

-- Deterministic ordering + the hot read (all versions for one quote, newest or
-- oldest first).
create index if not exists quote_versions_quote_idx
  on public.quote_versions (quote_id, version_number);

alter table public.quote_versions enable row level security;

-- RLS: org members READ their own org's versions. There is deliberately NO
-- insert/update/delete policy — the table is written only by the SECURITY
-- DEFINER capture trigger below, never by tenant DML.
drop policy if exists "quote_versions: members can select" on public.quote_versions;
create policy "quote_versions: members can select" on public.quote_versions
  for select to authenticated
  using (org_id in (select public.current_org_ids()));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Append-only backstop — service-role included
-- ═══════════════════════════════════════════════════════════════════════════
-- A captured version is history. These raise for EVERY role (no auth.uid()/role
-- gate), so even a direct service_role write can't rewrite or erase one — the
-- same posture as the CIS payment snapshot (20261051000000).

create or replace function public.tg_quote_versions_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception
    'quote version %/% is immutable — quote versions are append-only history',
    old.quote_id, old.version_number using errcode = 'check_violation';
end $$;

drop trigger if exists quote_versions_frozen on public.quote_versions;
create trigger quote_versions_frozen
  before update on public.quote_versions
  for each row execute function public.tg_quote_versions_frozen();

-- DELETE is refused too — EXCEPT the parent quote's ON DELETE CASCADE. During a
-- cascade the parent quote row is deleted first, so by the time this fires the
-- quote no longer exists and the delete is allowed; a bare direct delete (parent
-- still present) is refused. Same idiom as tg_cis_payment_snapshots_no_delete.
create or replace function public.tg_quote_versions_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.quotes where id = old.quote_id)
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'quote version %/% cannot be deleted — versions are append-only (delete the quote to remove its history)',
      old.quote_id, old.version_number using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists quote_versions_no_delete on public.quote_versions;
create trigger quote_versions_no_delete
  before delete on public.quote_versions
  for each row execute function public.tg_quote_versions_no_delete();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The capture trigger — the SOLE creation authority
-- ═══════════════════════════════════════════════════════════════════════════
-- Fires AFTER a quotes UPDATE that transitions status INTO 'sent' or 'approved'
-- (and only on an actual change — new.status distinct from old.status — so a
-- no-op update, or writing job_id/accepted_at on an already-sent quote, never
-- re-snapshots). Same-org line items are frozen into a jsonb array. Runs in the
-- update's own transaction, so a snapshot failure rolls the transition back.
create or replace function public._tg_quotes_capture_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_next   integer;
  v_reason text;
  v_lines  jsonb;
begin
  -- Gate: only the two capture milestones, only on a real transition.
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status not in ('sent', 'approved') then
    return new;
  end if;

  -- Reason: a re-approval is an 'approved' transition when an approval snapshot
  -- already exists for this quote; the first approval is plain 'approved'.
  if new.status = 'sent' then
    v_reason := 'sent';
  elsif exists (
    select 1 from public.quote_versions
    where quote_id = new.id
      and captured_reason in ('approved', 're-approved')
  ) then
    v_reason := 're-approved';
  else
    v_reason := 'approved';
  end if;

  -- Next version number for this quote (max+1). The unique key + ON CONFLICT
  -- below make a concurrent double-fire settle to a single row.
  select coalesce(max(version_number), 0) + 1
    into v_next
  from public.quote_versions
  where quote_id = new.id;

  -- Freeze the line items, same-org only, into a deterministic jsonb array.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'description', li.description,
               'qty',         li.qty,
               'unit',        li.unit,
               'unit_price',  li.unit_price,
               'vat_rate',    li.vat_rate,
               'line_total',  li.line_total,
               'sort_order',  li.sort_order
             )
             order by li.sort_order, li.id
           ),
           '[]'::jsonb
         )
    into v_lines
  from public.quote_line_items li
  where li.quote_id = new.id
    and li.org_id = new.org_id;

  insert into public.quote_versions (
    quote_id, org_id, version_number, captured_reason, status,
    currency, subtotal, vat_total, total, line_items
  ) values (
    new.id, new.org_id, v_next, v_reason, new.status,
    new.currency, new.subtotal, new.vat_total, new.total, v_lines
  )
  on conflict (quote_id, version_number) do nothing;

  return new;
  -- No error handler here: any failure propagates and rolls back the quote
  -- transition — no 'sent'/'approved' quote can exist without its snapshot.
end;
$fn$;

drop trigger if exists quotes_capture_version on public.quotes;
create trigger quotes_capture_version
  after update on public.quotes
  for each row execute function public._tg_quotes_capture_version();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Legacy backfill — safe + idempotent
-- ═══════════════════════════════════════════════════════════════════════════
-- Historical transitions weren't recorded, but the CURRENT state of any quote
-- that has already been sent or approved is a meaningful baseline (version 1).
-- Seed exactly that, only where no version exists yet (so re-running is a no-op),
-- and only for quotes whose lifecycle has passed a capture milestone.
--
-- Reason: 'sent' if the quote has been sent (sent_at present), else 'approved'
-- (approved_at present). Both null → the quote never reached a milestone → skip.
insert into public.quote_versions (
  quote_id, org_id, version_number, captured_reason, status,
  currency, subtotal, vat_total, total, line_items
)
select
  q.id,
  q.org_id,
  1,
  case when q.sent_at is not null then 'sent' else 'approved' end,
  q.status,
  q.currency,
  q.subtotal,
  q.vat_total,
  q.total,
  coalesce(
    (
      select jsonb_agg(
               jsonb_build_object(
                 'description', li.description,
                 'qty',         li.qty,
                 'unit',        li.unit,
                 'unit_price',  li.unit_price,
                 'vat_rate',    li.vat_rate,
                 'line_total',  li.line_total,
                 'sort_order',  li.sort_order
               )
               order by li.sort_order, li.id
             )
      from public.quote_line_items li
      where li.quote_id = q.id
        and li.org_id = q.org_id
    ),
    '[]'::jsonb
  )
from public.quotes q
where (q.sent_at is not null or q.approved_at is not null)
  and not exists (
    select 1 from public.quote_versions existing
    where existing.quote_id = q.id
  );
