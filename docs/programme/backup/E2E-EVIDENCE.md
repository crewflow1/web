# End-to-end evidence — independent backup + restore verification (SYNTHETIC local data)

**What this proves:** the whole pipeline — non-interactive capture, Storage copy, manifest, public-key
encryption, tiered upload, heartbeat, restore verification — works on a real Postgres 17.6 database and a
real Storage service, and the verification **fails loudly** for every deliberate corruption tried.

**What this does NOT prove (stated plainly):**

- **No production data was backed up, decrypted or restored.** The source was the local Supabase stack
  (synthetic data, 357 tables, migration tip `20261290000000`). The real artefacts in `~/CrewFlow-backups` were never opened.
- The production session pooler, production Storage S3 endpoint, Backblaze B2 (write-only key, Object
  Lock, lifecycle), the dead-man's-switch ping and the GitHub workflow itself have **not** been
  exercised — they need founder credentials (IMPLEMENTED-UNTESTED). The "off-site bucket" here was a
  local directory behind rclone.
- The dedicated read-only role `crewflow_backup` was not created anywhere; the local run used the local
  `postgres` role, which has the same attributes as production's (non-superuser, BYPASSRLS).
- `age` 1.2.1 ran from a local test container (nothing installed on the Mac); the runner will use
  Ubuntu 24.04's packaged `age` and `rclone` (older versions than those used here).

## How to reproduce

```
# local Supabase stack running; docker, rclone, age, age-keygen on PATH
bash scripts/ops/offsite-backup-e2e-local.sh          # add CF_E2E_REDACT=1 for the public-log mode
```

Run on 2026-11-14 against the shared local stack **while other workstreams were writing to it** — the
row counts still matched exactly, which is the point of capturing the dump and the counts in one
snapshot. Three full runs: all expectations held each time (the first two exposed and fixed two defects
in my own scripts — a macOS `tar` portability bug and a test-cleanup bug; see "Defects found").

Result of the final run: **13 expectations, 13 held, 0 unexpected** · exit 0.
Leftovers after the run (VERIFIED): 0 containers, 0 synthetic buckets/objects, 0 heartbeat rows, empty temp dir.

## 1. Backup run (real engine, `scripts/ops/offsite-backup.sh`)

```
20:53:26 [init] independent off-site backup starting (run_id=20261114205326-backupws-e2e-5414-5473-1, runner=backupws-e2e-5414)
20:53:26 [recipients] encrypting to 1 recipient(s): fingerprint(s) d7315dbe1c33426c
20:53:28 [capture] captured: 357 tables, 6825 TOC entries, migration tip 20261290000000, 1s
20:53:28 [capture] privacy tombstones: exported (count 342)
20:53:29 [manifest] storage: 14 buckets, objects: 6; manifest + checksums written and self-verified
20:53:30 [encrypt] encrypted artefact: 9904696 bytes, sha256 f89cd7d05e2accd4…
20:53:31 [upload] uploaded to tier(s): daily weekly (verification: listed)
CrewFlow restore verification — throwaway container, no network, counts only
----------------------------------------------------------------------
PASS  plaintext tar sha256               matches the hash recorded when the backup was taken
PASS  tar extraction                     archive is complete and well-formed
PASS  manifest format                    crewflow-offsite/1
PASS  bundle files present               8 listed
PASS  no unlisted files                  
PASS  bundle checksums (sha256)          8 file(s) verified
PASS  db dump matches manifest           
PASS  storage object count               matches manifest (6)
PASS  storage object checksums           every object matches its sha256 + size
INFO  throwaway postgres              PostgreSQL 17.6, container has no network
PASS  target prepared                    roles + extensions from the manifest created
PASS  pg_restore                         6824 TOC entries restored, 0 errors, 0 warnings, 3s
PASS  postgres major version             restored on PG 17.6 (source PG 17.6)
PASS  migration tip                      20261290000000
PASS  migration count                    440
PASS  schemas restored                   auth,public,storage,supabase_migrations
PASS  schema object counts               46 counters identical (tables, indexes, constraints, policies, triggers, functions, grants ...)
PASS  indexes valid                      0 invalid indexes
PASS  per-table row counts               357 tables identical (rows: 58953)
PASS  storage rows <-> payload           every restored storage.objects row has its file, sizes agree (rows: 6)
PASS  primary/unique keys                585 constraints, each backed by a valid unique index
PASS  foreign keys (orphan scan)         810 validated FKs scanned, 0 orphaned rows (2 NOT VALID at source, skipped)
----------------------------------------------------------------------
RESTORE VERIFICATION: PASSED (7s)
20:53:39 [done] BACKUP SUCCESS (db + storage captured at one snapshot, encrypted to public key(s), upload=uploaded, restore_verify=passed, tip=20261290000000)
off-site bucket now holds:
   ./daily/crewflow-offsite-20261114T205326Z.keycheck.age
   ./daily/crewflow-offsite-20261114T205326Z.tar.age
   ./daily/crewflow-offsite-20261114T205326Z.tar.age.json
   ./daily/crewflow-offsite-20261114T205326Z.verify.json
   ./tombstones/crewflow-tombstones-20261114T205326Z.jsonl.age
   ./weekly/crewflow-offsite-20261114T205326Z.keycheck.age
   ./weekly/crewflow-offsite-20261114T205326Z.tar.age
   ./weekly/crewflow-offsite-20261114T205326Z.tar.age.json
   ./weekly/crewflow-offsite-20261114T205326Z.verify.json
heartbeat row(s) for this runner: success / stage=done / upload=uploaded / verify=passed
artefact is age ciphertext (no plaintext tar header)
weekly tier copy is byte-identical
```

Shown by this run: capture needs no Supabase CLI login (plain connection string + S3 keys); the artefact
is `age` ciphertext; the heartbeat row carries the runner tag; the optional privacy-tombstone hook
exported to its own object under `tombstones/`.

## 2. Restore verification of the encrypted artefact — PASS

```
=== [1] GOOD artefact, founder key, sidecar (expect exit 0) ===
PASS  artefact sha256 (sidecar)          encrypted file is byte-identical to what was uploaded
PASS  decrypt (age)                      artefact decrypted with the supplied identity
PASS  plaintext tar sha256               matches the hash recorded when the backup was taken
PASS  tar extraction                     archive is complete and well-formed
PASS  manifest format                    crewflow-offsite/1
PASS  bundle files present               8 listed
PASS  no unlisted files                  
PASS  bundle checksums (sha256)          8 file(s) verified
PASS  db dump matches manifest           
PASS  storage object count               matches manifest (6)
PASS  storage object checksums           every object matches its sha256 + size
INFO  throwaway postgres              PostgreSQL 17.6, container has no network
PASS  target prepared                    roles + extensions from the manifest created
PASS  pg_restore                         6824 TOC entries restored, 0 errors, 0 warnings, 3s
PASS  postgres major version             restored on PG 17.6 (source PG 17.6)
PASS  migration tip                      20261290000000
PASS  migration count                    440
PASS  schemas restored                   auth,public,storage,supabase_migrations
PASS  schema object counts               46 counters identical (tables, indexes, constraints, policies, triggers, functions, grants ...)
PASS  indexes valid                      0 invalid indexes
PASS  per-table row counts               357 tables identical (rows: 58953)
PASS  storage rows <-> payload           every restored storage.objects row has its file, sizes agree (rows: 6)
PASS  primary/unique keys                585 constraints, each backed by a valid unique index
PASS  foreign keys (orphan scan)         810 validated FKs scanned, 0 orphaned rows (2 NOT VALID at source, skipped)
RESTORE VERIFICATION: PASSED (8s)
>>> OK: exit 0 as expected
```

## 3. Deliberate corruption — every case FAILS (exit 1)

```
=== [2] TRUNCATED artefact (60% of the file) (expect exit 1) ===
FAIL  decrypt (age)                      artefact did NOT decrypt (truncated, corrupted, or not encrypted to this identity)
RESTORE VERIFICATION: FAILED (1 failing check group(s), 0s)
>>> OK: exit 1 as expected

=== [3] CORRUPTED artefact (one flipped bit) (expect exit 1) ===
FAIL  decrypt (age)                      artefact did NOT decrypt (truncated, corrupted, or not encrypted to this identity)
RESTORE VERIFICATION: FAILED (1 failing check group(s), 0s)
>>> OK: exit 1 as expected

=== [4] CORRUPTED artefact vs sidecar sha256 (expect exit 1) ===
FAIL  artefact sha256 (sidecar)          encrypted file differs from the sidecar's sha256 (corrupt or wrong file)
RESTORE VERIFICATION: FAILED (1 failing check group(s), 1s)
>>> OK: exit 1 as expected

=== [5] WRONG key (artefact not sealed to it) (expect exit 1) ===
FAIL  decrypt (age)                      artefact did NOT decrypt (truncated, corrupted, or not encrypted to this identity)
RESTORE VERIFICATION: FAILED (1 failing check group(s), 0s)
>>> OK: exit 1 as expected

=== [6] Storage object altered after capture (expect exit 1) ===
FAIL  bundle checksums (sha256)          1 file(s) fail their checksum
FAIL  storage object checksums           1 object(s) missing or altered
RESTORE VERIFICATION: FAILED (1 failing check group(s), 0s)
>>> OK: exit 1 as expected

=== [7] TRUNCATED dump with VALID checksums (expect exit 1) ===
FAIL  pg_restore                         exit=1, 1 error(s), 0 warning(s) — the dump does not restore cleanly
FAIL  migration tip                      expected 20261290000000 got None
FAIL  migration count                    expected 440 got 0
FAIL  schema object counts               27 counter(s) differ
FAIL  per-table row counts               242 of 357 table(s) differ
FAIL  storage rows <-> payload           0 row(s) without a file, 0 size mismatch(es), 6 file(s) without a row
FAIL  primary/unique keys                0 of 0 key constraint(s) lack a valid unique index
FAIL  foreign keys (orphan scan)         0 of 0 foreign key(s) have orphaned rows
        pg_restore: error: could not read from input file: end of file
        auth.constraints_foreign_key                     expected 18 restored 0
        auth.constraints_primary_key                     expected 23 restored 0
RESTORE VERIFICATION: FAILED (4 failing check group(s), 5s)
>>> OK: exit 1 as expected

=== [8] restored data MISSING rows (fault injected) (expect exit 1) ===
INFO  TEST FAULT INJECTED              (--inject-fault-sql; throwaway DB only)
FAIL  migration tip                      expected 20261290000000 got 20261282000000
FAIL  migration count                    expected 440 got 439
FAIL  per-table row counts               1 of 357 table(s) differ
        supabase_migrations.schema_migrations            expected 440 restored 439
RESTORE VERIFICATION: FAILED (1 failing check group(s), 8s)
>>> OK: exit 1 as expected

=== [9] restored data with ORPHANED foreign key (fault injected) (expect exit 1) ===
INFO  TEST FAULT INJECTED              (--inject-fault-sql; throwaway DB only)
FAIL  per-table row counts               1 of 357 table(s) differ
FAIL  foreign keys (orphan scan)         2 of 810 foreign key(s) have orphaned rows
        public.memberships                               expected 194 restored 195
        public.memberships  memberships_org_id_fkey  orphans=1
        public.memberships  memberships_user_id_fkey  orphans=1
RESTORE VERIFICATION: FAILED (2 failing check group(s), 7s)
>>> OK: exit 1 as expected

```

Case 7 matters most: the dump was cut in half and then **re-checksummed**, so every checksum passes —
only an actual restore catches it. That is the gap in "decrypts and checksums" as a definition of
restorable.

## 4. Storage restore procedure + cleanup

```
### Storage restore procedure (rclone back into a scratch bucket, then compare)
>>> OK: restored bucket is identical to the source bucket

### leftovers check
>>> OK: synthetic buckets removed
>>> OK: no backup/verify containers left behind

======================================================================
E2E RESULT: ALL EXPECTATIONS HELD
```

## 5. Public-log mode (`--redact`, what the GitHub workflow uses)

Same run with `CF_E2E_REDACT=1`: all expectations held; row and object counts print as `withheld`:

```
[capture] privacy tombstones: exported (count withheld)
[manifest] storage: 17 buckets, objects: withheld; manifest + checksums written and self-verified
PASS  storage object count               matches manifest (withheld)
PASS  per-table row counts               357 tables identical (rows: withheld)
PASS  storage rows <-> payload           every restored storage.objects row has its file, sizes agree (rows: withheld)
```

In a failing run the redacted output names the affected tables and constraints (already public in this
repository's migrations) and schema-object counters, never row counts or object names.

## Defects found by this validation (all fixed before commit)

| Defect | How it showed | Fix |
|---|---|---|
| macOS `tar` adds AppleDouble `._*` members; the verifier rejected the bundle | Run 1: `FAIL tar extraction` | Bundle is now written with Python `tarfile` (identical on Linux/macOS) |
| Storage copy and its integrity check were retried separately, so an object uploaded between them could fail a run | Run 1: one retried check under concurrent writes | Copy + check retried as one unit |
| `rclone purge` does not empty a bucket on the Supabase S3 endpoint; the harness left synthetic buckets | Post-run leftover check | Harness deletes then removes; leftovers removed; harness now asserts none remain |

## Timings (synthetic, 53 MB database — not a production measurement)

Capture 1–4 s · encrypt + upload 2–3 s · restore into throwaway Postgres 3–8 s · whole verification
7–14 s · whole backup run about 25–35 s. Production (535 MB) is expected to take minutes, plus an image
pull on the runner; the first founder-triggered run will give the real figure.
