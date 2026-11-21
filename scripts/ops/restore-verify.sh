#!/usr/bin/env bash
#
# CrewFlow restore verification — proves a backup artefact actually RESTORES
# =========================================================================
# Takes one artefact produced by scripts/ops/offsite-backup.sh, restores its
# database into a THROWAWAY Postgres container, and asserts the restored copy is
# identical to what the manifest says the source held at the dump snapshot.
#
#   restore-verify.sh --artefact <file.tar.age> --identity <age-key-file> [--sidecar <file.json>]
#   restore-verify.sh --tar <bundle.tar>          # plaintext tar (the runner, BEFORE encryption)
#   restore-verify.sh --bundle-dir <dir>          # an already-extracted bundle
#
# Options:
#   --expect-tar-sha256 <hex>  the decrypted tar must hash to this (the runner records it)
#   --sidecar <file.json>      read that expectation from the artefact's sidecar instead
#   --image <ref>              Postgres image (default: the pinned Supabase build, PG 17)
#   --redact                   withhold every row/object COUNT (use where logs are public)
#   --keep                     keep the container + work dir for debugging (prints their names)
#   --inject-fault-sql <file>  TEST ONLY: run this SQL in the throwaway DB after the restore,
#                              to prove the assertions fail when the restored data is wrong
#
# What it asserts (each prints PASS/FAIL; any FAIL => exit 1):
#   1. the artefact decrypts and the tar is intact (age is authenticated encryption)
#   2. every file matches SHA256SUMS; the dump and every Storage object match MANIFEST.json
#   3. pg_restore completes with ZERO errors
#   4. Postgres major version, migration tip + count, schema list
#   5. schema object counts (tables, indexes, constraints, policies, triggers, functions,
#      Data-API grants, column ACLs ...) are identical
#   6. per-table row counts are identical for every table
#   7. key constraints: every PK/UNIQUE is backed by a valid unique index, and an
#      independent scan finds zero orphaned rows across every validated foreign key
#   8. every restored storage.objects row has its file in the bundle, sizes agree
#
# PRIVACY: prints counts, catalogue identifiers and PASS/FAIL only — never row
# contents, never Storage object names. Raw tool output stays in the private work
# dir, which is deleted on exit. The throwaway container has NO network
# (--network none) and no published port; it is always removed on exit.
#
# ISOLATION: this never touches the shared local Supabase stack or any real
# database — it only ever talks to the container it starts itself.
#
# Exit: 0 all checks passed · 1 verification FAILED · 2 usage/environment error.
#
set -Euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SELF_DIR/lib"
BUNDLE_PY="$LIB_DIR/offsite_bundle.py"
# Same Postgres build family as production (PG 17.6), pinned by DIGEST — it carries
# the Supabase roles + extensions, so ownership, grants and extension-typed columns
# restore faithfully. Multi-arch index (amd64 runner + arm64 Mac). This is
# supabase/postgres 17.6.1.121 — the image the local Supabase CLI stack already
# uses, so a Mac that runs `supabase start` needs no download. The workflow
# passes the identical digest from ghcr.io (authenticated pulls, no throttling).
DEFAULT_PG_IMAGE="public.ecr.aws/supabase/postgres@sha256:69e57a409628a809e3778a4d176eb97e32d7c961131ac025b77ad094c0b2d49e"

ARTEFACT=""; IDENTITY=""; TAR_IN=""; BUNDLE_DIR=""; SIDECAR=""; EXPECT_TAR_SHA=""
PG_IMAGE="${CF_PG_IMAGE:-$DEFAULT_PG_IMAGE}"
REDACT=0; KEEP=0; FAULT_SQL=""

usage(){ sed -n '2,/^set -Euo/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'; }
die(){ echo "restore-verify: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --artefact) ARTEFACT="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --tar) TAR_IN="${2:-}"; shift 2 ;;
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift 2 ;;
    --sidecar) SIDECAR="${2:-}"; shift 2 ;;
    --expect-tar-sha256) EXPECT_TAR_SHA="${2:-}"; shift 2 ;;
    --image) PG_IMAGE="${2:-}"; shift 2 ;;
    --redact) REDACT=1; shift ;;
    --keep) KEEP=1; shift ;;
    --inject-fault-sql) FAULT_SQL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

n_inputs=0
[ -n "$ARTEFACT" ] && n_inputs=$((n_inputs+1))
[ -n "$TAR_IN" ] && n_inputs=$((n_inputs+1))
[ -n "$BUNDLE_DIR" ] && n_inputs=$((n_inputs+1))
[ "$n_inputs" = "1" ] || die "give exactly one of --artefact, --tar, --bundle-dir"
if [ -n "$ARTEFACT" ]; then
  [ -f "$ARTEFACT" ] || die "artefact not found"
  [ -n "$IDENTITY" ] && [ -f "$IDENTITY" ] || die "--artefact needs --identity <age identity file>"
  command -v age >/dev/null 2>&1 || die "age is not installed (brew install age / apt-get install age)"
fi
[ -z "$TAR_IN" ] || [ -f "$TAR_IN" ] || die "tar not found"
[ -z "$BUNDLE_DIR" ] || [ -d "$BUNDLE_DIR" ] || die "bundle dir not found"
[ -z "$SIDECAR" ] || [ -f "$SIDECAR" ] || die "sidecar not found"
[ -z "$FAULT_SQL" ] || [ -f "$FAULT_SQL" ] || die "fault SQL file not found"
command -v docker >/dev/null 2>&1 || die "docker is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"

REDACT_FLAG=""; [ "$REDACT" = "1" ] && REDACT_FLAG="--redact"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-restore-verify.XXXXXX")"; chmod 700 "$WORK"
CONTAINER="cf-restore-verify-$$-$(date +%s)"
PW="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
FAILS=0
STARTED_S="$(date +%s)"

cleanup(){
  local rc=$?
  if [ "$KEEP" = "1" ]; then
    echo "KEEP: container=$CONTAINER workdir=$WORK (remove both when done: they hold restored data)" >&2
  else
    docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pass(){ printf 'PASS  %-34s %s\n' "$1" "${2:-}"; }
fail(){ printf 'FAIL  %-34s %s\n' "$1" "${2:-}"; FAILS=$((FAILS+1)); }
sha256_of(){ python3 -c 'import hashlib,sys
h=hashlib.sha256()
with open(sys.argv[1],"rb") as f:
    for c in iter(lambda: f.read(1<<20), b""): h.update(c)
print(h.hexdigest())' "$1"; }
finish(){
  local dur=$(( $(date +%s) - STARTED_S ))
  echo "----------------------------------------------------------------------"
  if [ "$FAILS" -gt 0 ]; then
    echo "RESTORE VERIFICATION: FAILED ($FAILS failing check group(s), ${dur}s)"
    exit 1
  fi
  echo "RESTORE VERIFICATION: PASSED (${dur}s)"
  exit 0
}

echo "CrewFlow restore verification — throwaway container, no network, counts only"
echo "----------------------------------------------------------------------"

# === 1. obtain the plaintext bundle =========================================
if [ -n "$SIDECAR" ] && [ -z "$EXPECT_TAR_SHA" ]; then
  EXPECT_TAR_SHA="$(python3 "$BUNDLE_PY" field --file "$SIDECAR" --path plaintext_tar_sha256 2>/dev/null || true)"
  [ -n "$EXPECT_TAR_SHA" ] || die "sidecar has no plaintext_tar_sha256"
  if [ -n "$ARTEFACT" ]; then
    want_enc="$(python3 "$BUNDLE_PY" field --file "$SIDECAR" --path encrypted_sha256 2>/dev/null || true)"
    if [ "$(sha256_of "$ARTEFACT")" = "$want_enc" ]; then
      pass "artefact sha256 (sidecar)" "encrypted file is byte-identical to what was uploaded"
    else
      fail "artefact sha256 (sidecar)" "encrypted file differs from the sidecar's sha256 (corrupt or wrong file)"
      finish
    fi
  fi
fi

TAR_PATH=""
if [ -n "$ARTEFACT" ]; then
  TAR_PATH="$WORK/bundle.tar"
  # age is AEAD (ChaCha20-Poly1305, chunked): a truncated, bit-flipped or
  # wrong-key artefact fails HERE, loudly, and yields no plaintext.
  if age --decrypt --identity "$IDENTITY" --output "$TAR_PATH" "$ARTEFACT" 2>"$WORK/age.err"; then
    pass "decrypt (age)" "artefact decrypted with the supplied identity"
  else
    rm -f "$TAR_PATH"
    fail "decrypt (age)" "artefact did NOT decrypt (truncated, corrupted, or not encrypted to this identity)"
    finish
  fi
elif [ -n "$TAR_IN" ]; then
  TAR_PATH="$TAR_IN"
fi

if [ -n "$TAR_PATH" ]; then
  if [ -n "$EXPECT_TAR_SHA" ]; then
    if [ "$(sha256_of "$TAR_PATH")" = "$EXPECT_TAR_SHA" ]; then
      pass "plaintext tar sha256" "matches the hash recorded when the backup was taken"
    else
      fail "plaintext tar sha256" "decrypted tar does not match the recorded hash"
      finish
    fi
  fi
  mkdir -p "$WORK/x"
  if BUNDLE="$(python3 "$BUNDLE_PY" safe-extract --tar "$TAR_PATH" --dest "$WORK/x" 2>"$WORK/extract.err")"; then
    pass "tar extraction" "archive is complete and well-formed"
  else
    fail "tar extraction" "archive is truncated, malformed or unsafe"
    finish
  fi
  # The decrypted tar is no longer needed; do not keep a second plaintext copy.
  [ -n "$ARTEFACT" ] && rm -f "$TAR_PATH"
else
  BUNDLE="$BUNDLE_DIR"
fi

# === 2. bundle integrity (checksums + manifest) ==============================
# shellcheck disable=SC2086
python3 "$BUNDLE_PY" verify-bundle --bundle "$BUNDLE" $REDACT_FLAG || { FAILS=$((FAILS+1)); finish; }

SCHEMAS="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["facts"]["schemas"]))' "$BUNDLE/MANIFEST.json")"
case "$SCHEMAS" in ''|*[!a-z0-9_,]*) fail "manifest schema list" "empty or unsupported"; finish ;; esac

# === 3. throwaway Postgres (same major as production; no network) ============
if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
  pulled=0
  for attempt in 1 2 3; do
    if docker pull -q "$PG_IMAGE" >/dev/null 2>"$WORK/pull.err"; then pulled=1; break; fi
    sleep $((attempt * 10))
  done
  [ "$pulled" = "1" ] || die "could not pull the Postgres image (network/registry) — this is an ENVIRONMENT failure, not a verdict on the backup"
fi
docker run -d --name "$CONTAINER" --network none --memory "${CF_RV_MEMORY:-2g}" \
  -e POSTGRES_PASSWORD="$PW" "$PG_IMAGE" >/dev/null 2>"$WORK/run.err" \
  || die "could not start the throwaway Postgres container"
ready=0
for _ in $(seq 1 90); do
  if docker exec -e PGPASSWORD="$PW" "$CONTAINER" psql -X -q -At -h localhost -U supabase_admin -d postgres -c 'select 1' >/dev/null 2>&1; then
    ready=$((ready+1)); [ "$ready" -ge 2 ] && break   # two consecutive: past the init-time restart
  else
    ready=0
  fi
  sleep 1
done
[ "$ready" -ge 2 ] || die "throwaway Postgres did not become ready"

psql_c(){ docker exec -i -e PGPASSWORD="$PW" "$CONTAINER" psql -X -q -At -h localhost -U supabase_admin "$@"; }

psql_c -d postgres -v ON_ERROR_STOP=1 -c 'create database rv_restore template template0' >/dev/null 2>"$WORK/createdb.err" \
  || die "could not create the restore database"
SERVER_V="$(psql_c -d rv_restore -c 'show server_version' 2>/dev/null || echo '?')"
echo "INFO  throwaway postgres              PostgreSQL $SERVER_V, container has no network"

{ docker exec -u 0 "$CONTAINER" mkdir -p /rv \
  && docker cp -q "$BUNDLE/db/db.dump" "$CONTAINER:/rv/db.dump" \
  && docker cp -q "$LIB_DIR/backup-facts.sql" "$CONTAINER:/rv/backup-facts.sql" \
  && docker cp -q "$LIB_DIR/restore-integrity.sql" "$CONTAINER:/rv/restore-integrity.sql" \
  && docker exec -u 0 "$CONTAINER" chmod -R a+rX /rv; } 2>"$WORK/cp.err" \
  || die "could not copy the dump into the throwaway container"

# Roles the dump's ownership/ACLs reference + the extensions its column types
# and defaults depend on. A failure here means "this image cannot host the
# backup" — reported as a failed check, with identifiers only.
if python3 "$BUNDLE_PY" prep-sql --bundle "$BUNDLE" | psql_c -d rv_restore -f - >/dev/null 2>"$WORK/prep.err"; then
  pass "target prepared" "roles + extensions from the manifest created"
else
  fail "target prepared" "could not create a role/extension the backup depends on"
  grep -E '^(psql:[^ ]* )?ERROR:' "$WORK/prep.err" | sed -e 's/^psql:[^ ]* //' | cut -c1-160 | head -5 | sed 's/^/        /'
  finish
fi

# === 4. restore — must complete with ZERO errors =============================
# `public` already exists in every Postgres database, so its CREATE SCHEMA entry
# is removed from the restore list (its ACL entries are still restored). Nothing
# else is filtered: any other error is a real restore defect.
docker exec -u 0 "$CONTAINER" sh -c \
  "pg_restore -l /rv/db.dump | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public ' > /rv/toc.list" 2>"$WORK/toc.err" \
  || { fail "dump table of contents" "pg_restore could not read the dump's TOC (truncated/corrupt dump)"; finish; }
TOC_N="$(docker exec "$CONTAINER" sh -c "grep -vc '^;' /rv/toc.list" 2>/dev/null || echo 0)"

R0="$(date +%s)"
restore_rc=0
docker exec -e PGPASSWORD="$PW" "$CONTAINER" pg_restore -h localhost -U supabase_admin -d rv_restore \
  --no-password -L /rv/toc.list /rv/db.dump >"$WORK/restore.out" 2>"$WORK/restore.err" || restore_rc=$?
RESTORE_S=$(( $(date +%s) - R0 ))
err_n="$(grep -c 'pg_restore: error:' "$WORK/restore.err" || true)"
warn_n="$(grep -c 'pg_restore: warning:' "$WORK/restore.err" || true)"
# Strict: a clean restore is exit 0 with NOTHING on stderr (warnings count too).
if [ "$restore_rc" = "0" ] && [ ! -s "$WORK/restore.err" ]; then
  pass "pg_restore" "$TOC_N TOC entries restored, 0 errors, 0 warnings, ${RESTORE_S}s"
else
  fail "pg_restore" "exit=$restore_rc, $err_n error(s), $warn_n warning(s) — the dump does not restore cleanly"
  # Identifiers only: the TOC entry (object type + name) each error belongs to.
  # ERROR/DETAIL/CONTEXT text is withheld — it can quote row values.
  grep -E '^pg_restore: (from TOC entry|error: (could not|unsupported|unexpected|corrupt|did not find|out of memory|invalid|input file))' \
    "$WORK/restore.err" | sed -e 's/: ERROR:.*$//' | cut -c1-140 | head -15 | sed 's/^/        /'
fi

if [ -n "$FAULT_SQL" ]; then
  echo "INFO  TEST FAULT INJECTED              (--inject-fault-sql; throwaway DB only)"
  psql_c -d rv_restore -v ON_ERROR_STOP=1 -f - < "$FAULT_SQL" >/dev/null 2>"$WORK/fault.err" \
    || die "fault-injection SQL failed to apply"
fi

# === 5–6, 8. like-for-like facts: source-at-snapshot vs restored ==============
if psql_c -d rv_restore -v ON_ERROR_STOP=1 -v schemas="$SCHEMAS" -f /rv/backup-facts.sql \
     >"$WORK/restored.json" 2>"$WORK/facts.err"; then
  # shellcheck disable=SC2086
  python3 "$BUNDLE_PY" compare --bundle "$BUNDLE" --restored "$WORK/restored.json" $REDACT_FLAG || FAILS=$((FAILS+1))
else
  fail "restored catalogue readable" "the facts query failed on the restored database (schema incomplete)"
fi

# === 7. key constraints — independent referential-integrity scan =============
if psql_c -d rv_restore -v schemas="$SCHEMAS" -f /rv/restore-integrity.sql >"$WORK/integrity.out" 2>"$WORK/integrity.err"; then
  IFS='|' read -r fk_n fk_bad fk_skip key_n key_bad < "$WORK/integrity.out" || true
  if [ "${key_bad:-1}" = "0" ] && [ "${key_n:-0}" -gt 0 ]; then
    pass "primary/unique keys" "$key_n constraints, each backed by a valid unique index"
  else
    fail "primary/unique keys" "${key_bad:-?} of ${key_n:-?} key constraint(s) lack a valid unique index"
  fi
  if [ "${fk_bad:-1}" = "0" ] && [ "${fk_n:-0}" -gt 0 ]; then
    pass "foreign keys (orphan scan)" "$fk_n validated FKs scanned, 0 orphaned rows (${fk_skip:-0} NOT VALID at source, skipped)"
  else
    fail "foreign keys (orphan scan)" "${fk_bad:-?} of ${fk_n:-?} foreign key(s) have orphaned rows"
    grep '^VIOLATION' "$WORK/integrity.out" | head -15 | while IFS='|' read -r _ child conname orphans; do
      if [ "$REDACT" = "1" ]; then echo "        $child  $conname"; else echo "        $child  $conname  orphans=$orphans"; fi
    done
  fi
else
  fail "key constraints" "the integrity scan could not run on the restored database"
fi

finish
