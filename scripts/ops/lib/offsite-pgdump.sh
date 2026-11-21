#!/bin/sh
# offsite-pgdump.sh — runs INSIDE the pinned Postgres tools container, invoked by
# `\!` from offsite-capture.psql while that session holds the exported snapshot.
#
# psql does not propagate a `\!` exit status, so the result is written to
# /cfwork/db/pg_dump.rc and checked by the caller (offsite-backup.sh). The file
# starts as 97 ("did not finish") so a crash can never read as success.
#
# Env (set by the psql session): CF_DB_URL, CF_SNAPSHOT, CF_SCHEMAS.
# Never echoes CF_DB_URL. pg_dump/libpq never print a password.
set -u
rc_file=/cfwork/db/pg_dump.rc
echo 97 > "$rc_file"

# Schema names are interpolated into pg_dump arguments: accept only plain
# lower-case identifiers. Anything else is a loud failure (96), never a guess.
case "${CF_SCHEMAS:-}" in
  '' | *[!a-z0-9_,]*)
    echo "offsite-pgdump: empty or unsupported schema list" >&2
    echo 96 > "$rc_file"
    exit 0
    ;;
esac

args=""
old_ifs=$IFS
IFS=,
for s in $CF_SCHEMAS; do
  args="$args --schema=$s"
done
IFS=$old_ifs

# Custom format: compressed, carries a table of contents (restore-verify lists
# it), and allows selective restore (e.g. data-only for auth onto a fresh
# Supabase project). Ownership and ACLs are KEPT — Data-API grants matter.
# shellcheck disable=SC2086
pg_dump "$CF_DB_URL" \
  --format=custom \
  --snapshot="$CF_SNAPSHOT" \
  $args \
  --file=/cfwork/db/db.dump 2>> /cfwork/logs/pg_dump.log
echo $? > "$rc_file"
exit 0
