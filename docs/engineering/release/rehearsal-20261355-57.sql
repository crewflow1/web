-- REHEARSAL for 20261355–57 on a RESTORED production backup (network-less container). Counts only.
\set QUIET on
\pset tuples_only on
\pset format unaligned
select 'pre: tip=' || (select max(version) from supabase_migrations.schema_migrations)
  || ' table=' || (to_regclass('public.subscription_cancellations') is not null)
  || ' fns=' || (select count(*) from pg_proc where proname in ('claim_subscription_cancellation','confirm_subscription_cancellation','apply_stripe_subscription_state'))
  || ' held_guards=' || (select count(*) from pg_trigger where tgname = 'held_org_write_guard')
  || ' policy_tables=' || (select count(distinct tablename) from pg_policies where schemaname = 'public')
  || ' orgs=' || (select count(*) from public.organizations);
\echo '== apply 355, 356, 357'
\i /tmp/m355.sql
\i /tmp/m356.sql
\i /tmp/m357.sql
select 'post-apply: table=' || (to_regclass('public.subscription_cancellations') is not null)
  || ' rls=' || (select relrowsecurity from pg_class where oid = 'public.subscription_cancellations'::regclass)
  || ' fns=' || (select count(*) from pg_proc where proname in ('claim_subscription_cancellation','confirm_subscription_cancellation','apply_stripe_subscription_state'))
  || ' client_exec=' || (select count(*) from information_schema.routine_privileges where routine_name in ('claim_subscription_cancellation','confirm_subscription_cancellation','apply_stripe_subscription_state') and grantee in ('anon','authenticated','PUBLIC'))
  || ' client_table_grants=' || (select count(*) from information_schema.role_table_grants where table_name = 'subscription_cancellations' and grantee in ('anon','authenticated'))
  || ' held_guards=' || (select count(*) from pg_trigger where tgname = 'held_org_write_guard')
  || ' policy_tables=' || (select count(distinct tablename) from pg_policies where schemaname = 'public')
  || ' orgs_unchanged=' || (select count(*) from public.organizations);
\echo '== behaviour (synthetic org, rolled back): claim → confirm revokes access exactly once'
begin;
insert into public.organizations (id, name, slug, status, stripe_customer_id, stripe_subscription_id)
  values ('00000000-0000-4000-8000-0000000f0001', 'Rehearsal billing', 'rehearsal-billing-355', 'active', 'cus_reh355', 'sub_reh355');
select 'claim1=' || (select outcome from public.claim_subscription_cancellation('00000000-0000-4000-8000-0000000f0001', 'sub_reh355', null, null, null, p_source => 'owner'))
  || ' claim2=' || (select outcome from public.claim_subscription_cancellation('00000000-0000-4000-8000-0000000f0001', 'sub_reh355', null, null, null, p_source => 'owner'));
select 'confirm1_revoked=' || (select access_revoked from public.confirm_subscription_cancellation('00000000-0000-4000-8000-0000000f0001', 'sub_reh355', 'webhook', '{}'::jsonb))
  || ' confirm2_newly=' || (select newly_confirmed from public.confirm_subscription_cancellation('00000000-0000-4000-8000-0000000f0001', 'sub_reh355', 'webhook', '{}'::jsonb));
-- separate statement: a status read inside the statement above would see its start-of-statement snapshot
select 'org_status_after=' || status || ' cancelled_at_set=' || (cancelled_at is not null)
  from public.organizations where id = '00000000-0000-4000-8000-0000000f0001';
rollback;
\echo '== rollback'
\i /tmp/rollback355.sql
select 'post-rollback: table=' || (to_regclass('public.subscription_cancellations') is not null)
  || ' fns=' || (select count(*) from pg_proc where proname in ('claim_subscription_cancellation','confirm_subscription_cancellation','apply_stripe_subscription_state'))
  || ' held_guards=' || (select count(*) from pg_trigger where tgname = 'held_org_write_guard')
  || ' policy_tables=' || (select count(distinct tablename) from pg_policies where schemaname = 'public');
\echo '== re-apply (idempotent)'
\i /tmp/m355.sql
\i /tmp/m356.sql
\i /tmp/m357.sql
\i /tmp/m355.sql
\i /tmp/m356.sql
\i /tmp/m357.sql
select 'post-reapply: table=' || (to_regclass('public.subscription_cancellations') is not null)
  || ' fns=' || (select count(*) from pg_proc where proname in ('claim_subscription_cancellation','confirm_subscription_cancellation','apply_stripe_subscription_state'));
