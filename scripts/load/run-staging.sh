#!/usr/bin/env bash
# scripts/load/run-staging.sh — ONE gate against the HOSTED STAGING stack, from a load-generator VM.
#
#   scripts/load/run-staging.sh <stage: 100|500|1k|5k|10k|25k|50k> <tag> [segment_index total_segments]
#
# NEVER run without the founder's written approval of this gate's spend
# (docs/engineering/LOAD-TEST-APPROVAL-REQUEST.md). Nothing here is run by the harness author.
#
# Required env (values are never printed):
#   LOAD_STAGING_HOST   staging app host, e.g. crewflow-load.vercel.app   (or a self-hosted app VM)
#   LOAD_STAGING_REF    staging Supabase project ref (must appear in SUPABASE_URL)
#   SUPABASE_URL        https://<ref>.supabase.co
#   SUPABASE_ANON_KEY   the STAGING project's anon key
#   LOAD_USER_PASSWORD  the password the seed used (>= 12 chars)
# Optional: BASE_URL (default https://$LOAD_STAGING_HOST), THINK_SCALE (default 1; keep 1 for user counts),
#   STAGING_DB_URL (enables the sentinel check + collector), GATE_DEADLINE_MIN (default 150; hard kill).
#
# Distributed run (G4+): every generator runs the SAME command with its own segment, e.g. VM 3 of 10:
#   scripts/load/run-staging.sh 50k g7 3 10
set -euo pipefail

STAGE="${1:?stage required (100|500|1k|5k|10k|25k|50k)}"
TAG="${2:?dataset tag required (the --tag used by seed.mjs)}"
SEG="${3:-1}"
SEGS="${4:-1}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
export PATH="/opt/homebrew/bin:$PATH"

for v in LOAD_STAGING_HOST LOAD_STAGING_REF SUPABASE_URL SUPABASE_ANON_KEY LOAD_USER_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "REFUSED: $v is not set" >&2; exit 1; }
done
BASE_URL="${BASE_URL:-https://${LOAD_STAGING_HOST}}"
THINK="${THINK_SCALE:-1}"
case "$STAGE" in 100|500|1k|5k|10k|25k|50k) ;; *) echo "REFUSED: unknown staging stage '$STAGE'" >&2; exit 1;; esac
[ "$THINK" = "1" ] || echo "NOTE: THINK_SCALE=$THINK — sessions are compressed; this is a stress run, not a user count" >&2

# 1. guard: production refused unconditionally; both URLs must be NON-local and contain the confirmed ref/host.
node --no-warnings --input-type=module -e "
import { authoriseTarget } from './scripts/load/_guard.mjs';
const [app, api, host] = process.argv.slice(1);
if (authoriseTarget(api, 'SUPABASE_URL') !== 'staging') { console.error('REFUSED: run-staging.sh is for hosted staging only'); process.exit(1); }
authoriseTarget(app, 'BASE_URL'); // throws on production hosts
const h = new URL(app).hostname.toLowerCase();
if (h !== host.toLowerCase()) { console.error('REFUSED: BASE_URL host does not equal LOAD_STAGING_HOST'); process.exit(1); }
if (/^(localhost|127\.|\[::1\])/.test(h)) { console.error('REFUSED: BASE_URL is local'); process.exit(1); }
console.log('guard ok: staging target confirmed (host + ref), production refused');
" "$BASE_URL" "$SUPABASE_URL" "$LOAD_STAGING_HOST"

# 2. database sentinel (only when a DB URL is given — the DB side of the two-key interlock).
if [ -n "${STAGING_DB_URL:-}" ]; then
  LOAD_DATABASE_URL="$STAGING_DB_URL" node --no-warnings scripts/load/seed.mjs --tag "$TAG" --verify >/dev/null \
    || { echo "REFUSED: sentinel/--verify failed — database is not the marked staging DB or seed floors are short" >&2; exit 1; }
fi

MANIFEST="$REPO/load/k6/.manifest/${TAG}.json"
[ -f "$MANIFEST" ] || { echo "no manifest $MANIFEST — copy it from the seeding host (it holds no secrets)" >&2; exit 1; }
OUT="$REPO/load/results/$(date -u +%Y%m%dT%H%M%SZ)-staging-${STAGE}-seg${SEG}of${SEGS}"
mkdir -p "$OUT"

# 3. server-action ids come from the SAME build as the deployment; k6 setup() re-discovers if absent.
ACTIONS="$REPO/load/k6/.manifest/actions.json"

# 4. collector alongside (DB side), generator 1 only.
COLLECTOR_PID=""
if [ -n "${STAGING_DB_URL:-}" ] && [ "$SEG" = "1" ]; then
  node --no-warnings scripts/load/collect.mjs --out "$OUT" --interval 5 --db "$STAGING_DB_URL" 2>"$OUT/collector.log" &
  COLLECTOR_PID=$!
fi
trap '[ -n "$COLLECTOR_PID" ] && kill -INT "$COLLECTOR_PID" 2>/dev/null || true' EXIT

# 5. k6 — execution segments keep VU ids globally unique across generators (one identity per VU).
SEGARGS=()
if [ "$SEGS" -gt 1 ]; then
  SEGARGS=(--execution-segment "$(awk -v i="$SEG" -v n="$SEGS" 'BEGIN{printf "%d/%d:%d/%d", i-1, n, i, n}')" \
           --execution-segment-sequence "$(awk -v n="$SEGS" 'BEGIN{s="0"; for(i=1;i<=n;i++) s=s sprintf(",%d/%d", i, n); print s}')")
fi
set +e
BASE_URL="$BASE_URL" SUPABASE_URL="$SUPABASE_URL" SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
LOAD_USER_PASSWORD="$LOAD_USER_PASSWORD" LOAD_STAGING_HOST="$LOAD_STAGING_HOST" LOAD_STAGING_REF="$LOAD_STAGING_REF" \
STAGE="$STAGE" THINK_SCALE="$THINK" LOAD_TAG="$TAG" MANIFEST="$MANIFEST" ACTIONS="$ACTIONS" \
RESULTS_DIR="$OUT" K6_NO_USAGE_REPORT=true \
  timeout "$(( ${GATE_DEADLINE_MIN:-150} * 60 ))" \
  k6 run --quiet "${SEGARGS[@]}" "$REPO/load/k6/scenarios/mixed.js" > "$OUT/k6-stdout.md" 2> "$OUT/k6.log"
K6_EXIT=$?
set -e
echo "k6 exit=$K6_EXIT  results: $OUT   (verdict in k6-summary.md; exit 99 = threshold failed / aborted)"
exit $K6_EXIT
