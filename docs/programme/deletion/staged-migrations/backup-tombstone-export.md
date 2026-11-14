# Staged change: carry deletion tombstones beside every backup

**Status: NOT-IMPLEMENTED in the script.** The SQL (`privacy_tombstone_export`,
`privacy_tombstone_reapply`) and the service functions (`exportTombstones`, `reapplyTombstones`) are
implemented and tested (`__tests__/integration/privacy/restore-and-drift.test.ts`).

## 1. `scripts/ops/off-platform-backup.sh`

After the dump is encrypted and uploaded, and **outside** the keep-last-N rotation:

1. Export every sealed tombstone as JSON lines:
   `select privacy_tombstone_export(null)` (service role), one object per line → `tombstones.jsonl`.
2. Upload it to a fixed key next to — not inside — the dated backup directory
   (`<remote>/tombstones/tombstones.jsonl`), overwriting the previous copy. The file only ever grows; it holds
   opaque ids, kinds and timestamps, so it needs no encryption beyond the bucket's own and no expiry.
3. Fail the backup run loudly if the export or the upload fails: a backup without its tombstones is a backup
   that can resurrect erased people.

To close the window between backups, the same export should also be pushed when a deletion completes (a
follow-up to the executor; not built).

## 2. `docs/backup-recovery-runbook.md` — restore procedure, new step before reopening

> **Re-apply deletions.** With the application still in maintenance mode: download
> `tombstones/tombstones.jsonl`; run the tombstone re-application against the restored database
> (`reapplyTombstones`); confirm every line reports `already_applied`, `nothing_to_reapply`, or a `completed`
> run. Do not remove maintenance mode until it does. Record the output with the incident.

A small operator entry point (a script that reads the file and calls `reapplyTombstones`) is needed; it must
refuse to run unless the operator passes the project ref explicitly.
