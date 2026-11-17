-- ROLLBACK for 20261363000000_ai_spend_threshold_alerts (AI spend governance, 80%/100% alerts).
-- 363 only CREATED the ai_spend_alert_marks table (+ two unique indexes) and ai_claim_spend_alerts;
-- nothing pre-existing is replaced.
-- ORDER: before rollback-20261358000000.sql (ai_claim_spend_alerts reads 358's ai_platform_budget).
-- App: the AI PR calls ai_claim_spend_alerts -> roll the APP back first. Production d24295e does not.
-- Losing the marks only means an 80%/100% alert may be sent again this month.
-- Then: supabase migration repair --status reverted 20261363000000 --linked
begin;
drop function if exists public.ai_claim_spend_alerts(uuid, integer, text);
drop table if exists public.ai_spend_alert_marks;
commit;
