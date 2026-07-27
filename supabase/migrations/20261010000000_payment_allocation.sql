-- Financial Operations — Payment Allocation (one payment across many invoices).
--
-- Today `invoice_payments` links a payment amount to ONE invoice, and
-- `_tg_invoice_payments_sync_status` recomputes that invoice's paid status by
-- summing its rows. That already handles partial payments; the gap is a single
-- real-world receipt covering SEVERAL invoices.
--
-- Design (extend the existing ledger — do NOT fork a parallel payments system):
--   * NEW `payments` = one real-world receipt (total amount).
--   * `invoice_payments` gains `payment_id` → each row is now optionally an
--     ALLOCATION of a payment to an invoice. Standalone rows keep payment_id NULL.
--   * The per-invoice status trigger is REUSED UNCHANGED — an allocation IS an
--     invoice_payments row, so each affected invoice's status recomputes for
--     free. No retarget, no data migration.
--   * Concurrency invariant (a payment can never be allocated for more than its
--     value) is enforced in the DB with a FOR UPDATE row lock so concurrent
--     allocations to the same payment SERIALISE — the sum check is race-free.
-- Additive + reversible.

-- 1. payments — one real-world receipt ---------------------------------------
create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  amount      numeric(12, 2) not null check (amount > 0),
  paid_at     date not null,
  method      text not null default 'bank_transfer'
              check (method in ('bank_transfer', 'card', 'cash', 'cheque', 'other')),
  reference   text,
  source      text not null default 'manual' check (source in ('manual', 'bank_csv')),
  notes       text,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint payments_id_org_key unique (id, org_id)
);

alter table public.payments enable row level security;
create policy "payments: members can select" on public.payments
  for select using (org_id in (select public.current_org_ids()));
create policy "payments: members can insert" on public.payments
  for insert with check (org_id in (select public.current_org_ids()));
create policy "payments: members can update" on public.payments
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy "payments: admins can delete" on public.payments
  for delete using (public.is_org_admin(org_id));

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at before update on public.payments
  for each row execute function public.tg_set_updated_at();

create index if not exists payments_org_paid_at_idx on public.payments (org_id, paid_at desc);
create index if not exists payments_customer_idx on public.payments (customer_id) where customer_id is not null;

-- 2. invoice_payments gains a grouping parent (an allocation) -----------------
alter table public.invoice_payments
  add column if not exists payment_id uuid;

-- Composite org-integrity: an allocation's payment must be in the same org.
-- (MATCH SIMPLE: when payment_id is NULL the FK is skipped, so standalone rows
-- are untouched.) ON DELETE CASCADE: deleting a payment removes its allocations,
-- and the status trigger then recomputes each affected invoice.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_payments_payment_org_fkey') then
    alter table public.invoice_payments
      add constraint invoice_payments_payment_org_fkey
      foreign key (payment_id, org_id) references public.payments (id, org_id) on delete cascade;
  end if;
end $$;

create index if not exists invoice_payments_payment_id_idx
  on public.invoice_payments (payment_id) where payment_id is not null;

-- 3. Concurrency-safe over-allocation guard ----------------------------------
create or replace function public.tg_invoice_payments_no_over_allocate()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_payment   numeric(12, 2);
  v_allocated numeric(12, 2);
begin
  if new.payment_id is null then
    return new;
  end if;

  -- Lock the parent payment row: concurrent allocations to the SAME payment now
  -- serialise here, so the sum below can never miss an in-flight sibling.
  select amount into v_payment
    from public.payments where id = new.payment_id for update;
  if v_payment is null then
    raise exception 'payment % not found', new.payment_id using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_allocated
    from public.invoice_payments
    where payment_id = new.payment_id and id <> new.id;

  if v_allocated + new.amount > v_payment + 0.005 then
    raise exception 'payment % over-allocated: % of % already allocated',
      new.payment_id, v_allocated, v_payment using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists invoice_payments_no_over_allocate on public.invoice_payments;
create trigger invoice_payments_no_over_allocate
  before insert or update on public.invoice_payments
  for each row execute function public.tg_invoice_payments_no_over_allocate();

-- 4. Atomic allocate — create a payment and spread it across invoices in ONE
--    transaction. SECURITY INVOKER so the caller's RLS, the composite org FKs,
--    and the over-allocation guard all apply. If any allocation violates the
--    guard the whole payment rolls back (all-or-nothing).
create or replace function public.allocate_payment(
  p_org_id      uuid,
  p_amount      numeric,
  p_paid_at     date,
  p_method      text,
  p_reference   text,
  p_source      text,
  p_notes       text,
  p_allocations jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_payment_id uuid;
  v_alloc      record;
begin
  -- Explicit tenant check for a clean error (RLS would also reject a foreign org).
  if p_org_id is null or p_org_id not in (select public.current_org_ids()) then
    raise exception 'not a member of org %', p_org_id using errcode = 'insufficient_privilege';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be a json array' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.payments (org_id, amount, paid_at, method, reference, source, notes, created_by)
  values (
    p_org_id, p_amount, p_paid_at,
    coalesce(p_method, 'bank_transfer'),
    p_reference,
    coalesce(p_source, 'manual'),
    p_notes, auth.uid()
  )
  returning id into v_payment_id;

  for v_alloc in
    select (elem->>'invoice_id')::uuid as invoice_id,
           (elem->>'amount')::numeric  as amount
      from jsonb_array_elements(p_allocations) as elem
  loop
    -- Guard trigger (FOR UPDATE-locked) + composite invoice-org FK + status
    -- sync + activity log all fire here. Over-allocation raises → txn rolls back.
    insert into public.invoice_payments
      (org_id, invoice_id, amount, paid_at, reference, source, created_by, payment_id)
    values (
      p_org_id, v_alloc.invoice_id, v_alloc.amount, p_paid_at,
      p_reference, coalesce(p_source, 'manual'), auth.uid(), v_payment_id
    );
  end loop;

  return v_payment_id;
end $$;

grant execute on function public.allocate_payment(uuid, numeric, date, text, text, text, text, jsonb) to authenticated;
