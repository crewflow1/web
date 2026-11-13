# Backup & disaster-recovery — posture status (honest assessment)

_Last reviewed: 2026-10-30. This is a **verification + status** document. It states
what is provable from the repository today, separately from what is only
**claimed** in docs and needs a live or CEO action to confirm. It changes no
setting and connects to nothing._

Companion docs (procedures, not re-stated here):
- `docs/backup-recovery-runbook.md` — PITR concepts + the Supabase restore procedure.
- `docs/ops/off-platform-backup-automation.md` — the encrypted off-platform backup design.
- `docs/ops/OUTAGE-RUNBOOK.md` — incident/outage handling.

CrewFlow runs on **one production Supabase Postgres** (ref `jzntbskdqdopzwdqwvkp`,
prod `crewflow.uk`) with **no staging** (per `CLAUDE.md`). There is no second
environment to fail over to, so recovery rests entirely on backups.

---

## 1. VERIFIED in-repo (provable from code, migrations, tests)

These facts are backed by committed artifacts and today's test run; they do not
depend on anyone's word.

| # | Fact | Evidence (path) |
|---|------|-----------------|
| V1 | A heartbeat/ledger table `public.ops_backup_runs` exists; **service-role only** (RLS enabled, no anon/authenticated policies → deny-all); stores run metadata only, **no secrets**. | `supabase/migrations/20261230000000_ops_backup_runs.sql`; locked-table proof in `__tests__/integration/rls/slice15-pr2-cclass-least-privilege.test.ts` |
| V2 | An off-platform backup **script** is committed: dumps DB (schema + public data + auth data) **and** every Storage bucket, checksums, fail-loud validates, encrypts (AES-256), uploads to a remote, enforces an upload gate, applies retention, and writes the heartbeat. | `scripts/ops/off-platform-backup.sh` (~15 KB) |
| V3 | A **launchd** schedule unit is committed (weekly; a missed run fires on next wake). | `scripts/ops/com.crewflow.backup.plist` |
| V4 | Production **surfaces backup freshness**: `/admin/ops` reads `ops_backup_runs` and renders a GREEN/AMBER/RED tile that also folds into the overall ops traffic light. | `server/services/ops-snapshot.ts` (`readBackupHealth` → `buildOpsSnapshot`); `app/admin/ops/page.tsx` |
| V5 | The freshness thresholds are now **unit-pinned**: GREEN ≤7d · AMBER >7d or a run stuck "running" >6h · RED >10d, last completed run failed, or no success on record — and the classifier **fails toward red/amber, never false-green** (incl. a newer "running" row not masking an older failure). | `classifyBackupHealth` in `server/services/ops-snapshot.ts`; `__tests__/ops/backup-health-freshness.test.ts` (15 cases, boundary + ordering) |
| V6 | Restoring onto a **fresh** Supabase project created on/after 2026-10-30 needs an explicit Data-API re-GRANT or the app returns `42501` on nearly every read; the re-grant SQL is documented. | `docs/backup-recovery-runbook.md` → "Restoring onto a BRAND-NEW Supabase project…"; guard `__tests__/security/migration-data-api-grant-guard.test.ts` |

**What V1–V6 together prove:** the *mechanism* for an encrypted, validated,
off-platform, Storage-inclusive backup and for making staleness loud in HQ
**exists in the codebase and its most safety-critical decision (the freshness
classification) is tested.** They do **not** prove that the mechanism is
*running*, that a backup *exists right now*, or that a restore *works end-to-end*
— those are operational facts outside the repo (Section 2).

---

## 2. CLAIMED in docs — needs a live or CEO/founder action to confirm

The following are asserted in `docs/ops/off-platform-backup-automation.md` and
`docs/backup-recovery-runbook.md` but are **not verifiable from this repository**
and must not be reported as proven. Each is an operational fact living on the
founder's machine or in the Supabase/Backblaze dashboards.

| # | Claim | Why it can't be verified in-repo | How to confirm |
|---|-------|----------------------------------|----------------|
| C1 | **PITR is OFF** (deliberate cost decision; $100/mo per 7-day window). | Billing/add-on state is dashboard-only. | Supabase → Settings → Add-ons / Billing. |
| C2 | The weekly backup is **actually running** and `ops_backup_runs` has a recent `success` row. | The repo can't see prod rows or the founder's launchd state. | Open `/admin/ops` in prod; or query `ops_backup_runs` on the live DB. |
| C3 | End-to-end **restore was PROVEN** on 2026-10-20 (B2 download → decrypt → DB restore with exact counts → Storage object byte-for-byte). | A one-time manual drill on the founder's Mac; no CI artifact, not reproducible here. | Re-run the documented restore drill and record RTO. |
| C4 | A **private Backblaze B2 bucket** + rclone remote are configured; the remote receives only ciphertext. | Off-repo config in `~/.config/rclone/rclone.conf` (correctly **not** committed). | Inspect the founder's rclone config / B2 console. |
| C5 | The **encryption key** (`~/.config/crewflow-backup/backup.key`) is backed up off-machine. | Off-repo by design. **If this is false, every backup is unrecoverable.** | Confirm the key is in the founder's password-manager vault. |
| C6 | WAL archiving is healthy (`archive_mode=on`, 0 failures). | Requires a live read of `pg_stat_archiver`. | Read-only query against prod. |

---

## 3. Recovery objectives today (PITR OFF)

Honest numbers given the verified mechanism + the claimed operational state:

| Failure class | Protection | RPO (max data loss) | RTO (time to restore) |
|---|---|---|---|
| Row/table corruption or bad write, project intact | Supabase **daily** logical backups (in-place restore) | up to ~24h | minutes–hours (small today) |
| Same, with **PITR** (currently **OFF** — C1) | would be ~2 min | — | — |
| **Whole project / account loss** (deletion, account compromise, region move) | **off-platform encrypted backup** (V2) — the only tier that survives this | up to ~**7 days** (weekly cadence) | documented, rehearsed once (C3); schema replay ≈30s + data/Storage load + Data-API re-grant (V6) |

Two independent gaps stack here:
1. **PITR OFF** ⇒ in-place DB RPO is ~24h, not ~2min.
2. **Off-platform cadence is weekly** ⇒ the account-loss tier can lose up to ~7
   days. For the failure it is designed to cover, that is the real RPO.

---

## 4. The honest "documented vs operationally proven" gap

- **Executor is a personal laptop.** The entire off-platform backup + Storage
  backup depends on the founder's Mac running launchd (V3). This is a committed,
  well-designed script — but not resilient infrastructure. The mitigation is
  **loudness** (V4/V5): staleness turns the `/admin/ops` tile AMBER at 7d and
  RED at 10d.
- **Loudness only fires where someone looks.** The freshness signal is a **pull**
  on the HQ `/admin/ops` page. If the Mac dies *and* nobody opens `/admin/ops`,
  nothing pages anyone. There is **no push alert** (email/Sentry/SMS) on a missed
  or failed backup. This is the single highest-leverage, lowest-cost hardening
  left.
- **Restore is proven once, manually, not continuously.** C3 is a real drill but
  there is no scheduled re-rehearsal and no CI coverage of the restore path, so
  "we can restore" decays toward "we could restore in October 2026" over time.
- **Key custody is an unverifiable single point of failure (C5).** Correct that
  it is off-repo; but a lost key makes every encrypted artifact useless, and the
  repo cannot attest the key is safely duplicated.
- **Storage backup shares the executor dependency.** File/document backup is in
  the script (V2) and is therefore exactly as reliable as C2/C4 — no more.

---

## 5. Ordered action list (CEO / founder — none of this is autonomous)

1. **Confirm the backup is actually running (C2).** Open `/admin/ops` in prod and
   confirm the "Off-platform backup (DR)" tile is GREEN with a recent success.
   *(Zero cost, 2 minutes — do this first; everything below assumes the mechanism runs.)*
2. **Confirm encryption-key custody (C5).** Verify `backup.key` is in the
   password-manager vault. Without it the backups are worthless. *(Zero cost.)*
3. **Add a push alert on stale/failed backup.** Today staleness is pull-only
   (Section 4). Add an external heartbeat/alert (e.g. a free cron-monitor ping
   from the backup script's success stage, or a Sentry/email alert off
   `ops_backup_runs`) so a dead Mac pages someone without an HQ login.
   *(Low/zero cost — the biggest reliability gain available.)*
4. **Decide PITR (C1).** Enabling it takes DB RPO from ~24h to ~2min for the
   common corruption case. CEO cost decision (~$100/mo per 7-day window);
   deferred "until paying customers". Re-confirm the deferral is still intended.
5. **Shorten off-platform cadence or move the executor off the laptop.** Weekly
   on a personal Mac is the account-loss RPO floor (~7 days). Consider
   daily, and/or running the backup from always-on infra (a small scheduled
   job/CI runner) rather than launchd on the founder's machine.
6. **Re-rehearse restore on a cadence (C3).** Schedule a periodic full restore
   drill (fresh project, including the Data-API re-grant from V6) and record the
   measured RTO, so recovery stays *proven*, not *remembered*.

---

## 6. What this review changed in the repo

- Extracted the backup freshness GREEN/AMBER/RED logic into a pure, exported
  `classifyBackupHealth` and added `__tests__/ops/backup-health-freshness.test.ts`
  (15 cases) so the most safety-critical DR decision is unit-pinned (V5). The
  runtime behaviour of `/admin/ops` is unchanged.
- Added this honest status assessment.

No production connection was made; no setting, schedule, or secret was touched.
