-- Proof for 20261363000000 (80% / 100% spend alerts) — the paths the integration
-- test cannot exercise on a SHARED database because they need platform-wide
-- spend: the CrewFlow-wide 80% mark raised by committed spend, then the 100%
-- mark by a refusal, each exactly once. ONE transaction, ROLLED BACK: safe on
-- the shared local database (it briefly holds the platform-budget lock, exactly
-- like platform-ceiling-proof.sql); never run against production.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f docs/programme/security-secrets/proofs/spend-alerts-proof.sql
\set QUIET on
begin;
insert into public.organizations (id, name, slug, status)
values ('00000000-0000-4000-8000-0000000a1e01', 'Spend alert proof', 'spend-alert-proof-a1e01', 'active');
delete from public.ai_spend_alert_marks where scope = 'platform';

-- Platform ceiling = this month's committed spend + 1,250p, so 1,000p more
-- crosses 80% whatever the shared DB already holds.
select public.ai_set_platform_ceiling(
  (select committed_pence::int + 1250 from public.ai_platform_month_usage()), null, 'spend-alert proof') \gset
\echo '1. before the spend: platform marks returned (expect 0 unless the month already sits >= 80%)'
select count(*) filter (where scope = 'platform') as platform_marks
  from public.ai_claim_spend_alerts('00000000-0000-4000-8000-0000000a1e01', 10000, null);
delete from public.ai_spend_alert_marks where scope = 'platform';

insert into public.ai_invocations (org_id, feature, task_class, provider, model, input_tokens, output_tokens, estimated_cost_pence, latency_ms, success)
values ('00000000-0000-4000-8000-0000000a1e01', 'quote.writer_draft', 'drafting', 'anthropic', 'proof', 0, 0, 1000, 1, true);

\echo '2. after 1,000p: the CrewFlow-wide 80% mark, once (no org row: 1,000p is 10% of the 10,000p org default)'
select scope, threshold, ceiling_pence from public.ai_claim_spend_alerts('00000000-0000-4000-8000-0000000a1e01', 10000, null) order by scope, threshold;
\echo '3. the same call again: nothing'
select count(*) as rows_again from public.ai_claim_spend_alerts('00000000-0000-4000-8000-0000000a1e01', 10000, null);
\echo '4. a platform_ceiling refusal: the 100% mark, once'
select scope, threshold from public.ai_claim_spend_alerts('00000000-0000-4000-8000-0000000a1e01', 10000, 'platform');
select count(*) as rows_after_second_refusal from public.ai_claim_spend_alerts('00000000-0000-4000-8000-0000000a1e01', 10000, 'platform');
\echo '5. client roles cannot call it or read the marks'
select has_function_privilege('authenticated', 'public.ai_claim_spend_alerts(uuid, integer, text)', 'execute') as authenticated_exec,
       has_function_privilege('anon', 'public.ai_claim_spend_alerts(uuid, integer, text)', 'execute') as anon_exec,
       has_table_privilege('authenticated', 'public.ai_spend_alert_marks', 'select') as authenticated_select;
rollback;
