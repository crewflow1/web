-- assets.purchase_price / current_value / hire_rate and fleet_vehicles.finance_*:
-- company financial data is no longer readable through the Data API
-- (least-privilege enforcement — UI finding S-3, register ST-10b "money columns").
--
-- THE HOLE
-- --------
-- A `staff` member legitimately sees asset rows (the plant on a job they are assigned
-- to, the vehicle they drive). RLS is row-level, so the same rows exposed what the
-- company paid for each asset, its book value, hire rates and vehicle finance
-- agreements (provider, reference, monthly payment, end date).
--
-- THE FIX — a column ACL (same construction as 20261341 / 20261342)
-- ------------------------------------------------------------------
-- Client roles keep SELECT on every other column. The money columns are read
-- server-side with the service role after an `assets:view` / `fleet:view` capability
-- check (server/services/private-columns.ts → readAssetMoney / readVehicleMoney).
-- INSERT / UPDATE grants are untouched (writes are owner/admin only by 20261340; the
-- SECURITY INVOKER save_fleet_vehicle RPC only WRITES these columns).
-- `anon` keeps the same narrowed column grant (no policy path to a row; ST-12).
--
-- data-api:exempt: narrows an existing grant; adds no table.
-- Idempotent.
--
-- Safe to apply before the code deploys: NO — deploy the code first (or together).
--   The pre-change asset detail and fleet pages select these columns with the user JWT.
-- Production precondition: none.
--
-- Rollback: grant select on public.assets, public.fleet_vehicles to authenticated, anon;

do $$
declare
  spec record;
  cols text;
begin
  for spec in
    select * from (values
      ('assets',         array['purchase_price', 'current_value', 'hire_rate']),
      ('fleet_vehicles', array['finance_type', 'finance_provider_id', 'finance_agreement_ref',
                               'finance_monthly_payment', 'finance_end_date'])
    ) as v(tbl, private_cols)
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
      into cols
      from pg_attribute a
     where a.attrelid = ('public.' || spec.tbl)::regclass
       and a.attnum > 0
       and not a.attisdropped
       and a.attname <> all (spec.private_cols);

    execute format('revoke select on public.%I from anon, authenticated', spec.tbl);
    execute format('grant select (%s) on public.%I to anon, authenticated', cols, spec.tbl);
  end loop;
end $$;
