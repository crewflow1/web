#!/bin/bash
# fixture-create.sh <label> — create a SYNTHETIC org + owner + staff on the LOCAL
# stack, fuzz-seed every org-scoped table with marker strings, and upload one
# marker-named object per tenant bucket. Prints shell-evalable ids/markers.
# LOCAL ONLY: refuses any non-loopback API URL.
set -euo pipefail
source /Users/moetalibi/Code/cf-wt/_shared/local-env.sh
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-local target" >&2; exit 2;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="${1:-a}"
RAND="$(openssl rand -hex 4)"
MNAME="Zqdel${RAND}"                       # name marker
MEMAIL="zqdel${RAND}@deletion-ws.invalid"  # email marker
MPHONE="+4477009$(printf '%05d' $((RANDOM % 100000)))"  # phone marker (Ofcom drama range)
ADMIN=(-H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json")

mkuser() { # role-label -> uuid
  curl -sS "${ADMIN[@]}" -X POST "$API_URL/auth/v1/admin/users" \
    -d "{\"email\":\"$1.$MEMAIL\",\"password\":\"Pw-$RAND-$1-9!x\",\"email_confirm\":true,\"user_metadata\":{\"full_name\":\"$MNAME $1\"}}" \
    | /opt/homebrew/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.id){console.error(s);process.exit(1)}console.log(j.id)})'
}
OWNER="$(mkuser owner)"; STAFF="$(mkuser staff)"
SLUG="deletion-ws-$LABEL-$RAND"
ORG="$(psql "$DB_URL" -qAt -v ON_ERROR_STOP=1 <<SQL
insert into public.users (id, email, full_name, phone) values
  ('$OWNER', 'owner.$MEMAIL', '$MNAME owner', '$MPHONE'),
  ('$STAFF', 'staff.$MEMAIL', '$MNAME staff', '$MPHONE')
on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone;
with o as (
  insert into public.organizations (name, slug, phone, billing_email, address, status)
  values ('$MNAME Builders Ltd', '$SLUG', '$MPHONE', 'billing.$MEMAIL',
          jsonb_build_object('line1', '$MNAME Street'), 'active')
  returning id
), m as (
  insert into public.memberships (org_id, user_id, role)
  select o.id, u.id, u.role from o, (values ('$OWNER'::uuid, 'owner'), ('$STAFF'::uuid, 'staff')) u(id, role)
)
select id from o;
SQL
)"
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -v org="$ORG" -v usr="$STAFF" -v mname="$MNAME" -v memail="$MEMAIL" -v mphone="$MPHONE" \
  -f "$HERE/synthetic-seed.sql" > "${SEED_LOG:-/dev/stderr}"

# one object per bucket, org-prefixed, marker in the object name
for B in $(psql "$DB_URL" -qAt -c "select id from storage.buckets order by 1"); do
  # image/png is accepted by every tenant bucket's mime allowlist
  curl -sS -o /dev/null -X POST "$API_URL/storage/v1/object/$B/$ORG/nested/$MNAME-$B.png" \
    -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H "Content-Type: image/png" --data-binary "synthetic $MNAME" || true
done
echo "ORG=$ORG SLUG=$SLUG OWNER=$OWNER STAFF=$STAFF MNAME=$MNAME MEMAIL=$MEMAIL MPHONE=$MPHONE"
