# Plaintext backup audit and safe cleanup (founder's Mac)

Audit run 2026-11-14 by the lead. Nothing was deleted. Evidence labels as elsewhere.

## 1. What is on the Mac (`~/CrewFlow-backups`)

| Directory | Size | Kind | Encrypted recovery copy | Verdict |
|---|---|---|---|---|
| `2026-10-20` | 171 MB | scheduled backup, plaintext | `2026-10-20.tar.enc` local + Backblaze B2 | **VERIFIED** recoverable — safe to delete plaintext |
| `2026-11-01` | 178 MB | scheduled backup, plaintext | local + B2 | **VERIFIED** — safe to delete plaintext |
| `2026-11-02` | 179 MB | scheduled backup, plaintext | local + B2 | **VERIFIED** — safe to delete plaintext |
| `2026-11-06` | 189 MB | scheduled backup, plaintext | local + B2 | **VERIFIED** — safe to delete plaintext |
| `2026-11-10` | 197 MB | scheduled backup, plaintext | local + B2 | **VERIFIED** — safe to delete plaintext |
| `2026-11-13` | 204 MB | scheduled backup, plaintext | local + B2 | see §2 (verified separately) |
| `2026-10-25`, `2026-11-08` | 0 B | leftovers of FAILED runs (one empty file) | none needed | safe to delete (no data) |
| `2026-11-14` | — | today's run | see §2 | — |
| `pre-1019`, `pre-1023` | 2.2 MB each | manual pre-migration snapshots (single file) | **none** | plaintext only — founder decision |
| `pre-20261241-2026-10-29`, `pre-20261260_2026-10-31`, `pre-R5-20261242_2026-10-31`, `pre-rpc-37-40-2026-10-26` | 159–185 MB each | manual pre-migration snapshots | **none** | plaintext only — founder decision |

"VERIFIED recoverable" means all five of these held for that date: the local artefact matches its recorded SHA-256; the Backblaze copy has the identical byte size; the artefact decrypts with the key on this Mac; every file inside passes its checksum; and the checksum manifest inside the artefact is byte-identical to the plaintext directory's manifest (so the encrypted copy contains exactly what the plaintext directory contains).

The six `pre-*` directories are point-in-time snapshots taken by hand before past migrations. They have **no encrypted copy anywhere**. They are older than, and superseded as recovery points by, the verified dated backups; their only remaining value is forensic ("what did the data look like before migration X"). Options: (a) delete them, (b) encrypt them with the same key and upload to B2 first, then delete the plaintext. Recommended: (a) for anything older than 30 days unless you know you want the history.

## 2. Today's state

- Last night's scheduled run (03:19 UTC) FAILED: the Mac cycled in and out of sleep, `pg_dump` lost its connection four times over two hours (`SSL SYSCALL error: EOF`, host-name resolution failures) and the run aborted. The failure marker and the `/admin/ops` heartbeat both recorded it. This is the "only works while the Mac is awake" limitation, not a script defect.
- A manual run at 21:40 UTC with the Mac held awake SUCCEEDED: `2026-11-14.tar.enc` (216 MB), decrypt + checksum self-test passed, Backblaze upload byte-matched, heartbeat `success` at migration tip `20261295000000`. This is the pre-migration recovery point for the 2026-11-14 security release.
- `2026-11-13` and `2026-11-14` were then verified with the same five checks as the others: **VERIFIED** recoverable.

## 3. Cleanup — NOT RUN; run only after you approve

```bash
# Dry run first: prints what would be removed, deletes nothing.
cd ~/CrewFlow-backups
for d in 2026-10-20 2026-11-01 2026-11-02 2026-11-06 2026-11-10 2026-10-25 2026-11-08; do
  [ -d "$d" ] && echo "would remove plaintext: $d ($(du -sh "$d" | cut -f1))"
done
```

```bash
# Real run (only after approval). Each dated directory is removed ONLY if its encrypted
# artefact still matches its recorded checksum at that moment.
cd ~/CrewFlow-backups
for d in 2026-10-20 2026-11-01 2026-11-02 2026-11-06 2026-11-10; do
  if [ "$(shasum -a 256 "$d.tar.enc" | awk '{print $1}')" = "$(awk '{print $1}' "$d.tar.enc.sha256")" ]; then
    rm -rf "$d" && echo "removed plaintext $d"
  else
    echo "KEPT $d — encrypted artefact did not verify"
  fi
done
rm -rf 2026-10-25 2026-11-08   # empty leftovers of failed runs
```

Going forward, the updated backup script (commit `e705f54b` on `ops/independent-backup-runner`, not installed) removes the plaintext directory automatically once the encrypted artefact has passed its decrypt-and-checksum self-test and its off-site upload has been size-verified.

## 4. Turning on FileVault (full-disk encryption) — founder only

FileVault encrypts the whole disk so that the plaintext above, the backup encryption key (`~/.config/crewflow-backup/backup.key`), local `.env` files and browser sessions are unreadable if the Mac is lost or stolen. It is OFF today (`fdesetup status` → "FileVault is Off").

1. Plug the Mac into power. Apple menu → **System Settings** → **Privacy & Security** → scroll to **FileVault** → **Turn On…** and authenticate.
2. When asked how to unlock the disk if you forget your password, choose one:
   - **"Allow my iCloud account to unlock my disk"** — simplest; nothing to write down; or
   - **"Create a recovery key and do not use my iCloud account"** — macOS shows a 24-character key **once**.
3. If you choose the recovery key: store it in your password manager and/or on paper kept away from the Mac. **Do not** save it in a file on this Mac, photograph it to a synced album, paste it into any chat, email, ticket or document, or show it to an assistant. Nobody at CrewFlow tooling ever needs it.
4. Encryption runs in the background while you keep working (typically under an hour on an SSD). Leave the Mac on power. Check progress on the same settings page; `fdesetup status` in Terminal reports "FileVault is On." when done.
5. Separately, make sure the backup encryption key exists in your password manager (it currently lives only on this Mac): without it the Backblaze artefacts cannot be decrypted. Copy it there yourself; do not send it anywhere.

Nothing in this procedure requires giving any key or password to anyone.
