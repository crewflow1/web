# Founder checklist — activating the independent backup runner (NEEDS-FOUNDER)

Everything below is something only the founder can do: it creates credentials, changes a provider
setting, or accepts a risk. Nothing here has been done by the engineering workstream. Until step 6 is
complete the workflow runs daily, prints "not configured" and does nothing.

Time: about 45 minutes. Cost: £0 (Backblaze free tier, GitHub public-repo minutes, healthchecks.io free).

**Never paste a secret value into a chat, an issue, a commit or a document.** Put each value straight
into GitHub's secret form and into your password manager.

## 0. Decisions to make first

- [ ] **Accept (or decline) that a GitHub-hosted runner in the United States holds plaintext production
      data for a few minutes per run**, before it is encrypted. If declined, stop here and ask for the
      small-server variant (same script, design doc option (e)).
- [ ] Add GitHub (Actions runners) and Backblaze to the sub-processor list in the privacy documentation.
- [ ] Choose who holds the **second (escrow) decryption key** — see step 1.

## 1. Generate the encryption keypair — on your own machine, offline copy kept

```
brew install age
age-keygen -o ~/crewflow-backup-founder.key      # prints "Public key: age1…"
age-keygen -o ~/crewflow-backup-escrow.key       # second key, for escrow
```

- [ ] Store the **contents of each `.key` file** (the line starting `AGE-SECRET-KEY-`) in your password
      manager as two separate entries, and print the founder key on paper for a safe place.
- [ ] Give the escrow key to the chosen holder (second vault / sealed envelope), then delete
      `~/crewflow-backup-escrow.key` from the Mac.
- [ ] Note the two **public** keys (`age1…`). Only these go to GitHub. They are safe to share.
- The private keys must never be stored in GitHub, in the repository, or unencrypted on a laptop
  without FileVault.

## 2. Create the read-only database role — Supabase SQL editor (a production change)

Run once, replacing the password with a long random one from your password manager:

```sql
create role crewflow_backup login password '<generate-a-long-random-password>'
  bypassrls connection limit 3;
grant pg_read_all_data to crewflow_backup;                       -- read every table, nothing else
grant insert, update on public.ops_backup_runs to crewflow_backup; -- its own heartbeat row only
-- OPTIONAL, only once the account-deletion migration is live (tombstone export hook):
-- grant execute on function public.privacy_tombstone_export(timestamptz) to crewflow_backup;
```

- [ ] Role created. (Why this works: the `postgres` role holds `pg_read_all_data` with admin option and
      `BYPASSRLS` — verified in production's catalogue on 2026-11-13.)
- [ ] Build the connection string from the dashboard's **Session pooler** string (Connect → Session
      pooler, port **5432**), replacing the user with `crewflow_backup.<project-ref>` and appending
      `?sslmode=require`. Shape: `postgresql://crewflow_backup.<project-ref>:<password>@<pooler-host>:5432/postgres?sslmode=require`.
      Do **not** use the direct `db.<ref>.supabase.co` host (IPv6 only; GitHub runners have no IPv6) or
      the transaction pooler on 6543 (`pg_dump` needs a session).
- Simpler but weaker alternative: use the existing `postgres` user in that string. It works, but then a
  GitHub compromise can also **write** to production. Not recommended.

## 3. Create Storage S3 access keys — Supabase dashboard (a production setting)

- [ ] Storage → Settings → **S3 Connection**: enable it if it is off, then "New access key".
- [ ] Note the **endpoint** (`https://<project-ref>.storage.supabase.co/storage/v1/s3`), the **region**,
      the access key id and the secret.
- Be aware: Supabase S3 keys give full read **and write** access to every bucket; there is no read-only
  variant. This is the narrowest credential Supabase offers for Storage.

## 4. Create the off-site bucket and its upload-only key — Backblaze B2

- [ ] Create a **new private bucket** (e.g. `crewflow-prod-backups-offsite`) with **Object Lock enabled**
      at creation. Then set its default retention: **Compliance mode, 14 days**.
      (Compliance mode means nobody, including you, can delete an artefact for 14 days. Object Lock
      cannot be turned off afterwards and has no extra fee.)
- [ ] Add **lifecycle rules** on the bucket (Lifecycle Settings → custom), one per prefix:

  | File name prefix | Days from upload to hide | Days from hide to delete |
  |---|---|---|
  | `daily/` | 14 | 1 |
  | `weekly/` | 56 | 1 |
  | `monthly/` | 365 | 1 |
  | `tombstones/` | 400 | 1 |

- [ ] Create an **application key restricted to that bucket** with exactly the capabilities
      `listBuckets, listFiles, writeFiles` — no `readFiles`, no `deleteFiles`. The web form's
      "Write Only" option is acceptable; for the exact set use the CLI:
      `b2 key create --bucket crewflow-prod-backups-offsite crewflow-offsite-runner listBuckets,listFiles,writeFiles`
- [ ] Note the `keyID` and the `applicationKey`.
- Do not reuse the Mac's bucket or key: that key can delete.

## 5. Dead-man's switch — healthchecks.io (optional, strongly recommended)

- [ ] Create a free check: period **1 day**, grace **6 hours**, notify by email (and phone if you wish).
- [ ] Copy its ping URL. This is what tells you when the backup silently stops running.

## 6. Put the secrets into GitHub

Repository → Settings → Environments → **New environment** named exactly `offsite-backup`:

- [ ] Deployment branches and tags → **Selected branches** → add `main`. (No required reviewers —
      a scheduled run must not wait for approval.)
- [ ] Add these **environment secrets** (names exact):

  | Secret name | Value |
  |---|---|
  | `OFFSITE_BACKUP_DB_URL` | connection string from step 2 |
  | `OFFSITE_BACKUP_S3_ENDPOINT` | endpoint from step 3 |
  | `OFFSITE_BACKUP_S3_REGION` | region from step 3 |
  | `OFFSITE_BACKUP_S3_ACCESS_KEY_ID` | from step 3 |
  | `OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY` | from step 3 |
  | `OFFSITE_BACKUP_AGE_RECIPIENTS` | the two **public** keys from step 1, separated by a space |
  | `OFFSITE_BACKUP_B2_KEY_ID` | `keyID` from step 4 |
  | `OFFSITE_BACKUP_B2_APPLICATION_KEY` | `applicationKey` from step 4 |
  | `OFFSITE_BACKUP_B2_BUCKET` | bucket name from step 4 |
  | `OFFSITE_BACKUP_HEALTHCHECK_URL` | ping URL from step 5 (optional) |

- [ ] GitHub → Settings → Notifications → Actions: "Send notifications for failed workflows only" on.
- [ ] Recommended, separate from backups: protect the `main` branch (it is currently unprotected).

## 7. First run and acceptance

- [ ] Actions → **offsite-backup** → Run workflow (leave "restore verify" ticked).
- [ ] The run is green and its log shows the stages `capture`, `storage`, `manifest`, `encrypt`,
      `upload`, the `PASS` lines of the restore verification, and `BACKUP SUCCESS`. It shows **no** row
      counts (they read "withheld").
- [ ] `/admin/ops` → Off-platform backup shows a fresh success; in the SQL editor,
      `select host, status, stage, upload_status from ops_backup_runs order by started_at desc limit 3;`
      shows `github-actions / success / done / uploaded`.
- [ ] B2 bucket shows `daily/crewflow-offsite-<stamp>.tar.age`, `.tar.age.json`, `.keycheck.age`,
      `.verify.json`.
- [ ] **Prove you can decrypt, without opening customer data:** download the `.keycheck.age` and the
      `.tar.age.json` from the B2 console, then
      `age -d -i ~/crewflow-backup-founder.key <file>.keycheck.age | shasum -a 256` must print the value
      of `keycheck_plaintext_sha256` in the JSON. Repeat once with the escrow key before handing it over.
- If the run fails at `capture`: the usual causes are the pooler string (wrong user form or port) or the
  role's password. If it fails at `upload`: the B2 key lacks a capability — add `listFiles`.
  These two paths could not be tested without your credentials.

## 8. Fix the laptop findings (audit F-1, F-3) — independent of the runner

- [ ] Turn on **FileVault** (System Settings → Privacy & Security). The Mac currently holds plaintext
      production dumps on an unencrypted disk.
- [ ] Confirm the Mac backup's key (`~/.config/crewflow-backup/backup.key`) is in your password manager
      and matches (compare `shasum -a 256` of both; never paste the key).
- [ ] Approve the follow-up change that deletes plaintext dump directories as soon as the encrypted
      artefact verifies, then delete the existing dated and `pre-*` directories in `~/CrewFlow-backups`.

## 9. Standing duties

- [ ] **Quarterly restore drill** — approval-gated procedure in `docs/backup-recovery-runbook.md`.
- [ ] Rotate the database role password and the S3/B2 keys yearly, or immediately if GitHub access is
      ever in doubt.
