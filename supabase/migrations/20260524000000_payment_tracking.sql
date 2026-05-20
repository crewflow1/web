-- Wave 3 — Payment Tracking OS + Tax foundation
--
-- CrewFlow does NOT process payments (Stripe etc.) — UK construction
-- companies are paid by bank transfer. We TRACK payments instead:
--   - Each invoice has zero or more invoice_payments rows
--   - Status auto-updates: any payment → 'partially_paid' / 'paid'
--   - Bank reconciliation: operator uploads CSV → suggested matches
--
-- New tables:
--   invoice_payments       (one row per money-in event)
--   bank_statements        (upload metadata)
--   bank_statement_lines   (one row per CSV row + auto-match scoring)
--
-- Existing invoice.status enum gains: awaiting_payment, partially_paid.

-- =========================================================================
-- Status enum extension
-- =========================================================================
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_enum e on t.oid = e.enumtypid
    where t.typname = 'invoice_status' and e.enumlabel = 'awaiting_payment'
  ) then
    alter type public.invoice_status add value if not exists 'awaiting_payment' before 'paid';
  end if;
  if not exists (
    select 1 from pg_type t join pg_enum e on t.oid = e.enumtypid
    where t.typname = 'invoice_status' and e.enumlabel = 'partially_paid'
  ) then
    alter type public.invoice_status add value if not exists 'partially_paid' before 'paid';
  end if;
end $$;

-- =========================================================================
-- invoice_payments
-- =========================================================================
create table if not exists public.invoice_payments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  invoice_id      uuid not null references public.invoices(id) on delete cascade,
  amount          numeric(12, 2) not null check (amount > 0),
  paid_at         date not null,
  reference       text,                -- e.g. "INV-0007", customer's bank ref
  notes           text,
  source          text not null default 'manual' check (source in ('manual', 'bank_csv')),
  bank_line_id    uuid,                -- FK added below once bank_statement_lines exists
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

create index if not exists invoice_payments_invoice_idx on public.invoice_payments (invoice_id);
create index if not exists invoice_payments_org_paid_at_idx on public.invoice_payments (org_id, paid_at desc);
create index if not exists invoice_payments_bank_line_idx on public.invoice_payments (bank_line_id);

drop trigger if exists invoice_payments_set_updated_at on public.invoice_payments;
create trigger invoice_payments_set_updated_at before update on public.invoice_payments
  for each row execute function public.tg_set_updated_at();

alter table public.invoice_payments enable row level security;

drop policy if exists "invoice_payments: members select" on public.invoice_payments;
create policy "invoice_payments: members select" on public.invoice_payments
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists "invoice_payments: members insert" on public.invoice_payments;
create policy "invoice_payments: members insert" on public.invoice_payments
  for insert to authenticated
  with check (public.is_org_member(org_id));

drop policy if exists "invoice_payments: members update" on public.invoice_payments;
create policy "invoice_payments: members update" on public.invoice_payments
  for update to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

drop policy if exists "invoice_payments: admins delete" on public.invoice_payments;
create policy "invoice_payments: admins delete" on public.invoice_payments
  for delete to authenticated
  using (public.is_org_admin(org_id));

-- =========================================================================
-- bank_statements + lines (CSV upload + match foundation)
-- =========================================================================
create table if not exists public.bank_statements (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  filename     text not null,
  uploaded_by  uuid references public.users(id) on delete set null,
  uploaded_at  timestamp with time zone not null default now(),
  line_count   integer not null default 0,
  matched_count integer not null default 0,
  notes        text
);

create index if not exists bank_statements_org_uploaded_at_idx
  on public.bank_statements (org_id, uploaded_at desc);

alter table public.bank_statements enable row level security;
drop policy if exists "bank_statements: members select" on public.bank_statements;
create policy "bank_statements: members select" on public.bank_statements
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists "bank_statements: admins insert" on public.bank_statements;
create policy "bank_statements: admins insert" on public.bank_statements
  for insert to authenticated with check (public.is_org_admin(org_id));
drop policy if exists "bank_statements: admins delete" on public.bank_statements;
create policy "bank_statements: admins delete" on public.bank_statements
  for delete to authenticated using (public.is_org_admin(org_id));

create table if not exists public.bank_statement_lines (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  bank_statement_id  uuid not null references public.bank_statements(id) on delete cascade,
  posted_at          date not null,
  amount             numeric(12, 2) not null, -- positive = incoming, negative = outgoing
  description        text,
  reference          text,
  -- Match resolution
  matched_invoice_id uuid references public.invoices(id) on delete set null,
  matched_payment_id uuid references public.invoice_payments(id) on delete set null,
  match_confidence   integer check (match_confidence between 0 and 100),
  match_status       text not null default 'unmatched'
                      check (match_status in ('unmatched', 'suggested', 'confirmed', 'ignored')),
  created_at         timestamp with time zone not null default now()
);

create index if not exists bank_lines_statement_idx
  on public.bank_statement_lines (bank_statement_id);
create index if not exists bank_lines_org_status_idx
  on public.bank_statement_lines (org_id, match_status);
create index if not exists bank_lines_matched_invoice_idx
  on public.bank_statement_lines (matched_invoice_id);

alter table public.bank_statement_lines enable row level security;
drop policy if exists "bank_lines: members select" on public.bank_statement_lines;
create policy "bank_lines: members select" on public.bank_statement_lines
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists "bank_lines: members insert" on public.bank_statement_lines;
create policy "bank_lines: members insert" on public.bank_statement_lines
  for insert to authenticated with check (public.is_org_member(org_id));
drop policy if exists "bank_lines: members update" on public.bank_statement_lines;
create policy "bank_lines: members update" on public.bank_statement_lines
  for update to authenticated using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

-- Now we can add the FK from invoice_payments → bank_statement_lines
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoice_payments_bank_line_fkey'
  ) then
    alter table public.invoice_payments
      add constraint invoice_payments_bank_line_fkey
      foreign key (bank_line_id) references public.bank_statement_lines(id)
      on delete set null;
  end if;
end $$;

-- =========================================================================
-- Auto-status trigger on invoice_payments
-- =========================================================================
-- When a payment is added/changed/removed:
--   - sum payments for that invoice
--   - if sum >= invoice.total → status = 'paid', paid_at = max payment date
--   - if 0 < sum < total      → status = 'partially_paid'
--   - if sum == 0             → status reverts to 'sent' (only if previously
--                                'paid' / 'partially_paid'); leaves other
--                                statuses alone
-- The invoice.status check constraint already allows all values.
create or replace function public._tg_invoice_payments_sync_status()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice_id   uuid;
  v_org_id       uuid;
  v_total        numeric(12, 2);
  v_paid         numeric(12, 2);
  v_current      text;
  v_next         text;
  v_paid_at      date;
begin
  v_invoice_id := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_org_id := COALESCE(NEW.org_id, OLD.org_id);

  select total, status into v_total, v_current
    from public.invoices where id = v_invoice_id;

  select COALESCE(SUM(amount), 0), MAX(paid_at) into v_paid, v_paid_at
    from public.invoice_payments where invoice_id = v_invoice_id;

  if v_paid >= v_total then
    v_next := 'paid';
  elsif v_paid > 0 then
    v_next := 'partially_paid';
  else
    if v_current in ('paid', 'partially_paid') then
      v_next := 'sent';  -- payments removed, revert
    else
      v_next := v_current;  -- leave alone (draft / sent / awaiting_payment / overdue)
    end if;
  end if;

  if v_next is distinct from v_current or v_paid_at is distinct from null then
    update public.invoices
       set status = v_next,
           paid_at = case when v_next = 'paid' then v_paid_at::timestamp with time zone else null end
     where id = v_invoice_id;
  end if;

  return COALESCE(NEW, OLD);
end;
$$;

drop trigger if exists invoice_payments_sync_status_trigger on public.invoice_payments;
create trigger invoice_payments_sync_status_trigger
  after insert or update or delete on public.invoice_payments
  for each row execute function _tg_invoice_payments_sync_status();

-- =========================================================================
-- Activity log triggers
-- =========================================================================
create or replace function public._tg_invoice_payments_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id, 'invoice.payment_recorded', 'invoice_payments', NEW.id,
      jsonb_build_object(
        'invoice_id', NEW.invoice_id,
        'amount', NEW.amount,
        'paid_at', NEW.paid_at,
        'reference', NEW.reference,
        'source', NEW.source
      )
    );
    return NEW;
  elsif TG_OP = 'DELETE' then
    perform _record_activity(
      OLD.org_id, 'invoice.payment_removed', 'invoice_payments', OLD.id,
      jsonb_build_object(
        'invoice_id', OLD.invoice_id,
        'amount', OLD.amount
      )
    );
    return OLD;
  end if;
  return null;
end;
$$;

drop trigger if exists invoice_payments_activity_trigger on public.invoice_payments;
create trigger invoice_payments_activity_trigger
  after insert or delete on public.invoice_payments
  for each row execute function _tg_invoice_payments_activity();
