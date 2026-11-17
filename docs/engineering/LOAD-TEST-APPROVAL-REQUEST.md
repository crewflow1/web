# 50,000-user load test: approval request (cost, hard cap, schedule)

> **STATUS: CANCELLED — founder decision 2026-11-17.** No paid staging is to be provisioned and no Vercel, Supabase or Hetzner resources purchased; the proposed $2,500 budget is not spent. This document and the harness are kept for future use only. Paid 50,000-user testing is NOT a launch blocker, and CrewFlow is NOT claimed verified for 50,000 concurrent users. Any future run needs fresh, explicit founder approval.


**Status: REQUEST. Nothing has been provisioned, bought, signed up for or run against any hosted system.**
Date 2026-11-16. Branch `perf/load-harness-and-staging` (PR #1114). Companion docs: `STAGING-AND-LOAD-PLAN.md` (method),
`scripts/load/provision-staging.md` (exact post-approval steps), `scripts/load/cost-model.mjs` (reproduces every number below:
`node scripts/load/cost-model.mjs`).

## 1. Decision needed, in one paragraph
Approve a **separate** staging stack (own Supabase organisation + project, own Vercel team + project, k6 generators on hourly VMs)
to run a seven-gate ladder from 100 to 50,000 simultaneous sessions. **Expected cost $622; worst case $2,226; recommended hard
cap $2,500 in three tranches ($400 / $1,100 / $2,500 cumulative).** Two things you must know first: (a) **Vercel's published policy
permits load testing only on Enterprise plans** (§3); (b) **Supabase has no hard cap on compute**, so the cap is enforced by a
limited-balance card, our own teardown timer and per-gate approval (§6).

## 2. What "50,000 users" means here (assumptions stated)
| Quantity | Value | Basis |
|---|---|---|
| Registered users seeded | **50,500** in **6,000 companies** (avg 8.4 per company) | `seed.mjs --orgs 6000 --staff 6 --admin-ratio 0.35 --hq 100` (`--plan` proves every gate has enough identities) |
| Peak concurrent sessions (top gate G7) | **50,000** signed-in sessions = the literal reading: every registered user active at once | `load/k6/lib/model.js` (one k6 VU = one session = one identity). Far stricter than a real launch; G6 (25,000) is half. |
| Mix at peak | 29,000 field staff · 10,000 office admins · 6,000 owners · 4,900 anonymous prospects · 100 HQ operators | persona slots per 1,000: 580 / 200 / 120 / 98 / 2 (plan §3) |
| Request rate at peak | **7,833 requests/s** (470k/min); about 82,000 Supabase calls/s, 15,700 of them Auth `getUser` | 9.4 requests/session/min, measured locally at realistic think time; 10.5 Supabase calls/request, measured |
| Request mix | 44% RSC prefetch, 34% page, 10% API, 9% server action, 2% photo upload, 1% cross-tenant canary; about 9% are writes | local baseline, 4,848 requests |
| Daily-active equivalent | not tested directly. If 50k concurrent is the peak, DAU would be several times that; DAU is **not** a target here | stated so the number is not over-read |
| Pass criteria | 0 tenant leaks, 5xx < 1%, page p95 <= 3 s / p99 <= 6 s at G5-G7, auth bounce < 2%, DB CPU < 80%, clean recovery (plan §7) | unchanged |

A smaller reading ("50,000 registered, 10,000 peak concurrent") is simply **stopping after G5**: expected ~$103, worst ~$333.

## 3. Blockers and decisions that are not money
1. **Vercel policy.** Vercel's load-testing page says "Load testing is only permitted on **Enterprise plans**", requires approval via a Vercel
   representative with start/end times, peak RPS, hostnames and source IPs (<1,000), warns that unannounced tests breach fair use and that
   the source IPs "will likely be blocked". Source: https://vercel.com/kb/guide/what-s-vercel-s-policy-regarding-load-testing-deployments (retrieved
   2026-11-16). **We cannot price an Enterprise contract** (sales quote). Options: (A) ask Vercel for written approval of this test on Pro
   (generators have fixed IPs, so they can be declared); (B) **Fallback F**: run the Next.js app on self-hosted VMs against the same Supabase
   project. F still answers the question most likely to bind (Supabase Auth + PostgREST + Postgres at 82k calls/s) but not Vercel's function
   concurrency or cold starts. Cost of F is in §4. **No gate above G2 runs on Vercel without the written reply.**
2. **Supabase** asks Team/Enterprise customers for 2 weeks' notice before heavy load tests
   (https://supabase.com/docs/guides/platform/going-into-prod, retrieved 2026-11-16). On Pro it is a courtesy ticket; we will send one.
3. **Auth limits.** Supabase Auth rate limits are per source IP (defaults 30 requests/5 min on listed endpoints incl. `/user`,
   150/5 min for token refresh, configurable: https://supabase.com/docs/guides/auth/rate-limits, retrieved 2026-11-16). They are raised on the
   staging project only. G1 will show whether the app's server-side `getUser` (Vercel egress IPs) trips them.

## 4. Topology, schedule, paid hours
Production is never a target (guard refuses its ref and `*.crewflow.uk`; unit-tested).
```
k6 generators (Hetzner CCX33, HEL1, 1-15 VMs, labelled purpose=crewflow-load)
   -> Vercel team "crewflow-load" / project "crewflow-load" (dub1)  [or Fallback F: next start on CCX33 VMs]
   -> Supabase organisation "crewflow-load" (Pro) / project "crewflow-load" (same region as production), synthetic data only
```
Separate **organisations/teams** on purpose: Supabase quotas, MAU, spend cap and the Vercel budget-pause then cannot touch production.

| Window (Supabase tier) | Sessions | Hours expected | Hours worst | Generators (expected) |
|---|---|---|---|---|
| Seed + migrations (XL) | 50,500 users, ~5 M rows | 4 | 4 | none |
| G1-G3 (Large) | 100 / 500 / 1,000 | 4 | 8 | 1 VM |
| G4 (2XL) | 5,000 | 4 | 8 | 1 VM |
| G5 (4XL) | 10,000 | 4 | 8 | 2 VMs |
| G6 (8XL) | 25,000 | 4 | 8 | 5 VMs |
| G7 (16XL) | 50,000 | 4 | 12 | 10 VMs (15 worst) |
| Micro (between windows) | | 144 h project life minus the 24 h above = 120 h | 336 - 48 = 288 h (14 days) | |

Peak holds are 10-30 min (plan §6; G7 is 128 min including ramp and recovery). Resize down to Micro after every gate.
Fallback F app VMs (CCX33, one per ~4.8 busy cores at 50 ms CPU/request): G4 9, G5 17, G6 41, G7 82 (worst-case 100 ms: 164).

## 5. Exact cost (arithmetic: `scripts/load/cost-model.mjs`, USD, ex-VAT, FX EUR 1 = $1.20 assumed)
Volume: 93,946 VU-hours x 9.4 req/min x 60 = **52.99 M app requests** (expected), 106 M (worst: every gate re-run once).

| Vendor | Line | Unit price (source) | Expected | Worst |
|---|---|---|---|---|
| Supabase | Pro org base less $10 compute credit | $25/mo, $10 credit [S1] | 15.00 | 15.00 |
| | Compute, hourly | Large 0.1517, XL 0.2877, 2XL 0.562, 4XL 1.32, 8XL 2.562, 16XL 5.12, Micro 0.01344 /h [S2]; expected = 4x0.2877 + 4x0.1517 + 4x0.562 + 4x1.32 + 4x2.562 + 4x5.12 + 120x0.01344 | 41.63 | 103.23 |
| | Disk 25 GB (50 worst) over 8 GB | $0.000171/GB-h [S3] x 17 x 144 h | 0.42 | 2.41 |
| | Disk IOPS/throughput add-on (assumed 16k IOPS, 1,000 MB/s in G5-G7) | $0.024/IOPS-mo, $0.095/MB/s-mo [S1]; ($312 + $83)/730 x 12 h | 6.50 | 15.16 |
| | Egress to the app, over 250 GB | $0.09/GB [S4]; 52.99 M x 25 KB = 1,325 GB (worst 5,299 GB) | 96.72 | 454.37 |
| | Storage (photos) | $0.0213/GB-mo above 100 GB [S1]; 207 GB (828) | 2.28 | 15.51 |
| | **Supabase subtotal** | | **162.54** | **605.67** |
| Vercel | Pro team fee less $20 credit | $20/mo incl. $20 credit [V1] | 0.00 | 0.00 |
| | Active CPU | $0.168/h dub1 [V2]; 52.99 M x 50 ms = 736 h (worst 100 ms: 2,944 h) | 123.63 | 494.53 |
| | Provisioned memory | $0.0139/GB-h [V2]; 2 GB x 0.3 s / 8 concurrent | 15.34 | 122.75 |
| | Invocations | $0.60/M [V3] | 31.79 | 63.58 |
| | CDN requests | $2.40/M [V2] | 127.17 | 254.33 |
| | Fast Data Transfer | $0.15/GB [V2]; 10.4 KB measured x 52.99 M = 551 GB | 82.66 | 317.91 |
| | Fast Origin Transfer | $0.06/GB [V2]; response + request + 207 GB uploads | 54.38 | 208.64 |
| | Middleware CPU above 10 ms | $0.36/h [V2]; none expected, 10 ms worst | 0.00 | 105.97 |
| | **Vercel subtotal** | | **434.98** | **1,567.72** |
| Generators | Hetzner CCX33 (8 vCPU dedicated, 32 GB, 30 TB traffic incl.) | EUR 0.1891/h [H1] x 1.20; 84 VM-h (worst 208) | 19.06 | 47.20 |
| | IPv4, snapshots | allowance | 5.00 | 5.00 |
| | **Generators subtotal** | k6 is free (AGPL) | **24.06** | **52.20** |
| **TOTAL** | | | **$621.57** | **$2,225.59** |

Biggest lines (expected): Vercel CDN requests 127, Vercel Active CPU 124, Supabase egress 97, Vercel Fast Data Transfer 83, Fast Origin Transfer 54, Supabase compute 42.
By tranche (expected / worst; each includes its own fixed fees): G1-G5 **$103 / $333**, G6 **$147 / $528**, G7 **$412 / $1,506**.
**Fallback F** replaces the Vercel subtotal with app VMs: 612 VM-h = **$139** expected (2,424 VM-h = $550 worst); total expected = 162.54 + 24.06 + 138.88 = **$325**, worst $1,208.
Vercel "Flat Rate CDN" ($300/mo tier, 150 M requests) would not be cheaper than on-demand CDN + FDT ($210 expected) and cannot be changed mid-cycle [V4].
**Not recommended:** Grafana Cloud k6 for the ladder: 93,946 VU-hours x $0.15 = **$14,092** ($28,184 worst) [G1], about 600x the VM cost.

Assumptions that move the number most, each **measured at G2/G3 before any larger spend** (the ladder is also the calibration): Supabase bytes per app request
(25 KB assumed, 10.5 calls), active CPU per request (50 ms; laptop-measured 48 ms), Vercel instance concurrency. If calibration is >2x the expected figures the next tranche is re-quoted before it starts.
Not included: engineering time, taxes/VAT, Supabase Team plan or Vercel Enterprise (§3, unquoted), any provider calls (none are configured: Stripe, Resend, Twilio, Anthropic, Sentry unset).

Sources (all retrieved 2026-11-16): [S1] https://supabase.com/pricing · [S2] https://supabase.com/docs/guides/platform/compute-and-disk · [S3] https://supabase.com/docs/guides/platform/manage-your-usage/disk-size ·
[S4] https://supabase.com/docs/guides/platform/manage-your-usage/egress · MAU (100k included, $0.00325 beyond; ours 50.5k = $0): https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users ·
[V1] https://vercel.com/docs/plans/pro-plan · [V2] https://vercel.com/docs/pricing/regional-pricing/dub1 · [V3] https://vercel.com/docs/functions/usage-and-pricing · [V4] https://vercel.com/docs/pricing/flat-rate-cdn ·
[H1] https://www.hetzner.com/cloud/general-purpose (the page showed "Create" unavailable for CCX at retrieval: capacity risk; AWS EC2 was not priceable from its page) · [G1] https://grafana.com/pricing/.

## 6. HARD SPENDING CAP and how each vendor enforces it
**Cap: $2,500 total** (worst case $2,226 + 12% headroom), released in tranches: **$400** (G1-G5), **$1,100 cumulative** (+G6), **$2,500 cumulative** (+G7). A tranche's money is not available until the previous one passed and you replied.
| Vendor | Allocation | Enforcement | Honest limit |
|---|---|---|---|
| Vercel (own team) | $1,650 | Spend Management **team budget with "Pause production deployments"** ON, set to the tranche's Vercel amount; alerts at 50/75/100%, SMS at 100% [https://vercel.com/docs/spend-management]. | **Real stop, but lagging**: checked "every few minutes", so projects keep serving for minutes after the cap. Budget counts spend beyond the $20 credit. Paused project returns 503; storage still billed. |
| Supabase (own org) | $700 | **No hard cap on compute** (docs: Spend Cap excludes Compute, IOPS/throughput; it covers egress, disk, MAU, storage) [https://supabase.com/docs/guides/platform/spend-cap]. Spend Cap must be **OFF** for G4+ (egress > 250 GB would otherwise be blocked, and the grace period would stop the test). Bound instead by: (1) our script is the only thing that resizes; max tier 16XL = $5.12/h; (2) teardown timer; (3) billing-usage check after every gate; (4) card limit. | **No vendor-side cap.** Worst unattended burn: 16XL $5.12/h + egress about 0.9 TB/h at peak = about $86/h. The timer is the control, not Supabase. |
| Generators (Hetzner) | $150 | **No spend cap or prepaid mode** on Hetzner Cloud; invoiced monthly. Bound by: project server limit set to <= 15 (G7) by support request (max burn 15 x EUR 0.1891 = EUR 2.84/h), labelled resources, `teardown-staging.sh` timer. A stopped server is still billed. | **No vendor-side cap.** A forgotten fleet of 15 costs about $41/day. (Under Fallback F the app VMs raise this limit to about 85-165 servers, about EUR 16-31/h, so F needs its own per-gate timer; the card limit still bounds the total.) |
| All three | $2,500 | **Dedicated virtual card with a $2,500 limit** (founder creates it; new accounts only; not the production card). | A declined payment suspends service after the invoice date, not instantly; it bounds total loss but is a backstop, not a brake. |
| Operator | | Deadline timer on the operator machine runs `teardown-staging.sh --yes` at the end of every window; teardown is also run by hand at the end of each gate day. | Needs the operator machine online. Mitigation: the card limit and a calendar reminder. |
No other billable resource is created. We will never raise a tier, add a vendor or exceed a tranche without a fresh yes.

## 7. Safety interlocks already built and tested
Production refused (ref + hostnames, no override); a hosted target needs `LOAD_STAGING_REF` in the URL **and** the database sentinel
(`01-mark-staging.sql`, itself refuses a DB with any non-synthetic organisation); k6 `setup()` aborts unless the app accepts a session
minted by the guarded project; identities are `@loadtest.crewflow.invalid`; isolation violation or canary leak aborts the run; all provider keys unset
(no mail/SMS/AI/Stripe/crons). Tests: `__tests__/load/` (guard, model, `staging-scripts`: the shell wrappers refuse production/missing env offline).

## 8. Teardown and cleanup commitment
At the end of each gate day the Supabase project is resized to Micro. At the end of the programme (or immediately on any abort, spend alert, or isolation violation) we run
`scripts/load/teardown-staging.sh --yes`: deletes all labelled Hetzner servers/firewalls/keys, the Vercel staging project, and the staging Supabase project; then we delete the
staging Supabase organisation and Vercel team and revoke the tokens. Results (`load/results/`, no secrets) are kept; nothing else. We report the three vendors'
final billed amounts against this request within 24 h of teardown, and again after the next invoice.

## 9. Approval wording (reply with exactly one)
**Full ladder to 50,000:** "I approve the CrewFlow load-test staging described in docs/engineering/LOAD-TEST-APPROVAL-REQUEST.md: new Supabase and Vercel accounts and Hetzner VMs, hard cap USD 2,500 total released in tranches of 400 / 1,100 / 2,500 cumulative, on a dedicated USD 2,500 virtual card, with teardown at the end. Run G1-G5 now; ask me again before G6 and G7. Use Vercel only with Vercel's written approval, otherwise use Fallback F."
**Smaller:** "...approve G1-G5 only, cap USD 400."

## 10. Readiness evidence (local only; NOT hosted capacity)
Local smoke 2026-11-17 via `heavy.sh` on the production build, local Supabase, 25 synthetic tenants: 12 sessions, 146 s wall (120 s profile + graceful stop),
1.7 requests/s at peak hold (8.6 requests/session/min), p50/p95/p99 94/185/244 ms, 0 failures, 0 auth bounces, 11/11 sign-ins, 22 writes confirmed,
tenant isolation 0 violations in 98 scanned responses, 3/3 canaries refused. **PASS**. `run-staging.sh` pointed at the production host/ref was refused before any
network call; `__tests__/load` 58+11 tests pass (shell wrappers refuse production, missing env, local targets, bad names; `seed.mjs --plan` proves 6,000 orgs / 50,500
users cover every gate and flags the old 2,000-org seed as short). The dataset was torn down afterwards (`clean: true`). These numbers validate the harness only.
