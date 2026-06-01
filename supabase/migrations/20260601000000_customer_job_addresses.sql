-- Issue #8: customer + job address system.
-- Additive only. Customers gain a structured UK address; jobs gain an optional
-- site-address override (when null, the job inherits the customer's address).

alter table public.customers
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city         text,
  add column if not exists county       text,
  add column if not exists postcode     text,
  add column if not exists country       text not null default 'United Kingdom';

alter table public.jobs
  add column if not exists site_address_line1 text,
  add column if not exists site_address_line2 text,
  add column if not exists site_city          text,
  add column if not exists site_county        text,
  add column if not exists site_postcode      text,
  add column if not exists site_country        text;
