-- scripts/load/sql/seed.sql — set-based synthetic tenant seeder (driven by seed.mjs).
--
-- Inputs (psql variables / temp tables prepared by seed.mjs):
--   :tag           short tag embedded in every slug / email / deterministic id
--   :anchor        the "today" the dataset is anchored to (YYYY-MM-DD)
--   :hq            number of HQ (super-admin candidate) users to create
--   :pwhash        ONE bcrypt hash shared by every synthetic user (computed once)
--   lt_orgs        one row per organisation with its per-org row counts
--
-- Properties:
--   * DETERMINISTIC — every id is md5('<tag>:<kind>:<org idx>:<n>')::uuid and
--     every "random" choice is a hash of the same key, so two runs with the same
--     arguments produce byte-identical rows (and k6 can recompute any id).
--   * IDEMPOTENT — every insert is ON CONFLICT DO NOTHING; dependent steps
--     (line items, status promotion, payments) only touch rows inserted by THIS
--     run, so a re-run is a no-op rather than a duplicate or a trigger error.
--   * TAGGED — slugs are `lt-<tag>-…`, emails are `lt-<tag>-…@loadtest.crewflow.invalid`
--     (RFC 2606 reserved TLD: undeliverable by construction).
--   * Triggers stay ON by default (activity log, rota sync, invoice line-item
--     snapshot, payment status sync all fire, exactly as for app writes). The
--     session presents as service_role so the approval/issue guards that exempt
--     trusted server paths behave as they do for the app's own service writes.

\set ON_ERROR_STOP on
\timing off

select set_config('request.jwt.claims', '{"role":"service_role"}', false) \gset _c1_
select set_config('request.jwt.claim.role', 'service_role', false) \gset _c2_

-- ── deterministic helpers (session-local; nothing is created in public) ──────
create function pg_temp.lt_r(k text) returns double precision
language sql immutable as
$$ select (('x' || substr(md5(k), 1, 7))::bit(28)::int)::double precision / 268435456.0 $$;

create function pg_temp.lt_id(k text) returns uuid
language sql immutable as $$ select md5(k)::uuid $$;

create function pg_temp.lt_pick(arr text[], k text) returns text
language sql immutable as
$$ select arr[1 + floor(pg_temp.lt_r(k) * array_length(arr, 1))::int] $$;

create function pg_temp.lt_first(k text) returns text language sql immutable as $$
  select pg_temp.lt_pick(array['Aoife','Callum','Priya','Declan','Niamh','Marcus','Sian','Tariq','Orla','Gareth','Ewa','Rhys','Fiona','Jamal','Roisin','Owen','Kasia','Liam','Megan','Dmitri','Eilidh','Conor','Yusuf','Bronagh','Piotr','Hannah','Ruairi','Zainab','Finlay','Shauna'], k) $$;
create function pg_temp.lt_sur(k text) returns text language sql immutable as $$
  select pg_temp.lt_pick(array['Harland','Okafor','McAllister','Devlin','Ferreira','Whitcombe','Nowak','Brannigan','Achebe','Thornley','Quigley','Petrov','Ashdown','Mulholland','Rahman','Castellan','Doherty','Varga','Lindqvist','Abernethy','Kowalczyk','Trevelyan','Osei','Macready','Fenwick','Gallacher','Soltani','Penhale','Drummond','Iweala'], k) $$;
create function pg_temp.lt_town(k text) returns text language sql immutable as $$
  select pg_temp.lt_pick(array['Ashbourne Vale','Kettlewick','Northmere','Dunharrow','Calderbrook','Wexcombe','Stonehaven Cross','Marlow Fen','Eastwick Green','Tarnside','Brackenfold','Holloway Reach'], k) $$;
create function pg_temp.lt_street(k text) returns text language sql immutable as $$
  select pg_temp.lt_pick(array['Mill Lane','Quarry Road','Foundry Street','Orchard Close','Station Approach','Kiln Way','Tannery Row','Weavers Court','Harbour View','Chapel Hill','Beech Avenue','Lockside'], k) $$;
create function pg_temp.lt_work(k text) returns text language sql immutable as $$
  select pg_temp.lt_pick(array['Kitchen extension','Loft conversion','Flat roof replacement','Rewire and consumer unit','Bathroom refit','Driveway and drainage','Structural opening and steel','External render','Underfloor heating install','Garage conversion','Boundary wall rebuild','Window and door replacement','Commercial fit-out','Scaffold and roof repairs','Damp proofing','Groundworks and footings'], k) $$;

-- ── users ───────────────────────────────────────────────────────────────────
create temp table lt_users as
select o.idx as org_idx, o.org_id, r.role, r.n,
       pg_temp.lt_id(:'tag' || ':user:' || o.idx || ':' || r.role || ':' || r.n) as user_id,
       'lt-' || :'tag' || '-o' || o.idx || '-' || r.role || r.n || '@loadtest.crewflow.invalid' as email,
       pg_temp.lt_first(:'tag' || ':fn:' || o.idx || ':' || r.role || ':' || r.n) || ' ' ||
       pg_temp.lt_sur(:'tag' || ':sn:' || o.idx || ':' || r.role || ':' || r.n) as full_name
from lt_orgs o
cross join lateral (
  select 'owner'::text as role, 1 as n
  union all select 'admin', g from generate_series(1, o.n_admins) g
  union all select 'staff', g from generate_series(1, o.n_staff) g
) r;

insert into lt_users (org_idx, org_id, role, n, user_id, email, full_name)
select 0, null, 'hq', g,
       pg_temp.lt_id(:'tag' || ':user:0:hq:' || g),
       'lt-' || :'tag' || '-hq' || g || '@loadtest.crewflow.invalid',
       'HQ Operator ' || g
from generate_series(1, :hq) g;

create index on lt_users (org_idx, role, n);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select '00000000-0000-0000-0000-000000000000', u.user_id, 'authenticated', 'authenticated',
       u.email, :'pwhash', now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('loadtest_tag', :'tag'),
       now(), now(), '', '', '', ''
from lt_users u
on conflict do nothing;

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.user_id::text, u.user_id,
       jsonb_build_object('sub', u.user_id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       'email', now(), now(), now()
from lt_users u
on conflict do nothing;

insert into public.users (id, email, full_name, employment_type, start_date)
select u.user_id, u.email, u.full_name,
       case when u.role = 'staff' then pg_temp.lt_pick(array['employee','employee','employee','self_employed','contractor','apprentice'], :'tag' || ':emp:' || u.org_idx || ':' || u.n) end,
       (:'anchor'::date - (30 + floor(pg_temp.lt_r(:'tag' || ':start:' || u.org_idx || ':' || u.role || ':' || u.n) * 1500))::int)
from lt_users u
on conflict do nothing;

-- ── organisations + memberships ─────────────────────────────────────────────
insert into public.organizations (id, name, slug, status, plan, onboarding_state, created_at)
select o.org_id, o.name, o.slug, 'active', 'starter',
       jsonb_build_object('loadtest_tag', :'tag', 'loadtest_marker', o.marker),
       :'anchor'::timestamptz - make_interval(days => (60 + floor(pg_temp.lt_r(:'tag' || ':orgage:' || o.idx) * 700))::int)
from lt_orgs o
on conflict do nothing;

insert into public.memberships (id, org_id, user_id, role)
select pg_temp.lt_id(:'tag' || ':membership:' || u.org_idx || ':' || u.role || ':' || u.n),
       u.org_id, u.user_id, u.role
from lt_users u
where u.role <> 'hq'
on conflict do nothing;

insert into public.staff_compensation (user_id, hourly_pay)
select u.user_id, round((12.5 + pg_temp.lt_r(:'tag' || ':pay:' || u.org_idx || ':' || u.role || ':' || u.n) * 19.5)::numeric, 2)
from lt_users u
where u.role in ('staff', 'admin')
on conflict do nothing;

-- ── customers ───────────────────────────────────────────────────────────────
insert into public.customers (
  id, org_id, name, email, phone, notes, address_line1, city, postcode, customer_type, created_at
)
select pg_temp.lt_id(:'tag' || ':customer:' || o.idx || ':' || n),
       o.org_id,
       case when pg_temp.lt_r(:'tag' || ':ctype:' || o.idx || ':' || n) < 0.3
            then pg_temp.lt_sur(:'tag' || ':csn:' || o.idx || ':' || n) || ' & ' || pg_temp.lt_sur(:'tag' || ':csn2:' || o.idx || ':' || n) || ' Ltd'
            else pg_temp.lt_first(:'tag' || ':cfn:' || o.idx || ':' || n) || ' ' || pg_temp.lt_sur(:'tag' || ':csn:' || o.idx || ':' || n)
       end || ' (' || o.marker || ')',
       'c' || n || '.o' || o.idx || '.' || :'tag' || '@customers.loadtest.crewflow.invalid',
       '+44 7700 900' || lpad((n % 1000)::text, 3, '0'),
       'Synthetic load-test customer ' || o.marker,
       (1 + floor(pg_temp.lt_r(:'tag' || ':chouse:' || o.idx || ':' || n) * 180))::int || ' ' || pg_temp.lt_street(:'tag' || ':cstreet:' || o.idx || ':' || n),
       pg_temp.lt_town(:'tag' || ':ctown:' || o.idx || ':' || n),
       'ZZ' || (1 + (o.idx % 98)) || ' ' || (n % 9) || 'ZZ',
       case when pg_temp.lt_r(:'tag' || ':ctype:' || o.idx || ':' || n) < 0.3 then 'business' else 'individual' end,
       :'anchor'::timestamptz - make_interval(days => floor(pg_temp.lt_r(:'tag' || ':cage:' || o.idx || ':' || n) * 730)::int)
from lt_orgs o
cross join lateral generate_series(1, o.n_customers) n
on conflict do nothing;

-- ── jobs (+ crew) ───────────────────────────────────────────────────────────
-- Customer choice is skewed (r^2) so a minority of customers own most jobs.
create temp table lt_jobs as
select o.idx as org_idx, o.org_id, o.marker, n,
       pg_temp.lt_id(:'tag' || ':job:' || o.idx || ':' || n) as job_id,
       pg_temp.lt_id(:'tag' || ':customer:' || o.idx || ':' ||
         (1 + floor(o.n_customers * power(pg_temp.lt_r(:'tag' || ':jobcust:' || o.idx || ':' || n), 2)))::int) as customer_id,
       case when pg_temp.lt_r(:'tag' || ':jobsched:' || o.idx || ':' || n) < 0.08 then null
            else :'anchor'::date + (floor(pg_temp.lt_r(:'tag' || ':jobdate:' || o.idx || ':' || n) * 225)::int - 180) end as scheduled_date,
       case when pg_temp.lt_r(:'tag' || ':jobassign:' || o.idx || ':' || n) < 0.15 then null
            else (1 + floor(pg_temp.lt_r(:'tag' || ':jobstaff:' || o.idx || ':' || n) * o.n_staff))::int end as staff_n,
       pg_temp.lt_r(:'tag' || ':jobstatus:' || o.idx || ':' || n) as sr,
       o.n_staff
from lt_orgs o
cross join lateral generate_series(1, o.n_jobs) n;

create temp table lt_new_jobs (job_id uuid primary key);

with ins as (
  insert into public.jobs (
    id, org_id, customer_id, assigned_to, status, scheduled_date, scheduled_end_date, notes,
    site_address_line1, site_city, site_postcode, created_at
  )
  select j.job_id, j.org_id, j.customer_id, su.user_id,
         case
           when j.scheduled_date is null then 'new'
           when j.scheduled_date < :'anchor'::date - 3 then
             case when j.sr < 0.86 then 'completed' when j.sr < 0.94 then 'in-progress' else 'blocked' end
           when j.scheduled_date <= :'anchor'::date + 3 then
             case when j.sr < 0.7 then 'in-progress' else 'new' end
           else 'new'
         end,
         j.scheduled_date,
         case when j.scheduled_date is not null and j.sr > 0.6
              then j.scheduled_date + (1 + floor(j.sr * 9))::int end,
         pg_temp.lt_work(:'tag' || ':jobwork:' || j.org_idx || ':' || j.n) || ' — job ' || j.n || ' ' || j.marker,
         (1 + floor(pg_temp.lt_r(:'tag' || ':jhouse:' || j.org_idx || ':' || j.n) * 180))::int || ' ' || pg_temp.lt_street(:'tag' || ':jstreet:' || j.org_idx || ':' || j.n),
         pg_temp.lt_town(:'tag' || ':jtown:' || j.org_idx || ':' || j.n),
         'ZZ' || (1 + (j.org_idx % 98)) || ' ' || (j.n % 9) || 'ZZ',
         coalesce(j.scheduled_date, :'anchor'::date)::timestamptz - make_interval(days => (7 + floor(j.sr * 30))::int)
  from lt_jobs j
  left join lt_users su on su.org_idx = j.org_idx and su.role = 'staff' and su.n = j.staff_n
  on conflict do nothing
  returning id
)
insert into lt_new_jobs select id from ins;

-- Primary crew row for every assigned job + a second operative on ~30%.
insert into public.job_assignments (id, org_id, job_id, user_id)
select pg_temp.lt_id(:'tag' || ':ja:' || j.org_idx || ':' || j.n || ':1'), j.org_id, j.job_id, su.user_id
from lt_jobs j
join lt_users su on su.org_idx = j.org_idx and su.role = 'staff' and su.n = j.staff_n
on conflict do nothing;

insert into public.job_assignments (id, org_id, job_id, user_id)
select pg_temp.lt_id(:'tag' || ':ja:' || j.org_idx || ':' || j.n || ':2'), j.org_id, j.job_id, su.user_id
from lt_jobs j
join lt_users su on su.org_idx = j.org_idx and su.role = 'staff' and su.n = 1 + (j.staff_n % j.n_staff)
where j.staff_n is not null and j.n_staff > 1
  and pg_temp.lt_r(:'tag' || ':ja2:' || j.org_idx || ':' || j.n) < 0.3
on conflict do nothing;

-- ── quotes (+ line items, then status promotion) ────────────────────────────
-- The LAST n_invoiceable quotes per org are accepted and deliberately left
-- un-invoiced: the pool the POST /api/invoices scenario draws from.
create temp table lt_quotes as
select o.idx as org_idx, o.org_id, o.marker, g.qn as n,
       pg_temp.lt_id(:'tag' || ':quote:' || o.idx || ':' || g.qn) as quote_id,
       jb.job_id, jb.customer_id,
       case
         when g.qn > o.n_quotes - o.n_invoiceable then 'accepted'
         when pg_temp.lt_r(:'tag' || ':qstatus:' || o.idx || ':' || g.qn) < 0.40 then 'accepted'
         when pg_temp.lt_r(:'tag' || ':qstatus:' || o.idx || ':' || g.qn) < 0.60 then 'sent'
         when pg_temp.lt_r(:'tag' || ':qstatus:' || o.idx || ':' || g.qn) < 0.70 then 'viewed'
         when pg_temp.lt_r(:'tag' || ':qstatus:' || o.idx || ':' || g.qn) < 0.88 then 'draft'
         when pg_temp.lt_r(:'tag' || ':qstatus:' || o.idx || ':' || g.qn) < 0.97 then 'declined'
         else 'expired'
       end as final_status,
       (g.qn > o.n_quotes - o.n_invoiceable) as in_pool,
       :'anchor'::timestamptz - make_interval(days => (2 + floor(pg_temp.lt_r(:'tag' || ':qage:' || o.idx || ':' || g.qn) * 360))::int) as created_at
from lt_orgs o
cross join lateral generate_series(1, o.n_quotes) as g(qn)
join lt_jobs jb on jb.org_idx = o.idx and jb.n = 1 + ((g.qn - 1) % o.n_jobs);

create temp table lt_new_quotes (quote_id uuid primary key);

with ins as (
  insert into public.quotes (id, org_id, customer_id, number, status, currency, notes, terms, public_token, created_by, created_at)
  select q.quote_id, q.org_id, q.customer_id, 'Q-' || lpad(q.n::text, 4, '0'), 'draft', 'GBP',
         'Synthetic load-test quote ' || q.marker,
         'Payment within 14 days of invoice. Variations priced separately.',
         pg_temp.lt_id(:'tag' || ':qtoken:' || q.org_idx || ':' || q.n)::text,
         ow.user_id, q.created_at
  from lt_quotes q
  join lt_users ow on ow.org_idx = q.org_idx and ow.role = 'owner'
  on conflict do nothing
  returning id
)
insert into lt_new_quotes select id from ins;

create temp table lt_lines as
select q.quote_id, q.org_id, k as sort_order,
       pg_temp.lt_id(:'tag' || ':qline:' || q.org_idx || ':' || q.n || ':' || k) as line_id,
       pg_temp.lt_work(:'tag' || ':qlwork:' || q.org_idx || ':' || q.n || ':' || k) || ' — ' ||
         pg_temp.lt_pick(array['labour','materials','plant hire','first fix','second fix','making good','waste removal','prelims'], :'tag' || ':qlkind:' || q.org_idx || ':' || q.n || ':' || k) as description,
       (1 + floor(pg_temp.lt_r(:'tag' || ':qlqty:' || q.org_idx || ':' || q.n || ':' || k) * 40))::numeric as qty,
       pg_temp.lt_pick(array['ea','m','m2','hr','day'], :'tag' || ':qlunit:' || q.org_idx || ':' || q.n || ':' || k) as unit,
       round((15 + pg_temp.lt_r(:'tag' || ':qlprice:' || q.org_idx || ':' || q.n || ':' || k) * 485)::numeric, 2) as unit_price,
       case when pg_temp.lt_r(:'tag' || ':qlvat:' || q.org_idx || ':' || q.n || ':' || k) < 0.9 then 20
            when pg_temp.lt_r(:'tag' || ':qlvat:' || q.org_idx || ':' || q.n || ':' || k) < 0.95 then 5 else 0 end::numeric as vat_rate
from lt_quotes q
join lt_new_quotes nq on nq.quote_id = q.quote_id
cross join lateral generate_series(1, (2 + floor(pg_temp.lt_r(:'tag' || ':qlines:' || q.org_idx || ':' || q.n) * 5))::int) k;

insert into public.quote_line_items (id, quote_id, org_id, description, qty, unit, unit_price, vat_rate, line_total, sort_order)
select l.line_id, l.quote_id, l.org_id, l.description, l.qty, l.unit, l.unit_price, l.vat_rate,
       round(l.qty * l.unit_price, 2), l.sort_order
from lt_lines l
on conflict do nothing;

-- Promote: totals + lifecycle status in ONE update (so the accepted-freeze
-- triggers see a consistent row and never fire against a half-built quote).
with tot as (
  select quote_id,
         sum(round(qty * unit_price, 2)) as subtotal,
         sum(round(round(qty * unit_price, 2) * vat_rate / 100, 2)) as vat_total
  from lt_lines group by quote_id
)
update public.quotes qq
set subtotal = t.subtotal,
    vat_total = t.vat_total,
    total = t.subtotal + t.vat_total,
    status = q.final_status,
    valid_until = (q.created_at + interval '30 days')::date,
    sent_at = case when q.final_status <> 'draft' then q.created_at + interval '1 day' end,
    viewed_at = case when q.final_status in ('viewed', 'accepted', 'declined') then q.created_at + interval '2 days' end,
    accepted_at = case when q.final_status = 'accepted' then q.created_at + interval '4 days' end,
    declined_at = case when q.final_status = 'declined' then q.created_at + interval '5 days' end,
    accept_signature = case when q.final_status = 'accepted'
      then jsonb_build_object('name', 'Synthetic Signer', 'source', 'seed') end,
    job_id = case when q.final_status = 'accepted' then q.job_id end
from lt_quotes q
join lt_new_quotes nq on nq.quote_id = q.quote_id
join tot t on t.quote_id = q.quote_id
where qq.id = q.quote_id;

-- ── invoices (+ payments) ───────────────────────────────────────────────────
create temp table lt_invoices as
with from_quote as (
  select q.org_idx, q.org_id, q.quote_id, q.job_id, q.customer_id, q.created_at + interval '5 days' as created_at,
         row_number() over (partition by q.org_idx order by q.n) as seq
  from lt_quotes q
  where q.final_status = 'accepted' and not q.in_pool
),
capped as (
  select f.* from from_quote f join lt_orgs o on o.idx = f.org_idx where f.seq <= o.n_invoices
),
standalone as (
  select o.idx as org_idx, o.org_id, null::uuid as quote_id, jb.job_id, jb.customer_id,
         :'anchor'::timestamptz - make_interval(days => (1 + floor(pg_temp.lt_r(:'tag' || ':invage:' || o.idx || ':' || s) * 300))::int) as created_at,
         c.cnt + s as seq
  from lt_orgs o
  cross join lateral (select count(*)::int as cnt from capped c2 where c2.org_idx = o.idx) c
  cross join lateral generate_series(1, greatest(0, o.n_invoices - c.cnt)) s
  join lt_jobs jb on jb.org_idx = o.idx and jb.n = 1 + ((s * 7) % o.n_jobs)
)
select *, pg_temp.lt_id(:'tag' || ':invoice:' || org_idx || ':' || seq) as invoice_id,
       pg_temp.lt_r(:'tag' || ':invstatus:' || org_idx || ':' || seq) as sr
from (select * from capped union all select * from standalone) x;

create temp table lt_new_invoices (invoice_id uuid primary key);

with ins as (
  insert into public.invoices (id, org_id, quote_id, number, amount, vat_total, status, due_date, sent_at, notes, created_at, job_id, customer_id)
  select i.invoice_id, i.org_id, i.quote_id, 'INV-' || lpad(i.seq::text, 4, '0'),
         coalesce(qq.subtotal, round((180 + i.sr * 7400)::numeric, 2)),
         coalesce(qq.vat_total, round((180 + i.sr * 7400)::numeric * 0.2, 2)),
         (case when i.sr < 0.10 then 'draft' else 'sent' end)::public.invoice_status,
         (i.created_at + interval '14 days')::date,
         case when i.sr >= 0.10 then i.created_at + interval '1 hour' end,
         'Synthetic load-test invoice',
         i.created_at, i.job_id, i.customer_id
  from lt_invoices i
  left join public.quotes qq on qq.id = i.quote_id
  on conflict do nothing
  returning id
)
insert into lt_new_invoices select id from ins;

-- ~42% fully paid, ~8% part-paid; the status-sync trigger moves the invoice.
insert into public.invoice_payments (id, org_id, invoice_id, amount, paid_at, reference, source)
select pg_temp.lt_id(:'tag' || ':payment:' || i.org_idx || ':' || i.seq), i.org_id, i.invoice_id,
       case when i.sr >= 0.58 then inv.total else round(inv.total * 0.4, 2) end,
       least(:'anchor'::date, (i.created_at + make_interval(days => (3 + floor(i.sr * 40))::int))::date),
       'FP-' || lpad(i.seq::text, 6, '0'), 'manual'
from lt_invoices i
join lt_new_invoices ni on ni.invoice_id = i.invoice_id
join public.invoices inv on inv.id = i.invoice_id
where i.sr >= 0.50 and inv.total > 0
on conflict do nothing;

-- ── time entries (the timesheet substrate) ──────────────────────────────────
-- One closed entry per staff member per recent working day, ~12% absence.
-- Everyone is left CLOCKED OUT so a virtual user can clock in.
insert into public.time_entries (id, org_id, user_id, job_id, started_at, ended_at, breaks, note)
select pg_temp.lt_id(:'tag' || ':te:' || u.org_idx || ':' || u.role || ':' || u.n || ':' || d.d),
       u.org_id, u.user_id,
       pg_temp.lt_id(:'tag' || ':job:' || u.org_idx || ':' || (1 + floor(pg_temp.lt_r(:'tag' || ':tejob:' || u.org_idx || ':' || u.n || ':' || d.d) * o.n_jobs))::int),
       st.s, st.s + make_interval(mins => (480 + floor(pg_temp.lt_r(:'tag' || ':telen:' || u.org_idx || ':' || u.n || ':' || d.d) * 90))::int),
       jsonb_build_array(jsonb_build_object('started_at', st.s + interval '4 hours', 'ended_at', st.s + interval '4 hours 30 minutes')),
       'seed'
from lt_users u
join lt_orgs o on o.idx = u.org_idx
cross join lateral (
  select g as d from generate_series(1, o.n_te * 2) g
  where extract(isodow from :'anchor'::date - g) < 6
  order by g limit o.n_te
) d
cross join lateral (
  select ((:'anchor'::date - d.d)::timestamp + interval '7 hours 30 minutes'
          + make_interval(mins => floor(pg_temp.lt_r(:'tag' || ':testart:' || u.org_idx || ':' || u.n || ':' || d.d) * 60)::int)) at time zone 'Europe/London' as s
) st
where u.role in ('staff', 'admin')
  and pg_temp.lt_r(:'tag' || ':teabsent:' || u.org_idx || ':' || u.role || ':' || u.n || ':' || d.d) >= 0.12
on conflict do nothing;

-- ── job documents ───────────────────────────────────────────────────────────
insert into public.job_documents (id, org_id, job_id, visibility, doc_type, title, status, assigned_to, created_by, created_at)
select pg_temp.lt_id(:'tag' || ':doc:' || o.idx || ':' || n), o.org_id,
       pg_temp.lt_id(:'tag' || ':job:' || o.idx || ':' || (1 + floor(pg_temp.lt_r(:'tag' || ':docjob:' || o.idx || ':' || n) * o.n_jobs))::int),
       case when pg_temp.lt_r(:'tag' || ':docvis:' || o.idx || ':' || n) < 0.8 then 'staff' else 'private' end,
       pg_temp.lt_pick(array['checklist','site_report','method_statement','completion_cert','test_sheet','commissioning','custom'], :'tag' || ':doctype:' || o.idx || ':' || n),
       pg_temp.lt_pick(array['Site induction checklist','Daily site report','Method statement','Completion certificate','Electrical test sheet','Commissioning record','Handover pack'], :'tag' || ':doctitle:' || o.idx || ':' || n) || ' ' || n || ' ' || o.marker,
       pg_temp.lt_pick(array['draft','in_progress','completed','completed'], :'tag' || ':docstatus:' || o.idx || ':' || n),
       case when pg_temp.lt_r(:'tag' || ':docassign:' || o.idx || ':' || n) < 0.5
            then pg_temp.lt_id(:'tag' || ':user:' || o.idx || ':staff:' || (1 + floor(pg_temp.lt_r(:'tag' || ':docstaff:' || o.idx || ':' || n) * o.n_staff))::int) end,
       pg_temp.lt_id(:'tag' || ':user:' || o.idx || ':owner:1'),
       :'anchor'::timestamptz - make_interval(days => floor(pg_temp.lt_r(:'tag' || ':docage:' || o.idx || ':' || n) * 200)::int)
from lt_orgs o
cross join lateral generate_series(1, o.n_docs) n
on conflict do nothing;

-- ── RAMS (risk assessments): born draft, then issued ────────────────────────
create temp table lt_new_rams (ra_id uuid primary key, org_idx int, n int);

with ins as (
  insert into public.risk_assessments (id, org_id, job_id, title, activity, location, assessor_id, assessment_date, review_date, ppe, method_statement, created_by)
  select pg_temp.lt_id(:'tag' || ':rams:' || o.idx || ':' || n), o.org_id,
         pg_temp.lt_id(:'tag' || ':job:' || o.idx || ':' || (1 + floor(pg_temp.lt_r(:'tag' || ':ramsjob:' || o.idx || ':' || n) * o.n_jobs))::int),
         'RAMS ' || n || ' — ' || pg_temp.lt_work(:'tag' || ':ramswork:' || o.idx || ':' || n) || ' ' || o.marker,
         pg_temp.lt_work(:'tag' || ':ramswork:' || o.idx || ':' || n),
         pg_temp.lt_town(:'tag' || ':ramstown:' || o.idx || ':' || n),
         pg_temp.lt_id(:'tag' || ':user:' || o.idx || ':owner:1'), :'anchor'::date - 20, :'anchor'::date + 160,
         array['Hard hat', 'Hi-vis', 'Safety boots', 'Gloves'],
         repeat('Sequence of works, access and egress, isolation of services, lifting plan, emergency arrangements. ', 8),
         pg_temp.lt_id(:'tag' || ':user:' || o.idx || ':owner:1')
  from lt_orgs o
  cross join lateral generate_series(1, o.n_rams) n
  on conflict do nothing
  returning id
)
insert into lt_new_rams (ra_id) select id from ins;

update public.risk_assessments ra
set status = 'issued',
    reference = 'RA-LT-' || lpad(x.n::text, 4, '0'),
    issued_at = now(),
    issued_by = ra.created_by
from (
  select pg_temp.lt_id(:'tag' || ':rams:' || o.idx || ':' || n) as ra_id, n
  from lt_orgs o cross join lateral generate_series(1, o.n_rams) n
) x
join lt_new_rams nr on nr.ra_id = x.ra_id
where ra.id = x.ra_id;

-- ── leads ───────────────────────────────────────────────────────────────────
insert into public.leads (id, org_id, source, status, service, postcode, notes, contact_name, contact_email, contact_phone, estimated_value, first_contact_at, last_activity_at, created_at)
select pg_temp.lt_id(:'tag' || ':lead:' || o.idx || ':' || n), o.org_id,
       pg_temp.lt_pick(array['web','web','phone','referral','email'], :'tag' || ':leadsrc:' || o.idx || ':' || n),
       pg_temp.lt_pick(array['new','new','contacted','qualified','quoted','won','lost'], :'tag' || ':leadstatus:' || o.idx || ':' || n),
       pg_temp.lt_work(:'tag' || ':leadwork:' || o.idx || ':' || n),
       'ZZ' || (1 + (o.idx % 98)) || ' ' || (n % 9) || 'ZZ',
       'Synthetic seeded enquiry ' || o.marker,
       pg_temp.lt_first(:'tag' || ':leadfn:' || o.idx || ':' || n) || ' ' || pg_temp.lt_sur(:'tag' || ':leadsn:' || o.idx || ':' || n) || ' (' || o.marker || ')',
       'lead' || n || '.o' || o.idx || '.' || :'tag' || '@leads.loadtest.crewflow.invalid',
       '+44 7700 900' || lpad(((n * 7) % 1000)::text, 3, '0'),
       round((500 + pg_temp.lt_r(:'tag' || ':leadval:' || o.idx || ':' || n) * 40000)::numeric, 2),
       t.ts, t.ts + interval '1 day', t.ts
from lt_orgs o
cross join lateral generate_series(1, o.n_leads) n
cross join lateral (
  select :'anchor'::timestamptz - make_interval(days => (1 + floor(pg_temp.lt_r(:'tag' || ':leadage:' || o.idx || ':' || n) * 120))::int) as ts
) t
on conflict do nothing;

-- ── finances (costs / bills) ────────────────────────────────────────────────
insert into public.finances (id, org_id, job_id, amount, vat_rate, category, notes, bill_date, created_at)
select pg_temp.lt_id(:'tag' || ':fin:' || o.idx || ':' || n), o.org_id,
       case when pg_temp.lt_r(:'tag' || ':finjobq:' || o.idx || ':' || n) < 0.7
            then pg_temp.lt_id(:'tag' || ':job:' || o.idx || ':' || (1 + floor(pg_temp.lt_r(:'tag' || ':finjob:' || o.idx || ':' || n) * o.n_jobs))::int) end,
       round((20 + pg_temp.lt_r(:'tag' || ':finamt:' || o.idx || ':' || n) * 4980)::numeric, 2),
       case when pg_temp.lt_r(:'tag' || ':finvat:' || o.idx || ':' || n) < 0.85 then 20 else 0 end,
       pg_temp.lt_pick(array['materials','materials','subcontractor','plant_hire','fuel','tools','other'], :'tag' || ':fincat:' || o.idx || ':' || n),
       'Synthetic cost ' || o.marker,
       t.d, t.d::timestamptz
from lt_orgs o
cross join lateral generate_series(1, o.n_fin) n
cross join lateral (
  select :'anchor'::date - floor(pg_temp.lt_r(:'tag' || ':finage:' || o.idx || ':' || n) * 330)::int as d
) t
on conflict do nothing;

analyze public.customers, public.jobs, public.job_assignments, public.quotes, public.quote_line_items,
        public.invoices, public.invoice_payments, public.time_entries, public.job_documents,
        public.risk_assessments, public.leads, public.finances, public.memberships;
