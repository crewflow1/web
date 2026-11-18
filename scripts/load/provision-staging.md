# Provision the load-test staging stack — runbook (NOT EXECUTED)

**Do nothing in this file until the founder has replied with the approval sentence in
`docs/engineering/LOAD-TEST-APPROVAL-REQUEST.md` §9.** Every step below creates something billable. Prices and
caps are in that document. Never paste a key into chat or a file in the repo; keep them in the generator
VMs' `/etc/crewflow-load.env` (mode 600) and the operator's password manager.

Conventions: `LOAD` = the staging identifier prefix `crewflow-load`. Every cloud resource carries the label
`purpose=crewflow-load` so `scripts/load/teardown-staging.sh` can find it. Run all commands from a **fresh clone
in a scratch directory that has never been `supabase link`ed** (the repo at `~/Code/web` IS linked to production —
never run `supabase db push --linked` for staging; always pass `--db-url`).

## 0. Before anything is created (all free)
1. Founder: set up a **virtual card with a hard limit** (the approved cap, §6 of the request) and a billing email
   that the operator reads. Use it for the three new accounts below.
2. Founder / operator: send the Vercel load-test notice (request §3) and wait for the written reply. If Vercel
   declines Pro-plan load testing, switch to **Fallback F** (§6 of this file) — the Supabase half is identical.
3. Supabase: no notice is required on Pro; open a courtesy ticket anyway (the production checklist asks Team/Enterprise
   customers for 2 weeks' notice before heavy load tests).
4. Confirm the exact commit under test is green in CI and `npm run build` succeeds from it.

## 1. Separate Supabase ORGANISATION (isolates quotas, MAU, spend cap and billing from production)
Dashboard → *New organization* → name `crewflow-load` → plan **Pro** → **leave Spend Cap ON for now**
(it must be switched OFF before G4: egress above the 250 GB quota is otherwise blocked; see request §6 — this is
exactly why it must never be the production organisation).
Record the org id (not a secret): `export LOAD_ORG_ID=<org id>`.

## 2. Staging Supabase project (same region as production)
```sh
export LOAD_DB_PASSWORD="$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-32)"   # keep in the password manager
supabase projects create crewflow-load --org-id "$LOAD_ORG_ID" --db-password "$LOAD_DB_PASSWORD" \
  --region <same region as production> --size micro          # verify flag names with `supabase projects create --help`
supabase projects list                                          # note the NEW ref -> export LOAD_STAGING_REF=<ref>
```
Pooler URL (transaction, port 6543) and direct host from Dashboard → Connect; export as `STAGING_DB_URL`.
Assert it is not production **before every later command**:
`[ "$LOAD_STAGING_REF" != "jzntbskdqdopzwdqwvkp" ] && echo ok`.

## 3. Schema, marker, Auth limits
```sh
supabase db push --db-url "$STAGING_DB_URL"                      # ALL repo migrations, forward-only, staging only
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -v staging_ref="$LOAD_STAGING_REF" -f scripts/load/staging/01-mark-staging.sql
```
Dashboard → Authentication on **staging only**: Rate Limits → raise *sign-ins/sign-ups per IP* and *token refreshes per IP*
to the ceiling (the defaults are per source IP and the app's server-side sign-in comes from Vercel egress IPs; confirm at G1),
turn **email confirmations off**, leave **SMTP unset** (no auth mail is ever sent). Copy the staging **anon** and
**service-role** keys into the operator's password manager (the service-role key is only needed by the Vercel
project env).

## 4. Seed the 50,000 users (run on a Supabase **XL** window — request §4 row 1)
Resize: Dashboard → Settings → Compute and Disk → **XL**, disk **25 GB**. Then, from the scratch clone:
```sh
export LOAD_STAGING_HOST=<staging app host>      # known after §5; any placeholder works for the seed (guard needs the ref)
export LOAD_DATABASE_URL="$STAGING_DB_URL"
export LOAD_USER_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"    # >=12 chars; password manager; never in the repo
node scripts/load/seed.mjs --orgs 6000 --staff 6 --admin-ratio 0.35 --hq 100 \
     --customers 30 --jobs 60 --quotes 40 --invoices 30 --documents 15 --leads 15 --costs 20 --timesheets 10 \
     --fast --tag g1 --plan                                         # 1) capacity plan: must print "ok": true
node scripts/load/seed.mjs ...same flags without --plan...          # 2) seed (~5 M rows)
node scripts/load/seed.mjs ...same flags... --verify                # 3) floors: exit 0
psql "$STAGING_DB_URL" -Atc "select count(*) from organizations where slug not like 'lt-%'"   # must be 0
psql "$STAGING_DB_URL" -c "ANALYZE"                                  # fresh statistics before G1
```
`--fast` turns triggers off (derived rows such as the activity log are not produced) — acceptable for the ladder;
G1–G3 are re-run once on a trigger-ON 500-org subset (`--tag t1 --orgs 500`, then teardown) if the founder wants
trigger-write cost included. The manifest (`load/k6/.manifest/g1.json`, no secrets) is copied to every generator.
Resize back to **Micro** when seeding is verified.

## 5. Staging Vercel project (separate TEAM — isolates the budget pause and the abuse controls from production)
1. Create a new Vercel **Pro team** `crewflow-load` (dashboard; the $20 fee includes $20 usage credit).
2. Spend Management → *Add Budget* → **Team**, amount = the Vercel line of the approved cap, **Pause production
   deployments ON**, SMS on (request §6).
3. Import the repo at the commit under test as project `crewflow-load`; region **dub1**; production branch = the tested
   commit's branch; **no custom domain**; Deployment Protection OFF only for the load-generator IPs if possible
   (otherwise a bypass secret header — keep it in the generator env, never in the repo).
4. Environment variables — same **names** as production (`.env.local.sanitised` lists them), **values**: staging Supabase
   URL/anon/service-role only; `CREWFLOW_SUPERADMIN_EMAILS` = `lt-g1-hq1..hq100@loadtest.crewflow.invalid`;
   **unset** every provider key (Resend, Twilio, WhatsApp/Meta, VAPID, Anthropic, Stripe, Sentry, PostHog) and `CRON_SECRET`
   (so the 48 crons cannot run). A human compares the names list against production in the UI (values never printed).
5. Deploy. Hit `https://<host>/api/health` once from a laptop (one request).

## 6. Fallback F — self-hosted app tier (only if Vercel declines Pro load tests)
`next start` containers on Hetzner CCX33 VMs in the same location as Supabase's nearest region, one app VM per
generator VM (each generator targets its paired app VM's `BASE_URL`; no load balancer needed). VM counts per gate
are in the request §4 (G7 ≈ 82 app VMs expected, 164 worst: ask Hetzner to raise the project server limit **in advance**).
This measures the database/Auth path (the expected bottleneck) but **not** Vercel's function platform.

## 7. Load generators (Hetzner CCX33 ×N, ~5,000 VUs each; HEL1)
```sh
hcloud ssh-key create --name crewflow-load --public-key-from-file ~/.ssh/<key>.pub --label purpose=crewflow-load
hcloud firewall create --name crewflow-load --label purpose=crewflow-load      # inbound: SSH from the operator IP only
for i in $(seq 1 "$N"); do
  hcloud server create --name crewflow-load-gen-$i --type ccx33 --location hel1 --image ubuntu-24.04 \
    --ssh-key crewflow-load --firewall crewflow-load --label purpose=crewflow-load \
    --user-data-from-file scripts/load/generator-cloud-init.yaml
done
```
`generator-cloud-init.yaml` is intentionally **not** committed (it would embed nothing secret, but it is a one-line
install of k6 from the official apt repo plus `ulimit -n 1048576`); create it at provisioning time. After boot, on
each VM: clone the repo at the tested commit, copy the manifest, write `/etc/crewflow-load.env` (staging host/ref/URL/anon key/
password), then `set -a; . /etc/crewflow-load.env; set +a; scripts/load/run-staging.sh 5k g1 $i $N`.
Verify G4 uniqueness (no two generators log the same sign-in email) before G5.

## 8. Run order (each gate needs the previous PASS and the founder's go for that tranche)
Resize Supabase to the gate's tier (request §4) → warm-up → `run-staging.sh <stage> g1 …` on all generators at once →
`collect.mjs` runs on generator 1 → verify → record the gate log → **resize Supabase back to Micro** → next gate.
Abort immediately (Ctrl-C all generators, then `teardown-staging.sh`) on: any isolation violation, spend alert at 75 % of
the tranche cap, or any outbound provider call seen.

## 9. Dead-man timer and teardown
At the start of every gate day, on the **operator machine** (not on a VM):
`echo "bash scripts/load/teardown-staging.sh --yes" | at now + <window hours> hours` (macOS: a `launchd` one-shot), and put
the teardown command in the calendar. A stopped Hetzner VM is still billed — only deletion stops billing.
Final teardown: `scripts/load/teardown-staging.sh` (dry run) → read it → `--yes`. Delete the staging Supabase organisation,
the staging Vercel team, and revoke the Hetzner project token. Confirm 24 h later that all three bills are flat.
