-- Proof for 20261355000000 (CrewFlow-wide AI ceiling). Runs in ONE transaction and ROLLS BACK:
-- safe on a shared local database; never run against production.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f docs/programme/security-secrets/proofs/platform-ceiling-proof.sql
\set QUIET on
begin;
insert into public.organizations (id, name, slug, status) values
  ('00000000-0000-4000-8000-0000000a1001', 'Proof org 1', 'proof-plat-1', 'active'),
  ('00000000-0000-4000-8000-0000000a1002', 'Proof org 2', 'proof-plat-2', 'active');

-- Platform headroom = whatever is already committed this month + 100p.
select public.ai_set_platform_ceiling(
  (select (committed_pence + reserved_pence)::int + 100 from public.ai_platform_month_usage()),
  null, 'proof') \gset
\set QUIET off
\echo '1) org 1 reserves 60p (org ceiling 10000p, platform headroom 100p) -> reserved'
select outcome, block_reason from public.ai_reserve_invocation('00000000-0000-4000-8000-0000000a1001', 'proof.feature', 'drafting', 60);
\echo '2) org 2 reserves 60p — its own ceiling has room, the PLATFORM does not -> blocked/platform_ceiling'
select outcome, block_reason from public.ai_reserve_invocation('00000000-0000-4000-8000-0000000a1002', 'proof.feature', 'drafting', 60);
\echo '3) org 2 reserves 40p — fits exactly -> reserved'
select outcome, block_reason from public.ai_reserve_invocation('00000000-0000-4000-8000-0000000a1002', 'proof.feature', 'drafting', 40);
\echo '4) org 1 reserves 1p — platform now full -> blocked/platform_ceiling'
select outcome, block_reason from public.ai_reserve_invocation('00000000-0000-4000-8000-0000000a1001', 'proof.feature', 'drafting', 1);
\echo '5) platform ceiling 0 -> every call blocked/platform_ceiling'
select public.ai_set_platform_ceiling(0, null, 'proof zero') \gset
select outcome, block_reason from public.ai_reserve_invocation('00000000-0000-4000-8000-0000000a1001', 'proof.feature', 'drafting', 1);
\echo '6) setter clamps to 1,000,000p and audits every change'
select new_pence from public.ai_set_platform_ceiling(99999999, null, 'proof clamp');
select count(*) as audit_rows_in_this_txn from public.ai_platform_budget_audit where note like 'proof%';
\echo '7) the client roles cannot read the budget, set it, or reserve'
select has_table_privilege('authenticated', 'public.ai_platform_budget', 'select') as auth_can_read_budget,
       has_function_privilege('authenticated', 'public.ai_set_platform_ceiling(integer,uuid,text)', 'execute') as auth_can_set,
       has_function_privilege('anon', 'public.ai_reserve_invocation(uuid,text,text,integer,uuid,text,integer,integer,integer)', 'execute') as anon_can_reserve;
rollback;
