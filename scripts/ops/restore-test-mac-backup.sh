#!/usr/bin/env bash
#
# CrewFlow — RESTORE TEST for the Mac off-platform backup (<date>.tar.enc)
# ========================================================================
# off-platform-backup.sh proves an artefact decrypts, extracts and matches its checksums.
# That is not a restore. This script loads the backup into a real PostgreSQL and checks the
# result — the step that was missing (first run 2026-11-15).
#
#   restore-test-mac-backup.sh [--artifact <file.tar.enc>] [--key <key file>] [--keep]
#     --artifact  default: the newest ~/CrewFlow-backups/*.tar.enc
#     --key       default: ~/.config/crewflow-backup/backup.key
#     --keep      leave the container running for inspection (prints its name)
#
# SAFETY / PRIVACY
#   * Production is never contacted. Nothing is written anywhere except the throwaway container.
#   * The container has NO network (--network none) and its database AND the decrypted files
#     live on tmpfs (RAM): the artefact is decrypted by openssl on the host and piped straight
#     into the container, so no plaintext production data touches the host disk. Removing the
#     container destroys everything. It is always removed on exit unless --keep is given.
#   * Prints counts and PASS/FAIL only — never row contents or object names.
#
# WHAT THE BACKUP DOES NOT CONTAIN (found by this test — see docs/backup-recovery-runbook.md)
#   * the `auth` and `storage` SCHEMA DEFINITIONS (GoTrue / Storage own them). A real restore
#     targets a Supabase project, which creates them; this test borrows them from the local
#     Supabase stack and adds, as plain text columns, any column production has that the local
#     stack's older GoTrue / Storage does not (reported below, never hidden).
#   * the migration history (`supabase_migrations.schema_migrations`). After a real restore,
#     re-record it with `supabase migration repair` up to the tip in MANIFEST.json.
#
# Exit: 0 restore verified · 1 verification failed · 2 environment / usage error.
#
set -Euo pipefail
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/libpq/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

BACKUP_ROOT="${CF_BACKUP_ROOT:-$HOME/CrewFlow-backups}"
KEY="${CF_BACKUP_ENC_KEY:-$HOME/.config/crewflow-backup/backup.key}"
LOCAL_DB_URL="${CF_RESTORE_LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
LOCAL_DB_CONTAINER="${CF_RESTORE_LOCAL_DB_CONTAINER:-supabase_db_crewflow}"
ARTIFACT=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ARTIFACT" ] || ARTIFACT="$(ls -1t "$BACKUP_ROOT"/*.tar.enc 2>/dev/null | head -1 || true)"
die(){ echo "ENVIRONMENT: $*" >&2; exit 2; }
[ -s "$ARTIFACT" ] || die "no artefact found (looked for $BACKUP_ROOT/*.tar.enc)"
[ -s "$KEY" ] || die "key file not found: $KEY"
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || die "Docker is not running"
docker inspect "$LOCAL_DB_CONTAINER" >/dev/null 2>&1 || die "local Supabase stack is not running (needed for the auth/storage structure and the Postgres image): run \`supabase start\`"
IMAGE="${CF_RESTORE_IMAGE:-$(docker inspect "$LOCAL_DB_CONTAINER" --format '{{.Config.Image}}')}"
DATE="$(basename "$ARTIFACT" .tar.enc)"
C="cf-restore-test-$$"
FAILS=0
pass(){ printf 'PASS  %s\n' "$*"; }
fail(){ printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS+1)); }
cleanup(){ if [ "$KEEP" = "1" ]; then echo "kept container: $C"; else docker rm -f "$C" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
px(){ docker exec -i "$C" psql -U supabase_admin -d postgres -At "$@"; }
scalar(){ printf '%s\n' "$1" | px | head -1; }

echo "artefact: $(basename "$ARTIFACT") ($(wc -c < "$ARTIFACT" | tr -d ' ') bytes) · image: $IMAGE"
if [ -s "${ARTIFACT}.sha256" ]; then
  [ "$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')" = "$(cat "${ARTIFACT}.sha256")" ] \
    && pass "encrypted artefact matches its recorded SHA-256" || fail "encrypted artefact does NOT match its recorded SHA-256"
fi

# 1. throwaway, network-less, RAM-only Postgres (same build family as production)
#    MEMORY: the container's memory cgroup limit (was 3g, now 4g) covers EVERYTHING RAM-backed: the tmpfs data
#    directory (grows through the restore), pg_wal (which lives in it), the /restore tmpfs, shared
#    buffers and the backends. The image's defaults (wal_level=logical, max_wal_size=1GB,
#    full_page_writes on) let a bulk restore put up to ~1GB of WAL ON TOP of the data in RAM, and a
#    5-second sample of a normal run already read 2.48 of 3.0 GiB; a slightly larger artefact or a
#    concurrent memory spike is then OOM-killed mid-restore. A restore TEST needs no WAL history,
#    replication or crash safety, so it is switched off: that removes the WAL from RAM without
#    touching what is restored or verified.
docker run -d --name "$C" --network none --memory 4g --memory-swap 4g \
  --tmpfs /var/lib/postgresql/data:rw,size=3g --tmpfs /restore:rw,size=1500m \
  -e POSTGRES_PASSWORD=restore-test-only "$IMAGE" \
  postgres -D /etc/postgresql \
  -c wal_level=minimal -c max_wal_senders=0 -c archive_mode=off \
  -c max_wal_size=192MB -c min_wal_size=32MB -c checkpoint_timeout=30min \
  -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
  -c autovacuum=off -c maintenance_work_mem=128MB -c max_connections=20 \
  >/dev/null || die "could not start the throwaway container"
for _i in $(seq 1 60); do docker exec "$C" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
sleep 8   # the image runs its init scripts and restarts once
for _i in $(seq 1 30); do [ "$(scalar 'select 1;' 2>/dev/null)" = "1" ] && break; sleep 2; done
[ "$(scalar 'select 1;' 2>/dev/null)" = "1" ] || die "throwaway Postgres did not become ready"

# 2. decrypt on the host, pipe straight into the container's tmpfs
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$KEY" -in "$ARTIFACT" 2>/dev/null \
     | docker exec -i "$C" tar -xf - -C /restore; then
  pass "decrypts and extracts (plaintext only inside the container's RAM)"
else
  fail "decrypt / extract failed"; exit 1
fi
B="/restore/$DATE"
docker exec "$C" sh -c "cd $B && sha256sum -c SHA256SUMS >/dev/null 2>&1" \
  && pass "every file matches SHA256SUMS" || fail "checksum mismatch inside the bundle"

# 3. auth + storage STRUCTURE (not part of the backup): borrow from the local stack, then add any
#    column the backup's rows need that this older local GoTrue / Storage does not have.
pg_dump "$LOCAL_DB_URL" --schema-only -n auth -n storage --clean --if-exists --no-owner 2>/dev/null \
  | px -q -v ON_ERROR_STOP=0 >/dev/null 2>&1 || true
ADDED="$(docker exec "$C" sh -c "grep -E '^INSERT INTO \"(auth|storage)\"\\.' $B/data.sql" | python3 -c '
import re,sys
for line in sys.stdin:
    m=re.match(r"INSERT INTO \"(auth|storage)\"\.\"([a-z_]+)\" \(([^)]*)\)", line)
    if not m: continue
    for col in re.findall(r"\"([a-z_0-9]+)\"", m.group(3)):
        print(f"{m.group(1)}.{m.group(2)}.{col}")' | while IFS=. read -r sch tbl col; do
  have="$(scalar "select count(*) from information_schema.columns where table_schema='$sch' and table_name='$tbl' and column_name='$col';")"
  if [ "$have" = "0" ]; then
    # stdin from /dev/null: docker exec -i would otherwise consume the rest of the loop input
    px -q -c "alter table \"$sch\".\"$tbl\" add column if not exists \"$col\" text;" </dev/null >/dev/null 2>&1 && echo "$sch.$tbl.$col"
  fi
done | tr '\n' ' ')"
[ -n "$ADDED" ] && echo "NOTE  production's auth/storage schema is newer than the local stack; added for this test: $ADDED"

# 4. the restore itself
docker exec "$C" sh -c "psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=0 -f $B/schema.sql > /restore/schema.out 2>&1"
E="$(docker exec "$C" sh -c 'grep -c ERROR /restore/schema.out || true')"
[ "$E" = "0" ] && pass "schema.sql restored with 0 errors" || fail "schema.sql restore raised $E error(s)"
docker exec "$C" sh -c "psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=0 -f $B/data.sql > /restore/data.out 2>&1"
E="$(docker exec "$C" sh -c 'grep -c ERROR /restore/data.out || true')"
if [ "$E" = "0" ]; then pass "data.sql (public + auth + storage rows) restored with 0 errors"; else
  fail "data.sql restore raised $E error(s):"
  docker exec "$C" sh -c "grep ERROR /restore/data.out | sed 's/^psql:[^ ]* //' | cut -c1-160 | sort | uniq -c | head -5"
fi
# migration history (present in backups taken from 2026-11-16; older artefacts do not have it)
if docker exec "$C" test -s "$B/migration-history.sql"; then
  px -q -c "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text, created_by text, idempotency_key text, rollback text[]);" </dev/null >/dev/null 2>&1 || true
  docker exec "$C" sh -c "psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=0 -f $B/migration-history.sql > /restore/mh.out 2>&1"
  E="$(docker exec "$C" sh -c 'grep -c ERROR /restore/mh.out || true')"
  TIP="$(scalar 'select max(version) from supabase_migrations.schema_migrations;')"
  [ "$E" = "0" ] && [ -n "$TIP" ] && pass "migration history restored (tip $TIP)" || fail "migration history restore raised $E error(s)"
else
  echo "NOTE  this artefact predates the migration-history capture (no migration-history.sql) — after a real restore, re-record the history with \`supabase migration repair\`"
fi
px -q -c "analyze;" </dev/null >/dev/null 2>&1 || true

# 5. what came back
n(){ scalar "$1"; }
ORGS="$(n 'select count(*) from public.organizations;')"; USERS="$(n 'select count(*) from auth.users;')"
[ "${ORGS:-0}" -gt 0 ] && pass "organisations restored ($ORGS)" || fail "no organisations restored"
[ "${USERS:-0}" -gt 0 ] && pass "auth users restored ($USERS)" || fail "no auth users restored"
echo "INFO  public tables $(n "select count(*) from pg_tables where schemaname='public';") · holding rows $(n "select count(*) from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind='r' and c.reltuples<>0;") · RLS policies $(n "select count(*) from pg_policies where schemaname='public';") · functions $(n "select count(*) from pg_proc where pronamespace='public'::regnamespace and prokind in ('f','p');") · buckets $(n 'select count(*) from storage.buckets;')"
z(){ local label="$1" v; v="$(n "$2")"; [ "$v" = "0" ] && pass "$label" || fail "$label — found $v"; }
z "no invalid indexes" "select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and not i.indisvalid;"
z "no membership without its organisation or user" "select count(*) from public.memberships m where not exists (select 1 from public.organizations o where o.id=m.org_id) or not exists (select 1 from public.users u where u.id=m.user_id);"
z "no customer without its organisation" "select count(*) from public.customers c where not exists (select 1 from public.organizations o where o.id=c.org_id);"
z "every application user has its auth identity" "select count(*) from public.users u where not exists (select 1 from auth.users a where a.id=u.id);"
RLS_OFF="$(n "select count(*) from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind='r' and not c.relrowsecurity and exists (select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='org_id' and not a.attisdropped);")"
[ "$RLS_OFF" = "0" ] && pass "row-level security is enabled on every org-scoped table" || fail "$RLS_OFF org-scoped table(s) restored WITHOUT row-level security"

# 6. Storage: every storage.objects row has its file in the bundle, with the recorded size
OBJ="$(n 'select count(*) from storage.objects;')"
BAD="$(printf "select bucket_id||'/'||name||'|'||coalesce(metadata->>'size','') from storage.objects;\n" | px \
  | docker exec -i "$C" sh -c "cd $B/storage 2>/dev/null && while IFS='|' read -r p s; do if [ -f \"\$p\" ] && [ \"\$(wc -c < \"\$p\" | tr -d ' ')\" = \"\$s\" ]; then :; else echo bad; fi; done | wc -l" | tr -d ' ')"
[ "${BAD:-1}" = "0" ] && pass "all $OBJ Storage object(s) are in the bundle with the recorded size" || fail "$BAD of $OBJ Storage object(s) missing or wrong size"

echo
if [ "$FAILS" = "0" ]; then echo "RESTORE VERIFIED — the backup loads into PostgreSQL and is internally consistent."; exit 0
else echo "RESTORE TEST FAILED — $FAILS check(s) failed."; exit 1; fi
