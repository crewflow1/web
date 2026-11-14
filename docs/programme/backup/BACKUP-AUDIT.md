# Backup audit — what is protected, by what, and where it can fail

Workstream: production-independent backup & restore verification · branch `ops/independent-backup-runner`
Audit date: 2026-11-13 · Baseline: prod `8cec66a7`, migration tip `20261295000000`.

Every claim carries one evidence label (AGENT-RULES §5): **VERIFIED** (I ran it; command/file cited) ·
**IMPLEMENTED-UNTESTED** · **BLOCKED** · **NEEDS-FOUNDER** · **NOT-IMPLEMENTED**.
No production data was read: production queries were catalogue facts and aggregate counts only.
The artefacts in `~/CrewFlow-backups` were **not opened, decrypted or restored** — only a top-level
directory listing (names, sizes, modes) was taken.

## 1. What exists to be lost (production, VERIFIED)

`supabase db query --linked` catalogue reads, 2026-11-13:

| Asset | Fact |
|---|---|
| Postgres | PostgreSQL **17.6**, database **535 MB**, 445 migrations, tip `20261295000000` |
| Schemas holding data | `public` 321 tables (507 MB — `cron_runs` 176 MB + `hq_timeline` 173 MB are telemetry), `auth` 27, `storage` 10 (metadata), `supabase_migrations` 1, `_backup` 1 (a hand-made schema) |
| Not capturable by a dump | `vault` — 0 secrets today (so nothing is lost); if secrets are ever stored there they are encrypted with a project key that cannot be exported |
| Storage objects | 13 buckets (0 public), **7 objects, 147 kB** — small now, but these are customer documents and they grow with every customer |
| Extensions | citext, pg_trgm, vector (in `public`), pgcrypto, uuid-ossp, pg_stat_statements (in `extensions`), supabase_vault. **No pg_cron, no pg_net** |
| Connection limits | `max_connections` 60, `statement_timeout` 120 s (a dump must lift it for its own session) |

## 2. The layers today

| | Layer 1 — Supabase managed backup | Layer 2 — founder-Mac off-platform backup |
|---|---|---|
| Mechanism | Daily physical backup, server-side, Pro plan | `scripts/ops/off-platform-backup.sh` via launchd, 03:17 local |
| Covers database | Yes | Yes (`supabase db dump`: schema, public data, auth data) |
| Covers Storage objects | **No** | Yes (`supabase storage cp`, count cross-checked against `storage.objects`) |
| Survives loss of the Supabase project/account | **No** — lives inside the same account | Yes — encrypted artefact in Backblaze B2 |
| Retention | 7 days | Last 8 artefacts (count-based) |
| Runs when | Always (provider-side) | **Only when that Mac is awake** |
| Restore routinely tested | No | Decrypt + extract + checksum each run; no restore into a database |
| RPO (design) | ≤ 24 h | ≤ 24 h if the Mac ran; in practice see F-2 |
| RTO | Dashboard restore, in place: minutes–hours. **Not measured on this project** (NEEDS-FOUNDER: a restore is destructive) | Manual: download, decrypt, rebuild schema from migrations, load data, re-upload Storage. Last measured 2026-10-20 / 2026-08-29 by hand (prior docs; not re-run) |
| PITR | Off (cost decision) | n/a |

VERIFIED on the Mac (metadata only, 2026-11-13): the installed script is byte-identical to the repo copy
(`diff -q ~/.local/bin/crewflow-off-platform-backup.sh scripts/ops/off-platform-backup.sh` → no output);
the launchd agent is loaded with last exit status 0 (`launchctl list`); production `ops_backup_runs`
holds 11 `success` and 5 `failed` rows since 2026-10-20, most recent success 2026-11-13 21:14 UTC.

## 3. Findings

Severity: **P0** critical data-loss/security · **P1** fix before paying customers · **P2** launch with
documented limitation · **P3** post-launch.

| ID | Sev | Finding | Label |
|---|---|---|---|
| F-1 | **P1** | Plaintext production dumps (incl. `auth` data) are kept on the founder's laptop, and the disk is **not encrypted** | VERIFIED |
| F-2 | **P1** | The only backup that covers Storage and survives account loss depends on one laptop being awake | VERIFIED |
| F-3 | **P1** | Key custody is a single point of failure: if the Mac is lost and the key was not copied off it, every B2 artefact is undecryptable | NEEDS-FOUNDER |
| F-4 | **P1** | No routine restore test — "restorable" currently means "decrypts and checksums" | VERIFIED |
| F-5 | **P2** | Off-site copies are deletable: the Mac's B2 key can delete, and there is no Object Lock | VERIFIED (key) / NEEDS-FOUNDER (bucket setting) |
| F-6 | **P2** | Retention is count-based (last 8). On a daily schedule that is ~8 days of history, not the "8 weeks" the docs imply | VERIFIED |
| F-7 | **P2** | A missed or failed backup alerts nobody unless someone opens `/admin/ops` or is sitting at the Mac | VERIFIED |
| F-8 | **P2** | The `/admin/ops` staleness thresholds are still the weekly-era 7 d / 10 d although the job is now daily | VERIFIED |
| F-9 | **P2** | Storage objects have exactly one backup layer | VERIFIED |
| F-10 | **P3** | Layer-2 encryption is AES-256-CBC without authentication; its checksum sidecar sits in the same bucket | VERIFIED |
| F-11 | **P3** | The Mac concentrates every credential: Supabase account token, B2 read/write key, encryption key | VERIFIED |
| F-12 | **P3** | Documentation drift: two docs still say "weekly, Sunday" | VERIFIED |
| F-13 | **P2** | The repository is **public** and `main` is unprotected — relevant to any credential placed in GitHub | VERIFIED |

### F-1 (P1) — plaintext dumps on an unencrypted laptop

- **Evidence.** `ls -la ~/CrewFlow-backups` shows dated plaintext directories (`2026-10-20/` … `2026-11-13/`)
  beside each `.tar.enc`; the script keeps them on purpose (`off-platform-backup.sh:341`, "pruned local
  plaintext" only beyond the retention count). `fdesetup status` → **"FileVault is Off."** The same
  directory also holds six older ad-hoc dump directories (`pre-*`), some mode `drwxr-xr-x`.
  The encryption key (`~/.config/crewflow-backup/backup.key`, mode 600) is on the same unencrypted disk.
- **Impact.** Theft or loss of the laptop exposes every customer's data and the auth tables in the clear,
  plus the key to every B2 artefact. This is a reportable personal-data breach under UK GDPR.
  Encrypting the artefact before upload does not help while eight plaintext copies sit next to it.
- **Reproduction (safe).** `fdesetup status`; `ls ~/CrewFlow-backups` (names only).
- **Fix — proposed, not applied** (the installed agent must not be modified by this workstream):
  1. Founder: turn on FileVault (System Settings → Privacy & Security). Free; one reboot.
  2. Script change for a later PR: delete the plaintext directory as soon as the encrypted artefact
     passes its decrypt-and-checksum self-test (the script already performs that test at stage
     `encrypt`), and stop retaining plaintext at all. One line after the self-test:
     `rm -rf "$BK"` guarded by the self-test having passed; the manifest must be read into the heartbeat
     first. Then re-copy the script to `~/.local/bin` (founder step).
  3. Founder: delete the existing dated plaintext directories and the `pre-*` directories once (2) is in.
- **Acceptance test.** After a run: `find ~/CrewFlow-backups -maxdepth 1 -type d -name '20*'` prints nothing;
  `fdesetup status` prints "FileVault is On."

### F-2 (P1) — the off-platform layer only runs when one Mac is awake

- **Evidence.** Encrypted artefacts on disk are dated 10-20, 11-01, 11-02, 11-06, 11-10, 11-13 — six in
  25 days, with a 12-day gap; directories `2026-10-25` and `2026-11-08` have no artefact (failed runs).
  5 of 16 recorded runs failed. launchd runs a missed slot on next wake, but not while the lid is shut.
- **Impact.** Real RPO for Storage objects and for account-loss scenarios has been up to 12 days.
- **Fix.** The independent runner delivered by this workstream (`INDEPENDENT-RUNNER-DESIGN.md`).
  **IMPLEMENTED, inert until the founder adds secrets.**
- **Acceptance test.** Seven consecutive daily `success` rows in `ops_backup_runs` with
  `host = 'github-actions'` while the Mac is switched off.

### F-3 (P1) — if the Mac is lost, are the B2 artefacts decryptable at all?

- **Evidence.** The symmetric key is generated on, and read from, the Mac (`off-platform-backup.sh:269`).
  `docs/backup-recovery-runbook.md` asserts it "is backed up off-machine by the founder". Nothing in the
  repository or on the machine can confirm that.
- **Answer.** Only if that off-machine copy really exists and is the current key. If it does not: the B2
  artefacts are permanently unreadable; Layer 1 still restores the **database** to within 7 days as long
  as the Supabase account is reachable; **Storage objects would exist only in Supabase itself.**
- **Fix.** (a) NEEDS-FOUNDER: confirm the key is in a password manager and matches (compare
  `shasum -a 256 ~/.config/crewflow-backup/backup.key` with the stored copy's hash — never paste the key).
  (b) The new runner removes the problem by design: it encrypts to `age` **public** keys, supports two
  recipients (founder + an escrow copy), and each run uploads a tiny non-personal "key-check" file so the
  founder can prove a private key still works without opening customer data.
- **Acceptance test.** Founder decrypts the latest `*.keycheck.age` with the offline key and its SHA-256
  equals `keycheck_plaintext_sha256` in the sidecar.

### F-4 (P1) — no routine restore test

- **Evidence.** The script's self-test decrypts, extracts and checks SHA-256 (`off-platform-backup.sh`
  stage `encrypt`); nothing loads a dump into Postgres. The last full restores were manual
  (2026-08-29, 2026-10-20 per prior docs; not re-performed here).
- **Impact.** A dump can be complete, checksummed and still not restore (missing role, extension,
  ordering, privilege). That is discovered during the incident.
- **Fix.** `scripts/ops/restore-verify.sh` — restores into a throwaway Postgres 17 container and asserts
  zero restore errors, identical schema object counts, identical per-table row counts, valid keys, zero
  orphaned foreign-key rows, matching migration tip, and Storage payload ↔ `storage.objects` agreement.
  The runner runs it on every backup before recording success. Evidence: `E2E-EVIDENCE.md`.
- **Limit.** It verifies the new runner's artefact format. Layer-2 artefacts (`.tar.enc`) are **not**
  covered — NOT-IMPLEMENTED; next step is to move the Mac job onto the same engine.

### F-5 (P2) — off-site copies can be deleted

- **Evidence.** The Mac's B2 application key is read+write and the script deletes with it
  (`off-platform-backup.sh:344`, `rclone delete`; `docs/ops/off-platform-backup-automation.md:65`).
  Whether Object Lock is on for `crewflow-prod-backups` cannot be read from here — NEEDS-FOUNDER
  (B2 console → bucket → Object Lock). Nothing in the docs or script sets it.
- **Impact.** Malware or a thief on the Mac, or anyone with the B2 console login, can erase every
  off-site backup; ransomware can do it before encrypting the live data.
- **Fix.** New runner writes to a **separate** bucket created with Object Lock, using a key that has no
  delete and no read capability; retention is enforced by the bucket's lifecycle rules, not by a
  credential that can delete. Founder steps in `FOUNDER-CHECKLIST.md`.

### F-6 (P2) — retention is a count, not a period

- **Evidence.** `CF_BACKUP_RETENTION` default 8 (`off-platform-backup.sh:43`), applied to local and remote.
  It was sized when the job was weekly (≈ 8 weeks); the plist is now daily.
- **Impact.** Corruption or a bad deletion noticed after ~8 days has no clean copy in Layer 2, and
  Layer 1 holds 7 days. Nothing older exists anywhere.
- **Fix.** New runner: time-based tiers — daily kept 14 days, weekly 8 weeks, monthly 12 months —
  enforced by B2 lifecycle rules. For Layer 2, proposed (not applied): raise the count or adopt the same tiers.

### F-7 (P2) — alerting needs someone to look

- **Evidence.** Failure paths: a heartbeat row, a `LAST_FAILURE.txt` file and a macOS notification
  (`off-platform-backup.sh:163`). A run that never starts produces none of them; `/admin/ops` turns
  amber only after 7 days. No email, no message.
- **Fix.** New runner: the workflow run fails (GitHub emails the owner), one deduplicated GitHub issue
  is opened, and an optional dead-man's-switch URL is pinged on start/success/failure — the last one is
  what catches "it silently stopped running". In-app email on a red tile is NOT-IMPLEMENTED (next step:
  a small Vercel cron reading `ops_backup_runs` and sending through the existing Resend path).

### F-8 (P2) — thresholds still assume a weekly job

- **Evidence.** `server/services/ops-snapshot.ts:443,448` — amber after 7 days, red after 10.
- **Impact.** A daily backup can be dead for a week before the tile changes colour.
- **Fix — NOT-IMPLEMENTED in this workstream** (bounded scope). Next step: split the tile by `host`
  (`github-actions` vs the Mac hostname), amber > 48 h / red > 96 h for the runner layer. Until then the
  tile blends both layers: any recent success from either keeps it green.

### F-9 (P2) — Storage objects have one layer

Layer 1 does not include them (Supabase documents this; consistent with the brief). Today that one layer
is the Mac. With the runner there are two independent copies. PITR would not change this.

### F-10 (P3), F-11 (P3), F-12 (P3)

- F-10: `openssl enc -aes-256-cbc` has no integrity tag (`off-platform-backup.sh:273`); the script
  compensates with an inner checksum file, and the `.sha256` sidecar lives in the same bucket, so it does
  not detect tampering by someone who can write there. The runner uses `age` (authenticated).
- F-11: Supabase CLI login (account-wide management token), B2 key and encryption key all live on the
  Mac. The runner uses a dedicated read-only database role instead of an account token.
- F-12: `docs/ops/off-platform-backup-automation.md:51` and `docs/backup-recovery-runbook.md:169` say
  weekly; `com.crewflow.backup.plist` is daily. Corrected in the runbook on this branch.

### F-13 (P2) — public repository, unprotected `main`

- **Evidence.** `gh repo view crewflow1/web --json visibility` → `PUBLIC`; branch-protection API → 404
  "Branch not protected"; 0 Actions secrets and 0 variables today.
- **Impact on backups.** Workflow logs, job summaries and issues are world-readable; anyone with write
  access can change a workflow that reads secrets. Designed for in `INDEPENDENT-RUNNER-DESIGN.md` §5
  (no counts in logs, no workflow artifacts, secrets in a `main`-only environment). Protecting `main` is
  a founder setting — NEEDS-FOUNDER.

## 4. Protection after this workstream (once the founder activates it)

| Scenario | Today | With the independent runner |
|---|---|---|
| Bad migration / accidental delete, noticed within 7 days | Layer 1 restore (≤ 24 h loss) | Same, plus a restore-proven daily copy |
| Same, noticed after 2–8 weeks | **No copy** | Weekly tier (8 weeks), monthly tier (12 months) |
| Supabase project or account lost | Layer 2, as old as the last time the Mac ran | Daily, independent of the Mac |
| Founder's Mac lost or stolen | Off-site copies may be undecryptable (F-3); plaintext exposed (F-1) | Runner unaffected; private key is offline, not on the Mac |
| Ransomware / malicious deletion of backups | Possible (F-5) | Blocked for the lock period by Object Lock; runner key cannot delete |
| Backup silently stops | Noticed after ≥ 7 days, if someone looks | Dead-man's switch + failed-run email + issue |
| "Is it restorable?" | Assumed | Proven on every run |

Honest limits that remain: RPO stays ≤ 24 h (only PITR improves that — a paid, founder decision);
the production restore drill has **not** been performed; the runner has **not** run against production.
