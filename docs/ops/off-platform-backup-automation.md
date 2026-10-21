# Off-platform encrypted backup automation (DR control)

Automated, validated, **encrypted** off-platform backups of the single production
Supabase project, shipped off-machine to a **private Backblaze B2 bucket**
(`crewflow-prod-backups`). This is the defence against **account/project-level loss**,
which PITR cannot cover.

> **DR lane status: GREEN (2026-10-20).** Live, monitored, weekly, and round-trip
> proven end-to-end (local encrypt → B2 upload → independent download → decrypt →
> checksum → isolated DB restore with exact-match counts → Storage object byte-for-byte).
> The remote stores **only ciphertext**; B2 free tier covers current volume at $0 (no card).

## Reliability model (read this first)
- **The Mac scheduler (`launchd`) is only an execution mechanism — NOT the source of truth.**
- The source of truth is the **validated heartbeat** in `public.ops_backup_runs`, surfaced
  in **`/admin/ops` → "Off-platform backup (DR)"**:
  - **GREEN** — last *validated* backup ≤ 7 days old.
  - **WARNING (amber)** — > 7 days.
  - **RED** — > 10 days, **or** the last run failed, **or** no successful backup on record.
- So a missed or failed backup becomes **loud** on every HQ login. It can never silently
  lapse the way it did for 52 days (Aug 29 → Oct 20 2026).

## What each run does (`scripts/ops/off-platform-backup.sh`)
Staged; `status="success"` is recorded **only after every stage passes**:
1. **migration_tip** — records prod migration tip (currency marker).
2. **db_dump** — `supabase db dump --linked` schema + `--data-only` public + `--data-only --schema auth`.
3. **storage_dump** — enumerates `storage.buckets`, `supabase storage cp --recursive` every bucket (customer documents).
4. **checksum** — SHA256SUMS over all artifacts.
5. **validate (fail-loud)** — checksums verify; each dump non-empty, has the pg_dump header AND the
   `PostgreSQL database dump complete` footer (**truncation = hard fail**); `data.sql` has the replica-role
   guard + table-data sections; every storage bucket copied. Any failure ⇒ `status=failed`, exit non-zero.
6. **encrypt** — `tar` the backup dir and `openssl enc -aes-256-cbc -pbkdf2 -iter 600000` to `<date>.tar.enc`
   using the local key. **Immediately self-tests decryptability** (decrypt + `tar -t`). The remote only ever
   receives this encrypted artifact — never plaintext dumps, Storage objects, auth data or PII.
7. **manifest** — sizes, checksums, migration tip, storage object count → `MANIFEST.json`.
8. **upload** — `rclone copy` the encrypted artifact (+ its `.sha256`) to the B2 bucket; verifies remote byte-size.
   If no remote is configured, records `upload_status=pending_no_remote` (backup still valid locally).
9. **upload gate** — a complete backup REQUIRES a verified off-site upload. If `upload_status` is anything
   other than `uploaded`, the run **aborts** (exit non-zero, heartbeat `failed`); the local encrypted copy is
   kept and retention is skipped. A failed/incomplete upload can never be recorded as a complete backup.
10. **retention** — keeps the last `CF_BACKUP_RETENTION` (default 8) locally and remotely; prunes older.
Heartbeat rows (`running` → `success`/`failed`) are written to `ops_backup_runs` throughout.

## Encryption key (critical)
- Key file: `~/.config/crewflow-backup/backup.key` (600, auto-generated on first run).
- **BACK IT UP off-machine** (password-manager vault). **Without it, every backup is unrecoverable.**
- Never commit it, never log it, never upload it. The remote stores only ciphertext.

## Scheduling + manual run
- Install (one-time): see the header of `scripts/ops/com.crewflow.backup.plist`.
- Weekly: Sunday 03:17 local; a **missed** run (Mac asleep/off) fires once on next wake.
- **Run now (manual):** `bash scripts/ops/off-platform-backup.sh` (or `launchctl start com.crewflow.backup`).

## Mac-offline handling (no silent gap)
If the Mac is off/asleep across the slot, `launchd` runs the job on next wake. If it's off long
enough that no run completes, `/admin/ops` turns **WARNING at 7d** and **RED at 10d** — visible to
HQ on every login. The guarantee is not "the Mac is always on"; it's "staleness is always loud."

## Remote object storage — DONE (Backblaze B2, private bucket)
Off-site durability is **live and proven**. The destination is a **private Backblaze B2 bucket**
`crewflow-prod-backups` (B2 free tier: 10 GB storage, no card required; our encrypted backups are
≈180 MB × 8 ≈ 1.5 GB). Configuration (reference — already in place):
- rclone remote **`crewflow-b2`** (B2 backend) in `~/.config/rclone/rclone.conf` (600). The script
  default is `crewflow-b2:crewflow-prod-backups` (override via `CF_BACKUP_RCLONE_REMOTE`).
- The B2 application key is **scoped to that one bucket** (read+write), stored **only** in
  `rclone.conf` — never in git/logs/telemetry/the app. The bootstrap `b2.env` was deleted after
  the key was written into rclone.conf.
- **Round-trip proven 2026-10-20:** encrypted upload → independent B2 download (checksum match) →
  decrypt → content checksum → isolated DB restore (exact-match counts) → Storage object byte-for-byte.
- Rotating the key: create a new bucket-scoped B2 app key, update the `crewflow-b2` remote in
  `rclone.conf`, delete the old key in the B2 console. No code change.

## Restore procedure (remote)
1. `rclone copy crewflow-b2:crewflow-prod-backups/<date>.tar.enc .` ; verify against `<date>.tar.enc.sha256`.
2. `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:~/.config/crewflow-backup/backup.key -in <date>.tar.enc | tar -xf -`
3. DB: build schema from migrations on a clean/isolated Supabase project, then `psql < <date>/auth-data.sql`, `psql < <date>/data.sql`.
4. Storage: `supabase storage cp --recursive <date>/storage/<bucket> ss:///<bucket>` per bucket.
5. Verify row counts + a storage object byte-for-byte (see the proof log).

## Retention / rotation
`CF_BACKUP_RETENTION` (default 8) newest backups kept locally (plaintext dated dirs + encrypted
artifacts) and remotely; older pruned each run. At ≈180 MB/backup this stays well under B2's 10 GB free tier.
