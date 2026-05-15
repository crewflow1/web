-- Accounting module: finances table + receipts storage bucket.
--
-- Touches:
--   - new table:  public.finances  (org-scoped; one row per receipt/earning entry)
--   - new bucket: storage `receipts` (private, 10 MB, image + PDF)
--   - RLS:        members CRUD their org; admins DELETE
--                 storage objects gated by first folder = org_id
--
-- vat_total is a STORED GENERATED column so the persisted value can never
-- drift from amount * vat_rate / 100. App code shouldn't try to write it.
--
-- Idempotent: tables / buckets / policies all use IF NOT EXISTS or DROP …
-- IF EXISTS first.

-- ---------------------------------------------------------------------------
-- finances table
-- ---------------------------------------------------------------------------
create table if not exists public.finances (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  -- nullable + SET NULL: keep finance record for audit if the job is removed
  job_id      uuid references public.jobs(id) on delete set null,
  amount      numeric(12, 2) not null,
  currency    text not null default 'GBP',
  -- UK VAT rates: 0 zero-rated, 5 reduced, 20 standard.
  -- CHECK constraint mirrors the spec.
  vat_rate    numeric(5, 2) not null default 20.00
              check (vat_rate in (0, 5, 20)),
  -- Stored generated column: never write directly. Always = amount * vat_rate / 100.
  vat_total   numeric(12, 2) generated always as (
                round(amount * vat_rate / 100, 2)
              ) stored,
  -- Free-text category for now (materials / labor / misc / fuel / …).
  -- If categories stabilise, promote to enum in a future migration.
  category    text,
  -- Storage path under the `receipts` bucket. Format: <org_id>/<finance_id>/<filename>.
  receipt_url text,
  notes       text,
  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone not null default now()
);

create index if not exists finances_org_id_idx       on public.finances (org_id);
create index if not exists finances_org_created_idx  on public.finances (org_id, created_at desc);
create index if not exists finances_org_category_idx on public.finances (org_id, category);
create index if not exists finances_job_id_idx       on public.finances (job_id);

drop trigger if exists finances_set_updated_at on public.finances;
create trigger finances_set_updated_at before update on public.finances
  for each row execute function public.tg_set_updated_at();

alter table public.finances enable row level security;

-- RLS: members can read/insert/update own org rows; admins can delete.
drop policy if exists "finances: members can select" on public.finances;
create policy "finances: members can select" on public.finances for select to authenticated
using (org_id in (select public.current_org_ids()));

drop policy if exists "finances: members can insert" on public.finances;
create policy "finances: members can insert" on public.finances for insert to authenticated
with check (org_id in (select public.current_org_ids()));

drop policy if exists "finances: members can update" on public.finances;
create policy "finances: members can update" on public.finances for update to authenticated
using (org_id in (select public.current_org_ids()))
with check (org_id in (select public.current_org_ids()));

drop policy if exists "finances: admins can delete" on public.finances;
create policy "finances: admins can delete" on public.finances for delete to authenticated
using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- receipts storage bucket
-- ---------------------------------------------------------------------------
-- Folder convention: <org_id>/<finance_id>/<filename>
-- Mime allowlist covers receipt PDFs + camera scans.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "receipts: members can read" on storage.objects;
create policy "receipts: members can read"
on storage.objects for select to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "receipts: members can upload" on storage.objects;
create policy "receipts: members can upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "receipts: members can update" on storage.objects;
create policy "receipts: members can update"
on storage.objects for update to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
)
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "receipts: admins can delete" on storage.objects;
create policy "receipts: admins can delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'receipts'
  and public.is_org_admin((storage.foldername(name))[1]::uuid)
);
