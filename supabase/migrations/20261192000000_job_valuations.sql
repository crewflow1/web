-- ═════════════════════════════════════════════════════════════════════════════
-- CONSTRUCTION VALUATION / APPLICATION-FOR-PAYMENT (interim, staged invoicing).
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Master Plan — "invoices auto-generated from completed work". Until now an
-- invoice in CrewFlow could only come from an ACCEPTED QUOTE (the quote→invoice
-- path) or a fixed-amount BILLING STAGE (generate_stage_invoice). Neither models
-- the way construction is actually billed by measure: a periodic VALUATION (an
-- "application for payment") assessing the CUMULATIVE value of work executed to
-- date, less what was previously certified, less retention, to arrive at the
-- amount due THIS period — the interim-certificate flow (JCT/NEC).
--
-- This migration models that flow PROPERLY as its own record — NOT a normal
-- invoice with a "valuation" label. A certified valuation then GENERATES a stage
-- invoice through the SAME invoice authority (next_invoice_number + invoices +
-- invoice_line_items, byte-identical body to _generate_stage_invoice_row), so
-- there is exactly ONE money path and the receivables/outstanding, retention and
-- VAT authorities all continue to work unchanged and un-forked.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE MONEY MODEL (all figures EX-VAT / NET; the UK convention).
-- ─────────────────────────────────────────────────────────────────────────────
-- Per valuation, cumulative to the period end:
--
--   gross_valuation        = work_completed_to_date        (measured original works)
--                          + materials_on_site             (goods delivered, on site)
--                          + variations_total              (Σ agreed variation NET)
--   previous_certified_gross = Σ net_certified_this over PRIOR certified valuations
--   net_certified_this     = gross_valuation
--                          − previous_certified_gross      (previous-vs-current cumulation)
--                          − deductions                    (contra charges this period)
--
-- `net_certified_this` is THIS PERIOD's certified increment and becomes the
-- generated stage invoice's ex-VAT `amount`. Σ over all certified valuations of
-- net_certified_this === (latest gross_valuation − Σ deductions), so the periods
-- telescope exactly and nothing is billed twice.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RETENTION — DERIVED once, by the existing authority. NEVER a second ledger.
-- ─────────────────────────────────────────────────────────────────────────────
-- CrewFlow already owns construction retention (20261005000000): accrued held
-- retention = rate% × Σ(non-draft invoices.amount) for the job, released via the
-- append-only retention_releases ledger, all DERIVED by computeRetentionPosition
-- (lib/retentions/compute.ts) — "derive, don't duplicate". This migration adds
-- NO retention column that affects money and writes NOTHING to retention_releases.
--
-- The generated stage invoice's ex-VAT `amount` is the FULL certified increment
-- (net_certified_this) — the works value, BEFORE any retention deduction. The
-- retention authority then accrues rate% × Σ(those invoice amounts) exactly as it
-- does for every other invoice, so held retention is applied EXACTLY ONCE, in one
-- place, and the valuation certificate's retention line reconciles to it by
-- construction. Subtracting retention from the invoice amount HERE (and letting
-- the authority accrue on the reduced figure) would be the double-count; we do
-- not. `retention_percent` is snapshotted onto the valuation purely so the frozen
-- certificate can DISPLAY the split — it drives no money path.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- VARIATIONS — reused, not re-modelled. No double bill.
-- ─────────────────────────────────────────────────────────────────────────────
-- Variations are quotes rows carrying variation_number (20260520180000); an
-- accepted variation's NET value is quotes.subtotal. A valuation INCLUDES agreed
-- variations by reference through job_valuation_variations, snapshotting each
-- variation's ex-VAT value at link time. A variation may be linked to AT MOST ONE
-- valuation (unique), must be accepted, same-org+same-job, and must NOT already
-- carry an ISSUED (non-draft) invoice of its own — the guard refuses otherwise,
-- so a variation can never be billed both by its own accept-time invoice and by a
-- valuation. (A variation's DRAFT accept-invoice contributes to no money authority
-- — draft is excluded from receivables, revenue and retention — so it is harmless
-- until sent; the guard's non-draft test is the real double-bill fence.)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LIFECYCLE.  draft → submitted → certified → invoiced   (+ cancelled)
-- ─────────────────────────────────────────────────────────────────────────────
--   draft      operator builds/edits the application (member; RLS insert/update)
--   submitted  application submitted for certification (member; RLS update)
--   certified  a QS/admin certifies — SNAPSHOTS gross/previous/net/retention/vat
--              and FREEZES the money columns (certify_valuation, admin-only RPC)
--   invoiced   a stage invoice has been generated from the certified figures and
--              CAS-bound (generate_valuation_invoice, admin-only RPC)
--   cancelled  a draft/submitted application withdrawn (admin; RLS update)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TENANT SAFETY.  Every child carries org_id + a composite (…, org_id) FK to its
-- parent's (id, org_id) candidate key (jobs_id_org_key, invoices_id_org_key,
-- quotes_id_org_key, job_valuations own key) — the C36/C37 pattern — so no row can
-- ever be stitched across tenants, for EVERY writer including service_role.
-- RLS is member-read / member-write-own-org; the two SECURITY DEFINER RPCs pin
-- org on every hop and re-check is_org_admin.
--
-- Additive + reversible:
--   drop function public.generate_valuation_invoice(uuid, date);
--   drop function public.certify_valuation(uuid);
--   drop table public.job_valuation_variations;
--   drop table public.job_valuations;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE VALUATION RECORD.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_valuations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  job_id        uuid not null,
  -- Per-job application number: "Valuation 1, 2, 3…". Assigned by the writer.
  sequence      integer not null check (sequence >= 1),

  -- The period this application covers (both nullable: a first application may be
  -- to-date only). period_end must not precede period_start when both are set.
  period_start  date,
  period_end    date,
  valuation_date date not null default (now() at time zone 'utc')::date,

  status        text not null default 'draft'
                  check (status in ('draft','submitted','certified','invoiced','cancelled')),

  -- ── OPERATOR INPUTS (ex-VAT, cumulative-to-date). Mutable only while draft. ──
  work_completed_to_date numeric(14, 2) not null default 0 check (work_completed_to_date >= 0),
  materials_on_site      numeric(14, 2) not null default 0 check (materials_on_site >= 0),
  deductions             numeric(14, 2) not null default 0 check (deductions >= 0),
  -- Per-application VAT rate applied to the certified increment (mirrors the
  -- per-stage vat_rate of generate_stage_invoice). Not the VAT SCHEME (that governs
  -- the return, lib/tax/compute.ts) — this is the tax point rate on this supply.
  vat_rate               numeric(5, 2)  not null default 20.00 check (vat_rate >= 0 and vat_rate <= 100),

  notes         text,

  -- ── CERTIFICATION SNAPSHOTS (null until certified; frozen thereafter). ──
  -- Σ of linked variation NET values at certification.
  variations_total         numeric(14, 2),
  -- work + materials + variations at certification.
  gross_valuation          numeric(14, 2),
  -- Σ net_certified_this of PRIOR certified valuations for this job.
  previous_certified_gross numeric(14, 2),
  -- gross − previous − deductions: THIS period's certified increment (=invoice amount).
  net_certified_this       numeric(14, 2),
  -- Contract retention rate at certification — DISPLAY only, drives no money path.
  retention_percent        numeric(5, 2),
  certified_at  timestamptz,
  certified_by  uuid references public.users(id) on delete set null,

  -- ── INVOICE BINDING (null until a stage invoice is generated; CAS-set once). ──
  invoice_id    uuid,

  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One application number per job.
  constraint job_valuations_job_sequence_key unique (job_id, sequence),
  -- Composite candidate key so children (junction) carry a tenant-safe FK.
  constraint job_valuations_id_org_key unique (id, org_id),
  -- Tenant integrity: a valuation's job must live in the SAME org.
  constraint job_valuations_job_org_fkey
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,
  -- Tenant integrity: a bound invoice must live in the SAME org.
  constraint job_valuations_invoice_org_fkey
    foreign key (invoice_id, org_id) references public.invoices (id, org_id) on delete set null,
  -- Period sanity.
  constraint job_valuations_period_order
    check (period_start is null or period_end is null or period_end >= period_start),
  -- A certified/invoiced valuation MUST carry a complete, non-negative snapshot.
  constraint job_valuations_certified_snapshot
    check (
      status not in ('certified','invoiced')
      or (
        variations_total is not null
        and gross_valuation is not null
        and previous_certified_gross is not null
        and net_certified_this is not null
        and net_certified_this >= 0
        and retention_percent is not null
      )
    ),
  -- An invoiced valuation MUST be bound to an invoice; a non-invoiced one MUST NOT.
  constraint job_valuations_invoice_binding
    check (
      (status = 'invoiced' and invoice_id is not null)
      or (status <> 'invoiced' and invoice_id is null)
    )
);

create index if not exists job_valuations_org_job_idx  on public.job_valuations (org_id, job_id, sequence);
create index if not exists job_valuations_org_status_idx on public.job_valuations (org_id, status);
create index if not exists job_valuations_invoice_idx   on public.job_valuations (invoice_id);

alter table public.job_valuations enable row level security;

-- Members read/insert/update their org's applications; admins delete.
drop policy if exists "job_valuations: members select" on public.job_valuations;
create policy "job_valuations: members select" on public.job_valuations
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "job_valuations: members insert" on public.job_valuations;
create policy "job_valuations: members insert" on public.job_valuations
  for insert to authenticated with check (org_id in (select public.current_org_ids()));

drop policy if exists "job_valuations: members update" on public.job_valuations;
create policy "job_valuations: members update" on public.job_valuations
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

drop policy if exists "job_valuations: admins delete" on public.job_valuations;
create policy "job_valuations: admins delete" on public.job_valuations
  for delete to authenticated using (public.is_org_admin(org_id));

comment on table public.job_valuations is
  'Construction interim valuation / application for payment. Cumulative ex-VAT '
  'work+materials+variations, less previously certified and retention, yields the '
  'certified increment net_certified_this — the ex-VAT amount of the stage invoice '
  'generated by generate_valuation_invoice. Retention is DERIVED by the existing '
  'authority from that invoice (never a second ledger); retention_percent here is '
  'display-only. Lifecycle draft→submitted→certified→invoiced.';

-- ── updated_at ───────────────────────────────────────────────────────────────
create or replace function public.tg_job_valuations_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists job_valuations_touch on public.job_valuations;
create trigger job_valuations_touch
  before update on public.job_valuations
  for each row execute function public.tg_job_valuations_touch();

-- ── Freeze — once certified, the money columns are immutable ──────────────────
-- A certificate is a contractual instrument; its figures cannot drift after
-- issue. Once status is certified/invoiced, no money/input/identity column may
-- change. status and invoice_id are LEFT mutable so certify→invoice binding and
-- the (admin) generate step can proceed; nothing else can. Mirrors the accepted-
-- quote freeze (tg_quotes_freeze_accepted).
create or replace function public.tg_job_valuations_freeze()
returns trigger language plpgsql as $$
begin
  if old.status in ('certified','invoiced') then
    if new.org_id                  is distinct from old.org_id
       or new.job_id               is distinct from old.job_id
       or new.sequence             is distinct from old.sequence
       or new.work_completed_to_date is distinct from old.work_completed_to_date
       or new.materials_on_site     is distinct from old.materials_on_site
       or new.deductions            is distinct from old.deductions
       or new.vat_rate              is distinct from old.vat_rate
       or new.variations_total      is distinct from old.variations_total
       or new.gross_valuation       is distinct from old.gross_valuation
       or new.previous_certified_gross is distinct from old.previous_certified_gross
       or new.net_certified_this    is distinct from old.net_certified_this
       or new.retention_percent     is distinct from old.retention_percent
       or new.certified_at          is distinct from old.certified_at
    then
      raise exception 'valuation % is certified — its figures are immutable', old.id
        using errcode = 'check_violation';
    end if;
    -- invoiced is terminal: never walk a bound invoice back off the record.
    if old.status = 'invoiced' and new.status <> 'invoiced' then
      raise exception 'valuation % is invoiced — status is terminal', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists job_valuations_freeze on public.job_valuations;
create trigger job_valuations_freeze
  before update on public.job_valuations
  for each row execute function public.tg_job_valuations_freeze();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE VARIATION INCLUSION JUNCTION.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_valuation_variations (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  valuation_id        uuid not null,
  -- The variation is a quotes row (variation_number is not null).
  variation_quote_id  uuid not null,
  -- Snapshot of the variation's ex-VAT (NET) value at link time — the certified
  -- figure. quotes freeze on acceptance, but snapshotting keeps the certificate
  -- self-contained and immune to any later source change.
  amount              numeric(14, 2) not null check (amount >= 0),
  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),

  -- A variation may be included in AT MOST ONE valuation (no double inclusion).
  constraint job_valuation_variations_variation_key unique (org_id, variation_quote_id),
  -- Tenant-safe composite FKs to parent valuation and to the variation quote.
  constraint job_valuation_variations_valuation_org_fkey
    foreign key (valuation_id, org_id)
    references public.job_valuations (id, org_id) on delete cascade,
  constraint job_valuation_variations_quote_org_fkey
    foreign key (variation_quote_id, org_id)
    references public.quotes (id, org_id) on delete cascade
);

create index if not exists job_valuation_variations_valuation_idx
  on public.job_valuation_variations (valuation_id);
create index if not exists job_valuation_variations_org_idx
  on public.job_valuation_variations (org_id);

alter table public.job_valuation_variations enable row level security;

drop policy if exists "job_valuation_variations: members select" on public.job_valuation_variations;
create policy "job_valuation_variations: members select" on public.job_valuation_variations
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "job_valuation_variations: members insert" on public.job_valuation_variations;
create policy "job_valuation_variations: members insert" on public.job_valuation_variations
  for insert to authenticated with check (org_id in (select public.current_org_ids()));

-- No UPDATE policy — a link is create-or-remove, never mutated.
drop policy if exists "job_valuation_variations: members delete" on public.job_valuation_variations;
create policy "job_valuation_variations: members delete" on public.job_valuation_variations
  for delete to authenticated using (org_id in (select public.current_org_ids()));

comment on table public.job_valuation_variations is
  'Which agreed variations (quotes rows) an interim valuation includes, with a '
  'snapshot of each variation ex-VAT value. Unique per variation (no double '
  'inclusion); the guard refuses variations that are not accepted, belong to '
  'another job, or already carry an issued invoice (no double bill).';

-- ── Link guard — validity + no-double-bill, at insert time ───────────────────
-- SECURITY DEFINER so it reads the full quote/invoice truth regardless of the
-- caller's row visibility; search_path pinned.
create or replace function public.tg_job_valuation_variation_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_val_status  text;
  v_val_job     uuid;
  v_val_org     uuid;
  v_q_org       uuid;
  v_q_job       uuid;
  v_q_status    text;
  v_q_varnum    integer;
  v_q_subtotal  numeric;
  v_draft_inv   record;
begin
  -- Parent valuation must exist, be same-org, and still be a DRAFT (variations
  -- are part of the assessment, fixed once submitted for certification).
  select status, job_id, org_id into v_val_status, v_val_job, v_val_org
  from public.job_valuations where id = new.valuation_id;
  if v_val_org is null then
    raise exception 'valuation % not found', new.valuation_id using errcode = 'check_violation';
  end if;
  if v_val_org <> new.org_id then
    raise exception 'variation link: org mismatch' using errcode = 'check_violation';
  end if;
  if v_val_status <> 'draft' then
    raise exception 'variations can only be linked while the valuation is a draft'
      using errcode = 'check_violation';
  end if;

  -- The linked quote must be a same-org, same-job, ACCEPTED variation.
  select org_id, job_id, status, variation_number, subtotal
    into v_q_org, v_q_job, v_q_status, v_q_varnum, v_q_subtotal
  from public.quotes where id = new.variation_quote_id;
  if v_q_org is null then
    raise exception 'variation quote % not found', new.variation_quote_id using errcode = 'check_violation';
  end if;
  if v_q_org <> new.org_id then
    raise exception 'variation link: quote org mismatch' using errcode = 'check_violation';
  end if;
  if v_q_varnum is null then
    raise exception 'quote % is not a variation', new.variation_quote_id using errcode = 'check_violation';
  end if;
  if v_q_job is distinct from v_val_job then
    raise exception 'variation % belongs to a different job than the valuation', new.variation_quote_id
      using errcode = 'check_violation';
  end if;
  if v_q_status <> 'accepted' then
    raise exception 'only an accepted variation can be included (variation % is %)',
      new.variation_quote_id, v_q_status using errcode = 'check_violation';
  end if;

  -- No double bill — two cases, because accepting a variation AUTO-CREATES a
  -- DRAFT accept-invoice (quote_id = variation, status 'draft'; see
  -- acceptQuoteAsOwner / the portal accept path):
  --
  --   • An ISSUED (non-draft) invoice is already money in the ledger. Refuse the
  --     link outright — the operator must resolve the existing bill first.
  if exists (
    select 1 from public.invoices i
    where i.quote_id = new.variation_quote_id
      and i.org_id = new.org_id
      and i.status <> 'draft'
  ) then
    raise exception 'variation % already has an issued invoice — cannot bill it again via a valuation',
      new.variation_quote_id using errcode = 'check_violation';
  end if;

  --   • A DRAFT accept-invoice carries no money in any authority (draft is
  --     "never issued" — excluded from receivables, revenue and retention; see
  --     lib/invoices/schema.ts) but it COULD later be SENT and thereby bill the
  --     variation a SECOND time, on top of the valuation. Linking the variation
  --     to a valuation SUPERSEDES it: the variation is now billed via the
  --     valuation invoice, so its provisional accept-invoice must never be
  --     issued. public.invoices has no `void`/`cancelled` status (the enum is
  --     draft|sent|awaiting_payment|partially_paid|paid|overdue), so the supersede
  --     is a DELETE of the never-issued draft — which also frees the
  --     invoices(quote_id) unique slot. Audited per row. Same transaction as the
  --     link insert: if the insert later fails, the supersede rolls back with it.
  for v_draft_inv in
    select id, number from public.invoices
    where quote_id = new.variation_quote_id
      and org_id = new.org_id
      and status = 'draft'
  loop
    delete from public.invoices where id = v_draft_inv.id and org_id = new.org_id;
    perform public._record_activity(
      new.org_id, 'invoice.superseded_by_valuation', 'invoices', v_draft_inv.id,
      jsonb_build_object(
        'variation_quote_id', new.variation_quote_id,
        'valuation_id', new.valuation_id,
        'invoice_number', v_draft_inv.number,
        'reason', 'variation billed via interim valuation'
      )
    );
  end loop;

  -- Pin the snapshot amount to the variation's ex-VAT subtotal (ignore any client
  -- value), so the certificate cannot be seeded with a wrong figure.
  new.amount := round(coalesce(v_q_subtotal, 0), 2);
  return new;
end $$;

drop trigger if exists job_valuation_variations_guard on public.job_valuation_variations;
create trigger job_valuation_variations_guard
  before insert on public.job_valuation_variations
  for each row execute function public.tg_job_valuation_variation_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CERTIFY — submitted → certified, snapshotting the frozen figures. Admin.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.certify_valuation(p_valuation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_val        public.job_valuations%rowtype;
  v_variations numeric(14,2);
  v_prev       numeric(14,2);
  v_gross      numeric(14,2);
  v_net        numeric(14,2);
  v_rate       numeric(5,2);
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;

  select * into v_val from public.job_valuations where id = p_valuation_id for update;
  if not found then raise exception 'valuation not found'; end if;
  if not public.is_org_admin(v_val.org_id) then
    raise exception 'only an owner or admin can certify a valuation';
  end if;
  if v_val.status <> 'submitted' then
    raise exception 'only a submitted valuation can be certified (this one is %)', v_val.status;
  end if;

  -- ── SERIALIZE CERTIFICATION PER JOB (concurrent double-count fence) ──────────
  -- The `for update` above locks only THIS row. The cumulation base below is a
  -- sum over the job's OTHER certified/invoiced valuations, read UNLOCKED. Under
  -- READ COMMITTED, two concurrent certifications of SIBLING valuations of the
  -- same job would both read previous_certified_gross before either commits — so
  -- both see the stale base (e.g. 0), both certify the full increment, and Σ
  -- net_certified_this exceeds the true cumulative works: a double invoice.
  --
  -- A transaction-scoped advisory lock keyed on the JOB serializes them: the
  -- second certification blocks here until the first COMMITS, then reads the
  -- first's committed net_certified_this into the base (or the non-negative guard
  -- below rejects the now-over-certified increment). Per-job (not global) so
  -- certifications on different jobs never contend. Released automatically at
  -- transaction end.
  perform pg_advisory_xact_lock(hashtextextended(v_val.job_id::text, 0));

  -- Σ linked variation NET values (org-pinned). Re-validate each is still an
  -- accepted variation with no issued invoice — the same fence as the link guard,
  -- re-checked at the moment of certification.
  select coalesce(sum(jvv.amount), 0) into v_variations
  from public.job_valuation_variations jvv
  join public.quotes q
    on q.id = jvv.variation_quote_id and q.org_id = jvv.org_id
  where jvv.valuation_id = p_valuation_id
    and jvv.org_id = v_val.org_id
    and q.variation_number is not null
    and q.status = 'accepted';

  if exists (
    select 1
    from public.job_valuation_variations jvv
    join public.invoices i
      on i.quote_id = jvv.variation_quote_id and i.org_id = jvv.org_id and i.status <> 'draft'
    where jvv.valuation_id = p_valuation_id and jvv.org_id = v_val.org_id
  ) then
    raise exception 'a linked variation now carries an issued invoice — remove it before certifying';
  end if;

  -- Cumulation: previously certified gross = Σ net_certified_this of PRIOR
  -- certified/invoiced valuations for this job (org-pinned).
  select coalesce(sum(net_certified_this), 0) into v_prev
  from public.job_valuations
  where job_id = v_val.job_id
    and org_id = v_val.org_id
    and id <> p_valuation_id
    and status in ('certified','invoiced');

  v_gross := round(v_val.work_completed_to_date + v_val.materials_on_site + v_variations, 2);
  v_net   := round(v_gross - v_prev - v_val.deductions, 2);
  if v_net < 0 then
    raise exception 'certified amount is negative (gross %, previously certified %, deductions %) — a valuation cannot go backwards below what is already certified',
      v_gross, v_prev, v_val.deductions;
  end if;

  select retention_percent into v_rate from public.jobs
  where id = v_val.job_id and org_id = v_val.org_id;
  v_rate := coalesce(v_rate, 0);

  update public.job_valuations
     set status = 'certified',
         variations_total = v_variations,
         gross_valuation = v_gross,
         previous_certified_gross = v_prev,
         net_certified_this = v_net,
         retention_percent = v_rate,
         certified_at = now(),
         certified_by = auth.uid()
   where id = p_valuation_id;

  perform public._record_activity(
    v_val.org_id, 'valuation.certified', 'job_valuations', p_valuation_id,
    jsonb_build_object(
      'job_id', v_val.job_id, 'sequence', v_val.sequence,
      'gross_valuation', v_gross, 'previous_certified_gross', v_prev,
      'net_certified_this', v_net, 'retention_percent', v_rate
    )
  );

  return p_valuation_id;
end $$;

revoke all on function public.certify_valuation(uuid) from public, anon, authenticated;
grant execute on function public.certify_valuation(uuid) to authenticated;

comment on function public.certify_valuation(uuid) is
  'Admin-only. Certifies a submitted valuation: snapshots variations_total, '
  'gross_valuation, previous_certified_gross (Σ prior certified increments), '
  'net_certified_this and retention_percent, then freezes them. Refuses a '
  'negative increment. Retention is not touched — it is derived from the invoice '
  'the next step generates.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. GENERATE STAGE INVOICE — certified → invoiced, through the invoice authority.
-- ─────────────────────────────────────────────────────────────────────────────
-- Body mirrors _generate_stage_invoice_row (20261153000000) EXACTLY: per-supply
-- VAT, next_invoice_number, one invoice_line_items snapshot, draft status, and a
-- CAS bind of invoice_id so a re-fire cannot double-bill. The invoice's ex-VAT
-- `amount` is net_certified_this — the FULL certified increment — so the retention
-- authority accrues on it exactly once. Admin-only.
create or replace function public.generate_valuation_invoice(p_valuation_id uuid, p_due_date date default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_val      public.job_valuations%rowtype;
  v_customer uuid;
  v_number   text;
  v_vat      numeric(12,2);
  v_due      date;
  v_invoice  uuid;
  v_desc     text;
  v_draft_inv record;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;

  select * into v_val from public.job_valuations where id = p_valuation_id for update;
  if not found then raise exception 'valuation not found'; end if;
  if not public.is_org_admin(v_val.org_id) then
    raise exception 'only an owner or admin can generate a valuation invoice';
  end if;
  if v_val.status <> 'certified' then
    raise exception 'only a certified valuation can be invoiced (this one is %)', v_val.status;
  end if;
  if v_val.invoice_id is not null then
    raise exception 'this valuation has already been invoiced';
  end if;
  if coalesce(v_val.net_certified_this, 0) <= 0 then
    raise exception 'a valuation must certify a positive amount to invoice';
  end if;

  -- Re-fence double-bill at generation time (a variation invoice could have been
  -- issued between certify and now).
  if exists (
    select 1
    from public.job_valuation_variations jvv
    join public.invoices i
      on i.quote_id = jvv.variation_quote_id and i.org_id = jvv.org_id and i.status <> 'draft'
    where jvv.valuation_id = p_valuation_id and jvv.org_id = v_val.org_id
  ) then
    raise exception 'a linked variation now carries an issued invoice — cannot generate a valuation invoice';
  end if;

  -- Defense-in-depth supersede: delete any variation DRAFT accept-invoice that
  -- reappeared after linking (e.g. the variation was re-accepted between link and
  -- now). The link-time delete is the primary fence; this closes the
  -- re-accept-between-link-and-generate window so a variation billed via this
  -- valuation can never also be billed by a lingering draft accept-invoice.
  for v_draft_inv in
    select i.id, i.number
    from public.job_valuation_variations jvv
    join public.invoices i
      on i.quote_id = jvv.variation_quote_id and i.org_id = jvv.org_id and i.status = 'draft'
    where jvv.valuation_id = p_valuation_id and jvv.org_id = v_val.org_id
  loop
    delete from public.invoices where id = v_draft_inv.id and org_id = v_val.org_id;
    perform public._record_activity(
      v_val.org_id, 'invoice.superseded_by_valuation', 'invoices', v_draft_inv.id,
      jsonb_build_object(
        'valuation_id', p_valuation_id,
        'invoice_number', v_draft_inv.number,
        'reason', 'variation billed via interim valuation (generate-time supersede)'
      )
    );
  end loop;

  select customer_id into v_customer from public.jobs
  where id = v_val.job_id and org_id = v_val.org_id;
  if v_customer is null then
    raise exception 'this job has no customer — set a customer on the job before invoicing';
  end if;

  v_number := public.next_invoice_number(v_val.org_id);
  v_vat := round(v_val.net_certified_this * v_val.vat_rate / 100.0, 2);
  v_due := coalesce(p_due_date, ((now() at time zone 'utc')::date + 14));
  v_desc := 'Valuation ' || v_val.sequence || ' — works to '
            || to_char(coalesce(v_val.period_end, v_val.valuation_date), 'DD Mon YYYY');

  insert into public.invoices (org_id, job_id, quote_id, customer_id, number, amount, vat_total, status, due_date, notes)
    values (v_val.org_id, v_val.job_id, null, v_customer, v_number,
            v_val.net_certified_this, v_vat, 'draft', v_due, v_desc)
    returning id into v_invoice;

  -- The AFTER-INSERT snapshot trigger only copies quote lines (quote_id is null
  -- here), so write the single valuation line explicitly — same shape as the
  -- stage-invoice path.
  insert into public.invoice_line_items (invoice_id, org_id, description, qty, unit, unit_price, vat_rate, line_total, sort_order)
    values (v_invoice, v_val.org_id, v_desc, 1, 'item', v_val.net_certified_this, v_val.vat_rate, v_val.net_certified_this, 0);

  update public.job_valuations
     set status = 'invoiced', invoice_id = v_invoice
   where id = p_valuation_id;

  perform public._record_activity(
    v_val.org_id, 'valuation.invoiced', 'job_valuations', p_valuation_id,
    jsonb_build_object(
      'job_id', v_val.job_id, 'sequence', v_val.sequence,
      'invoice_id', v_invoice, 'invoice_number', v_number,
      'amount', v_val.net_certified_this, 'vat_total', v_vat
    )
  );

  return v_invoice;
end $$;

revoke all on function public.generate_valuation_invoice(uuid, date) from public, anon, authenticated;
grant execute on function public.generate_valuation_invoice(uuid, date) to authenticated;

comment on function public.generate_valuation_invoice(uuid, date) is
  'Admin-only. Generates the stage invoice for a certified valuation through the '
  'shared invoice authority (next_invoice_number + invoices + invoice_line_items, '
  'draft status). ex-VAT amount = net_certified_this (the full certified increment) '
  'so retention accrues once via the existing authority. CAS-binds invoice_id and '
  'flips status to invoiced; idempotent (refuses if already invoiced).';
