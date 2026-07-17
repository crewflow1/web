# Directive → Main — Production Release Readiness

> Programme: make the entire `directive/018-r6-controlled-live-execution` branch releasable to
> production `main`. Audit date **2026-07-17**. Release candidate: `feat/whatsapp-hardening-release`
> (= directive tip + the WhatsApp stack #360/#361/#362). Prod `main` ends at migration `20260729`.
>
> **Method note (honesty):** findings below are **source + structural proof** (code, migrations,
> local typecheck) and **partial behavioural proof** (the WhatsApp slice ran real-Postgres CI). The
> authoritative **integration/e2e/build execution** proof for the *whole* delta comes only from the
> actual directive→main CI run — which has not yet executed. That is the single largest open item
> and is called out as such, not papered over. Four specialist audit agents ran; three stalled on
> runtime stream errors, so the migration + security conclusions here were **re-verified directly by
> the CTO** (grep/read of the real files), not taken from a partial agent.

---

## 1. Executive summary

The delta is **54 migrations / 356 commits** ahead of production. It is overwhelmingly **additive
and dark**: every new capability (AI-employee execution kernel, receptionist conversation engine,
WhatsApp inbound, semantic memory, comms seams) is gated behind default-`false` feature flags and
absent vendor credentials, layered on top of a **live, unaffected CRM + subscription-billing base**.
Crucially the delta also carries **real production integrity fixes** (billing claim-lease race,
cross-tenant invoice-payment fix, org-scoping) that are currently *stuck* behind the merge.

**The release is engineering-ready to ship dark.** There is **exactly one** irreversible operation
in all 54 migrations (LR5.4B legacy-column drop) and it is **verified forward-safe**. Zero new env
vars are required to boot. No new npm dependency. All flags fail closed. The correct strategy is a
**single grouped migration batch + dark deploy + phased per-feature flag activation**.

The gates to actually pressing "go" are **process, not code**: (a) the authoritative directive→main
six-gate CI run must be green; (b) the CEO must authorise the irreversible LR5.4B drop + the
production cutover (reserved decisions); (c) confirm Sentry/BetterStack env are set in Vercel so the
dark deploy is observable.

**Release Readiness Score: 88 / 100** (see §3).

---

## 2. Living roadmap (reconciled 2026-07-17 — supersedes the stale `docs/roadmap.md` @ #009)

The through-line of directives **#012 → #018** is a single **AI-employee execution kernel**, built
bottom-up. All merged to the directive branch; **none in production.**

| Track | State | Detail |
|---|---|---|
| Customer CRM (jobs/quotes/invoices/scheduling/portal) | ✅ **Live in prod** | ~58 pages, ~61 APIs; the base the AI operates on |
| SaaS subscription billing (Stripe) | ✅ **Live in prod** | checkout + 13-event webhook |
| Event Spine (write/audit/timeline) | ✅ **Live in prod** | consumer/reactive side dark (no registered consumers) |
| Shared Memory (lexical/structural recall) | ✅ **Live**; semantic **built-dark** | needs OpenAI key + worker flag |
| **#012 Task Engine** | 🟩 **Complete (branch)** | architecturally done; contract #5 partial |
| **#013 RunContext** | 🟩 **Complete (branch)** | contract #4 established |
| **#014 AI SDK envelope + doorman** | 🟩 **Complete (branch)** | executor built but **shadow-only** (no live ToolImplementation bound) |
| **#015 Capability Registry** | 🟩 **Complete (branch)** | legacy columns physically dropped (LR5.4B, irreversible) |
| **#016 Live Executor Rollout** | 🟨 **In progress** | R1 shadow merged; R2 authorised; R3–R6 pending |
| **#017 API Gateway + cost metering** | 🟨 **Shipped, no governance record** | ADRs stop at 0011 |
| **#018 Controlled Live Execution — WhatsApp #27** | ✅ **Complete (branch), dark** | 4 PRs, CI-green; #359 merged, #360/#361/#362 open |
| Receptionist conversation engine | 🟨 **Built, effect-free** | decides/drafts/audits; booking-exec framework-only; no quote path |
| HQ Sales AI — acquisition half | 🟩 **Built (branch)** | research + qualify + draft |
| HQ Sales AI — **conversion half** (send→reply→demo→won) | 🟥 **Not built** | funnel dies at `outreach_ready` |
| AI Boardroom (11 HQ employees) | 🟥 **Framework-only / inert** | by design; unlocks when an execution seam is armed |

- **Blocked** (on the merge + one armed execution/outbound seam): #017 activation, Task-Engine
  completion, Boardroom write/act, Shared Comms Protocol.
- **Deferred:** WhatsApp rich media; autonomous acknowledgements; Sales conversion half; Blueprint
  Centre / Mobile / Offline (Customer-WOW tier, gated behind an unbuilt design system).
- **Cancelled:** the legacy `ai_employees` capability mirror (LR5.1 retired, LR5.4B dropped).
- **Critical path:** **this production cutover** → arm **one** execution/outbound seam (the shared
  bottleneck of the kernel, receptionist, comms, and sales) → Sales conversion half.
- **Completion estimate:** **Engineering ≈ 78%** (kernel + channels + CRM built; execution seam +
  conversion half + boardroom-act remain). **Product (in customers' hands) ≈ 35%** (CRM + billing
  live; the entire AI-operated layer is branch-only until this release).

---

## 3. Release readiness score — 88 / 100

| Dimension | Score | Note |
|---|---|---|
| Migration safety | 19/20 | 53 additive; 1 irreversible (LR5.4B) verified forward-safe |
| Boot/deploy safety | 20/20 | zero new required env; no new npm dep; boots dark |
| Feature-flag safety | 15/15 | 4 flags default-false, strict `==="true"`, all fail closed |
| Tenant isolation / security | 14/15 | RLS on all new tables; org-scoped RPCs; −1 pending full definer sweep |
| CI / test rigour | 10/15 | 6 gates, no silent skips, local typecheck clean; **−5: authoritative full-delta CI not yet run** |
| Observability readiness | 10/15 | wired but optional; **−5: confirm Sentry/BetterStack env set in prod** |
| **Total** | **88/100** | High engineering readiness; residual is process + the one CI run |

---

## 4. Critical blockers (must clear before "go")

1. **CEO authorisation** for (a) the irreversible LR5.4B column drop and (b) the production cutover
   itself. *Reserved decision — cannot be self-approved.* (Forward-safety proven; the risk is
   irreversibility, which is a business decision.)
2. **Authoritative CI**: the directive→main integration PR must show all six gates green with the
   integration suite **executed** (file counts, zero skips) — not commit-message claims.
3. **Observability confirmation**: verify `NEXT_PUBLIC_SENTRY_DSN` / `BETTERSTACK_*` are set in the
   Vercel prod project, or the dark deploy ships blind to errors. (Optional env → could ship blind.)

None of the three is a code defect. **No release-blocking bug was found in the audit.**

---

## 5. Production risks (+ mitigation)

| Risk | Severity | Mitigation |
|---|---|---|
| LR5.4B irreversible drop | Med | Verified no live reader; forward-safe; snapshot `ai_employees` pre-migration for belt-and-braces |
| 54 migrations applied at once to the single prod DB (no staging) | Med | All additive/idempotent (`if not exists`); near-empty prod tables → no long locks; apply in one monotonic pass |
| A dark feature accidentally armed | Med | Flags default-false + strict compare + absent creds = triple-gated; monitor for any `ai_reply_transports` `sent` |
| Migration timestamp vs PR order (`20260919/21` predate `20260920`) | Low | Apply all in one deploy → monotonic; no functional dependency between them |
| Cron soft-fail if migrations lag deploy | Low | Apply migrations **before** deploy; crons fail-closed on `CRON_SECRET` |
| Semantic memory / executor still dark | Low | Intended; not part of this release's activation |

---

## 6. Migration audit

- **Count:** 54 (migrations `20260730` → `20260921`).
- **Destructive/irreversible:** **exactly one** — `20260812_lr5_4b_remove_legacy_authority_columns.sql`
  (`alter table public.ai_employees drop column tools_allowed, drop column permissions`). **Forward-safe:**
  grep-verified that no live `server/`/`lib/`/`app/` code reads those columns — the two apparent
  references are (i) `registry-authoring.ts:138` reading the **RPC-response envelope** `env.tools_allowed`,
  and (ii) `actions.ts:361` writing `tools_allowed` into **audit-log metadata jsonb** — neither touches
  the dropped columns. The Capability Registry is the sole authority now.
- **All other 53:** additive — `create table if not exists`, `add column … default`/nullable, `create
  index if not exists`, CHECK-widening. Verified: **no** `drop table`, `truncate`, or `delete from`
  anywhere in the delta. NOT-NULL added columns all carry constant DEFAULTs (safe on populated tables).
- **RLS:** every new table enables `row level security` in its own migration (0 gaps found).
- **Idempotency:** re-runnable guards used throughout; safe to re-apply.
- **Rollback:** the 53 additive migrations need **no** down-migration (flag-off = inert). LR5.4B is the
  only one that cannot be config-rolled-back — hence the CEO gate.

Full detail: `docs/whatsapp-release-inventory.md` (WhatsApp slice) + this audit.

---

## 7. Infrastructure audit

- **Env:** only **3** vars are required-to-boot (`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`) — all long-standing, already in prod. The **11 new delta vars are
  all optional/defaulted** ⇒ **zero new boot prerequisites**.
- **Flags:** 4 (`VOICE_NOTES`, `MISSED_CALL_TEXTBACK`, `WHATSAPP`, `BOOKING_EXECUTION`), all
  `default("false")`, strict `=== "true"`; provider seams default `"auto"` = dark without keys.
- **External deps:** none blocks the deploy (all dark). Per-feature activation only. Inngest is a
  dormant dep (0 refs). Vercel auto-registers 2 new crons (`overdue-invoices`, `task-reaper`) using the
  existing `CRON_SECRET` (fail-closed) — no manual cron step.
- **Build:** `package.json` unchanged vs `main` → no new npm dependency, no build risk. Node ≥20.

---

## 8. Security audit

- **RLS:** all new tenant tables (`receptionist_*`, `ai_reply_*`, `whatsapp_*`, `inbound_enquiries` alter)
  enable RLS; ledger tables use the RLS-on/zero-policy posture with server-side org filtering.
- **Tenant isolation:** every tenant table carries `org_id`; `hq_*` tables correctly omit it (HQ-global).
  Tenant-data `SECURITY DEFINER` RPCs scope by org and **copy `org_id` from the authoritative row, not
  the caller** (spot-verified `ai_reply_delivery_receipts` → `v_transport.org_id`). The 178 definer
  functions with no `org_id` reference are all `hq_*`/registry/executor (correctly HQ-global).
- **Hardening sweep** (`20260910–16`): genuine cross-tenant fixes (billing claim-lease race,
  cross-tenant invoice-payment) — these **improve** prod integrity and are a reason *to* ship.
- **WhatsApp slice:** independent review CLEAN — 14/14 invariants held (`docs/whatsapp-security-review.md`).
- **Residual (−1):** an exhaustive line-by-line pass over all 178 definer functions was not completed
  (agent stalls); the structural posture is verified sound and the tenant-facing RPCs spot-check clean.
  Recommend a focused definer sweep during the merge-PR review.

---

## 9. Rollback plan

- **Instant kill:** `NEXT_PUBLIC_FEATURE_*=false` (already the default) disables every new feature; the
  webhook routes 404, providers resolve null. No deploy revert needed.
- **Outbound-only stop:** clear `WHATSAPP_ACCESS_TOKEN` / `COMMS_*_PROVIDER=off`.
- **Single-tenant stop:** `ai_receptionist_setups.status` off `live` / route `active=false`.
- **Schema:** the 53 additive migrations need **no** rollback (inert while dark). **LR5.4B cannot be
  reversed** — mitigation is a pre-migration `ai_employees` snapshot; there is no live dependency, so
  reversal would never be needed operationally.
- **Bottom line:** rollback is a **config flip**, not a deploy revert or schema down-migration.

---

## 10. Deployment plan (the one recommended strategy)

**Grouped migration batch + dark deploy + phased flag activation.** Chosen over canary/phased-code
because: the code is *one* additive superset with everything flag-gated off, so there is nothing to
canary at the code layer — the risk lives entirely in (a) the migration batch and (b) later flag
flips, which this strategy isolates and sequences.

1. **Pre-flight:** confirm CI green on the directive→main PR; confirm Sentry/BetterStack env set;
   snapshot `ai_employees` (LR5.4B belt-and-braces); CEO authorises the cutover + LR5.4B.
2. **Migrate first:** apply all 54 migrations `20260730→20260921` in one monotonic pass to the single
   prod DB (before code deploy, so the new crons/tables exist).
3. **Deploy code:** Vercel deploy — boots on existing env; **all features dark**; 2 new crons auto-register.
4. **Smoke (dark):** §11.
5. **Phased activation (later, per-feature, reversible):** WhatsApp inbound (subscribe webhook → set
   secret → per-org `live` → flag on) → … → one execution/outbound seam when armed. Each step monitored,
   each independently rolled back by a flag.

---

## 11. Smoke-test plan (post-deploy, dark)

1. `GET /api/health` → 200 + commit SHA (app booted on the new build).
2. Existing CRM + billing pages load and function (regression-free — the live base is unaffected).
3. `GET/POST /api/webhooks/whatsapp` → **404 `not_enabled`** (new route present, gate closed).
4. New ledger tables exist with **0 tenant rows** (`whatsapp_webhook_events`, `whatsapp_number_routes`,
   `ai_reply_transports`, `ai_reply_delivery_receipts`).
5. `select count(*)` on a few migrated tables to confirm the batch applied cleanly.
6. Stripe subscription webhook still processes (existing live path unbroken).

---

## 12. Monitoring plan

- **Sentry:** error-rate step-change — must stay **flat** while dark (any spike = a migration/boot issue).
- **Event Spine:** cron/drain health; no stuck rows.
- **Billing:** Stripe webhook success rate unchanged.
- **New ledgers:** `whatsapp_webhook_events` in-flight-stuck index (`processed_at NULL` aging past the
  15-min lease); **any `ai_reply_transports` row with `status='sent'` before a send is intended** (the
  canary that an outbound seam armed unexpectedly).
- **Crons:** `overdue-invoices` / `task-reaper` execute without auth failures.

---

## 13. Final recommendation

**GO — ship the delta dark, as a single grouped release**, subject to the three §4 gates (CEO
authorisation of the cutover + LR5.4B, the authoritative green CI run, and the Sentry-env confirmation).
The engineering is release-ready: additive, dark, forward-safe, zero new boot prerequisites, no build
risk, all flags fail-closed, and the release *also* delivers real prod integrity fixes currently stuck
behind the branch. Holding the delta unreleased is now a larger risk (drift + unshipped fixes) than a
disciplined dark cutover. After cutover, the highest-leverage next programme is **arming one
execution/outbound seam** — the shared bottleneck that turns the built-but-effect-free AI layer into a
(human-gated) operating one.
