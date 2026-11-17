-- ROLLBACK for 20261360000000_privacy_org_teardown (company deletion, part 2 of 4).
-- Restores the EXACT pre-360 definitions of the 19 append-only guard functions 360 replaced -- each copied
-- VERBATIM by a generator from the migration that last defined it (cited per statement; no later migration
-- redefines or ALTERs any of them) -- and drops the two functions 360 created. CREATE OR REPLACE keeps the
-- guards' grants and triggers (360 changed neither). Like 360 itself, a guard is touched only if it exists.
-- ORDER: after rollback-20261362000000.sql and rollback-20261361000000.sql, before rollback-20261359000000.sql.
-- App: no production (d24295e) code calls anything here; #1091 calls privacy_org_* -> roll the app back first.
-- Then: supabase migration repair --status reverted 20261360000000 --linked
begin;

-- ai_reply_audits_block_mutation: supabase/migrations/20260815000000_ai_reply_audits.sql:107
do $rb$ begin if to_regprocedure('public.ai_reply_audits_block_mutation()') is not null then execute $def$
create or replace function public.ai_reply_audits_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_reply_audits is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- ai_reply_delivery_receipts_block_mutation: supabase/migrations/20260817000000_ai_reply_delivery_receipts.sql:235
do $rb$ begin if to_regprocedure('public.ai_reply_delivery_receipts_block_mutation()') is not null then execute $def$
create or replace function public.ai_reply_delivery_receipts_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_reply_delivery_receipts is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- ai_reply_transports_block_mutation: supabase/migrations/20260816000000_ai_reply_transports.sql:233
do $rb$ begin if to_regprocedure('public.ai_reply_transports_block_mutation()') is not null then execute $def$
create or replace function public.ai_reply_transports_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_reply_transports is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_actions_block_mutation: supabase/migrations/20260827000000_receptionist_conversation_actions.sql:101
do $rb$ begin if to_regprocedure('public.receptionist_conversation_actions_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_actions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_actions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_authorisations_block_mutation: supabase/migrations/20260829000000_receptionist_conversation_authorisations.sql:157
do $rb$ begin if to_regprocedure('public.receptionist_conversation_authorisations_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_authorisations_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_authorisations is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_claim_reassignments_block_mutation: supabase/migrations/20260909000000_receptionist_conversation_claim_reassignments.sql:181
do $rb$ begin if to_regprocedure('public.receptionist_conversation_claim_reassignments_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_claim_reassignments_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_claim_reassignments is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_claim_releases_block_mutation: supabase/migrations/20260908000000_receptionist_conversation_claim_releases.sql:148
do $rb$ begin if to_regprocedure('public.receptionist_conversation_claim_releases_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_claim_releases_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_claim_releases is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_claims_block_mutation: supabase/migrations/20260907000000_receptionist_conversation_claims.sql:135
do $rb$ begin if to_regprocedure('public.receptionist_conversation_claims_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_claims_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_claims is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_coordinations_block_mutation: supabase/migrations/20260905000000_receptionist_conversation_coordinations.sql:357
do $rb$ begin if to_regprocedure('public.receptionist_conversation_coordinations_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_coordinations_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_coordinations is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_executions_block_mutation: supabase/migrations/20260828000000_receptionist_conversation_executions.sql:136
do $rb$ begin if to_regprocedure('public.receptionist_conversation_executions_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_executions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_executions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_fulfilments_block_mutation: supabase/migrations/20260830000000_receptionist_conversation_fulfilments.sql:157
do $rb$ begin if to_regprocedure('public.receptionist_conversation_fulfilments_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_fulfilments_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_fulfilments is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_lifecycles_block_mutation: supabase/migrations/20260903000000_receptionist_conversation_lifecycles.sql:314
do $rb$ begin if to_regprocedure('public.receptionist_conversation_lifecycles_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_lifecycles_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_lifecycles is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_orchestrations_block_mutation: supabase/migrations/20260904000000_receptionist_conversation_orchestrations.sql:330
do $rb$ begin if to_regprocedure('public.receptionist_conversation_orchestrations_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_orchestrations_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_orchestrations is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_outcomes_block_mutation: supabase/migrations/20260826000000_receptionist_conversation_outcomes.sql:95
do $rb$ begin if to_regprocedure('public.receptionist_conversation_outcomes_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_outcomes_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_outcomes is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_recoveries_block_mutation: supabase/migrations/20260901000000_receptionist_conversation_recoveries.sql:265
do $rb$ begin if to_regprocedure('public.receptionist_conversation_recoveries_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_recoveries_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_recoveries is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_resolutions_block_mutation: supabase/migrations/20260902000000_receptionist_conversation_resolutions.sql:285
do $rb$ begin if to_regprocedure('public.receptionist_conversation_resolutions_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_resolutions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_resolutions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_conversation_verifications_block_mutation: supabase/migrations/20260831000000_receptionist_conversation_verifications.sql:211
do $rb$ begin if to_regprocedure('public.receptionist_conversation_verifications_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_conversation_verifications_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_verifications is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- receptionist_review_resolutions_block_mutation: supabase/migrations/20260821000000_receptionist_human_review_inbox.sql:232
do $rb$ begin if to_regprocedure('public.receptionist_review_resolutions_block_mutation()') is not null then execute $def$
create or replace function public.receptionist_review_resolutions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_review_resolutions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$
$def$; end if; end $rb$;

-- tg_comm_events_frozen: supabase/migrations/20261165000000_comms_audit.sql:146
create or replace function public.tg_comm_events_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'comm_events is append-only — % is not permitted', tg_op
    using errcode = 'check_violation';
end $$;

drop function if exists public.privacy_org_teardown(uuid, date);
drop function if exists public.privacy_org_lockout(uuid);
commit;
