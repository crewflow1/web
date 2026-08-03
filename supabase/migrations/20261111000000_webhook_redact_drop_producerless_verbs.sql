-- Outbound webhooks — drop the two producer-less verbs from the fan-out
-- redaction allowlist (C26 catalogue-drift correction).
--
-- Background. The exposable-webhook catalogue (lib/webhooks/events.ts) used to
-- advertise 8 subscribable verbs, but the spine producer (hq_emit_from_activity,
-- 20260720010000) only ever emits 6: customer.created, customer.updated,
-- job.created, job.completed, quote.sent, quote.accepted. `job.scheduled` and
-- `job.cancelled` have NO producer — jobs.status is new|in-progress|completed|
-- blocked (there is no cancel), scheduling is a scheduled_date change surfaced as
-- the un-exposed `job.rescheduled` activity, and a delete is a hard delete
-- (`job.deleted`, deliberately kept off the spine). A subscriber to either verb
-- would receive silence forever, so they have been removed from the TS catalogue.
--
-- This migration re-mirrors that removal in the SQL layer: webhook_redact_data is
-- a hand-mirror of WEBHOOK_REDACTION_MAP and the security test pins the two at
-- EXACT key-set equality, so the SQL CASE must lose the same two branches. Dropping
-- the two dead cases is purely additive to safety — the function fail-closes on any
-- verb absent from the CASE (returns an empty jsonb), and no fan-out ever produces
-- these verbs anyway, so this is a no-op at runtime and only removes dead vocabulary.
--
-- No producer is changed (the mapper already emitted the correct 6); no table,
-- policy, grant, or fan-out path is touched. Feature stays DARK
-- (NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS off). Source of truth: 20261087000000.

create or replace function public.webhook_redact_data(p_verb text, p_data jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_object_agg(key, value)
       from jsonb_each(coalesce(p_data, '{}'::jsonb))
      where key = any (
        case p_verb
          when 'job.created'      then array['status']
          when 'job.completed'    then array['from', 'to']
          when 'customer.created' then array[]::text[]
          when 'customer.updated' then array['fields']
          when 'quote.sent'       then array['number', 'total']
          when 'quote.accepted'   then array['number', 'total', 'source']
          else array[]::text[]
        end
      )),
    '{}'::jsonb
  );
$$;

revoke all on function public.webhook_redact_data(text, jsonb) from public, anon, authenticated;
grant execute on function public.webhook_redact_data(text, jsonb) to service_role;
