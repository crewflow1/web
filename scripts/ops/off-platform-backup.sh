#!/usr/bin/env bash
#
# CrewFlow off-platform encrypted backup — production DR control
# ============================================================
# Captures a complete, validated, ENCRYPTED off-platform backup of the single
# production Supabase project and ships the ENCRYPTED artifact to remote object
# storage (Cloudflare R2). Protects against account/project-level loss that PITR
# cannot cover.
#
# Design (per DR spec):
#  - The Mac scheduler (launchd) is only an EXECUTION mechanism. The source of
#    truth for backup health is the validated heartbeat in `ops_backup_runs`
#    (surfaced in /admin/ops). A miss/failure therefore becomes LOUD, not silent.
#  - Captures: Postgres schema + public data + auth data + ALL Supabase Storage
#    objects (customer documents).
#  - Validates: checksums + pg_dump completeness BEFORE anything is called a success.
#  - Encrypts LOCALLY (AES-256, openssl) before any upload. The remote receives
#    ONLY the encrypted artifact — never plaintext dumps / Storage objects / PII.
#  - status="success" is recorded ONLY after every required stage passes.
#  - Never prints DB/storage/remote credentials. The encryption key and remote
#    credentials live in local files (600), never in git / logs / telemetry / the app.
#  - Retention: keeps the last RETENTION_WEEKS backups locally and remotely; prunes older.
#
# Exit non-zero on any failure. Safe to run manually ("run backup now") or via launchd.
#
# Config (env-overridable; defaults are safe):
#   CF_BACKUP_LINK_DIR      dir where `supabase` is linked to prod   (default ~/Code/web)
#   CF_BACKUP_ROOT          local backup root                        (default ~/CrewFlow-backups)
#   CF_BACKUP_ENC_KEY       AES-256 key file (auto-generated 600)    (default ~/.config/crewflow-backup/backup.key)
#   CF_BACKUP_RCLONE_REMOTE rclone remote:bucket for the encrypted artifact (default r2:crewflow-prod-backups)
#   CF_BACKUP_RETENTION     number of backups to retain              (default 8)
#   CF_BACKUP_LOG_DIR       log dir                                  (default ~/.local/state/crewflow-backup/logs)
#
set -Eeuo pipefail

# node/supabase live in /opt/homebrew/bin, which is NOT on launchd's default PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

LINK_DIR="${CF_BACKUP_LINK_DIR:-$HOME/Code/web}"
BACKUP_ROOT="${CF_BACKUP_ROOT:-$HOME/CrewFlow-backups}"
ENC_KEY_FILE="${CF_BACKUP_ENC_KEY:-$HOME/.config/crewflow-backup/backup.key}"
RCLONE_REMOTE="${CF_BACKUP_RCLONE_REMOTE:-r2:crewflow-prod-backups}"
RETENTION="${CF_BACKUP_RETENTION:-8}"
LOG_DIR="${CF_BACKUP_LOG_DIR:-$HOME/.local/state/crewflow-backup/logs}"

HOST_TAG="$(hostname -s 2>/dev/null || echo mac)"
DATE="$(date -u +%Y-%m-%d)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BK="$BACKUP_ROOT/$DATE"
ENC_ARTIFACT="$BACKUP_ROOT/${DATE}.tar.enc"

STATUS="running"
STAGE="init"
ERR=""
MIG_TIP=""
UPLOAD_STATUS="skipped"

mkdir -p "$BK" "$LOG_DIR" "$(dirname "$ENC_KEY_FILE")"
chmod 700 "$BACKUP_ROOT" "$BK" "$(dirname "$ENC_KEY_FILE")" 2>/dev/null || true
LOG_FILE="$LOG_DIR/backup-${DATE}.log"

log(){ printf '%s [%s] %s\n' "$(date -u +%H:%M:%S)" "$STAGE" "$*" | tee -a "$LOG_FILE" >&2; }

# --- heartbeat: write start/finish rows to prod ops_backup_runs (best-effort; no creds logged) ---
RUN_ID="$(date -u +%Y%m%d%H%M%S)-${HOST_TAG}"
write_heartbeat(){
  local st="$1" fin="$2"
  local manifest_json="[]"
  [ -f "$BK/MANIFEST.json" ] && manifest_json="$(cat "$BK/MANIFEST.json")"
  # Build a parameter-safe SQL upsert via python3 (never echoes creds; values are literals only).
  local sql
  sql="$(python3 - "$RUN_ID" "$HOST_TAG" "$DATE" "$STARTED_AT" "$fin" "$st" "$STAGE" "$MIG_TIP" "$UPLOAD_STATUS" "$ERR" "$manifest_json" <<'PY'
import sys, json
run_id,host,bdate,started,fin,st,stage,tip,upload,err,manifest=sys.argv[1:12]
def q(v):
    if v is None or v=="": return "null"
    return "'" + str(v).replace("'","''") + "'"
try: json.loads(manifest)
except Exception: manifest="[]"
fin_sql = q(fin) if fin else "null"
print(f"""insert into public.ops_backup_runs
 (run_id, host, backup_date, started_at, finished_at, status, stage, migration_tip, upload_status, error, file_manifest)
 values ({q(run_id)}, {q(host)}, {q(bdate)}::date, {q(started)}::timestamptz, {fin_sql}::timestamptz,
         {q(st)}, {q(stage)}, {q(tip)}, {q(upload)}, {q(err)}, {q(manifest)}::jsonb)
 on conflict (run_id) do update set
   finished_at=excluded.finished_at, status=excluded.status, stage=excluded.stage,
   migration_tip=excluded.migration_tip, upload_status=excluded.upload_status,
   error=excluded.error, file_manifest=excluded.file_manifest;""")
PY
)"
  ( cd "$LINK_DIR" && supabase db query --linked "$sql" ) >/dev/null 2>&1 \
    && log "heartbeat[$st] recorded" \
    || log "heartbeat[$st] skipped (ops_backup_runs unavailable or not yet deployed)"
}

on_error(){
  local rc=$?
  [ "$STATUS" = "success" ] && return 0
  STATUS="failed"
  [ -z "$ERR" ] && ERR="unexpected failure (rc=$rc) at stage=$STAGE"
  log "ABORT: $ERR"
  write_heartbeat "failed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || true
  exit "$rc"
}
trap on_error ERR

log "CrewFlow off-platform backup starting (run_id=$RUN_ID, dir=$BK)"
write_heartbeat "running" ""

# === Stage 1: migration tip (currency marker) ===
STAGE="migration_tip"
MIG_TIP="$( ( cd "$LINK_DIR" && supabase db query --linked "select max(version) tip from supabase_migrations.schema_migrations;" ) 2>/dev/null | grep -oE '"tip": "[0-9]+"' | grep -oE '[0-9]+' | head -1 || true)"
[ -n "$MIG_TIP" ] && log "prod migration tip: $MIG_TIP" || log "WARN: could not read migration tip"

# === Stage 2: database dumps (schema / public data / auth data) ===
STAGE="db_dump"
( cd "$LINK_DIR" && supabase db dump --linked -f "$BK/schema.sql" ) >>"$LOG_FILE" 2>&1
( cd "$LINK_DIR" && supabase db dump --linked --data-only -f "$BK/data.sql" ) >>"$LOG_FILE" 2>&1
( cd "$LINK_DIR" && supabase db dump --linked --data-only --schema auth -f "$BK/auth-data.sql" ) >>"$LOG_FILE" 2>&1
log "db dumps complete"

# === Stage 3: Supabase Storage objects (customer documents) ===
STAGE="storage_dump"
mkdir -p "$BK/storage"
STORAGE_OK=1
# Enumerate buckets from the DB (authoritative), then copy each recursively.
BUCKETS="$( ( cd "$LINK_DIR" && supabase db query --linked "select id from storage.buckets order by id;" ) 2>/dev/null | grep -oE '"id": "[^"]+"' | sed 's/.*: "//; s/"$//' || true)"
if [ -z "$BUCKETS" ]; then
  log "WARN: no buckets enumerated (storage may be empty) — recording empty storage set"
fi
STORAGE_OBJ_COUNT=0
for b in $BUCKETS; do
  # cp appends the bucket name to the dest, so dest is "$BK/storage" (not ".../$b")
  # to avoid a doubled "storage/<b>/<b>/..." path.
  if ( cd "$LINK_DIR" && supabase storage cp --experimental --recursive "ss:///$b" "$BK/storage" ) >>"$LOG_FILE" 2>&1; then
    n=$(find "$BK/storage/$b" -type f 2>/dev/null | wc -l | tr -d ' ')
    STORAGE_OBJ_COUNT=$((STORAGE_OBJ_COUNT + n))
    log "storage bucket '$b': $n object(s)"
  else
    STORAGE_OK=0
    log "WARN: storage copy failed for bucket '$b'"
  fi
done
log "storage objects captured: $STORAGE_OBJ_COUNT"

# === Stage 4: checksums (generate) ===
STAGE="checksum"
( cd "$BK" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.json -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS )
log "checksums generated ($(wc -l < "$BK/SHA256SUMS" | tr -d ' ') files)"

# === Stage 5: HARD validation (fail loudly on incomplete/truncated) ===
STAGE="validate"
validate_fail(){ ERR="validation failed: $1"; log "VALIDATION FAIL: $1"; return 1; }
# 5a. checksums verify
( cd "$BK" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1 ) || validate_fail "checksum mismatch"
# 5b. schema.sql is a schema dump (no pg_dump header/footer) — validate by DDL presence + size.
[ -s "$BK/schema.sql" ] || validate_fail "schema.sql missing/empty"
[ "$(grep -c '^CREATE ' "$BK/schema.sql")" -ge 50 ] || validate_fail "schema.sql has too few CREATE statements (truncated?)"
[ "$(wc -c < "$BK/schema.sql")" -ge 100000 ] || validate_fail "schema.sql suspiciously small (truncated?)"
# 5c. data-only dumps: non-empty + pg_dump header + completeness footer (truncation guard)
for f in data.sql auth-data.sql; do
  [ -s "$BK/$f" ] || validate_fail "$f missing/empty"
  grep -q "PostgreSQL database dump" "$BK/$f" || validate_fail "$f missing pg_dump header"
  tail -c 300 "$BK/$f" | grep -q "PostgreSQL database dump complete" || validate_fail "$f truncated (no completeness footer)"
done
# 5d. data.sql must set replica role (FK-safe load) and contain table data sections
grep -q "session_replication_role = replica" "$BK/data.sql" || validate_fail "data.sql missing replica-role guard"
grep -q "Type: TABLE DATA" "$BK/data.sql" || validate_fail "data.sql has no table data sections"
# 5e. storage: every enumerated bucket copied without failure
[ "$STORAGE_OK" = "1" ] || validate_fail "one or more storage buckets failed to copy"
log "validation PASSED (dumps complete, checksums OK, storage captured)"

# === Stage 6: local encryption (AES-256) — remote gets ONLY this ===
STAGE="encrypt"
if [ ! -f "$ENC_KEY_FILE" ]; then
  umask 077; openssl rand -hex 32 > "$ENC_KEY_FILE"; chmod 600 "$ENC_KEY_FILE"
  log "WARN: generated a NEW encryption key at $ENC_KEY_FILE — BACK IT UP SECURELY (off-machine). Without it, backups are UNRECOVERABLE."
fi
# tar the plaintext backup dir, encrypt to <date>.tar.enc with a strong KDF
( cd "$BACKUP_ROOT" && tar -cf - "$DATE" | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$ENC_KEY_FILE" -out "$ENC_ARTIFACT" )
[ -s "$ENC_ARTIFACT" ] || { ERR="encryption produced empty artifact"; log "ENCRYPT FAIL"; false; }
shasum -a 256 "$ENC_ARTIFACT" | awk '{print $1}' > "${ENC_ARTIFACT}.sha256"
ENC_BYTES=$(wc -c < "$ENC_ARTIFACT" | tr -d ' ')
log "encrypted artifact: $ENC_ARTIFACT ($ENC_BYTES bytes), sha256 recorded"
# 6b. prove decryptability immediately (decrypt header to a throwaway, verify tar lists)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$ENC_KEY_FILE" -in "$ENC_ARTIFACT" 2>/dev/null | tar -tf - >/dev/null 2>&1 \
  || { ERR="encrypted artifact failed decrypt+list self-test"; log "DECRYPT SELF-TEST FAIL"; false; }
log "encryption self-test PASSED (artifact decrypts + tar lists cleanly)"

# === Stage 7: build manifest (sizes, checksums, validation) ===
STAGE="manifest"
python3 - "$BK" "$ENC_ARTIFACT" "$ENC_BYTES" "$MIG_TIP" "$STORAGE_OBJ_COUNT" > "$BK/MANIFEST.json" <<'PY'
import sys, os, json, hashlib
bk, enc, enc_bytes, tip, storage_count = sys.argv[1:6]
files=[]
for root,_,names in os.walk(bk):
    for n in names:
        if n in ("MANIFEST.json",): continue
        p=os.path.join(root,n); rel=os.path.relpath(p,bk)
        files.append({"file":rel,"bytes":os.path.getsize(p)})
total=sum(f["bytes"] for f in files)
enc_sha=hashlib.sha256(open(enc,"rb").read()).hexdigest() if os.path.exists(enc) else None
print(json.dumps({
  "migration_tip": tip or None,
  "plaintext_total_bytes": total,
  "plaintext_file_count": len(files),
  "storage_object_count": int(storage_count),
  "encrypted_artifact": os.path.basename(enc),
  "encrypted_bytes": int(enc_bytes),
  "encrypted_sha256": enc_sha,
  "validation": "passed",
  "files": sorted(files, key=lambda x:-x["bytes"])[:40],
}, indent=0))
PY
log "manifest written"

# === Stage 8: encrypted remote upload (only if remote configured; else pending) ===
STAGE="upload"
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q "^${RCLONE_REMOTE%%:*}:"; then
  if rclone copy "$ENC_ARTIFACT" "$RCLONE_REMOTE/" >>"$LOG_FILE" 2>&1 \
     && rclone copy "${ENC_ARTIFACT}.sha256" "$RCLONE_REMOTE/" >>"$LOG_FILE" 2>&1; then
    # verify remote size matches local (integrity of the upload)
    RSIZE=$(rclone size "$RCLONE_REMOTE/$(basename "$ENC_ARTIFACT")" --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('bytes',-1))" 2>/dev/null || echo -1)
    if [ "$RSIZE" = "$ENC_BYTES" ]; then UPLOAD_STATUS="uploaded"; log "encrypted upload OK (remote bytes match)"; else UPLOAD_STATUS="upload_size_mismatch"; log "WARN: remote size mismatch ($RSIZE != $ENC_BYTES)"; fi
  else
    UPLOAD_STATUS="upload_failed"; log "WARN: rclone upload failed (backup still valid locally)"
  fi
else
  UPLOAD_STATUS="pending_no_remote"; log "remote not configured — encrypted artifact staged locally; upload pending owner credential"
fi

# === Stage 9: retention / rotation (local plaintext dirs + encrypted artifacts + remote) ===
STAGE="retention"
# local encrypted artifacts
ls -1dt "$BACKUP_ROOT"/*.tar.enc 2>/dev/null | tail -n +$((RETENTION+1)) | while read -r old; do rm -f "$old" "${old}.sha256"; log "pruned local enc $(basename "$old")"; done || true
# local plaintext dated dirs (keep fewer plaintext copies: RETENTION, but plaintext is sensitive — keep same window)
ls -1dt "$BACKUP_ROOT"/20*-*/ 2>/dev/null | tail -n +$((RETENTION+1)) | while read -r old; do rm -rf "$old"; log "pruned local plaintext $(basename "$old")"; done || true
# remote
if [ "$UPLOAD_STATUS" = "uploaded" ]; then
  rclone lsf "$RCLONE_REMOTE/" --include "*.tar.enc" 2>/dev/null | sort -r | tail -n +$((RETENTION+1)) | while read -r old; do rclone delete "$RCLONE_REMOTE/$old" 2>/dev/null && rclone delete "$RCLONE_REMOTE/${old}.sha256" 2>/dev/null; log "pruned remote $old"; done || true
fi
log "retention applied (keep last $RETENTION)"

# === Success: only now ===
STAGE="done"
STATUS="success"
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_heartbeat "success" "$FINISHED_AT"
log "BACKUP SUCCESS (db+storage dumped, validated, encrypted, upload=$UPLOAD_STATUS, tip=$MIG_TIP)"
exit 0
