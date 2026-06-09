# activity_log retention runbook (F-8)

`public.activity_log` is the append-only audit/activity feed. Every business
mutation (jobs, quotes, invoices, finances, leads, customers) appends a row
via the `SECURITY DEFINER` `_tg_*_activity` triggers, plus a few admin/cron
writes. **Nothing prunes it.** At ~200 active orgs each doing dozens of
mutations a day it accrues millions of rows a year, steadily inflating
storage, backup/PITR size, autovacuum cost and index depth.

Migration `20260710000000_activity_log_retention.sql` adds the **mechanism**
to trim the feed. It does **not** delete anything on apply — see *Safety*.

## TL;DR

```sql
-- One-off trim from the SQL editor (service role), 24-month window:
select public.purge_activity_log(interval '24 months');
```

Returns the number of rows removed. Run it again any time; it is safe to
repeat and safe to interrupt.

## What the migration adds

| Object | Purpose |
|---|---|
| `activity_log_created_at_idx` on `(created_at)` | Lets the cross-org `where created_at < cutoff` purge do an index range scan. The existing indexes are all `(org_id, created_at …)` — org-leading — so a global age sweep can't use them. Cheap on write (append-mostly, `created_at ≈ now()`). |
| `purge_activity_log(p_retention interval, p_batch integer)` | Batched delete of rows older than `now() - p_retention`. Returns rows removed. `SECURITY DEFINER`, `search_path = public`. |
| `revoke execute … from public, anon, authenticated` | A tenant must never be able to erase audit history. Only the `postgres` owner, `service_role`, and pg_cron (superuser/owner) keep `EXECUTE`. |

### Function signature & defaults

```sql
public.purge_activity_log(
  p_retention interval default interval '24 months',
  p_batch     integer  default 5000
) returns integer
```

- **`p_retention`** — keep everything newer than `now() - p_retention`; delete
  the rest. Must be a non-negative interval. Default **24 months**.
- **`p_batch`** — rows deleted per pass (loops until a pass deletes nothing) so
  a single statement never builds an unbounded delete set and locks are short.
  Must be a positive integer. Default **5000**.

Invalid arguments raise `22023` (invalid parameter value) rather than doing
anything surprising.

## Choosing a retention window

This trims the activity **FEED** only. The financial **RECORDS** that
statutory (e.g. HMRC) retention applies to — invoices, finances, quotes,
payments — live in their **own tables and are NOT touched here**. So the
window is an audit/observability policy decision, not a tax one.

- The default **24 months** is deliberately generous and a safe starting point.
- Pick a shorter window only if you have an explicit audit policy that allows
  it. Trimming is irreversible (rows are deleted, not archived) — if you need
  long-term audit history, export before purging or keep the window long.

## How to run it

Pick **one**. All are operator-initiated; none is enabled by applying the
migration.

### (a) Manual, one-off (SQL editor, service role)

```sql
select public.purge_activity_log(interval '24 months');
```

Good for the first trim and for ad-hoc cleanups. Watch the returned count.

### (b) Scheduled via pg_cron (if the extension is enabled)

```sql
-- 03:30 on the 1st of each month, 24-month window:
select cron.schedule(
  'purge-activity-log',
  '30 3 1 * *',
  $cron$ select public.purge_activity_log(interval '24 months') $cron$
);
```

pg_cron runs as a superuser/owner, so it keeps `EXECUTE` despite the revoke.
To inspect or remove the schedule later:

```sql
select jobid, schedule, command from cron.job where jobname = 'purge-activity-log';
select cron.unschedule('purge-activity-log');
```

### (c) External scheduler

Any service-role connection (a Supabase Edge Function on a schedule, an
external worker, etc.) can call the function the same way as (a).

## Safety

- **Applying the migration deletes nothing.** It only creates an index, defines
  a function, and revokes a grant. The `DELETE` lives *inside* the function
  body and runs only when the function is explicitly called. The pg_cron and
  manual examples in the migration are **commented out** — documentation, not
  executable SQL. This is pinned by `__tests__/ops/activity-log-retention.test.ts`,
  which asserts the executable SQL contains no `cron.schedule` and no
  top-level `select public.purge_activity_log(...)`.
- **Batched & resumable.** Each pass deletes ≤ `p_batch` of the oldest
  past-cutoff rows and stops when a pass deletes nothing. Interrupting it just
  stops early; rerun to continue.
- **Locked to the service role.** `anon`/`authenticated` (i.e. tenants) cannot
  execute it, so a customer can never erase audit history.
- **No cascade surprises.** Nothing has a foreign key referencing
  `activity_log.id`, so deletes don't ripple into other tables.

## Verifying before/after

```sql
-- How much is past a candidate cutoff (does NOT delete):
select count(*) as purgeable
from public.activity_log
where created_at < now() - interval '24 months';

-- Oldest/newest retained after a run:
select min(created_at), max(created_at) from public.activity_log;
```
