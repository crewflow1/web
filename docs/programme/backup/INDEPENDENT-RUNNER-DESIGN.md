# Independent backup runner — options, recommendation, design

Goal: a daily backup of the production database **and** Storage objects that does not depend on the
founder's Mac, costs nothing or nearly nothing, cannot be read by whoever runs it, cannot be deleted by
whoever runs it, proves it restores, and tells a human when it stops.

Evidence labels as in `BACKUP-AUDIT.md`. Facts about third-party limits come from the providers'
documentation as read on 2026-11-13 and are marked where I could not re-check them.

## 1. Recommendation

**Use a scheduled GitHub Actions workflow in this repository — and yes, still, knowing the repository is
public** — with five conditions that the implementation enforces:

1. The runner encrypts to `age` **public** keys only. It never holds a key that can decrypt.
2. Nothing sensitive is ever printed, summarised, attached or cached: row and object counts are withheld
   from logs, tool error text is withheld, and the workflow uploads no workflow artifacts.
3. The database credential is a dedicated **read-only** role, not the `postgres` password.
4. The off-site bucket is a new one with Object Lock, and the runner's key can write but not read or delete.
5. A dead-man's-switch ping exists, because a scheduled workflow that stops running cannot report itself.

Why it wins: it is the only zero-cost option that can run a real `pg_dump` (so the result is a real,
restorable dump), on infrastructure independent of the Mac, of Supabase and of Vercel, with nothing to
patch. The repository already relies on it for the outage monitor.

**One decision only the founder can make (NEEDS-FOUNDER):** during a run, plaintext production data
exists for a few minutes on a GitHub-hosted virtual machine (Microsoft Azure, United States) before it
is encrypted. That makes GitHub a sub-processor for that moment and is an international transfer under
UK GDPR. If that is not acceptable, use option (e) below — the same script on a small UK/EU server —
which is the only alternative that keeps a real dump and stays independent.

### What "public repository" changes — and what changes if it is made private

| | Public (today — VERIFIED via `gh repo view`) | If made private |
|---|---|---|
| Actions minutes | Free, unmetered on standard runners | **Metered**: 2,000 min/month on the Free plan, shared with CI. A backup run is expected to take ~5–10 min ⇒ ~150–300 min/month. The real risk is CI exhausting the allowance, after which **scheduled backups stop** until the month rolls over |
| Run logs, summaries, issues | **World-readable** — the workflow is built for this (conditions 2 above) | Private; the redaction stays on anyway (it costs nothing) |
| Scheduled workflow auto-disable | **Yes** — "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days" (GitHub docs) | The documented rule names public repositories only |
| Environment with a `main`-only branch rule (protects the secrets) | Available free | Not available on the Free plan for private repositories — secrets would be plain repository secrets |
| Secrets exposure to forks | Fork pull requests never receive secrets; this workflow has no `pull_request` trigger at all | Same |

My recommendation does not depend on the visibility. Staying public is slightly better for this job
(free minutes, branch-restricted secrets) provided the redaction rules hold — they are pinned by a test.

## 2. Options compared

| | (a) GitHub Actions schedule | (b) Supabase pg_cron + Edge Function | (c) Vercel cron | (d) Backblaze-side / managed backup service | (e) Small server (fallback) |
|---|---|---|---|---|---|
| Real `pg_dump`? | **Yes** (pinned Postgres 17 image) | No — no binaries in Edge Functions; would be a hand-written export | No — no `pg_dump` in the runtime; bundling one fights the size limit | Service-dependent; B2 itself cannot pull anything | Yes |
| Storage objects | rclone from the S3-compatible endpoint | Possible in principle, within function time/memory limits | Same limits problem | Service-dependent | rclone |
| Independent of the Mac | Yes | Yes | Yes | Yes | Yes |
| Independent of what it protects | Yes | **No** — runs inside the Supabase project it is backing up; account loss or pause stops it | **No** — a Vercel billing suspension already took production down for 5 days; crons stop with it | Yes | Yes |
| Production change needed | One read-only DB role; Storage S3 key | Enable `pg_cron` (not installed — VERIFIED) and deploy a function holding B2 credentials | New route + env vars | DB password given to a vendor | Role + key as (a) |
| Cost | £0 | £0 | Function time is metered | Typically £20–40/month | ~£4/month + patching |
| Verdict | **Recommended** | Rejected | Rejected | Rejected | Fallback if GitHub transit is unacceptable |

**(b) confirmed impractical.** `pg_cron` and `pg_net` are not installed in production (VERIFIED:
`select … from pg_extension`), so this starts with a production change. Edge Functions run Deno with no
`pg_dump`; published limits are a few hundred seconds of wall-clock and a few hundred MB of memory
(not re-verified today), against a 535 MB database. The export would be custom code whose
restorability nobody else has tested — the opposite of what a backup should be. And it shares fate with
the project.

**(c) confirmed impractical.** Vercel functions have a hard duration cap (minutes), a 250 MB bundle
limit and a ~500 MB scratch disk (published limits, not re-verified today), no `pg_dump`, and the
platform is the one whose suspension this programme already suffered. The repo also already runs 48 crons.

**(d).** Backblaze B2 is storage: it has no agent that connects to a database. Managed backup services
do, but they cost money, hold the full database credential, and see plaintext — a second processor with
more access than option (a) gives GitHub.

## 3. How the recommended runner works

Files: `.github/workflows/offsite-backup.yml` → `scripts/ops/offsite-backup.sh` →
`scripts/ops/lib/*` and `scripts/ops/restore-verify.sh`.

```
 GitHub runner (ephemeral VM)                              off-site
 ┌──────────────────────────────────────────────┐
 │ 1 capture   one exported snapshot:           │
 │             pg_dump -Fc  +  row/object counts │◄── read-only DB role, session pooler, TLS
 │ 2 storage   rclone copy + rclone check        │◄── Storage S3 endpoint
 │ 3 manifest  MANIFEST.json + SHA256SUMS        │
 │ 4 package   one tar                           │
 │ 5 encrypt   age → PUBLIC keys only            │
 │ 6 upload    artefact + sidecar + key-check    │──► B2 bucket (Object Lock, write-only key)
 │ 7 verify    restore the SAME tar into a       │     daily/  weekly/  monthly/
 │             throwaway Postgres, assert equal  │
 │ 8 heartbeat ops_backup_runs (host=github-actions) ──► /admin/ops
 │ 9 ping      dead-man's switch                 │──► email if a ping is missed
 └──────────────────────────────────────────────┘
```

### Database capture (VERIFIED on synthetic local data — see `E2E-EVIDENCE.md`)

- Direct `pg_dump` from a Postgres 17.6 image pinned by digest, the same build family as production
  (VERIFIED: production reports 17.6). No Supabase CLI login, no management token.
- **One snapshot for the dump and for its manifest.** A `REPEATABLE READ, READ ONLY` session exports its
  snapshot, records exact per-table row counts and schema object counts, and runs
  `pg_dump --snapshot=<same>` while the session is still open (`lib/offsite-capture.psql`). The counts
  therefore describe exactly what is in the dump, even while the application is writing, so
  verification can demand exact equality.
- **Exclude-list, not include-list.** Every schema is dumped except platform-managed ones
  (`extensions`, `graphql*`, `realtime`, `vault`, …). A schema added later is backed up automatically.
  Today that means `public`, `auth`, `storage`, `supabase_migrations`, `_backup`.
- Custom format: compressed, has a table of contents, allows selective restore; ownership and grants kept.
- Connection: the **session** pooler on port 5432 (GitHub runners have no IPv6; the direct host is
  IPv6-only). `sslmode=require` is forced. **IMPLEMENTED-UNTESTED against the production pooler** — in
  particular that a second session can import the snapshot through the pooler. If that fails the run
  fails loudly at stage `capture`; the first manual dispatch is the acceptance test.

### Storage capture (VERIFIED on synthetic local data)

- rclone against the S3-compatible endpoint, one bucket at a time, then `rclone check` (sizes + hashes
  re-read from the source), then a cross-check against `storage.objects`: any object that existed both at
  the snapshot and after the copy must be in the bundle at the recorded size, or the run fails.
- Non-interactive options considered: Supabase CLI `storage cp` needs a personal access token with
  account-wide power — rejected; the service-role key reads and writes the whole database — rejected;
  **Storage S3 access keys** are limited to Storage — chosen. They are still read/write and bypass RLS
  (Supabase docs); there is no read-only variant.

### Encryption and key management

- `age`, X25519 recipients. The workflow holds **public** keys (`age1…`); the script refuses anything
  else and refuses loudly if a private key is pasted by mistake.
- The private key ("identity") is generated by the founder on their own machine and kept **offline**:
  password manager plus a printed copy. It is never in GitHub, never on the runner.
- **Two recipients recommended**: the founder's key and an escrow key held somewhere else (a second
  password vault, a sealed envelope with the company's solicitor or accountant). Either decrypts.
- `age` is authenticated: a truncated or altered artefact fails to decrypt instead of yielding garbage.
- Each run also uploads `…keycheck.age` — a random non-personal token sealed to the same recipients. The
  founder proves the offline key still works by decrypting that, with no customer data involved.
- Rotation: add the new public key as a second recipient, run once, remove the old one. Old artefacts
  still need the old private key — keep it until those artefacts have expired.

### Retention, immutability, write-only access

- Tiers by object prefix: `daily/` every run, `weekly/` also on Sundays, `monthly/` also on the 1st (UTC).
- The runner **never deletes**. Retention is B2 lifecycle rules on the bucket: `daily/` 14 days,
  `weekly/` 56 days, `monthly/` 365 days.
- **Object Lock** on a new bucket with a default retention of 14 days (compliance mode): for that period
  nobody — not the runner, not the Mac, not someone logged in to the B2 console — can delete or
  overwrite an artefact. Object Lock has no extra fee (Backblaze docs).
- Application key: restricted to that bucket, capabilities `listBuckets, listFiles, writeFiles` — no
  `readFiles`, no `deleteFiles`. With `listFiles` the script confirms the stored size; with a strictly
  write-only key it falls back to the upload API's acknowledgement (B2 verifies the SHA-1 it is sent).
  **IMPLEMENTED-UNTESTED against Backblaze** (no credentials, no provisioning allowed); the upload path
  itself is VERIFIED against rclone's local backend, in both verification modes.
- Capacity: B2 gives 10 GB free. The Mac layer uses ~1.5 GB. At the measured dump compression the runner's
  34 retained artefacts fit; beyond 10 GB the price is about $6 per TB per month (pennies at this size).

### Restore verification (VERIFIED on synthetic local data, including failure cases)

- The runner restores the **same tar it encrypts** into a throwaway Postgres container with no network,
  on every run, and records `success` only if it passes. Its SHA-256 goes into the sidecar, so a later
  decrypt can prove it produced the identical bytes that were verified.
- The runner cannot decrypt, so it cannot re-verify a stored artefact. That gap is closed two ways:
  `age` authentication (intact ciphertext + right key ⇒ identical plaintext) and the founder's periodic
  drill (`docs/backup-recovery-runbook.md`), which runs the same script against a downloaded artefact.

### Heartbeat and alerting

- Same table, same columns as the Mac layer; `host = 'github-actions'`, `run_id` carries the workflow run
  id. No migration needed. `/admin/ops` continues to work; **splitting the tile per layer is
  NOT-IMPLEMENTED** (see audit F-8).
- A failure: (1) fails the workflow run — GitHub emails the account that owns the schedule;
  (2) opens or updates one issue labelled `backup-failure`, with a generic body (public repository);
  (3) pings `<healthcheck>/fail`.
- Silence (schedule disabled, GitHub outage): the dead-man's switch notices the missing ping and emails.
  A free healthchecks.io check is enough. Optional, strongly recommended.
- The 60-day auto-disable: a second tiny job re-enables the workflow through the API on every run, the
  standard way to reset that timer. **IMPLEMENTED-UNTESTED** (cannot wait 60 days) — the dead-man's
  switch is the control that actually covers it.

## 4. Secrets — by NAME

All ten live as **environment secrets** in a GitHub environment named `offsite-backup` whose deployment
branches are restricted to `main`. Until they exist the workflow prints "not configured" and exits 0.

| Secret name | What it is | Who can do what with it |
|---|---|---|
| `OFFSITE_BACKUP_DB_URL` | Session-pooler URI for the role `crewflow_backup` | Read everything, write only `ops_backup_runs` |
| `OFFSITE_BACKUP_S3_ENDPOINT` | Storage S3 endpoint URL | Not secret by itself |
| `OFFSITE_BACKUP_S3_REGION` | Project region | Not secret by itself |
| `OFFSITE_BACKUP_S3_ACCESS_KEY_ID` | Storage S3 key id | With the secret: read **and write** all Storage |
| `OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY` | Storage S3 secret | as above |
| `OFFSITE_BACKUP_AGE_RECIPIENTS` | One or two `age1…` public keys | Encrypt only |
| `OFFSITE_BACKUP_B2_KEY_ID` | B2 application key id | Upload and list in one bucket; no read, no delete |
| `OFFSITE_BACKUP_B2_APPLICATION_KEY` | B2 application key | as above |
| `OFFSITE_BACKUP_B2_BUCKET` | Bucket name | Not secret by itself |
| `OFFSITE_BACKUP_HEALTHCHECK_URL` | Dead-man's-switch ping URL (optional) | Can send pings only |

How to create each one: `FOUNDER-CHECKLIST.md`.

## 5. Threat model

| If this is compromised… | …the attacker gets | …and does not get |
|---|---|---|
| **GitHub secrets** (account takeover, or a collaborator editing the workflow) | Read access to the whole production database including `auth` (confidentiality breach); read/write to Storage objects; the ability to upload junk to the backup bucket | Database writes (role is read-only apart from one ops table); existing backups — they cannot be read (no `readFiles`, no private key) or deleted (no `deleteFiles`, Object Lock) |
| **The runner VM during a run** | The plaintext of that run | Anything afterwards — the VM is destroyed; nothing is cached or attached |
| **Public logs** | Stage names, timings, artefact size, migration tip, table *count* | Row counts, object counts, object names, error text, credentials |
| **Backblaze account or bucket** | Ciphertext only; can stop future uploads | Plaintext (no private key); deletion inside the lock period |
| **Supabase account** | Everything live | The off-site history — it is elsewhere and locked |
| **Vercel** | The application | Nothing here: the runner does not touch Vercel |
| **The founder's Mac** | The Mac layer (see audit F-1, F-11) | The runner's secrets or the offline private key, provided it is not stored on the Mac in the clear |
| **The offline private key** | Ability to decrypt artefacts *if* they also obtain them (needs B2 read access, which no automated credential has) | — |

Residual risks accepted in this design, stated plainly:

- A GitHub compromise is a full **read** breach of production. This is inherent in any external runner
  that can dump the database. Mitigations: read-only role, `main`-only environment, no third-party
  actions (only `actions/checkout`, pinned by commit SHA), digest-pinned image. Protecting `main`
  (currently unprotected — VERIFIED) is recommended and is a founder setting.
- TLS to the pooler is `sslmode=require`: encrypted, but the server certificate is not pinned. P3
  hardening: ship Supabase's root certificate and use `verify-full`.
- `age` and `rclone` come from Ubuntu's signed package archive on a pinned runner release
  (`ubuntu-24.04`), not from a hash-pinned download. Consistent with the repo's existing practice for
  runner-provided tools; noted, not hidden.

## 6. Restore procedure

Full procedure, key-loss scenario and the approval-gated production drill:
`docs/backup-recovery-runbook.md`. In one line: download artefact + sidecar from B2 with a read-capable
key the founder creates for the occasion → `scripts/ops/restore-verify.sh --artefact … --identity …
--sidecar …` proves it → restore the database with `pg_restore`, Storage with `rclone copy`.

## 7. Status

| Item | Label |
|---|---|
| Capture, Storage copy, manifest, encryption, upload logic, restore verification | **VERIFIED on synthetic local data** (`E2E-EVIDENCE.md`) |
| Workflow file, inert gate, redaction | IMPLEMENTED; static assertions VERIFIED by `__tests__/ci/offsite-backup.test.ts`; **never executed on GitHub** |
| Production pooler, production Storage S3, Backblaze key/Object Lock/lifecycle, healthcheck | **IMPLEMENTED-UNTESTED** — NEEDS-FOUNDER (credentials) |
| Production backup by this runner | **Not performed** |
| Production restore drill | **Not performed** — founder-approved step |
