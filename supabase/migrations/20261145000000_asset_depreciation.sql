-- Asset Management — P3W2: per-asset depreciation policy (net book value).
--
-- Today `assets.purchase_price` is captured but never depreciated: the register
-- shows an acquisition cost that quietly diverges from the asset's real worth on
-- the books. This adds a per-asset DEPRECIATION POLICY — method, cost basis,
-- salvage, useful life / rate, start date — from which net book value (NBV) and
-- a full depreciation schedule are COMPUTED ON READ by the pure module
-- `lib/assets/depreciation.ts`. Nothing here stores a derived NBV: the policy is
-- the only durable state, so the number can never drift from the maths.
--
-- One row per asset (PK = asset_id), the satellite-config shape. Same-org
-- integrity is a COMPOSITE FK to the assets candidate key `(id, org_id)`
-- (assets_id_org_key, added 20261056000000) — not a bare `asset_id` FK — so no
-- writer, service-role included, can anchor a policy onto another tenant's
-- asset. Depreciation is a finance policy, so writes are admin-only at the DB
-- (member read), mirroring asset_service_schedules. Additive + reversible.

create table if not exists public.asset_depreciation_settings (
  -- One policy per asset. PK is the asset itself.
  asset_id           uuid primary key,
  org_id             uuid not null references public.organizations(id) on delete cascade,
  method             text not null
    check (method in ('straight_line', 'reducing_balance')),
  -- The depreciable cost basis. Defaults from assets.purchase_price at the
  -- action layer, but STORED so the schedule is deterministic even if the
  -- asset's purchase_price is later edited.
  cost               numeric(12, 2) not null check (cost >= 0),
  -- Residual value at the end of useful life. Straight-line depreciates down to
  -- exactly this; reducing-balance floors here (it is asymptotic).
  salvage_value      numeric(12, 2) not null default 0 check (salvage_value >= 0),
  -- Depreciation start (defaults from purchase_date; the clock the maths runs
  -- against). Date-only — the pure module does UTC-anchored day arithmetic.
  start_date         date not null,
  -- Straight-line: the number of months over which cost - salvage is written
  -- off. Reducing-balance: the schedule horizon (rows to project).
  useful_life_months integer
    check (useful_life_months is null or useful_life_months between 1 and 1200),
  -- Reducing-balance: the annual depreciation percentage (e.g. 25.000).
  annual_rate_pct    numeric(6, 3)
    check (annual_rate_pct is null or (annual_rate_pct > 0 and annual_rate_pct <= 100)),
  created_by         uuid references public.users(id) on delete set null,
  updated_by         uuid references public.users(id) on delete set null,
  created_at         timestamp with time zone not null default now(),
  updated_at         timestamp with time zone not null default now(),
  -- Same-org integrity as a DB invariant (composite FK to the assets candidate
  -- key), not a bare FK + trigger. Cascade so deleting an asset drops its policy.
  constraint asset_depreciation_settings_asset_org_fk
    foreign key (asset_id, org_id)
    references public.assets (id, org_id) on delete cascade,
  -- Each method needs its own parameter, and neither can be negative-value.
  constraint asset_depreciation_method_params_check check (
    (method = 'straight_line'    and useful_life_months is not null)
    or (method = 'reducing_balance' and annual_rate_pct    is not null)
  ),
  -- Salvage can never exceed the cost it is deducted from.
  constraint asset_depreciation_salvage_le_cost_check
    check (salvage_value <= cost)
);

comment on constraint asset_depreciation_settings_asset_org_fk
  on public.asset_depreciation_settings is
  'Composite FK to assets(id, org_id): the policy''s asset must be same-org — a DB invariant, not an app check.';

-- Reporting sweeps ("show every asset with a depreciation policy in this org").
create index if not exists asset_depreciation_settings_org_idx
  on public.asset_depreciation_settings (org_id, updated_at desc);

drop trigger if exists asset_depreciation_settings_set_updated_at on public.asset_depreciation_settings;
create trigger asset_depreciation_settings_set_updated_at
  before update on public.asset_depreciation_settings
  for each row execute function public.tg_set_updated_at();

-- Finance policy ⇒ admin-only writes (member read), the asset_service_schedules
-- posture: standing config that governs a reported number belongs to owners /
-- admins, but every member can see the NBV on the asset.
alter table public.asset_depreciation_settings enable row level security;

create policy asset_depreciation_settings_select on public.asset_depreciation_settings
  for select using (org_id in (select public.current_org_ids()));
create policy asset_depreciation_settings_insert on public.asset_depreciation_settings
  for insert with check (public.is_org_admin(org_id));
create policy asset_depreciation_settings_update on public.asset_depreciation_settings
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
create policy asset_depreciation_settings_delete on public.asset_depreciation_settings
  for delete using (public.is_org_admin(org_id));
