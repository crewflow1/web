#!/bin/bash
# Concurrency proof for 20261355000000 against the LOCAL stack only (refuses any non-local URL).
# 4 orgs x 5 simultaneous 10p reservations, platform headroom 50p => exactly 5 must be reserved.
set -euo pipefail
case "$DB_URL" in *127.0.0.1*|*localhost*) ;; *) echo "refusing: not a local database"; exit 2;; esac
ORGS=(00000000-0000-4000-8000-0000000c0001 00000000-0000-4000-8000-0000000c0002 00000000-0000-4000-8000-0000000c0003 00000000-0000-4000-8000-0000000c0004)
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -c "insert into public.organizations (id,name,slug,status) select x::uuid, 'Conc '||x, 'conc-'||x, 'active' from unnest(array['${ORGS[0]}','${ORGS[1]}','${ORGS[2]}','${ORGS[3]}']) x"
ORIG=$(psql "$DB_URL" -At -c "select ceiling_pence from public.ai_platform_budget where id")
psql "$DB_URL" -q -At -c "select public.ai_set_platform_ceiling((select (committed_pence+reserved_pence)::int + 50 from public.ai_platform_month_usage()), null, 'concurrency proof')" >/dev/null
OUT=$(mktemp -d)
for o in "${ORGS[@]}"; do for i in 1 2 3 4 5; do
  psql "$DB_URL" -At -c "select outcome||':'||coalesce(block_reason,'') from public.ai_reserve_invocation('$o','proof.conc','drafting',10)" > "$OUT/$o-$i" &
done; done
wait
echo "results:"; cat "$OUT"/* | sort | uniq -c
RES=$(cat "$OUT"/* | grep -c '^reserved' || true)
psql "$DB_URL" -q -c "delete from public.ai_cost_reservations where org_id in ('${ORGS[0]}','${ORGS[1]}','${ORGS[2]}','${ORGS[3]}'); delete from public.organizations where id in ('${ORGS[0]}','${ORGS[1]}','${ORGS[2]}','${ORGS[3]}');"
psql "$DB_URL" -q -At -c "select public.ai_set_platform_ceiling($ORIG, null, 'restore after concurrency proof')" >/dev/null
rm -rf "$OUT"
echo "reserved=$RES (expected 5)"; [ "$RES" = 5 ]
