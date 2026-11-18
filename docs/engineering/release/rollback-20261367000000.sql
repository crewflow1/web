-- ROLLBACK for 20261367000000_activity_log_org_feed_idx (perf/free-optimisation).
-- Drops the additive per-org activity-feed index. No data, policy, grant or function is affected;
-- queries return identical results with or without it (the planner falls back to the pre-367 plans).
-- App: no code depends on the index to function -> DB rollback can go first, in any order.
-- Then: supabase migration repair --status reverted 20261367000000 --linked
begin;
drop index if exists public.activity_log_org_created_id_idx;
commit;
