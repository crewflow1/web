#!/usr/bin/env bash
#
# CrewFlow INDEPENDENT off-site backup — the runner-agnostic capture engine
# ========================================================================
# Layer 3 of the backup model (see docs/backup-recovery-runbook.md). Unlike the
# founder-Mac job (scripts/ops/off-platform-backup.sh) this needs NO logged-in
# Supabase CLI, NO local key file and NO particular machine: every input is an
# environment variable, so it runs unchanged on a GitHub-hosted runner
# (.github/workflows/offsite-backup.yml), a small VPS, or a laptop.
#
# Requires: bash, docker, python3, rclone, age, curl.
#
# What one run does (status=success is recorded ONLY if every stage passes):
#   capture        ONE exported snapshot: pg_dump (custom format) of every non-platform
#                  schema + exact per-table row counts + schema object counts, all at the
#                  same instant (scripts/ops/lib/offsite-capture.psql). READ ONLY.
#   storage        every Storage bucket via the S3-compatible endpoint (rclone), then
#                  `rclone check` against the source, then cross-checked against
#                  storage.objects (a silent Storage skip is impossible).
#   manifest       MANIFEST.json + SHA256SUMS over every file.
#   package        one plaintext tar (never leaves this machine).
#   encrypt        age, to PUBLIC recipient key(s) only. This machine can encrypt but
#                  can NEVER decrypt: the private identity is held offline by the founder.
#   upload         encrypted artefact + small non-sensitive sidecar to the off-site
#                  bucket, under daily/ (+ weekly/ on Sundays, monthly/ on the 1st).
#                  Retention is enforced by the BUCKET (lifecycle + Object Lock) — this
#                  script never deletes anything and its key cannot.
#   restore_verify the SAME tar is restored into a throwaway Postgres and proven
#                  identical to the manifest (scripts/ops/restore-verify.sh).
#   tombstones     OPTIONAL hook: if the deletion workstream's export function exists,
#                  the cumulative deletion-tombstone list is uploaded as a separate
#                  encrypted object under tombstones/ (re-applied after any restore).
#   heartbeat      a row in public.ops_backup_runs tagged with the runner name, so
#                  /admin/ops can tell this layer from the Mac layer.
#
# Modes:
#   offsite-backup.sh --check-config   print which required settings are missing (NAMES
#                                      only) and exit: 0 + "NOT_CONFIGURED" when none are
#                                      set, 0 + "CONFIGURED" when all are, 2 when partial.
#   offsite-backup.sh                  run a backup.
#
# Required environment (names only — values are never printed):
#   CF_OFFSITE_DB_URL                    Postgres URI (session pooler, sslmode=require)
#   CF_OFFSITE_S3_ENDPOINT               Supabase Storage S3 endpoint URL
#   CF_OFFSITE_S3_REGION                 its region
#   CF_OFFSITE_S3_ACCESS_KEY_ID          Storage S3 access key id
#   CF_OFFSITE_S3_SECRET_ACCESS_KEY      Storage S3 secret
#   CF_OFFSITE_AGE_RECIPIENTS            one or more age PUBLIC keys (age1...), space/comma/newline separated
#   and EITHER  CF_OFFSITE_B2_KEY_ID + CF_OFFSITE_B2_APPLICATION_KEY + CF_OFFSITE_B2_BUCKET
#       OR      CF_OFFSITE_DEST          any rclone destination (used by the local tests)
# Optional:
#   CF_OFFSITE_HEALTHCHECK_URL           dead-man's-switch ping URL (…/start, …, …/fail)
#   CF_OFFSITE_RUNNER_TAG                heartbeat `host` tag            (default github-actions)
#   CF_OFFSITE_HEARTBEAT                 1|0 write ops_backup_runs       (default 1)
#   CF_OFFSITE_VERIFY                    1|0 restore-verify before success (default 1)
#   CF_OFFSITE_REDACT                    1|0 withhold row/object counts  (default 1 — logs may be public)
#   CF_OFFSITE_TIERS                     override tier list, e.g. "daily weekly"
#   CF_OFFSITE_UPLOAD_VERIFY             auto|list|ack                   (default auto)
#   CF_OFFSITE_PGSSLMODE                 libpq sslmode default           (default require)
#   CF_PG_IMAGE                          Postgres tools/restore image    (default: pinned digest)
#   CF_OFFSITE_DEBUG_LOG_DIR             LOCAL troubleshooting only: keep raw tool logs here
#
# Exit: 0 success · 1 backup failed · 2 configuration/usage error.
#
# SECRET HYGIENE: no `set -x` anywhere; credentials reach child processes only via
# the environment (never argv); tool stderr goes to a private log that is deleted
# on exit, and only stage names + sanitised one-line reasons are printed.
#
set -Eeuo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SELF_DIR/lib"
BUNDLE_PY="$LIB_DIR/offsite_bundle.py"
DEFAULT_PG_IMAGE="public.ecr.aws/supabase/postgres@sha256:69e57a409628a809e3778a4d176eb97e32d7c961131ac025b77ad094c0b2d49e"
PG_IMAGE="${CF_PG_IMAGE:-$DEFAULT_PG_IMAGE}"
# Platform-managed schemas: owned and rebuilt by Supabase itself on any project.
# EVERYTHING else (public, auth, storage, supabase_migrations, and any schema
# added later) is dumped.
MANAGED_SCHEMAS="extensions,graphql,graphql_public,realtime,_realtime,vault,pgbouncer,pgsodium,pgsodium_masks,supabase_functions,net,cron,pgmq,_analytics,_supavisor"

REQUIRED_VARS="CF_OFFSITE_DB_URL CF_OFFSITE_S3_ENDPOINT CF_OFFSITE_S3_REGION CF_OFFSITE_S3_ACCESS_KEY_ID CF_OFFSITE_S3_SECRET_ACCESS_KEY CF_OFFSITE_AGE_RECIPIENTS"
B2_VARS="CF_OFFSITE_B2_KEY_ID CF_OFFSITE_B2_APPLICATION_KEY CF_OFFSITE_B2_BUCKET"

# --- configuration check (shared by the workflow's inert gate) ---------------
check_config(){
  local missing="" present=0 v
  for v in $REQUIRED_VARS; do
    if [ -n "${!v:-}" ]; then present=$((present+1)); else missing="$missing $v"; fi
  done
  if [ -n "${CF_OFFSITE_DEST:-}" ]; then
    present=$((present+1))
  else
    for v in $B2_VARS; do
      if [ -n "${!v:-}" ]; then present=$((present+1)); else missing="$missing $v"; fi
    done
  fi
  if [ "$present" = "0" ]; then echo "NOT_CONFIGURED"; return 0; fi
  if [ -n "$missing" ]; then
    echo "PARTIALLY_CONFIGURED missing:$missing"
    return 2
  fi
  echo "CONFIGURED"; return 0
}
if [ "${1:-}" = "--check-config" ]; then check_config; exit $?; fi
[ $# -eq 0 ] || { echo "offsite-backup: unknown argument (only --check-config is supported)" >&2; exit 2; }

CFG="$(check_config)" || { echo "offsite-backup: $CFG" >&2; exit 2; }
[ "$CFG" = "CONFIGURED" ] || { echo "offsite-backup: not configured — nothing to do" >&2; exit 2; }
for bin in docker python3 rclone age curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "offsite-backup: required tool not found: $bin" >&2; exit 2; }
done

RUNNER_TAG="${CF_OFFSITE_RUNNER_TAG:-github-actions}"
HEARTBEAT="${CF_OFFSITE_HEARTBEAT:-1}"
VERIFY="${CF_OFFSITE_VERIFY:-1}"
REDACT="${CF_OFFSITE_REDACT:-1}"
UPLOAD_VERIFY="${CF_OFFSITE_UPLOAD_VERIFY:-auto}"
export PGSSLMODE="${CF_OFFSITE_PGSSLMODE:-require}"
export PGCONNECT_TIMEOUT=30
export PGAPPNAME="crewflow-offsite-backup"
export CF_DB_URL="$CF_OFFSITE_DB_URL"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BACKUP_DATE="$(date -u +%Y-%m-%d)"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-${RUNNER_TAG}-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
NAME="crewflow-offsite-${STAMP}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-offsite.XXXXXX")"; chmod 700 "$WORK"
LOGS="$WORK/logs"; mkdir -p "$LOGS"
BUNDLE="$WORK/$NAME"; mkdir -p "$BUNDLE/db" "$BUNDLE/storage"
TOOLS="cf-offsite-tools-$$-$(date +%s)"
# rclone must never read the operator's own config (it may hold other remotes).
export RCLONE_CONFIG="$WORK/rclone.conf"; : > "$RCLONE_CONFIG"

STAGE="init"; STATUS="running"; ERR=""; MIG_TIP=""; UPLOAD_STATUS="skipped"
HB_MANIFEST='{}'; VERIFY_RESULT="not_run"; HB_FAILED=0

log(){ printf '%s [%s] %s\n' "$(date -u +%H:%M:%S)" "$STAGE" "$*" >&2; }
abort(){ ERR="$1"; log "FATAL: $ERR"; return 1; }
num(){ if [ "$REDACT" = "1" ]; then echo "withheld"; else echo "$1"; fi; }
sha256_of(){ python3 -c 'import hashlib,sys
h=hashlib.sha256()
with open(sys.argv[1],"rb") as f:
    for c in iter(lambda: f.read(1<<20), b""): h.update(c)
print(h.hexdigest())' "$1"; }

RETRIES="${CF_OFFSITE_RETRIES:-3}"
retry(){ # retry <desc> <cmd...> — transient network blips must not fail a nightly backup
  local desc="$1"; shift; local n=1 delay=10
  while :; do
    if "$@"; then return 0; fi
    if [ "$n" -ge "$RETRIES" ]; then log "gave up after $n attempts: $desc"; return 1; fi
    log "attempt $n/$RETRIES failed ($desc) — retrying in ${delay}s"; sleep "$delay"; n=$((n+1)); delay=$((delay*2))
  done
}

ping_hc(){ # ping_hc <suffix> — dead-man's switch; never fails the run
  [ -n "${CF_OFFSITE_HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 15 --retry 3 -o /dev/null "${CF_OFFSITE_HEALTHCHECK_URL%/}$1" 2>/dev/null || log "healthcheck ping failed (non-fatal)"
}

# --- heartbeat: same table + columns as the Mac layer, distinct `host` tag ----
heartbeat(){ # heartbeat <status> <finished_at|"">
  [ "$HEARTBEAT" = "1" ] || return 0
  docker exec -i -e CF_DB_URL -e PGSSLMODE -e PGCONNECT_TIMEOUT -e PGAPPNAME "$TOOLS" \
    sh -c 'exec psql "$CF_DB_URL" "$@"' sh -X -q -v ON_ERROR_STOP=1 \
      -v run_id="$RUN_ID" -v host="$RUNNER_TAG" -v bdate="$BACKUP_DATE" -v started="$STARTED_AT" \
      -v finished="$2" -v status="$1" -v stage="$STAGE" -v tip="$MIG_TIP" -v upload="$UPLOAD_STATUS" \
      -v err="$ERR" -v manifest="$HB_MANIFEST" -f - >/dev/null 2>>"$LOGS/heartbeat.log" <<'SQL'
insert into public.ops_backup_runs
  (run_id, host, backup_date, started_at, finished_at, status, stage, migration_tip, upload_status, error, file_manifest)
values
  (:'run_id', :'host', :'bdate'::date, :'started'::timestamptz, nullif(:'finished', '')::timestamptz,
   :'status', :'stage', nullif(:'tip', ''), :'upload', nullif(:'err', ''), :'manifest'::jsonb)
on conflict (run_id) do update set
  finished_at = excluded.finished_at, status = excluded.status, stage = excluded.stage,
  migration_tip = excluded.migration_tip, upload_status = excluded.upload_status,
  error = excluded.error, file_manifest = excluded.file_manifest;
SQL
}

cleanup(){
  local rc=$?
  trap - EXIT ERR
  if [ "$STATUS" != "success" ]; then
    [ "$rc" = "0" ] && rc=1
    STATUS="failed"
    [ -n "$ERR" ] || ERR="unexpected failure at stage=$STAGE"
    log "BACKUP FAILED at stage=$STAGE: $ERR"
    heartbeat "failed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || log "failure heartbeat could not be written"
    ping_hc "/fail"
  fi
  docker rm -f -v "$TOOLS" >/dev/null 2>&1 || true
  # LOCAL TROUBLESHOOTING ONLY: keep the raw tool logs (they can name Storage
  # objects). Never set this in CI — the workflow does not, and a test pins that.
  if [ -n "${CF_OFFSITE_DEBUG_LOG_DIR:-}" ]; then
    mkdir -p "$CF_OFFSITE_DEBUG_LOG_DIR" && cp -R "$LOGS/." "$CF_OFFSITE_DEBUG_LOG_DIR/" 2>/dev/null || true
  fi
  # The work dir holds PLAINTEXT production data until this line. Always remove it.
  rm -rf "$WORK" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

log "independent off-site backup starting (run_id=$RUN_ID, runner=$RUNNER_TAG)"
ping_hc "/start"

# === recipients: PUBLIC keys only ============================================
STAGE="recipients"
RECIPIENT_ARGS=(); RECIPIENT_FPS=()
for r in $(printf '%s' "$CF_OFFSITE_AGE_RECIPIENTS" | tr ',\n\r\t' '    '); do
  case "$r" in
    AGE-SECRET-KEY-*) abort "CF_OFFSITE_AGE_RECIPIENTS contains a PRIVATE age key — remove it, treat it as compromised and generate a new keypair" ;;
  esac
  printf '%s' "$r" | grep -Eq '^age1[0-9a-z]{58}$' || abort "CF_OFFSITE_AGE_RECIPIENTS has an entry that is not an age public key (age1…)"
  RECIPIENT_ARGS+=(--recipient "$r")
  # A short fingerprint lets the founder confirm WHICH key a backup was sealed to.
  RECIPIENT_FPS+=("$(printf '%s' "$r" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:16])')")
done
[ "${#RECIPIENT_ARGS[@]}" -gt 0 ] || abort "no age recipient configured"
log "encrypting to ${#RECIPIENT_FPS[@]} recipient(s): fingerprint(s) ${RECIPIENT_FPS[*]}"

# === tools container (pinned Postgres client == production major) ============
STAGE="tools"
if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
  retry "pull postgres image" docker pull -q "$PG_IMAGE" >/dev/null 2>>"$LOGS/docker.log" || abort "could not pull the pinned Postgres image"
fi
docker run -d --name "$TOOLS" --add-host=host.docker.internal:host-gateway --entrypoint sleep "$PG_IMAGE" infinity \
  >/dev/null 2>>"$LOGS/docker.log" || abort "could not start the Postgres tools container"
docker exec -u 0 "$TOOLS" sh -c 'mkdir -p /cfwork/db /cfwork/logs /cflib && chmod -R 777 /cfwork' 2>>"$LOGS/docker.log" \
  || abort "could not prepare the tools container"
docker cp -q "$LIB_DIR/." "$TOOLS:/cflib/" 2>>"$LOGS/docker.log" || abort "could not copy the capture scripts into the tools container"

heartbeat "running" "" || { HB_FAILED=1; log "WARN: could not write the 'running' heartbeat (continuing; the final heartbeat is mandatory)"; }

# === capture: snapshot-consistent dump + facts ===============================
STAGE="capture"
capture_once(){
  docker exec "$TOOLS" sh -c 'rm -f /cfwork/db/db.dump /cfwork/db/facts.json /cfwork/db/pg_dump.rc /cfwork/db/privacy-tombstones.*' || return 1
  docker exec -e CF_DB_URL -e PGSSLMODE -e PGCONNECT_TIMEOUT -e PGAPPNAME "$TOOLS" \
    sh -c 'exec psql "$CF_DB_URL" -X -q -v managed="$1" -f /cflib/offsite-capture.psql' sh "$MANAGED_SCHEMAS" \
    >>"$LOGS/capture.log" 2>&1 || return 1
  [ "$(docker exec "$TOOLS" cat /cfwork/db/pg_dump.rc 2>/dev/null || echo 98)" = "0" ] || return 1
}
C0="$(date +%s)"
retry "snapshot capture (pg_dump + facts)" capture_once \
  || abort "database capture failed (connection, privileges or pg_dump error — see the runbook's troubleshooting table)"
docker cp -q "$TOOLS:/cfwork/db/db.dump" "$BUNDLE/db/db.dump" && docker cp -q "$TOOLS:/cfwork/db/facts.json" "$WORK/facts.json" \
  || abort "could not copy the dump out of the tools container"
[ -s "$BUNDLE/db/db.dump" ] && [ -s "$WORK/facts.json" ] || abort "capture produced an empty dump or empty facts"
TOC_N="$(docker exec "$TOOLS" sh -c "pg_restore -l /cfwork/db/db.dump | grep -vc '^;'" 2>>"$LOGS/capture.log")" \
  || abort "the dump's table of contents is unreadable (truncated dump)"
MIG_TIP="$(python3 "$BUNDLE_PY" field --file "$WORK/facts.json" --path migration_tip)"
N_TABLES="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["table_counts"]))' "$WORK/facts.json")"
BUCKETS="$(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["storage_buckets"]))' "$WORK/facts.json")"
log "captured: $N_TABLES tables, $TOC_N TOC entries, migration tip $MIG_TIP, $(( $(date +%s) - C0 ))s"

# --- HOOK: privacy tombstone export (see lib/offsite-capture.psql) -------------
# Kept OUTSIDE the bundle and uploaded as its own object under tombstones/, so a
# restore of ANY older dump can be followed by re-applying every later deletion.
TOMB_STATE="$(docker exec "$TOOLS" cat /cfwork/db/privacy-tombstones.state 2>/dev/null | tr -d '[:space:]' || true)"
TOMB_FILE=""; TOMB_N=0
case "$TOMB_STATE" in
  exported)
    docker cp -q "$TOOLS:/cfwork/db/privacy-tombstones.jsonl" "$WORK/tombstones.jsonl" \
      || abort "tombstone export exists in the database but could not be copied out"
    TOMB_WANT="$(docker exec "$TOOLS" cat /cfwork/db/privacy-tombstones.expected 2>/dev/null | tr -d '[:space:]' || true)"
    TOMB_N="$(grep -c . "$WORK/tombstones.jsonl" || true)"
    # A silently EMPTY export would let erased people come back after a restore.
    [ -n "$TOMB_WANT" ] && [ "$TOMB_N" = "$TOMB_WANT" ] \
      || abort "tombstone export is incomplete (rows exported differ from completed deletions on record)"
    TOMB_FILE="$WORK/tombstones.jsonl"
    log "privacy tombstones: exported (count $(num "$TOMB_N"))" ;;
  no_privilege)
    log "WARN: privacy tombstone export exists but this role may not execute it — NOT exported (grant EXECUTE to the backup role; see FOUNDER-CHECKLIST)" ;;
  *)
    TOMB_STATE="absent"
    log "privacy tombstone export: function not present in this database — hook inactive" ;;
esac

# === storage: every bucket, verified against the source ======================
STAGE="storage"
export RCLONE_CONFIG_CFSRC_TYPE=s3
export RCLONE_CONFIG_CFSRC_PROVIDER=Other
export RCLONE_CONFIG_CFSRC_ENDPOINT="$CF_OFFSITE_S3_ENDPOINT"
export RCLONE_CONFIG_CFSRC_REGION="$CF_OFFSITE_S3_REGION"
export RCLONE_CONFIG_CFSRC_ACCESS_KEY_ID="$CF_OFFSITE_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_CFSRC_SECRET_ACCESS_KEY="$CF_OFFSITE_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_CFSRC_FORCE_PATH_STYLE=true
copy_bucket(){ rclone copy "cfsrc:$1" "$BUNDLE/storage/$1" --transfers 4 --checkers 8 --retries 2 --low-level-retries 5 >>"$LOGS/rclone-src.log" 2>&1; }
check_bucket(){ rclone check "cfsrc:$1" "$BUNDLE/storage/$1" --one-way >>"$LOGS/rclone-src.log" 2>&1; }
copy_and_check_bucket(){ copy_bucket "$1" && check_bucket "$1"; }
N_BUCKETS=0
while IFS= read -r b; do
  [ -n "$b" ] || continue
  N_BUCKETS=$((N_BUCKETS+1))
  mkdir -p "$BUNDLE/storage/$b"
  # Copy, then an independent integrity pass (rclone re-reads sizes + hashes from
  # the source). Retried as ONE unit: an object uploaded between the two steps
  # makes the check fail, and the retry's copy then picks it up.
  retry "storage copy + check (bucket $N_BUCKETS)" copy_and_check_bucket "$b" \
    || abort "Storage copy failed or differs from the source for a bucket (S3 endpoint, key, network)"
done <<EOF
$BUCKETS
EOF
find "$BUNDLE/storage" -type d -empty -delete 2>/dev/null || true
mkdir -p "$BUNDLE/storage"
# Second listing AFTER the copy: an object present both at the snapshot and now
# existed throughout and MUST have been captured (see offsite_bundle.py).
docker exec -e CF_DB_URL -e PGSSLMODE -e PGCONNECT_TIMEOUT -e PGAPPNAME "$TOOLS" sh -c \
  'exec psql "$CF_DB_URL" -X -q -At -v ON_ERROR_STOP=1 -c "select coalesce(json_agg(json_build_object('"'"'bucket'"'"', bucket_id, '"'"'name'"'"', name, '"'"'size'"'"', nullif(metadata ->> '"'"'size'"'"', '"'"''"'"')::bigint)), '"'"'[]'"'"'::json) from storage.objects"' \
  > "$WORK/post-objects.json" 2>>"$LOGS/capture.log" || abort "could not re-list storage.objects after the Storage copy"

# === manifest + checksums ====================================================
STAGE="manifest"
SUMMARY="$(python3 "$BUNDLE_PY" build-manifest --bundle "$BUNDLE" --facts "$WORK/facts.json" \
  --post-objects "$WORK/post-objects.json" --stamp "$STAMP" --created-at "$STARTED_AT" \
  --runner "$RUNNER_TAG" --pg-image "$PG_IMAGE" --toc-entries "$TOC_N")" \
  || abort "Storage capture is INCOMPLETE: objects recorded in storage.objects are missing from, or differ in size in, the download"
N_OBJECTS="$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["storage_objects"])')"
python3 "$BUNDLE_PY" write-sums --bundle "$BUNDLE" >/dev/null || abort "could not write SHA256SUMS"
python3 "$BUNDLE_PY" verify-bundle --bundle "$BUNDLE" --redact >"$LOGS/self-verify.log" 2>&1 || abort "bundle failed its own checksum verification"
log "storage: $N_BUCKETS buckets, objects: $(num "$N_OBJECTS"); manifest + checksums written and self-verified"

# === package + encrypt (public-key only) =====================================
STAGE="package"
TAR="$WORK/$NAME.tar"
# Python tarfile, not the system tar: byte-for-byte the same layout on Linux and
# macOS (bsdtar adds AppleDouble members), sorted and owner-neutral.
TAR_SHA="$(python3 "$BUNDLE_PY" pack --bundle "$BUNDLE" --out "$TAR" 2>>"$LOGS/tar.log")" || abort "could not create the bundle tar"

STAGE="encrypt"
ART="$WORK/$NAME.tar.age"
age --encrypt "${RECIPIENT_ARGS[@]}" --output "$ART" "$TAR" 2>>"$LOGS/age.log" || abort "age encryption failed"
[ -s "$ART" ] || abort "encryption produced an empty artefact"
[ "$(head -c 21 "$ART")" = "age-encryption.org/v1" ] || abort "artefact does not carry the age header"
# Tool self-test with a THROWAWAY key: proves this machine's age binary round-trips
# byte-exactly. It cannot (by design) prove the founder's key decrypts — that is the
# job of the key-check canary below and of the founder's restore drill.
age-keygen -o "$WORK/selftest.key" >/dev/null 2>&1 || abort "age-keygen failed"
ST_PUB="$(age-keygen -y "$WORK/selftest.key")"
printf 'crewflow-offsite-selftest-%s' "$STAMP" > "$WORK/selftest.txt"
age --encrypt --recipient "$ST_PUB" --output "$WORK/selftest.age" "$WORK/selftest.txt" 2>>"$LOGS/age.log" \
  && age --decrypt --identity "$WORK/selftest.key" --output "$WORK/selftest.out" "$WORK/selftest.age" 2>>"$LOGS/age.log" \
  && cmp -s "$WORK/selftest.txt" "$WORK/selftest.out" || abort "age round-trip self-test failed on this machine"
rm -f "$WORK/selftest.key" "$WORK/selftest.txt" "$WORK/selftest.age" "$WORK/selftest.out"
# Key-check canary: a tiny NON-personal token sealed to the real recipients. The
# founder can prove they still hold a working private key by decrypting THIS —
# without ever opening customer data. Its expected sha256 is in the sidecar.
CANARY_TXT="crewflow-offsite-keycheck ${STAMP} $(python3 -c 'import secrets; print(secrets.token_hex(16))')"
CANARY_SHA="$(printf '%s' "$CANARY_TXT" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
printf '%s' "$CANARY_TXT" | age --encrypt "${RECIPIENT_ARGS[@]}" --output "$WORK/$NAME.keycheck.age" 2>>"$LOGS/age.log" || abort "could not seal the key-check canary"

TOMB_ART=""
if [ -n "$TOMB_FILE" ]; then
  TOMB_ART="$WORK/crewflow-tombstones-${STAMP}.jsonl.age"
  age --encrypt "${RECIPIENT_ARGS[@]}" --output "$TOMB_ART" "$TOMB_FILE" 2>>"$LOGS/age.log" || abort "could not encrypt the tombstone export"
fi

SIDECAR="$WORK/$NAME.tar.age.json"
FP_ARGS=(); for fp in "${RECIPIENT_FPS[@]}"; do FP_ARGS+=(--recipient-fp "$fp"); done
ART_SHA="$(python3 "$BUNDLE_PY" sidecar --bundle "$BUNDLE" --artefact "$ART" --tar-sha256 "$TAR_SHA" "${FP_ARGS[@]}" --out "$SIDECAR")" \
  || abort "could not write the sidecar"
python3 - "$SIDECAR" "$CANARY_SHA" <<'PY'
import json, sys
p, sha = sys.argv[1:3]
d = json.load(open(p)); d["keycheck_plaintext_sha256"] = sha
json.dump(d, open(p, "w"), indent=1, sort_keys=True)
PY
ART_BYTES="$(wc -c < "$ART" | tr -d ' ')"
log "encrypted artefact: $ART_BYTES bytes, sha256 ${ART_SHA:0:16}…"

# === upload (append-only by design: nothing is ever deleted here) ============
STAGE="upload"
if [ -n "${CF_OFFSITE_DEST:-}" ]; then
  DEST="${CF_OFFSITE_DEST%/}"
else
  export RCLONE_CONFIG_CFDEST_TYPE=b2
  export RCLONE_CONFIG_CFDEST_ACCOUNT="$CF_OFFSITE_B2_KEY_ID"
  export RCLONE_CONFIG_CFDEST_KEY="$CF_OFFSITE_B2_APPLICATION_KEY"
  DEST="cfdest:${CF_OFFSITE_B2_BUCKET}"
fi
if [ -n "${CF_OFFSITE_TIERS:-}" ]; then
  TIERS="$CF_OFFSITE_TIERS"
else
  TIERS="daily"
  [ "$(date -u +%u)" = "7" ] && TIERS="$TIERS weekly"
  [ "$(date -u +%d)" = "01" ] && TIERS="$TIERS monthly"
fi
# --no-check-dest/--no-traverse: never LIST the destination, so a write-only key
# is enough. B2 verifies the SHA-1 rclone sends with every upload server-side.
put(){ rclone copyto "$1" "$2" --no-check-dest --no-traverse --retries 2 --low-level-retries 5 >>"$LOGS/rclone-dest.log" 2>&1; }
UPLOAD_MODE="ack"
for tier in $TIERS; do
  for f in "$ART" "$SIDECAR" "$WORK/$NAME.keycheck.age"; do
    retry "upload to $tier/" put "$f" "$DEST/$tier/$(basename "$f")" \
      || { UPLOAD_STATUS="upload_failed"; abort "off-site upload failed (tier $tier)"; }
  done
  # Where the key may list (listFiles — still no read, no delete) confirm the size
  # the bucket actually holds. A write-only key cannot list: the API ack stands.
  if [ "$UPLOAD_VERIFY" != "ack" ]; then
    RSIZE="$(rclone lsjson "$DEST/$tier/$NAME.tar.age" 2>>"$LOGS/rclone-dest.log" \
      | python3 -c 'import json,sys
try: print(json.load(sys.stdin)[0]["Size"])
except Exception: print("")' 2>/dev/null || true)"
    if [ -n "$RSIZE" ]; then
      [ "$RSIZE" = "$ART_BYTES" ] || { UPLOAD_STATUS="upload_size_mismatch"; abort "remote size differs from the local artefact (tier $tier)"; }
      UPLOAD_MODE="listed"
    elif [ "$UPLOAD_VERIFY" = "list" ]; then
      UPLOAD_STATUS="upload_unverified"; abort "could not list the uploaded artefact but CF_OFFSITE_UPLOAD_VERIFY=list requires it"
    fi
  fi
done
if [ -n "$TOMB_ART" ]; then
  # Own prefix, own (longer) lifecycle: each export is cumulative, so the NEWEST
  # one is what a restore re-applies — whichever dump is being restored.
  retry "upload tombstone export" put "$TOMB_ART" "$DEST/tombstones/$(basename "$TOMB_ART")" \
    || { UPLOAD_STATUS="upload_failed"; abort "off-site upload of the tombstone export failed"; }
fi
UPLOAD_STATUS="uploaded"
log "uploaded to tier(s): $TIERS (verification: $UPLOAD_MODE)"

# === restore verification of the SAME tar that was encrypted =================
STAGE="restore_verify"
if [ "$VERIFY" = "1" ]; then
  RV_ARGS=(--tar "$TAR" --expect-tar-sha256 "$TAR_SHA" --image "$PG_IMAGE")
  [ "$REDACT" = "1" ] && RV_ARGS+=(--redact)
  set +e
  bash "$SELF_DIR/restore-verify.sh" "${RV_ARGS[@]}"
  RV_RC=$?
  set -e
  case "$RV_RC" in
    0) VERIFY_RESULT="passed" ;;
    1) VERIFY_RESULT="failed"; abort "the uploaded backup FAILED restore verification — treat this artefact as NOT restorable" ;;
    *) VERIFY_RESULT="error"; abort "restore verification could not run (environment error) — the artefact is uploaded but UNPROVEN" ;;
  esac
  printf '{"artefact":"%s","restore_verify":"%s","verified_at":"%s"}\n' "$NAME.tar.age" "$VERIFY_RESULT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/$NAME.verify.json"
  for tier in $TIERS; do
    retry "upload verify marker" put "$WORK/$NAME.verify.json" "$DEST/$tier/$NAME.verify.json" || log "WARN: could not upload the verify marker (non-fatal)"
  done
else
  VERIFY_RESULT="skipped"
  log "restore verification SKIPPED (CF_OFFSITE_VERIFY=0) — this run proves capture + upload only"
fi

# === success: only now =======================================================
STAGE="done"
HB_MANIFEST="$(python3 - "$NAME.tar.age" "$ART_BYTES" "$ART_SHA" "$TAR_SHA" "$TIERS" "$N_TABLES" "$N_OBJECTS" "$VERIFY_RESULT" "$UPLOAD_MODE" "$RUNNER_TAG" "${RECIPIENT_FPS[*]}" "$TOMB_STATE" "$TOMB_N" <<'PY'
import json, sys
a = sys.argv[1:]
print(json.dumps({
  "format": "crewflow-offsite/1", "layer": "independent-runner", "runner": a[9],
  "encrypted_artifact": a[0], "encrypted_bytes": int(a[1]), "encrypted_sha256": a[2],
  "plaintext_tar_sha256": a[3], "tiers": a[4].split(), "tables": int(a[5]),
  "storage_object_count": int(a[6]), "restore_verify": a[7], "upload_verify": a[8],
  "encryption": "age", "recipient_fingerprints": a[10].split(),
  "privacy_tombstones": {"state": a[11], "count": int(a[12])},
}))
PY
)"
if ! heartbeat "success" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
  STAGE="heartbeat"
  abort "backup is uploaded and verified, but the success heartbeat could NOT be written — /admin/ops will go stale"
fi
STATUS="success"
ping_hc ""
log "BACKUP SUCCESS (db + storage captured at one snapshot, encrypted to public key(s), upload=$UPLOAD_STATUS, restore_verify=$VERIFY_RESULT, tip=$MIG_TIP)"
exit 0
