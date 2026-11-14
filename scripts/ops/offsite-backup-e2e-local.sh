#!/usr/bin/env bash
#
# LOCAL, SYNTHETIC end-to-end proof of the independent backup pipeline.
# =====================================================================
# Backs up the LOCAL Supabase stack (synthetic data only) with the real engine
# (scripts/ops/offsite-backup.sh), encrypts to a THROWAWAY age keypair, uploads
# to a local directory standing in for the off-site bucket, then runs
# scripts/ops/restore-verify.sh against the encrypted artefact — and then proves
# the verification FAILS LOUDLY for each deliberate corruption.
#
# Never touches production, never touches ~/CrewFlow-backups, never restores
# into the shared local stack (restores go to a throwaway container).
# It creates one synthetic Storage bucket and one heartbeat row in the LOCAL
# database and removes both on exit.
#
# Needs: a running local Supabase stack (run from the repo root), docker,
# python3, rclone, age + age-keygen on PATH.
#
# Usage: bash scripts/ops/offsite-backup-e2e-local.sh
# Exit : 0 if every expectation held, 1 otherwise.
#
set -Euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/../.." && pwd)"

for bin in docker python3 rclone age age-keygen supabase; do
  command -v "$bin" >/dev/null 2>&1 || { echo "e2e: missing tool: $bin" >&2; exit 2; }
done
ENVTXT="$(cd "$ROOT" && supabase status -o env 2>/dev/null)" || { echo "e2e: local Supabase stack is not running" >&2; exit 2; }
val(){ printf '%s\n' "$ENVTXT" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" | head -1; }
LOCAL_DB="$(val DB_URL)"; S3_URL="$(val STORAGE_S3_URL)"
case "$LOCAL_DB" in *@127.0.0.1:*|*@localhost:*) ;; *) echo "e2e: refusing — DB_URL is not a local database" >&2; exit 2 ;; esac

E2E="$(mktemp -d "${TMPDIR:-/tmp}/cf-offsite-e2e.XXXXXX")"; chmod 700 "$E2E"
DEST="$E2E/offsite-bucket"; mkdir -p "$DEST"
TAG="backupws-e2e-$$"
BUCKET="$TAG"
RUNNER="$TAG"
export RCLONE_CONFIG="$E2E/rclone.conf"; : > "$RCLONE_CONFIG"
export RCLONE_CONFIG_E2ESRC_TYPE=s3 RCLONE_CONFIG_E2ESRC_PROVIDER=Other RCLONE_CONFIG_E2ESRC_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_E2ESRC_ENDPOINT="$S3_URL" RCLONE_CONFIG_E2ESRC_REGION="$(val S3_PROTOCOL_REGION)"
export RCLONE_CONFIG_E2ESRC_ACCESS_KEY_ID="$(val S3_PROTOCOL_ACCESS_KEY_ID)"
export RCLONE_CONFIG_E2ESRC_SECRET_ACCESS_KEY="$(val S3_PROTOCOL_ACCESS_KEY_SECRET)"
PG_IMAGE="${CF_PG_IMAGE:-public.ecr.aws/supabase/postgres@sha256:69e57a409628a809e3778a4d176eb97e32d7c961131ac025b77ad094c0b2d49e}"
# From inside a container the host's loopback is host.docker.internal.
CONTAINER_DB="$(printf '%s' "$LOCAL_DB" | sed -e 's/@127\.0\.0\.1:/@host.docker.internal:/' -e 's/@localhost:/@host.docker.internal:/')"

local_sql(){ docker run --rm -i --add-host=host.docker.internal:host-gateway -e U="$CONTAINER_DB" -e PGSSLMODE=disable \
  --entrypoint sh "$PG_IMAGE" -c 'exec psql "$U" -X -q -At -v ON_ERROR_STOP=1 "$@"' sh "$@"; }

FAILED=0; N=0
drop_bucket(){ # `rclone purge` does not empty a bucket on this S3 endpoint: delete, then remove.
  rclone delete "e2esrc:$1" >/dev/null 2>&1 || true
  rclone rmdir "e2esrc:$1" >/dev/null 2>&1 || true
}
cleanup(){
  drop_bucket "$BUCKET"; drop_bucket "$BUCKET-restored"
  local_sql -c "delete from public.ops_backup_runs where host = '$RUNNER'" >/dev/null 2>&1 || true
  rm -rf "$E2E"
}
trap cleanup EXIT

expect(){ # expect <want-exit> <title> <cmd...> ; shows the tool's own PASS/FAIL lines
  local want="$1" title="$2"; shift 2; N=$((N+1))
  echo; echo "=== [$N] $title (expect exit $want) ==="
  set +e; "$@" > "$E2E/out.txt" 2>&1; local got=$?; set -e
  grep -E '^(PASS|FAIL|INFO|RESTORE VERIFICATION|        )' "$E2E/out.txt" || tail -5 "$E2E/out.txt"
  if [ "$got" = "$want" ]; then echo ">>> OK: exit $got as expected"
  else echo ">>> UNEXPECTED: exit $got, wanted $want"; FAILED=$((FAILED+1)); fi
}
set -e

echo "### 1. synthetic Storage objects in local bucket $BUCKET"
mkdir -p "$E2E/seed/docs/sub"
python3 - "$E2E/seed" <<'PY'
import os, sys
root = sys.argv[1]
open(os.path.join(root, "docs", "synthetic-a.txt"), "w").write("synthetic backup e2e object A\n" * 50)
open(os.path.join(root, "docs", "sub", "synthetic-b.bin"), "wb").write(os.urandom(300_000))
open(os.path.join(root, "synthetic-c.json"), "w").write('{"synthetic": true}\n')
PY
rclone mkdir "e2esrc:$BUCKET"
rclone copy "$E2E/seed" "e2esrc:$BUCKET" -q
echo "uploaded $(find "$E2E/seed" -type f | wc -l | tr -d ' ') synthetic objects"

echo "### 2. throwaway age keypair (the 'founder' key) + an unrelated key"
age-keygen -o "$E2E/founder.key" 2>/dev/null; RECIP="$(age-keygen -y "$E2E/founder.key")"
age-keygen -o "$E2E/stranger.key" 2>/dev/null

echo "### 3. backup with the real engine (non-interactive capture, encrypt, upload, verify, heartbeat)"
set +e
CF_OFFSITE_DB_URL="$CONTAINER_DB" CF_OFFSITE_PGSSLMODE=disable \
CF_OFFSITE_S3_ENDPOINT="$S3_URL" CF_OFFSITE_S3_REGION="$RCLONE_CONFIG_E2ESRC_REGION" \
CF_OFFSITE_S3_ACCESS_KEY_ID="$RCLONE_CONFIG_E2ESRC_ACCESS_KEY_ID" \
CF_OFFSITE_S3_SECRET_ACCESS_KEY="$RCLONE_CONFIG_E2ESRC_SECRET_ACCESS_KEY" \
CF_OFFSITE_AGE_RECIPIENTS="$RECIP" CF_OFFSITE_DEST="$DEST" CF_OFFSITE_RUNNER_TAG="$RUNNER" \
CF_OFFSITE_REDACT="${CF_E2E_REDACT:-0}" CF_OFFSITE_TIERS="daily weekly" CF_PG_IMAGE="$PG_IMAGE" \
CF_RV_MEMORY="${CF_RV_MEMORY:-1g}" TMPDIR="$E2E" \
  bash "$SELF_DIR/offsite-backup.sh"
BK_RC=$?
set -e
[ "$BK_RC" = "0" ] || { echo ">>> backup run FAILED (exit $BK_RC)"; exit 1; }
ART="$(ls "$DEST"/daily/*.tar.age | head -1)"; SIDE="$ART.json"
echo "off-site bucket now holds:"; (cd "$DEST" && find . -type f | sort | sed 's/^/   /')
echo "heartbeat row(s) for this runner: $(local_sql -c "select status || ' / stage=' || stage || ' / upload=' || upload_status || ' / verify=' || (file_manifest->>'restore_verify') from public.ops_backup_runs where host = '$RUNNER'")"
[ "$(head -c 21 "$ART")" = "age-encryption.org/v1" ] && echo "artefact is age ciphertext (no plaintext tar header)"
cmp -s "$ART" "$DEST/weekly/$(basename "$ART")" && echo "weekly tier copy is byte-identical"

RV=(bash "$SELF_DIR/restore-verify.sh" --image "$PG_IMAGE")
[ "${CF_E2E_REDACT:-0}" = "1" ] && RV+=(--redact)
export TMPDIR="$E2E" CF_RV_MEMORY="${CF_RV_MEMORY:-1g}"

expect 0 "GOOD artefact, founder key, sidecar"      "${RV[@]}" --artefact "$ART" --identity "$E2E/founder.key" --sidecar "$SIDE"

KC="$(ls "$DEST"/daily/*.keycheck.age | head -1)"
if [ "$(age --decrypt --identity "$E2E/founder.key" "$KC" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')" \
     = "$(python3 "$SELF_DIR/lib/offsite_bundle.py" field --file "$SIDE" --path keycheck_plaintext_sha256)" ]; then
  echo; echo ">>> OK: key-check canary decrypts with the founder key and matches the sidecar (no data opened)"
else echo ">>> UNEXPECTED: key-check canary mismatch"; FAILED=$((FAILED+1)); fi

SIZE="$(wc -c < "$ART" | tr -d ' ')"
head -c $((SIZE * 6 / 10)) "$ART" > "$E2E/truncated.tar.age"
expect 1 "TRUNCATED artefact (60% of the file)"     "${RV[@]}" --artefact "$E2E/truncated.tar.age" --identity "$E2E/founder.key"

python3 - "$ART" "$E2E/bitflip.tar.age" <<'PY'
import sys
data = bytearray(open(sys.argv[1], "rb").read())
data[len(data) // 2] ^= 0x01            # one flipped bit in the middle of the ciphertext
open(sys.argv[2], "wb").write(data)
PY
expect 1 "CORRUPTED artefact (one flipped bit)"     "${RV[@]}" --artefact "$E2E/bitflip.tar.age" --identity "$E2E/founder.key"
expect 1 "CORRUPTED artefact vs sidecar sha256"     "${RV[@]}" --artefact "$E2E/bitflip.tar.age" --identity "$E2E/founder.key" --sidecar "$SIDE"
expect 1 "WRONG key (artefact not sealed to it)"    "${RV[@]}" --artefact "$ART" --identity "$E2E/stranger.key"

# Plaintext-level corruptions: decrypt once (test key, synthetic data) and damage the bundle.
age --decrypt --identity "$E2E/founder.key" --output "$E2E/good.tar" "$ART"
python3 "$SELF_DIR/lib/offsite_bundle.py" safe-extract --tar "$E2E/good.tar" --dest "$E2E/x" > "$E2E/root.txt"
B="$(cat "$E2E/root.txt")"

cp -R "$B" "$E2E/b-storage"; OBJ="$(find "$E2E/b-storage/storage/$BUCKET" -type f | head -1)"; printf 'X' >> "$OBJ"
expect 1 "Storage object altered after capture"     "${RV[@]}" --bundle-dir "$E2E/b-storage"

cp -R "$B" "$E2E/b-dump"
python3 - "$E2E/b-dump" <<'PY'
import hashlib, json, os, sys
b = sys.argv[1]; dump = os.path.join(b, "db", "db.dump")
data = open(dump, "rb").read(); open(dump, "wb").write(data[: len(data) // 2])   # dump cut in half…
m = json.load(open(os.path.join(b, "MANIFEST.json")))
m["db"]["bytes"] = os.path.getsize(dump); m["db"]["sha256"] = hashlib.sha256(open(dump, "rb").read()).hexdigest()
json.dump(m, open(os.path.join(b, "MANIFEST.json"), "w"), indent=1, sort_keys=True)
PY
python3 "$SELF_DIR/lib/offsite_bundle.py" write-sums --bundle "$E2E/b-dump" >/dev/null   # …and RE-CHECKSUMMED, so only a real restore can catch it
expect 1 "TRUNCATED dump with VALID checksums"      "${RV[@]}" --bundle-dir "$E2E/b-dump"

cat > "$E2E/fault-rows.sql" <<'SQL'
-- simulate "the restore lost rows": remove the newest migration record
delete from supabase_migrations.schema_migrations
 where version = (select max(version) from supabase_migrations.schema_migrations);
SQL
expect 1 "restored data MISSING rows (fault injected)" "${RV[@]}" --bundle-dir "$B" --inject-fault-sql "$E2E/fault-rows.sql"

cat > "$E2E/fault-fk.sql" <<'SQL'
-- simulate "referential integrity broken": orphan a child row behind the constraint's back
set session_replication_role = replica;
insert into public.memberships (org_id, user_id, role)
select gen_random_uuid(), gen_random_uuid(), (select role from public.memberships limit 1)
where exists (select 1 from public.memberships);
SQL
expect 1 "restored data with ORPHANED foreign key (fault injected)" "${RV[@]}" --bundle-dir "$B" --inject-fault-sql "$E2E/fault-fk.sql"

echo; echo "### Storage restore procedure (rclone back into a scratch bucket, then compare)"
rclone mkdir "e2esrc:$BUCKET-restored"
rclone copy "$B/storage/$BUCKET" "e2esrc:$BUCKET-restored" -q
if rclone check "e2esrc:$BUCKET" "e2esrc:$BUCKET-restored" >/dev/null 2>&1; then echo ">>> OK: restored bucket is identical to the source bucket"
else echo ">>> UNEXPECTED: restored bucket differs"; FAILED=$((FAILED+1)); fi
drop_bucket "$BUCKET-restored"

echo; echo "### leftovers check"
drop_bucket "$BUCKET"
[ -z "$(rclone lsd e2esrc: 2>/dev/null | awk '{print $NF}' | grep "^$TAG" || true)" ] && echo ">>> OK: synthetic buckets removed" \
  || { echo ">>> UNEXPECTED: synthetic bucket left behind"; FAILED=$((FAILED+1)); }
docker ps -a --format '{{.Names}}' | grep -E '^cf-(restore-verify|offsite-tools)-' && { echo ">>> UNEXPECTED: container left behind"; FAILED=$((FAILED+1)); } || echo ">>> OK: no backup/verify containers left behind"

echo; echo "======================================================================"
if [ "$FAILED" = "0" ]; then echo "E2E RESULT: ALL EXPECTATIONS HELD"; exit 0; fi
echo "E2E RESULT: $FAILED expectation(s) NOT met"; exit 1
