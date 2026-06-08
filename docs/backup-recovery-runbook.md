# CrewFlow — Backup & Recovery Runbook

_Supabase project ref: `jzntbskdqdopzwdqwvkp` · region: West EU (Ireland) · single production project, no staging._

This runbook documents what backup coverage exists today, the resulting
RPO/RTO, the exact restore procedure, and how to verify backups. It was
produced as part of launch hardening.

---

## 1. Current backup status (VERIFIED 2026-06-08)

Verified with the Supabase CLI against the linked project:

```
$ supabase backups list
 REGION            | WALG | PITR  | EARLIEST TIMESTAMP | LATEST TIMESTAMP
 ------------------|------|-------|--------------------|------------------
 West EU (Ireland) | true | false | 0                  | 0
```

| Capability | Status | Meaning |
|---|---|---|
| Daily physical backups (WAL-G) | **ENABLED** | A full physical backup is taken on Supabase's daily schedule. |
| Point-in-Time Recovery (PITR) | **NOT ENABLED** | No continuous WAL archiving; the `0` timestamps confirm there is no PITR window. |
| Database branching | **NOT ENABLED** | `supabase branches list` returns no branches; no isolated clone is available via CLI. |

> **Action item (billing/dashboard, not code):** Enable PITR for this project.
> It is a paid Supabase add-on and can only be turned on from the dashboard
> (Project → Database → Backups → enable PITR) or via the Management API with an
> account that has billing rights. This cannot be done from read-only DB tooling.

---

## 2. RPO / RTO

| Metric | Today (daily backup only) | After enabling PITR (recommended) |
|---|---|---|
| **RPO** (max data loss) | **Up to ~24 h** — worst case is a failure immediately before the next daily snapshot. | **~2 min** (Supabase PITR WAL granularity). |
| **RTO** (time to restore) | Realistic end-to-end **~1–2 h**: detect → decide → trigger restore → verify → re-point. The restore mechanic itself is minutes on a DB this small. | Similar; PITR restore lets you pick an exact timestamp just before the incident. |

For a financial product (invoices, payments, quotes), a 24 h RPO is the single
biggest gap. Enabling PITR closes it to minutes.

---

## 3. Restore procedure

> ⚠️ A daily-backup restore is a **destructive, full-project** operation — it
> overwrites current state. It is **not** something to run casually and must
> never be run autonomously. It requires dashboard/owner access.

### 3a. Restore from the latest daily backup (available today)

1. **Stop writes** if feasible: put the app into maintenance (or accept that
   writes after the chosen backup point will be lost).
2. Supabase Dashboard → **Project → Database → Backups**.
3. Pick the most recent daily backup and click **Restore**. Confirm the
   project ref is `jzntbskdqdopzwdqwvkp`.
4. Wait for the restore to complete (minutes for the current DB size).
5. Run the verification queries in §4 against the restored DB.
6. Redeploy / confirm the app (`crewflow.uk`) connects and core flows work
   (login, dashboard, create invoice, record payment).

### 3b. Restore to a point in time (only after PITR is enabled)

```
# Lists the available PITR window first:
supabase backups list
# Restores the linked project to a timestamp inside that window:
supabase backups restore --help    # confirm exact flag, then run with the target ts
```

Same verification (§4) and redeploy steps follow.

### 3c. Test restore to an isolated environment (recommended rehearsal)

A safe rehearsal that does **not** touch production requires one of:

- **Enable database branching** (`supabase branches create <name>`), which
  provisions an isolated Postgres with the schema (and optionally data), or
- Restore a `supabase db dump` into a throwaway project / local Postgres:

```
supabase db dump --linked -f /tmp/cf-prod-dump.sql      # schema + data dump
# then load into a scratch DB and run the §4 checks there
```

> **Status of the launch-hardening test restore:** A true point-in-time test
> restore could **not** be executed from available tooling because PITR is off
> and no branch/clone environment exists; the only restore path today (3a) is a
> destructive full-project operation on the single prod project, which is out of
> bounds for an autonomous action. The procedure above is the rehearsal to run
> by hand once PITR and/or branching is enabled. A logical `supabase db dump`
> into a scratch DB is the lowest-risk way to rehearse before launch.

---

## 4. Post-restore verification queries

Run these against the restored database; all should return sane, non-zero
counts and the lifecycle should reconcile:

```sql
-- Core tables populated
select 'orgs' t, count(*) from public.organizations
union all select 'customers', count(*) from public.customers
union all select 'quotes', count(*) from public.quotes
union all select 'invoices', count(*) from public.invoices
union all select 'payments', count(*) from public.invoice_payments;

-- Money reconciles: paid invoices should have payments summing to >= total
select i.id, i.total, coalesce(sum(p.amount),0) paid, i.status
from public.invoices i
left join public.invoice_payments p on p.invoice_id = i.id
group by i.id
having i.status = 'paid' and coalesce(sum(p.amount),0) < i.total;
-- ^ expect ZERO rows

-- RLS helpers still present (multi-tenant isolation intact)
select proname from pg_proc where proname in ('current_org_ids','is_org_admin');
-- ^ expect both rows

-- Payment-sync trigger present
select tgname from pg_trigger where tgname like '%invoice_payments%';
```

`scripts/e2e-lifecycle.sql` (full lifecycle, self-cleaning) can also be run as a
heavier smoke test after a restore.

---

## 5. Where backups are verified

- **Existence/cadence:** `supabase backups list` (shown in §1) — run weekly; the
  daily-backup row must show `WALG: true`. Once PITR is enabled, confirm the
  EARLIEST/LATEST window is non-zero and advancing.
- **Restorability:** the §3c rehearsal — the only way to *prove* a backup
  restores is to restore it. Rehearse before launch and after any major schema
  change.
- **Dashboard:** Project → Database → Backups shows the daily backup list and
  (once enabled) the PITR window.

---

## 6. Summary

- ✅ Daily physical backups are on.
- ❌ PITR is **off** → RPO is up to 24 h. **Enable PITR** to reach ~2 min RPO
  (paid dashboard action — cannot be done from code/CLI without billing rights).
- ❌ No rehearsed restore yet → run the §3c dump-to-scratch rehearsal before
  onboarding paying customers.
