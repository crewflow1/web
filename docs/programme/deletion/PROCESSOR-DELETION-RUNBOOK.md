# Runbook: processor deletion requests

**When to use it:** whenever `privacy_processor_requests` has **open** rows. Check at least weekly while the deletion
feature is on. Each open row has a `due_by` date 30 days after the deletion ran (`PROCESSOR_MANUAL_DEADLINE_DAYS`).

**What the rows contain:** opaque provider handles only, such as Stripe `cus_…`, Twilio `PN…` or a PostHog `org_<hash>`.
They hold no names, emails or phone numbers, so you can paste them into a provider console.

## 1. List what is open

Run this with the service role, or in the Supabase SQL editor on production as an operator. It is read-only.

```sql
select p.id, p.processor, p.held_count, p.external_refs, p.due_by,
       r.kind, r.completed_at
from public.privacy_processor_requests p
join public.privacy_deletion_requests r on r.id = p.request_id
where p.status = 'open'
order by p.due_by;
```

## 2. Act on each open row

| Processor | Action (provider console. Never call an API from a laptop with a production key) |
|---|---|
| `posthog` | PostHog → Persons → search for the distinct id in `external_refs` (`org_<hash>`) → **Delete person and events**. If nothing is found, resolve as `nothing_found`. |
| `twilio` | For each `PN…`: Phone Numbers → **Release** the number, unless the customer is porting it out. In Monitor → Logs, delete the call recordings and message logs for those numbers. For a person request (`held_count` = texts sent to them), delete those message records by SID. |
| `vapi` | Delete the assistant's phone number and the call recordings and transcripts for the listed numbers. |
| `whatsapp_meta` | WhatsApp Manager → deregister or delete the phone number id(s) in `external_refs` from the business account. Meta offers no message deletion, so record `deregistered_no_message_api`. |

Do not act on `stripe` rows. They are `retained_legal` and closed. The Stripe customer is CrewFlow's own tax record
until `retention_until`. After that date, use Stripe's data-redaction tooling. That purge is staged in
`staged-migrations/purge-expired-retained-billing.sql`.

## 3. Record the outcome

Record it as a symbolic code: lowercase letters, digits, `_`, `:`, `.` and `-` only. Never write free text and never
write a name.

```sql
select public.privacy_processor_request_resolve('<row id>', 'deleted_via_dashboard');
-- other codes: 'nothing_found', 'released_number_and_deleted_logs', 'deregistered_no_message_api',
--              'provider_ticket:<ticket-number>'
```

The function closes a row once. A second call refuses, which stops evidence being rewritten.

## 4. If a deadline will be missed

Escalate to the founder before `due_by`. The 30-day deadline sits inside the one month that UK GDPR Art. 12(3) allows.

## 5. Before activating a dark integration

Twilio, Vapi and WhatsApp are dark today. Before any of them is switched on in production, decide whether its deletion
moves from this runbook into code (an API step in `runOrgDeletion`, injected and faked in tests like Stripe). Record
that decision in DELETION-DESIGN.md §10.
