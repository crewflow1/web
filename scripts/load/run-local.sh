#!/usr/bin/env bash
# scripts/load/run-local.sh — one LOCAL load run, end to end.
#
#   ALWAYS through the RAM mutex (it starts the shared :3000 server and k6):
#     bash ~/Code/cf-wt/_shared/heavy.sh bash scripts/load/run-local.sh <stage> [think_scale] [tag]
#   e.g. … run-local.sh smoke 1 lt1     |   … run-local.sh local 1 lt1   |   … run-local.sh local 0.2 lt1
#
# Prerequisites: `npm run build` done (production build in .next), local Supabase
# up, dataset seeded (`node scripts/load/seed.mjs --orgs 25 --tag lt1`), env from
# ~/Code/cf-wt/_shared/local-env.sh. LOCAL ONLY: refuses anything but loopback.
#
# Steps: guard → action-id map from the build → `next start` on :3000 (with the
# outbound-call tracer preloaded) → collector → k6 → stop collector → kill :3000.
# Output: load/results/<UTC timestamp>-<stage>/ (gitignored): k6-summary.{json,md},
# collector.{json,md}, collector-samples.jsonl, trace.jsonl, REPORT.md.
set -euo pipefail

STAGE="${1:-smoke}"
THINK="${2:-1}"
TAG="${3:-lt1}"
PORT=3000
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/libpq/bin:$PATH"

: "${API_URL:?source ~/Code/cf-wt/_shared/local-env.sh first}"
: "${ANON_KEY:?source ~/Code/cf-wt/_shared/local-env.sh first}"
DB="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# 1. guard — node side (DB + API) and k6 side (init context) both refuse non-local.
node --input-type=module -e "
import { authoriseTarget } from './scripts/load/_guard.mjs';
for (const [u, w] of [[process.argv[1], 'database URL'], [process.argv[2], 'Supabase URL']]) {
  if (authoriseTarget(u, w) !== 'local') { console.error('run-local.sh is LOCAL ONLY'); process.exit(1); }
}" "$DB" "$API_URL"

[ -f .next/BUILD_ID ] || { echo "no production build (.next/BUILD_ID) — run heavy.sh npm run build first" >&2; exit 1; }
[ -f "load/k6/.manifest/${TAG}.json" ] || { echo "no manifest for tag ${TAG} — seed first" >&2; exit 1; }
if lsof -t -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo ":${PORT} is already in use by another process — refusing to start (shared-server rule)" >&2; exit 1
fi

OUT="$REPO/load/results/$(date -u +%Y%m%dT%H%M%SZ)-${STAGE}-t${THINK}"
mkdir -p "$OUT"
node scripts/load/discover-actions.mjs >/dev/null

# HQ persona identities must be allowlisted for /admin (this process only).
HQ_EMAILS="$(node -e 'const m=require(process.argv[1]);console.log(Array.from({length:m.hq},(_,i)=>`lt-${m.tag}-hq${i+1}@loadtest.crewflow.invalid`).join(","))' "$REPO/load/k6/.manifest/${TAG}.json")"

cleanup() {
  [ -n "${COLLECTOR_PID:-}" ] && kill -INT "$COLLECTOR_PID" 2>/dev/null && wait "$COLLECTOR_PID" 2>/dev/null || true
  lsof -t -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT

# 2. production server (next start), tracer preloaded (records counts/timings only).
CREWFLOW_SUPERADMIN_EMAILS="$HQ_EMAILS" \
LOAD_TRACE_FILE="$OUT/trace.jsonl" \
NODE_OPTIONS="--require $REPO/scripts/load/trace-fetch.cjs" \
PORT=$PORT nohup "$REPO/node_modules/.bin/next" start -p $PORT > "$OUT/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -fsS -o /dev/null "http://localhost:${PORT}/api/health" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://localhost:${PORT}/api/health" || { echo "server did not become healthy" >&2; tail -20 "$OUT/next.log" >&2; exit 1; }

# 3. collector (pg_stat_activity, docker stats, next CPU, pg_stat_statements delta)
node scripts/load/collect.mjs --out "$OUT" --interval 3 --db "$DB" --next-pid "$NEXT_PID" 2>"$OUT/collector.log" &
COLLECTOR_PID=$!

# 4. k6
set +e
BASE_URL="http://localhost:${PORT}" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" \
STAGE="$STAGE" THINK_SCALE="$THINK" LOAD_TAG="$TAG" \
MANIFEST="$REPO/load/k6/.manifest/${TAG}.json" ACTIONS="$REPO/load/k6/.manifest/actions.json" \
RESULTS_DIR="$OUT" K6_NO_USAGE_REPORT=true \
  k6 run --quiet "$REPO/load/k6/scenarios/mixed.js" > "$OUT/k6-stdout.md" 2> "$OUT/k6.log"
K6_EXIT=$?
set -e

# 5. stop collector, summarise outbound fan-out, assemble the report
kill -INT "$COLLECTOR_PID" 2>/dev/null; wait "$COLLECTOR_PID" 2>/dev/null || true
COLLECTOR_PID=""
node scripts/load/trace-summary.mjs "$OUT/trace.jsonl" > "$OUT/trace.md" 2>/dev/null || echo "(no trace summary)" > "$OUT/trace.md"
{
  cat "$OUT/k6-summary.md" 2>/dev/null || cat "$OUT/k6-stdout.md"
  echo
  cat "$OUT/collector.md" 2>/dev/null || true
  echo
  cat "$OUT/trace.md"
  echo
  echo "_k6 exit code: ${K6_EXIT} (99 = a threshold failed; 108 = aborted by a threshold/abort)_"
} > "$OUT/REPORT.md"
echo "$OUT"
exit 0
