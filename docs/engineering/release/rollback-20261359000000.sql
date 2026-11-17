-- ROLLBACK for 20261359000000_privacy_deletion_ledger (account & data deletion, part 1 of 4).
-- 359 only CREATED objects: three service_role-only tables (privacy_deletion_requests + its tombstone
-- trigger, privacy_retained_billing_records, privacy_processor_requests) and their functions. Nothing
-- pre-existing is replaced. No foreign key from any pre-existing table points at these tables.
-- ORDER: LAST of the deletion set -- after rollback-20261362/61/60 (360's guard escape reads
-- privacy_deletion_requests; 360-362 functions call _privacy_require_service_role / the ledger).
-- App: #1091 (feature flag FEATURE_ACCOUNT_DELETION, OFF) calls these -> roll the APP back first.
-- Production d24295e references none of them.
-- DESTROYS the deletion ledger, its completion tombstones and the retained billing copies: export
-- them first if any rows exist (the feature is dark, so production should hold none).
-- Then: supabase migration repair --status reverted 20261359000000 --linked
begin;
drop function if exists public.privacy_processor_census(uuid);
drop function if exists public.privacy_processor_request_resolve(uuid, text);
drop function if exists public.privacy_processor_record(uuid, jsonb);
drop function if exists public.privacy_request_complete(uuid, text[], date);
drop function if exists public.privacy_request_fail(uuid, text);
drop function if exists public.privacy_request_step_done(uuid, text, jsonb);
drop function if exists public.privacy_request_claim(uuid, integer);
drop function if exists public.privacy_request_cancel(uuid, uuid);
drop function if exists public.privacy_request_create(text, uuid, uuid, uuid, text, integer);
drop function if exists public._privacy_require_service_role(text);
drop table if exists public.privacy_processor_requests;
drop table if exists public.privacy_retained_billing_records;
drop table if exists public.privacy_deletion_requests;   -- drops its tombstone trigger + indexes
drop function if exists public.tg_privacy_deletion_requests_tombstone();
commit;
