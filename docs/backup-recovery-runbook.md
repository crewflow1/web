# Backup & disaster-recovery runbook (F-3)

CrewFlow runs on a single managed Supabase Postgres (project ref
`jzntbskdqdopzwdqwvkp`, prod `crewflow.uk`). There is **no second
environment** — prod is the only database — so a clean, tested recovery
story is the difference between a bad afternoon and losing every customer's
jobs, quotes and invoices. This runbook covers what protection exists today,
what to turn on before scaling to 200 paying companies, and the exact restore
procedure.

> **Scope / authority.** Enabling the PITR add-on and restoring a project are
> **paid, account-Owner actions in the Supabase dashboard**. They are out of
> scope for autonomous execution and are documented here for a human operator
> with Owner + billing access to perform.

> **Currency note (2026-08-29):** the snapshot section immediately below is the
> original **2026-06 snapshot (STALE)** — its figures (25 MB, 98 tables,
> `max_connections=60`) no longer describe production. For today's posture see
> **[Current state 2026-08-29](#current-state-2026-08-29)** at the bottom of
> this file. The restore *procedure* (Steps 1–3) remains correct.

## What's verified in production — 2026-06 snapshot (STALE)

Read-only checks against prod (`pg_stat_archiver`, `pg_settings`) as of 2026-06:

| Signal | Value | Meaning |
|---|---|---|
| `archive_mode` | `on` | WAL archiving is active — the substrate for backups & PITR. |
| `wal_level` | `logical` | Full WAL detail is being written. |
| `pg_stat_archiver.archived_count` | 3805, **0 failed**, last archived minutes ago | Archiving is healthy and current. |
| `max_connections` | 60 | Smallest compute tier (Nano/Micro). |
| `pg_database_size` | ~25 MB, 98 user tables | Pre-launch data volume. |

**What this means:** the platform is continuously shipping WAL, so the raw
material for point-in-time recovery exists. **What SQL cannot tell us:**
whether the paid **PITR add-on** (which sets the recovery-window retention and
exposes the restore-to-timestamp UI) is actually purchased. The `max_connections=60`
compute tier strongly suggests the project is **not** yet on a plan + add-on
that includes PITR. **This must be confirmed in the dashboard** (see below) —
do not assume PITR is available just because WAL archiving is on.

## Recovery objectives (target before launch)

| Metric | Daily backups only | With PITR add-on |
|---|---|---|
| **RPO** (max data loss) | up to ~24h (last nightly) | ≤ 2 minutes |
| **RTO** (time to restore) | minutes–hours (size dependent) | minutes–hours |
| Granularity | one snapshot/day | any second within the retention window |

At 200 paying companies, a 24h RPO means a bad day could erase a full day of
every customer's jobs/quotes/invoices with no way back. **PITR is the
launch-blocking requirement here.**

## Step 1 — Confirm current backup posture (dashboard, ~2 min)

1. Supabase dashboard → project `jzntbskdqdopzwdqwvkp`.
2. **Database → Backups**. Note whether you see:
   - only a list of **daily** backups (→ daily-only, no PITR), or
   - a **"Restore to a point in time"** / **Physical backups** panel with a
     time slider (→ PITR add-on active).
3. **Settings → Add-ons** (or **Settings → Billing**): check for a
   **Point-in-Time Recovery** add-on line item and its retention (7 / 14 / 28 days).

Record the finding. If PITR is absent, proceed to Step 2.

## Step 2 — Enable PITR (paid; Owner + billing required)

> This is the action that requires more than dashboard access — it needs
> **account Owner / billing permission** and incurs cost.

PITR requires the project to be on **Pro plan or higher** and then the
**PITR add-on** enabled on top:

1. **Settings → Billing** → ensure the org is on **Pro** (or Team/Enterprise).
   PITR is not available on Free.
2. **Settings → Add-ons → Point-in-Time Recovery** → enable. Choose a
   retention window (start at **7 days**; raise to 14/28 if audit policy
   requires). Enabling PITR may also bump the compute add-on — expect a
   monthly cost increase.
3. Wait for the first physical backup to complete (dashboard shows status).
   Until it finishes, only daily logical backups exist.

What's needed beyond plain dashboard access: **Owner/billing role** to add a
paid add-on, and acceptance of the recurring cost. An engineer with only
project (developer) access cannot enable it.

## Step 3 — Restore procedure (rehearse before you need it)

**Supabase restore is in-place and destructive to current state** — it rolls
the project back to the chosen timestamp. There is no "restore into a copy"
within a single project, so treat any real restore as an incident with
comms. Practise it on a throwaway project first.

1. Dashboard → **Database → Backups → Restore**.
2. **PITR:** pick the exact timestamp (UTC) just before the bad event. The
   slider is bounded by the retention window. **Daily-only:** pick the nightly
   snapshot.
3. Confirm. The project goes read-only/unavailable during restore (minutes to
   hours depending on size; trivial at today's 25 MB, longer at scale).
4. Post-restore verification (run read-only):
   - `select max(created_at) from public.activity_log;` — newest row ≈ target time.
   - Spot-check row counts on `jobs`, `quotes`, `invoices`, `finances`,
     `customers`, `memberships`.
   - Confirm auth still works (a test login) and RLS is intact.
5. Comms: notify affected orgs of the recovery point; anything written between
   the restore target and the incident is gone.

## Step 4 — Pre-launch DR checklist

- [ ] PITR add-on enabled, retention ≥ 7 days (Step 2). **Launch blocker.**
- [ ] One **rehearsed** restore on a scratch project, RTO measured and recorded.
- [ ] `pg_stat_archiver.failed_count` alerting — a rising value means WAL
      archiving is broken and backups are silently degrading. Add to the
      `/admin/ops` health surface or external monitoring.
- [ ] A periodic **logical export** (`pg_dump` / `supabase db dump`) stored
      off-Supabase (e.g. object storage) as defence against project-level loss
      (account compromise, accidental project deletion) that PITR can't cover.
- [ ] Documented owner + escalation path for invoking a restore.

## Notes

- Restores are **in-place and irreversible** — never trigger one to "take a
  look." Use a scratch project for drills.
- PITR protects against data corruption *within* the project. It does **not**
  protect against losing the whole project/account — keep an independent
  logical dump for that tier of failure.
- This runbook is documentation only; it executes nothing and changes no
  setting.

## Current state 2026-08-29

Verified posture at the Customer-#1 reconciliation (supersedes the 2026-06
snapshot above; the restore procedure in Steps 1–3 is unchanged):

| Signal | Value (2026-08-29) |
|---|---|
| WAL archiving | **Healthy** — archiving current, 0 failures |
| PITR add-on | **OFF** (verified via management API; WAL-G on) — enabling it is a billing decision, **CEO action**, and remains the single biggest recovery upgrade (RPO 24 h → ~2 min) |
| Compute tier | **Medium** (the 2026-06 `max_connections=60` Nano/Micro inference is obsolete) |
| Off-platform copy | Dated off-platform dump route established (pending `SUPABASE_DB_PASSWORD` in the founder's password manager — verified blocked without it) |
| Restore rehearsal | **Rehearsed and measured** — full replay of all 380 migrations onto a clean database in ~26 s restoring 307 RLS-enabled tables / 605 policies / 461 triggers, app verified live post-restore. Full drill record + incident procedure: [`docs/customer-success/FIRST-CUSTOMER-SUPPORT.md`](./customer-success/FIRST-CUSTOMER-SUPPORT.md) § "Database incident — evidence-backed drill record (2026-08-29)" |
| Migration tip | `20261220000000` (380/380 repo↔DB parity) |

Honest recovery numbers today: schema-restore RTO ≈ 30 s · app redeploy RTO
≈ 5 min · data RPO ≤ 24 h on daily backups (PITR OFF). The open CEO actions
(PITR enable, DB password custody, dated dump) are tracked in the support
runbook's checklist — not here.
