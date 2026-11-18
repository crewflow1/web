#!/usr/bin/env bash
# scripts/load/teardown-staging.sh — destroy EVERY billable staging resource. DRY-RUN by default.
#
#   scripts/load/teardown-staging.sh                 # prints exactly what it would delete
#   scripts/load/teardown-staging.sh --yes           # deletes it
#
# Required env: LOAD_STAGING_REF (Supabase staging ref), LOAD_VERCEL_PROJECT (staging project name),
#   LOAD_VERCEL_SCOPE (staging team slug), HCLOUD_TOKEN is read by hcloud itself (never printed).
# Refuses: the production Supabase ref, the project names crewflow / web / crewflow-web, or an empty value.
# Idempotent: every step tolerates "already gone". Also run it from a dead-man timer (see provision-staging.md §9).
set -uo pipefail
PROD_REF="jzntbskdqdopzwdqwvkp"
YES=0; [ "${1:-}" = "--yes" ] && YES=1

: "${LOAD_STAGING_REF:?set LOAD_STAGING_REF}"
: "${LOAD_VERCEL_PROJECT:?set LOAD_VERCEL_PROJECT}"
: "${LOAD_VERCEL_SCOPE:?set LOAD_VERCEL_SCOPE}"
[ "$LOAD_STAGING_REF" != "$PROD_REF" ] || { echo "REFUSED: that is the PRODUCTION Supabase ref" >&2; exit 1; }
case "$LOAD_VERCEL_PROJECT" in crewflow|web|crewflow-web|crewflow-uk|"") echo "REFUSED: '$LOAD_VERCEL_PROJECT' looks like a production project name" >&2; exit 1;; esac
case "$LOAD_VERCEL_PROJECT" in *load*) ;; *) echo "REFUSED: staging Vercel project name must contain 'load'" >&2; exit 1;; esac

run() { if [ $YES -eq 1 ]; then echo "+ $*"; "$@" || echo "  (non-zero exit — already gone? continuing)"; else echo "DRY-RUN: $*"; fi; }

echo "== 1. generators + app VMs (label crewflow-load) =="
if command -v hcloud >/dev/null 2>&1; then
  IDS="$(hcloud server list -l purpose=crewflow-load -o noheader -o columns=id 2>/dev/null || true)"
  for id in $IDS; do run hcloud server delete "$id"; done
  [ -n "$IDS" ] || echo "no labelled servers found"
  for k in firewall network ssh-key; do
    for id in $(hcloud $k list -l purpose=crewflow-load -o noheader -o columns=id 2>/dev/null || true); do run hcloud $k delete "$id"; done
  done
else echo "hcloud CLI not installed — delete the project's servers in the Hetzner console"; fi

echo "== 2. Vercel staging project =="
run npx vercel@latest project rm "$LOAD_VERCEL_PROJECT" --scope "$LOAD_VERCEL_SCOPE" --yes
echo "   then: Vercel > Settings > Billing > Spend Management: keep the budget until the invoice has closed."

echo "== 3. Supabase staging project (the ONLY database that ever held synthetic data) =="
run supabase projects delete "$LOAD_STAGING_REF"
echo "   then: dashboard > Organization > Billing: confirm 0 projects; delete the staging ORGANISATION to stop the \$25 plan fee."

echo "== 4. local residue =="
run rm -f load/k6/.manifest/g*.json
echo "   Keep load/results/ (the evidence). It holds no secrets (guard-tested)."

echo "== 5. verify (manual, record in the gate log) =="
echo "   hcloud server list            -> empty"
echo "   vercel project ls --scope ... -> staging project absent"
echo "   supabase projects list        -> staging ref absent"
echo "   vendor billing pages          -> usage flat at the end-of-test figure for 24 h"
[ $YES -eq 1 ] || echo "(dry run: nothing was deleted. Re-run with --yes.)"
