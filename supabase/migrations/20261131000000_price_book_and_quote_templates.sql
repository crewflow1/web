-- Estimating price-book / rate-library + saved quote templates.
--
-- WHAT THIS IS. The estimating memory that CrewFlow never had a HOME for. Today
-- every manual quote row starts blank (app/(app)/quotes/_builder.tsx emptyLine),
-- and the only pricing memory is an invisible, AI-only derivation over the
-- org's historic quote_line_items (server/services/ai-quote-writer.ts
-- readPriceBook). This migration carves the two curated, first-class tables that
-- turn that implicit history into an editable, pickable rate library:
--
--   price_book_items   — the org's curated RATE LIBRARY: one row per priced
--                        line the firm reuses (code, description, unit,
--                        unit_price, category, vat_rate, active). Pickable in
--                        the quote builder to populate a line.
--   quote_templates    — a named, reusable multi-line SCOPE OF WORKS by job
--   quote_template_lines type (e.g. "Bathroom refit", "Re-roof — mid terrace").
--                        Saved from an existing quote's lines, applied to a new
--                        one.
--
-- ── MONEY IS INTEGER PENCE ──────────────────────────────────────────────────
-- unit_price on BOTH price_book_items and quote_template_lines is INTEGER PENCE
-- (a curated catalogue is a clean place to hold exact minor units — see
-- lib/money.ts poundsToPence/penceToPounds). This deliberately differs from the
-- legacy quotes/quote_line_items columns, which are `numeric` pounds: the
-- application converts pence → pounds at the boundary when a picked item or an
-- applied template populates a quote line, so the quote math is unchanged.
--
-- ── TENANCY + RLS: MEMBER-READ, MEMBER-WRITE (the customers/quotes posture) ───
-- These are OPERATIONAL estimating data an estimator maintains, not an admin
-- integration secret — so they take the customers/quotes/leads posture: any org
-- member may read AND write, org-pinned, DB-enforced. (Contrast the
-- merchant_connections / api_keys admin-write posture, which guards credentials;
-- there are no secrets here.) DELETE is admin-only on price_book_items — the
-- everyday "stop offering this" is `active = false` (archive), and a hard delete
-- of a catalogue row is an admin act — matching the customers table exactly.
-- Templates ARE member-deletable: a template is a personal workflow convenience,
-- not shared reference data, so the person who saved it can remove it.
--
-- RLS's current_org_ids() returns EVERY org the viewer belongs to (the OUTER
-- boundary), so every application read/write ALSO pins ctx.org.id (the #456
-- active-org convention). RLS here is the backstop, not the scope.
--
-- ── COMPOSITE (id, org_id) CANDIDATE KEYS ───────────────────────────────────
-- quote_template_lines references quote_templates via a COMPOSITE FK
-- (template_id, org_id) → (id, org_id), so a line can NEVER attach to another
-- org's template even if a forged template_id is supplied — the org must match.
-- Same idiom as quotes_cross_tenant_fk (20261113).
--
-- Additive and reversible. To roll back:
--   drop table public.quote_template_lines;
--   drop table public.quote_templates;
--   drop table public.price_book_items;

-- ── price_book_items ─────────────────────────────────────────────────────────
create table if not exists public.price_book_items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  -- Optional short reference / SKU the firm uses on the item (e.g. "ROOF-01").
  code         text,
  description  text not null check (length(btrim(description)) > 0),
  -- Unit of sale ("ea", "m2", "day", "hr"…). Mirrors quote_line_items.unit.
  unit         text not null default 'ea',
  -- INTEGER PENCE. Non-negative. A rate card holds prices, never negatives.
  unit_price   integer not null default 0 check (unit_price >= 0),
  -- Free-text grouping ("Roofing", "Labour", "Plumbing") for the picker filter.
  category     text,
  -- Default VAT rate to seed on the quote line — the closed set the quote
  -- builder offers (lib/quotes/schema QUOTE_VAT_RATES).
  vat_rate     integer not null default 20 check (vat_rate in (0, 5, 20)),
  -- Archive flag. The everyday "retire this item" — kept for history, hidden
  -- from the picker. A hard delete is admin-only (see RLS).
  active       boolean not null default true,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint price_book_items_id_org_key unique (id, org_id)
);

create index if not exists price_book_items_org_idx
  on public.price_book_items (org_id);
-- The picker reads active items ordered by description; a partial index keeps
-- that hot path lean as archived rows accumulate.
create index if not exists price_book_items_org_active_idx
  on public.price_book_items (org_id, active);

drop trigger if exists price_book_items_set_updated_at on public.price_book_items;
create trigger price_book_items_set_updated_at before update on public.price_book_items
  for each row execute function public.tg_set_updated_at();

alter table public.price_book_items enable row level security;

drop policy if exists "price_book_items: members can select" on public.price_book_items;
create policy "price_book_items: members can select" on public.price_book_items
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "price_book_items: members can insert" on public.price_book_items;
create policy "price_book_items: members can insert" on public.price_book_items
  for insert to authenticated with check (org_id in (select public.current_org_ids()));

drop policy if exists "price_book_items: members can update" on public.price_book_items;
create policy "price_book_items: members can update" on public.price_book_items
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

-- Hard delete is admin-only — the everyday retire is `active = false`.
drop policy if exists "price_book_items: admins can delete" on public.price_book_items;
create policy "price_book_items: admins can delete" on public.price_book_items
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── quote_templates ──────────────────────────────────────────────────────────
create table if not exists public.quote_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  -- Optional job-type label the template is filed under ("Bathroom", "Re-roof").
  job_type    text,
  notes       text,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Composite candidate key so child lines can carry a cross-tenant-safe FK.
  constraint quote_templates_id_org_key unique (id, org_id)
);

create index if not exists quote_templates_org_idx
  on public.quote_templates (org_id);

drop trigger if exists quote_templates_set_updated_at on public.quote_templates;
create trigger quote_templates_set_updated_at before update on public.quote_templates
  for each row execute function public.tg_set_updated_at();

alter table public.quote_templates enable row level security;

drop policy if exists "quote_templates: members can select" on public.quote_templates;
create policy "quote_templates: members can select" on public.quote_templates
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "quote_templates: members can insert" on public.quote_templates;
create policy "quote_templates: members can insert" on public.quote_templates
  for insert to authenticated with check (org_id in (select public.current_org_ids()));

drop policy if exists "quote_templates: members can update" on public.quote_templates;
create policy "quote_templates: members can update" on public.quote_templates
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

drop policy if exists "quote_templates: members can delete" on public.quote_templates;
create policy "quote_templates: members can delete" on public.quote_templates
  for delete to authenticated using (org_id in (select public.current_org_ids()));

-- ── quote_template_lines ─────────────────────────────────────────────────────
create table if not exists public.quote_template_lines (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  template_id  uuid not null,
  description  text not null check (length(btrim(description)) > 0),
  qty          numeric not null default 1 check (qty > 0),
  unit         text not null default 'ea',
  -- INTEGER PENCE (see money note above).
  unit_price   integer not null default 0 check (unit_price >= 0),
  vat_rate     integer not null default 20 check (vat_rate in (0, 5, 20)),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  -- Cross-tenant-safe composite FK: a line's (template_id, org_id) must match a
  -- template that BELONGS to the same org. A forged template_id from another org
  -- is refused at the DB, not merely by RLS.
  constraint quote_template_lines_template_fk
    foreign key (template_id, org_id)
    references public.quote_templates (id, org_id) on delete cascade
);

create index if not exists quote_template_lines_template_idx
  on public.quote_template_lines (template_id);
create index if not exists quote_template_lines_org_idx
  on public.quote_template_lines (org_id);

alter table public.quote_template_lines enable row level security;

drop policy if exists "quote_template_lines: members can select" on public.quote_template_lines;
create policy "quote_template_lines: members can select" on public.quote_template_lines
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "quote_template_lines: members can insert" on public.quote_template_lines;
create policy "quote_template_lines: members can insert" on public.quote_template_lines
  for insert to authenticated with check (org_id in (select public.current_org_ids()));

drop policy if exists "quote_template_lines: members can update" on public.quote_template_lines;
create policy "quote_template_lines: members can update" on public.quote_template_lines
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

drop policy if exists "quote_template_lines: members can delete" on public.quote_template_lines;
create policy "quote_template_lines: members can delete" on public.quote_template_lines
  for delete to authenticated using (org_id in (select public.current_org_ids()));
