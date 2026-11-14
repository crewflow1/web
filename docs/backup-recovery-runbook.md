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

> **Currency note (2026-11-14):** the authoritative description of today's
> backup model, restore procedures, key-loss scenario and restore drill is
> **[Current model — 2026-11-14](#current-model--2026-11-14-read-this-first-it-supersedes-every-dated-section-below)**.
> Everything from "What's verified in production — 2026-06 snapshot" downward is
> dated history kept for context.
>
> **Currency note (2026-08-29):** the snapshot section immediately below is the
> original **2026-06 snapshot (STALE)** — its figures (25 MB, 98 tables,
> `max_connections=60`) no longer describe production. For today's posture see
> **[Current state 2026-08-29](#current-state-2026-08-29)** at the bottom of
> this file. The restore *procedure* (Steps 1–3) remains correct.

## Current model — 2026-11-14 (read this first; it supersedes every dated section below)

Evidence labels: **VERIFIED** = run and observed (where, is stated) · **IMPLEMENTED-UNTESTED** ·
**NEEDS-FOUNDER** · **NOT-IMPLEMENTED**. Audit and design:
`docs/programme/backup/BACKUP-AUDIT.md`, `INDEPENDENT-RUNNER-DESIGN.md`, `FOUNDER-CHECKLIST.md`,
`E2E-EVIDENCE.md`.

### The layers

| | Layer 1 — Supabase managed | Layer 2 — founder Mac | Layer 3 — independent runner |
|---|---|---|---|
| What | Daily physical database backup, 7 days | `scripts/ops/off-platform-backup.sh`, launchd **daily 03:17** | `.github/workflows/offsite-backup.yml` → `scripts/ops/offsite-backup.sh`, **daily 02:23 UTC** |
| Database | Yes | Yes | Yes (one consistent snapshot) |
| Storage objects | **No** | Yes | Yes |
| Survives loss of the Supabase account | No | Yes (Backblaze B2) | Yes (separate B2 bucket, Object Lock) |
| Depends on | Supabase | The Mac being awake; a key file on the Mac | GitHub Actions; nothing on the Mac |
| Who can decrypt | n/a | Whoever holds the Mac's key file | Only the holder of the **offline** `age` private key — not the runner |
| Retention | 7 days | Last 8 artefacts (count) | daily 14 d · weekly 8 wk · monthly 12 mo (bucket lifecycle) |
| Restore proven | Not on this project | Decrypt + checksum per run; manual restores 2026-08-29 / 2026-10-20 | Restored into a throwaway Postgres on **every run** |
| Status | Live | Live | **Built, inert** until the founder completes `FOUNDER-CHECKLIST.md` |

PITR remains **off** (cost decision). Nothing here changes that.

### Recovery objectives (honest numbers)

| Scenario | Use | RPO (data lost) | RTO (time to recover) |
|---|---|---|---|
| Bad write / bad migration, noticed ≤ 7 days | Layer 1, in-place dashboard restore | ≤ 24 h | Minutes–hours. **Not measured on production** (a restore is destructive) |
| Same, noticed later | Layer 3 weekly/monthly artefact | Up to the age of the chosen artefact | As the row below |
| Supabase project/account lost | Layer 3 (or Layer 2) onto a new project | ≤ 24 h once Layer 3 is active; today up to the last time the Mac ran (gaps of 12 days observed) | Estimated 1–3 h, dominated by creating the project and re-pointing the app. **Not measured.** The database restore step itself took 3–6 s for a 53 MB synthetic database (VERIFIED locally); production is ~535 MB |
| Storage objects lost | Layer 3 (or Layer 2) | as above | Minutes at today's 7 objects |

### Restore — database, from a Layer 3 artefact

You need: the offline `age` private key; a Backblaze key that can **read** (create a temporary
read-only application key in the B2 console for the occasion and delete it afterwards — no automated
credential can read backups); Docker; `age`; `rclone`.

1. **Download** one artefact and its sidecar from the same tier:
   `daily/crewflow-offsite-<stamp>.tar.age` and `…tar.age.json`.
   Prefer one whose `…verify.json` says `"restore_verify":"passed"`.
2. **Prove it restores before relying on it** (throwaway container, no network, prints counts and
   PASS/FAIL only):
   `bash scripts/ops/restore-verify.sh --artefact <file>.tar.age --identity <private-key-file> --sidecar <file>.tar.age.json`
   Exit 0 = every check passed. Any `FAIL` = do not use this artefact; take the previous one.
   **VERIFIED on synthetic local data** (good artefact passes; truncated, bit-flipped, wrong-key,
   truncated-dump, missing-rows and orphaned-key cases all fail). **Never run against production data
   without the approval gate below.**
3. **Decrypt and unpack** onto an encrypted disk:
   `age -d -i <private-key-file> <file>.tar.age | tar -xf -` → `crewflow-offsite-<stamp>/` containing
   `db/db.dump` (pg_dump custom format), `storage/<bucket>/…`, `MANIFEST.json`, `SHA256SUMS`.
4. **Restore into a new Supabase project** (same region, Postgres 17).
   **IMPLEMENTED-UNTESTED against a real Supabase project** — the first drill onto a scratch project is
   its acceptance test. The platform already owns the `auth` and `storage` table definitions, so restore
   their **data** only, and everything for the application schemas:
   ```
   # a. enable the extensions named in MANIFEST.json → facts.extensions (citext, pg_trgm, vector, …)
   # b. application schemas: definitions first
   pg_restore -d "$NEW_DB_URL" --section=pre-data -n public -n _backup -n supabase_migrations db/db.dump
   # c. all data, with triggers/FK checks deferred for the load
   pg_restore -l db/db.dump | grep 'TABLE DATA' \
     | grep -v -E ' (auth schema_migrations|storage migrations) ' > data.list
   PGOPTIONS='-c session_replication_role=replica' pg_restore -d "$NEW_DB_URL" --data-only -L data.list db/db.dump
   # d. indexes, constraints, triggers, policies, grants
   pg_restore -d "$NEW_DB_URL" --section=post-data -n public -n _backup -n supabase_migrations db/db.dump
   ```
   The dump **keeps ownership and grants**, so the Data-API grants come back with it (VERIFIED: the
   `data_api_grants` and `column_acl_entries` counters are identical after a restore). The manual
   re-grant block further down this file applies only to Layer 2 artefacts rebuilt from migrations.
5. **Check the result** with the same facts the verification uses: migration tip and count equal
   `MANIFEST.json`; a login works; a spot read returns rows.
6. **Re-apply deletion tombstones** (next section) **before** reopening the application.
7. Re-point the application (Vercel env) at the new project; tell affected customers the recovery point.

For an in-place rollback of the existing project use Layer 1 (Step 3 below) — and still do step 6.

### Restore — Storage objects

From the unpacked bundle, one bucket at a time, to the target project's S3 endpoint:
`rclone copy crewflow-offsite-<stamp>/storage/<bucket> <target-remote>:<bucket>` then
`rclone check crewflow-offsite-<stamp>/storage/<bucket> <target-remote>:<bucket>`.
**VERIFIED on synthetic local data** (restored bucket identical to source). The `storage.objects` rows
arrive with the database restore; object keys are unchanged, so rows and files line up
(the verification asserts exactly that pairing).

### Re-apply deletion tombstones after ANY restore — HOOK (deletion workstream)

A backup taken before a company or person was deleted still contains them. Restoring it — from any
layer, including a Supabase in-place restore — would bring erased data back. So:

- Each Layer 3 run exports the cumulative list of completed deletions to its own object,
  `tombstones/crewflow-tombstones-<stamp>.jsonl.age` — **beside, never inside, the dump** — one JSON
  object per line (opaque ids, kind, timestamps). The export hook is optional by construction: it is
  active only where `public.privacy_tombstone_export(timestamptz)` exists and the backup role may
  execute it; otherwise the run logs that the hook is inactive and carries on.
  Capture of the export: **VERIFIED on synthetic local data** (function present locally).
- **After every restore, before reopening:** take the **newest** tombstone object in the bucket (not
  the one next to the dump you restored — the newest lists every deletion to date), decrypt it, and
  feed each line to `public.privacy_tombstone_reapply(jsonb)` as the service role, then let the normal
  deletion executor run:
  ```
  age -d -i <private-key-file> crewflow-tombstones-<newest>.jsonl.age > tombstones.jsonl
  psql "$RESTORED_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
  set request.jwt.claims = '{"role":"service_role"}';
  create temp table _t (j jsonb);
  \copy _t from 'tombstones.jsonl'
  select public.privacy_tombstone_reapply(j) from _t;
  SQL
  ```
  This step is **documentation of that workstream's contract** (their functions and tests live on
  branch `privacy/account-deletion`); it has **not** been executed by the backup workstream. If those
  functions are not yet in production there are no tombstones and the step is a no-op.
- Deletions completed after the newest tombstone export and before the incident are not in any export:
  compare against the deletion request log/emails for that window.

### If the decryption key is lost

| Lost | Consequence | What still works |
|---|---|---|
| The Mac (Layer 2 key file on it), no off-machine copy | Every Layer 2 artefact in B2 is permanently unreadable | Layer 1 (database, 7 days); Layer 3 once active |
| The founder's `age` private key | Use the **escrow** key — every artefact is sealed to both | Everything |
| Both `age` private keys | Every Layer 3 artefact is permanently unreadable. Nobody — not Backblaze, not GitHub, not Anthropic, not Supabase — can recover them | Layer 1; Layer 2 if its key survives. Generate a new keypair immediately and replace `OFFSITE_BACKUP_AGE_RECIPIENTS`; history restarts from that day |
| The Supabase account **and** every key | Total loss | Nothing. This is why there are two recipients and a paper copy |

Check you still hold a working key at any time, without opening customer data: decrypt the latest
`…keycheck.age` and compare its SHA-256 with `keycheck_plaintext_sha256` in the sidecar
(`FOUNDER-CHECKLIST.md` §7).

### Production restore drill — APPROVAL GATE

**Status: not performed.** The pipeline is VERIFIED on synthetic local data only. A drill decrypts real
customer data, so it is a founder-approved, founder-present step — never run by an agent on its own.

Before starting, the founder records (date, name) in `docs/programme/backup/` that they approve this
drill, and confirms:

- [ ] FileVault is **on** for the machine used (`fdesetup status`).
- [ ] The private key is typed/loaded from the password manager into a file under a `chmod 700`
      directory and deleted afterwards.
- [ ] Nobody else is using the machine; screen sharing/recording is off.

Procedure (about 15 minutes, quarterly):

1. In the B2 console create a **temporary read-only** application key for the off-site bucket.
2. Download the newest `daily/…tar.age` and its `.tar.age.json` into a private directory.
3. `bash scripts/ops/restore-verify.sh --artefact … --identity … --sidecar … --redact`
   It restores into a container with no network, prints PASS/FAIL (counts withheld with `--redact`),
   and removes the container and every plaintext file on exit.
4. Record in `docs/programme/backup/` : date, artefact stamp, exit code, the `pg_restore … Ns` line
   (that is the measured database RTO), nothing else.
5. Delete the downloaded artefact, the key file, and the temporary B2 key.
6. Optional, once: steps 3–5 of "Restore — database" onto a **scratch** Supabase project to validate
   the real-platform path, then delete the project.

Pass = exit 0. Any failure = open an incident, keep the artefact, do not delete older tiers.

### When a Layer 3 run fails

The public run log shows the stage only; the reason is in `ops_backup_runs.error` (`/admin/ops`).

| Stage | Usual cause |
|---|---|
| `recipients` | `OFFSITE_BACKUP_AGE_RECIPIENTS` is not an `age1…` public key (or a private key was pasted — rotate it) |
| `tools` | Image pull failed (registry) — re-run |
| `capture` | Pooler string wrong (use the **session** pooler, port 5432, user `crewflow_backup.<ref>`), password rotated, role lacks `pg_read_all_data`/`BYPASSRLS` |
| `storage` | S3 keys revoked, S3 connection disabled, or endpoint/region wrong |
| `manifest` | Storage objects recorded in the database are missing from the download — investigate, do not ignore |
| `upload` | B2 key revoked or lacks `writeFiles`; bucket name wrong |
| `restore_verify` | **Serious** if the log shows `FAIL` lines: the backup does not restore — open an incident. If it says the verification "could not run", it is an environment fault — re-run |
| `heartbeat` | Role lacks `insert, update` on `ops_backup_runs` |

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
every customer's jobs/quotes/invoices with no way back. PITR closes that gap
(RPO ~24h → ~2min). **It is NOT a customer-#1 launch blocker** — it is
**CEO-deferred as a cost decision** ($100/mo per 7-day retention), to reconsider
once there are paying customers. Until then the daily logical backups plus the
automated encrypted off-platform backup (below) are the recovery floor.

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

- [ ] PITR add-on enabled, retention ≥ 7 days (Step 2). **CEO-deferred — cost**, not a customer-#1 blocker; reconsider once there are paying customers.
- [x] Automated encrypted off-platform backup live + monitored (see "Current state 2026-10-20" below) — the recovery floor while PITR is deferred.
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

## Delta 2026-10-19 (supersedes only the rows it names; procedure unchanged)

- **Migration tip:** `20261229000000` (389/389 repo↔DB parity) — the 2026-08-29
  row above is history.
- **Off-platform copy:** the "pending password" caveat above is resolved —
  dated off-platform dumps have since been produced with stored credentials
  (DB password custody established; dumps live on the founder's machine).
  Cadence remains **policy-enforced, not telemetry-observable** — see
  `docs/ops/OUTAGE-RUNBOOK.md` §6, written after the 2026-10 five-day
  Vercel-402 outage.
- **PITR:** still **OFF** (CEO billing decision; unchanged).

## Current state 2026-10-20 — off-platform backup is now AUTOMATED + MONITORED

The 52-day silent lapse (Aug 29 → Oct 20 2026) is fixed by an automated, validated,
**encrypted** off-platform backup with a **loud** health monitor:
- `scripts/ops/off-platform-backup.sh` (originally weekly; **daily 03:17 since 2026-11-13** via `scripts/ops/com.crewflow.backup.plist`)
  dumps DB (schema + public + auth) **and all Supabase Storage objects**, generates + verifies
  checksums, **validates fail-loud** (pg_dump completeness/truncation), **encrypts locally**
  (AES-256), ships ONLY the encrypted artifact **off-machine to a private Backblaze B2 bucket**
  (`crewflow-prod-backups`, via rclone), applies retention, and writes a heartbeat
  to `ops_backup_runs`. `status=success` is recorded only after every validation stage passes —
  **including a hard upload gate**: a failed or incomplete off-site upload aborts the run (exit
  non-zero, heartbeat `failed`) and can never be recorded as a complete backup.
- **End-to-end round-trip PROVEN (2026-10-20):** encrypted local backup → B2 upload (bytes verified)
  → independent B2 download (checksum match) → decrypt → content-checksum 11/11 → isolated DB restore
  (321 tables, business counts exact-match) → ≥1 Storage object byte-for-byte (sha256 match). The
  remote receives **only ciphertext** — never plaintext PII. B2 free tier (10 GB) covers current
  volume at $0; no card on file.
- **Backup freshness IS now observable from production** (reversing the §6 "not telemetry-observable"
  caveat): `/admin/ops` → "Off-platform backup (DR)" shows **GREEN ≤7d / WARNING >7d / RED >10d or
  last run failed**. The scheduler is only an execution mechanism; the heartbeat is the source of truth.
- Full setup, the B2 remote config, and the restore procedure: `docs/ops/off-platform-backup-automation.md`.
- **DR lane status: GREEN** — off-platform encrypted off-machine backup is live, monitored, and
  round-trip proven. The encryption key (`~/.config/crewflow-backup/backup.key`) is backed up
  off-machine by the founder (without it, backups are unrecoverable).
- **PITR** remains OFF — a deliberate COST decision (CEO; $100/mo per 7-day retention), to reconsider
  when CrewFlow has paying customers. PITR covers the DB only; the off-platform backup additionally
  covers Storage objects and survives account/project loss.

### ⚠️ Restoring onto a BRAND-NEW Supabase project created after 2026-10-30 — Data API grants

From **2026-10-30** Supabase no longer auto-grants the Data API roles (`anon`,
`authenticated`) on tables in `public` **at creation time**. CrewFlow's historical
migrations mostly relied on that old auto-grant (only ~16 of 188 table-creating
migrations grant explicitly). Consequence for disaster recovery:

- **Restoring in place / PITR / restoring onto the EXISTING project:** no action —
  the live tables already carry their grants (Supabase retained them).
- **Restoring onto a FRESH project created on/after 2026-10-30** (e.g. account loss,
  region move — the exact tier the off-platform dump protects): rebuilding the schema
  from the historical migrations will produce tables with **no Data API grants**, so
  the restored app returns `42501 permission denied` on nearly every read even though
  the data is present. **After loading schema + data, re-grant the Data API roles:**

  ```sql
  grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant select on all tables in schema public to anon;  -- only if anon reads are expected
  alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
  ```

  RLS still governs row visibility — these grants only restore table reachability.
  Verify with a login + a spot read before declaring the restore healthy.

Going forward, every NEW client-facing table must grant the Data API role(s)
explicitly in its own migration (or be marked service-role-only). This is enforced
in CI by `__tests__/security/data-api-grant-guardrail.test.ts`, so a future restore
from migrations authored after this date will not reintroduce the gap.
