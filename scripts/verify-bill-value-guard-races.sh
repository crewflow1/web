#!/usr/bin/env bash
#
# Concurrency proof for `tg_finances_bill_value_guard` (20261053/20261054).
#
# WHY THIS EXISTS AND WHY IT IS NOT A VITEST FILE
# -----------------------------------------------------------------------------
# The guard's whole job is to hold under a race: one session recording a supplier
# payment against a bill while another session cuts that bill's value. Proving
# that needs TWO REAL DATABASE SESSIONS with OVERLAPPING, UNCOMMITTED
# transactions. The integration suite talks to PostgREST, which is one
# transaction per HTTP request and cannot hold a transaction open across
# statements — so it can prove the sequential rules (it does, see
# __tests__/integration/rls/supplier-payments.test.ts §6) but it structurally
# cannot prove the concurrent ones. This harness drives psql directly instead.
#
# It asserts three things a single-session test cannot:
#   1. the second session genuinely BLOCKS — confirmed from pg_stat_activity
#      (wait_event_type='Lock'), not merely inferred from elapsed time;
#   2. having blocked, it RE-READS and then REFUSES, in BOTH lock orderings;
#   3. no ordering deadlocks, because 20261047's payment-then-bill lock order is
#      the only lock order in the ledger and this guard takes no locks of its own.
#
# USAGE
#   supabase start && supabase db reset --local
#   bash scripts/verify-bill-value-guard-races.sh
#
#   DBNAME=guardlab bash scripts/verify-bill-value-guard-races.sh
#     Run against a private clone instead of the shared local `postgres` DB —
#     strongly advised when other branches share the stack, because their
#     `supabase db reset` drops your migrations mid-run and the failures look
#     like product bugs. Create one with:
#       docker exec supabase_db_crewflow bash -c \
#         "createdb -U postgres guardlab && pg_dump -U postgres -d postgres \
#          --no-owner --no-privileges | psql -U postgres -d guardlab -q"
#
# Exits non-zero on any failure.

set -uo pipefail
DBNAME="${DBNAME:-postgres}"
CT="${CT:-supabase_db_crewflow}"

Q()   { docker exec -i "$CT" psql -U postgres -d "$DBNAME" -tAq -c "$1" 2>&1; }
SES() { docker exec -i "$CT" psql -U postgres -d "$DBNAME" -tAq; }
ms()  { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }

PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
chk() { if [[ "$2" =~ $3 ]]; then ok "$1"; else bad "$1 -- got: ${2:-<empty>}"; fi; }

# The single most confusing failure mode: running against a database where the
# migrations under test are not installed. Every assertion then "fails" for a
# reason that has nothing to do with the code. Refuse to start.
if [ -z "$(Q "select 1 from pg_trigger where tgrelid='public.finances'::regclass and tgname='finances_bill_value_guard';")" ]; then
  echo "ABORT: trigger finances_bill_value_guard is not installed on $DBNAME."
  echo "       Apply 20261053000000 and 20261054000000 first (supabase db reset --local)."
  exit 2
fi

TAG="race$$"
ORG=$(Q "insert into organizations (name, slug) values ('$TAG','$TAG') returning id;")
SUP=$(Q "insert into suppliers (org_id, name) values ('$ORG','merchant') returning id;")
SUB=$(Q "insert into suppliers (org_id, name) values ('$ORG','subbie') returning id;")
Q "insert into cis_subcontractors (org_id, supplier_id, legal_name, cis_status, deduction_rate, verified_at)
   values ('$ORG','$SUB','Sub Ltd','standard_20',20,now());" >/dev/null
trap 'Q "delete from organizations where id='"'"'$ORG'"'"';" >/dev/null; rm -f /tmp/$TAG.*' EXIT

bill()  { Q "insert into finances (org_id, supplier_id, amount, vat_rate, category)
             values ('$ORG','$1',$2,$3,'materials') returning id;"; }
pay()   { Q "insert into supplier_payments (org_id, supplier_id, paid_at, method, gross_amount, net_paid)
             values ('$ORG','$1',current_date,'bank_transfer',$2,$2) returning id;"; }
alloc() { Q "insert into supplier_payment_allocations (org_id,payment_id,supplier_id,finance_id,amount)
             values ('$ORG','$1','$2','$3',$4);"; }

# A CIS payment is a THREE-part write and the order is forced by two triggers
# pulling in opposite directions: `..._cis_snapshot_required` (deferred) demands
# a verification snapshot by COMMIT, while `tg_cis_payment_snapshot_totals`
# demands the snapshot's basis and deduction already agree with the allocations.
# So: payment, then allocations, then snapshot, all in ONE transaction. This is
# what `record_cis_supplier_payment` does; the RPC itself is SECURITY INVOKER and
# gated on is_org_admin(), which a psql superuser session cannot satisfy, so the
# harness reproduces its statements directly.
cispay() { # gross deduction -> payment id (no snapshot yet)
  Q "insert into supplier_payments (org_id,supplier_id,paid_at,method,gross_amount,cis_withheld,net_paid)
     values ('$ORG','$SUB',current_date,'bank_transfer',$1,$2,$(($1-$2))) returning id;"
}
cis_alloc_sql() { # payment bill amount basis deduction -> the allocation INSERT
  echo "insert into supplier_payment_allocations (org_id,payment_id,supplier_id,finance_id,amount,
       cis_rate_applied,cis_bill_net,cis_bill_gross,cis_bill_materials,cis_bill_citb,cis_basis,
       cis_deduction,cis_vat_treatment,cis_reverse_charge_vat)
     values ('$ORG','$1','$SUB','$2',$3,20,1000,1000,0,0,$4,$5,'standard',0);"
}
cis_snap_sql() { # payment basis deduction -> the snapshot INSERT
  echo "insert into cis_payment_snapshots (org_id,payment_id,supplier_id,cis_status,deduction_rate,legal_name,
       cis_gross_payment,materials_total,citb_total,cis_basis,cis_deduction,tax_month_start,tax_month_end)
     values ('$ORG','$1','$SUB','standard_20',20,'Sub Ltd',$2,0,0,$2,$3,date '2026-07-06',date '2026-08-05');"
}
cis_post() { # payment bill amount basis deduction — post a complete CIS payment
  SES <<SQL
begin;
$(cis_alloc_sql "$1" "$2" "$3" "$4" "$5")
$(cis_snap_sql "$1" "$4" "$5")
commit;
SQL
}
settled() { Q "select coalesce(sum(a.amount),0) from supplier_payment_allocations a
                 join supplier_payments p on p.id=a.payment_id
                where a.finance_id='$1' and p.voided_at is null;"; }
gross()   { Q "select round(amount+coalesce(vat_total,0),2) from finances where id='$1';"; }

# =============================================================================
echo "=============== A. SEQUENTIAL RULES ==============="
B=$(bill "$SUP" 1000 0); P=$(pay "$SUP" 900); alloc "$P" "$SUP" "$B" 900 >/dev/null
chk "reduce below settled is REFUSED"      "$(Q "update finances set amount=100 where id='$B';")" "already settled against it"
chk "increase is ALLOWED"                  "$(Q "update finances set amount=2000 where id='$B';")OK" "^OK$"
chk "reduce to exactly settled is ALLOWED" "$(Q "update finances set amount=900 where id='$B';")OK" "^OK$"
chk "one penny under is REFUSED"           "$(Q "update finances set amount=899.99 where id='$B';")" "already settled against it"
chk "a VAT-RATE cut below settled is REFUSED too" \
                                           "$(Q "update finances set amount=800, vat_rate=0 where id='$B';")" "already settled against it"
chk "columns that cannot move the payable stay editable" \
                                           "$(Q "update finances set notes='x', category='labour' where id='$B';")OK" "^OK$"

echo
echo "--- LEGACY REPAIR: an already-broken row must not be trapped ---"
# Manufacture the state a pre-guard production database can hold. This is the
# only way to reach it: with the guard installed there is no longer a route in.
LB=$(bill "$SUP" 1000 0); LP=$(pay "$SUP" 900); alloc "$LP" "$SUP" "$LB" 900 >/dev/null
Q "alter table finances disable trigger finances_bill_value_guard;" >/dev/null
Q "update finances set amount=100 where id='$LB';" >/dev/null
Q "alter table finances enable trigger finances_bill_value_guard;" >/dev/null
echo "  manufactured legacy row: gross=$(gross "$LB") settled=$(settled "$LB")  (INVALID)"
chk "repair TOWARD validity is ALLOWED even though 500 is still under 900" \
                                           "$(Q "update finances set amount=500 where id='$LB';")OK" "^OK$"
chk "repair to fully valid is ALLOWED"     "$(Q "update finances set amount=900 where id='$LB';")OK" "^OK$"
chk "but moving AWAY from validity is still REFUSED" \
                                           "$(Q "update finances set amount=50 where id='$LB';")" "already settled against it"

echo
echo "=============== B. CIS FREEZE — a different rule, a different message ==============="
CB=$(bill "$SUB" 1000 0); CP=$(cispay 500 100); cis_post "$CP" "$CB" 500 500 100 >/dev/null 2>&1
R=$(Q "update finances set amount=5000 where id='$CB';")
chk "a CIS bill is frozen even on an INCREASE" "$R" "part-paid under CIS"
if [[ "$R" =~ "already settled against it" ]]; then bad "the CIS refusal leaked the settlement-floor wording"
else ok "the CIS refusal does not cite settlement"; fi
R2=$(Q "update finances set amount=100 where id='$B';")
if [[ "$R2" =~ CIS ]]; then bad "a plain bill's refusal wrongly mentions CIS"
else ok "a plain bill's refusal never mentions CIS"; fi
chk "CIS detail UPDATE after part-payment is REFUSED" \
  "$(Q "insert into cis_bill_details (org_id,finance_id,supplier_id,materials_amount) values ('$ORG','$CB','$SUB',200);")" \
  "frozen at materials of zero"

# =============================================================================
echo
echo "=============== C. REAL CONCURRENT SESSIONS ==============="
# Session 1 opens a transaction, does its write, and HOLDS it open for 3s.
# Session 2 then attempts the conflicting write and must block on session 1's
# row lock. A watchdog session confirms the block from pg_stat_activity so the
# proof does not rest on wall-clock timing alone.
race() { # label | session-1 SQL | session-2 SQL | marker | expected refusal
  local label="$1" sqlA="$2" sqlB="$3" marker="$4" want="$5"
  ( SES <<SQL
begin;
$sqlA
select pg_sleep(3);
commit;
SQL
  ) > "/tmp/$TAG.A" 2>&1 &
  local APID=$!
  sleep 1.2
  ( for _ in $(seq 1 60); do
      W=$(Q "select wait_event_type from pg_stat_activity
              where state='active' and query ilike '%$marker%' and wait_event_type='Lock';")
      [ -n "$W" ] && { echo "BLOCKED"; break; }; sleep 0.2
    done ) > "/tmp/$TAG.W" 2>&1 &
  local WPID=$!
  local T0 T1 R; T0=$(ms); R=$(Q "$sqlB"); T1=$(ms)
  wait $APID; wait $WPID
  local waited=$(( T1 - T0 )) blocked; blocked=$(cat "/tmp/$TAG.W")
  echo "  [$label] session 2 waited ${waited}ms; pg_stat_activity=${blocked:-not-observed}"
  local s1; s1=$(tr '\n' ' ' < "/tmp/$TAG.A" | sed 's/  */ /g')
  [ -n "${s1// /}" ] && echo "  [$label] session 1 said: $s1"
  if [ "${blocked:-}" = "BLOCKED" ] && [ "$waited" -gt 800 ]
  then ok "$label — session 2 genuinely BLOCKED on a lock"
  else bad "$label — session 2 did not block (${waited}ms, ${blocked:-not-observed})"; fi
  chk "$label — then re-read and refused" "${R:-<<IT SUCCEEDED>>}" "$want"
}

echo "--- ORDERING A: the ALLOCATION commits first, the bill reduction is second ---"
RB=$(bill "$SUP" 1000 0); RP=$(pay "$SUP" 900)
race "order-A" \
  "insert into supplier_payment_allocations (org_id,payment_id,supplier_id,finance_id,amount) values ('$ORG','$RP','$SUP','$RB',900);" \
  "/* MARK_A */ update finances set amount = 100 where id = '$RB';" \
  "MARK_A" "already settled against it"
echo "  outcome: gross=$(gross "$RB") settled=$(settled "$RB")"

echo "--- ORDERING B: the BILL REDUCTION is first (uncommitted), the allocation second ---"
RB2=$(bill "$SUP" 1000 0); RP2=$(pay "$SUP" 900)
race "order-B" \
  "update finances set amount = 100 where id = '$RB2';" \
  "/* MARK_B */ insert into supplier_payment_allocations (org_id,payment_id,supplier_id,finance_id,amount) values ('$ORG','$RP2','$SUP','$RB2',900);" \
  "MARK_B" "over-paid"
echo "  outcome: gross=$(gross "$RB2") settled=$(settled "$RB2")"

echo "--- ORDERING A, CIS: the CIS allocation commits first, the bill edit is second ---"
RB3=$(bill "$SUB" 1000 0); RP3=$(cispay 500 100)
race "order-A-cis" \
  "$(cis_alloc_sql "$RP3" "$RB3" 500 500 100)
$(cis_snap_sql "$RP3" 500 100)" \
  "/* MARK_C */ update finances set amount = 5000 where id = '$RB3';" \
  "MARK_C" "part-paid under CIS"
echo "  outcome: gross=$(gross "$RB3")"

echo
echo "--- DEADLOCK PROBE: 12 pairs fired simultaneously, both orderings at once ---"
DL=0
for i in $(seq 1 12); do
  DB_=$(bill "$SUP" 1000 0); DP_=$(pay "$SUP" 900)
  ( alloc "$DP_" "$SUP" "$DB_" 900 ) > "/tmp/$TAG.d1.$i" 2>&1 &
  ( Q "update finances set amount=100 where id='$DB_';" ) > "/tmp/$TAG.d2.$i" 2>&1 &
done
wait
for f in /tmp/$TAG.d1.* /tmp/$TAG.d2.*; do grep -qi deadlock "$f" && DL=$((DL+1)); done
if [ "$DL" -eq 0 ]; then ok "no deadlock across 12 concurrent pairs"
else bad "$DL deadlock(s) detected"; fi

# =============================================================================
echo
echo "=============== D. THE PROPERTY ALL OF THE ABOVE PROTECTS ==============="
OVER=$(Q "select coalesce(string_agg(f.id||' gross='||round(f.amount+coalesce(f.vat_total,0),2)||' settled='||s.tot,'; '),'NONE')
  from finances f
  join (select a.finance_id, sum(a.amount) tot
          from supplier_payment_allocations a
          join supplier_payments p on p.id = a.payment_id
         where p.voided_at is null group by 1) s on s.finance_id = f.id
 where f.org_id='$ORG' and s.tot > round(f.amount+coalesce(f.vat_total,0),2)+0.005;")
if [ "$OVER" = "NONE" ]; then ok "after every race, no bill is settled beyond its own gross"
else bad "OVER-SETTLED BILLS SURVIVED: $OVER"; fi

echo
echo "=============== $PASS passed, $FAIL failed ==============="
[ "$FAIL" -eq 0 ]
