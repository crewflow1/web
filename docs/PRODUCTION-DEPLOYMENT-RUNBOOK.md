# CrewFlow — Production Deployment Runbook

> ## 🔄 RC2 ADDENDUM — through PR #374 (2026-07-19)
>
> This runbook's baseline (2026-07-17) is unchanged and authoritative for the
> directive→main mechanics (Vercel Git deploy, `supabase db push`, LR5.4B ordering,
> health checks, comms readiness). **RC2 adds 7 additive migrations and their routes
> on top of that baseline** (PRs #367–#374). No step below changes; this addendum
> only extends the migration list + the smoke checklist.
>
> **New migrations to `supabase db push` (in this order, AFTER the code deploy — the
> same code-before-migration rule as the baseline; all additive, none destructive):**
> `20260919_snags` · `20260920_site_diary` · `20260921_toolbox_talks` ·
> `20260922_site_reports` · `20260923_site_reports_portal` · `20260924_assets` ·
> `20260925_asset_assignments`.
>
> **New prerequisites: none.** No env vars, vendors, feature flags, crons, or buckets.
> All reuse the existing `tenant-attachments` bucket + `current_org_ids`/`is_org_admin`/
> `tg_set_updated_at` helpers + `recordAdminActivity`.
>
> **Post-deploy smoke (new surfaces):** open `/snags`, `/diary`, `/toolbox`,
> `/site-reports`, `/assets` (each lists + empty-state renders); create one asset →
> check it out → confirm custody card; issue a site report → download its PDF;
> publish a report → open `/customer-portal/[token]/reports` as the customer.
>
> **Rollback:** all additive. A Vercel revert hides the new nav/routes immediately;
> the additive tables/columns are safe to leave in place (no reader in old code) or
> drop in reverse order (`20260925`→`20260919`) — no customer data is touched.
>
> ---


> **Canonical operational runbook.** Directive `018-r6` → production. Authored 2026-07-17.
> **Audience:** a senior engineer who has never worked on CrewFlow. Every action is explicit; every
> expected result is documented; every decision has objective criteria. **No tribal knowledge assumed.**
> Read end-to-end once before starting. Companion docs: `docs/RELEASE-MANIFEST.md` (what ships),
> `docs/directive-to-main-release-readiness.md` (audit).
>
> **This runbook changes nothing by itself.** It is the procedure; you execute it on CEO go.

---

## 1. Executive summary

Deploy the entire directive branch (**54 migrations, ~161 PRs, directives #012–#018**) to production as
**one grouped release, dark**. Everything new is gated behind default-`false` feature flags and absent
vendor credentials, atop a live, unaffected Customer-CRM + Stripe-billing base. **The deploy activates
nothing** — activation is a separate, later, per-feature step.

**Deployment complexity: MODERATE.** The code is one additive superset; the risk is concentrated in
exactly two places — (a) the single `supabase db push` that applies 54 migrations (incl. one
irreversible), and (b) later flag flips. Both are isolated and sequenced here.

**Estimated total duration: 60–90 minutes** (active), + a monitoring soak. **Highest-risk stage:** the
migration push (Stage 7). **Operational readiness: 90/100.**

**The single most important rule of this release:** **deploy the code FIRST, then run `db push`.** The
LR5.4B migration drops `ai_employees.tools_allowed/permissions`, columns the *current* production code
still reads. The new code does **not** read them (it uses the Capability Registry, with a legacy
fail-safe). Applying the migration before the new code is live would break the running app. **Order:
merge → Vercel deploys new code (dark) → verify → `db push`.** This matches CrewFlow's own doctrine
(directive-012 completion report: *"the cutover — merge, then a scheduled `supabase db push` … one
CEO-reviewed push, on a maintenance window, never auto-applied; dry-run on a branch DB first"*).

---

## 2. Release overview

- **What:** 54 migrations `20260730→20260921`; the AI-employee execution kernel (dark), the
  receptionist conversation engine (dark), WhatsApp inbound (dark), semantic memory (dark), and **live
  tenant-integrity fixes** (cross-tenant invoice-payment, billing claim-lease, org-scoping).
- **Release candidate:** PR **#363** (`release/directive-to-main-integration` → `main`), CI-green
  (all six gates + Vercel build; integration 94 files/677 tests, e2e 13, zero skips).
- **One irreversible migration:** LR5.4B (`20260812`), forward-safe, **snapshot already taken**
  (`docs/release-artifacts/lr5_4b-prerelease-ai_employees-snapshot.json`).

## 3. Deployment prerequisites (all must be TRUE before Stage 4)

| # | Prerequisite | How to verify | Blocker if false |
|---|---|---|---|
| 3.1 | CEO has authorised merge + deploy + LR5.4B | Written CEO approval | STOP |
| 3.2 | PR #363 all gates green | `gh pr checks 363` → all `pass` | STOP |
| 3.3 | Supabase CLI installed + linked to prod | `supabase projects list` shows the linked prod ref (`crewflow.uk` project) | STOP |
| 3.4 | Vercel project connected to the repo, `main`=production | Vercel dashboard → Settings → Git → Production Branch = `main` | STOP |
| 3.5 | 3 boot env vars set in Vercel prod | Vercel → Settings → Environment Variables: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | STOP (app won't boot) |
| 3.6 | Observability env set (recommended) | Vercel env has `NEXT_PUBLIC_SENTRY_DSN`, `BETTERSTACK_*` | Proceed but deploy is "blind" — strongly discouraged |
| 3.7 | LR5.4B snapshot exists | `docs/release-artifacts/lr5_4b-prerelease-ai_employees-snapshot.json` present (12 rows) | STOP |
| 3.8 | Maintenance window scheduled | low-traffic window agreed | Recommended |

**Tools required:** `git`, `gh` (GitHub CLI, authenticated), `supabase` CLI (pinned version matching
`supabase/config.toml`, Postgres 17), access to the Vercel dashboard, access to the Supabase dashboard.

## 4. Production environment verification (pre-flight)

**Objective:** confirm prod is in the expected pre-deploy state. **Duration: ~5 min.**

```bash
# 4.1 Confirm prod DB is reachable and at the pre-release migration state.
supabase db query --linked "select count(*) as applied from supabase_migrations.schema_migrations;"
#   Expected: ~100 (main's migration count). Success: query returns; count matches main.
#   Failure: connection error → fix CLI link before proceeding.

# 4.2 Confirm the legacy columns LR5.4B will drop still exist (proves prod < 20260812).
supabase db query --linked "select column_name from information_schema.columns
  where table_name='ai_employees' and column_name in ('tools_allowed','permissions');"
#   Expected: 2 rows. Success: both present. Failure: 0 rows → LR5.4B may already be applied; STOP + investigate.

# 4.3 Current prod app health (baseline).
curl -s https://crewflow.uk/api/health | jq
#   Expected: {"ok":true,"service":"crewflow-web","env":"production","sha":"<old7>",...}
#   Record the OLD sha — you will confirm it CHANGES after deploy.
```

**Success criteria:** DB reachable, ~100 migrations applied, legacy columns present, `/api/health` 200.
**Failure criteria:** any query error, unexpected migration count, or non-200 health → **do not proceed.**

## 5. Backup strategy

**Objective:** a restorable point before any change. **Duration: ~5–10 min.**

CrewFlow prod is a single Supabase Postgres (no staging). Two layers:

```bash
# 5.1 Confirm Supabase Point-In-Time-Recovery (PITR) / daily backup is enabled.
#     Supabase Dashboard → Database → Backups. Note the latest backup timestamp.
#     Success: a recent backup exists (PITR window covers now). Failure: no backup → enable before proceeding.

# 5.2 Take an on-demand logical dump of the tables the release touches most (belt-and-braces).
#     ai_employees is the one with an irreversible change; dump the whole small HQ set.
supabase db dump --linked --data-only -f prod-predeploy-$(date +%Y%m%d).sql
#   Success: file written, non-zero size. Store it OUTSIDE the repo (ops vault).
```

**Success:** PITR confirmed + a logical dump saved. **Failure:** no backup path → **STOP** (never deploy
without a restore point). **Rollback trigger:** n/a (this is the safety net itself).

## 6. Database snapshot procedure (LR5.4B — already done, verify)

**Objective:** the specific rollback artifact for the one irreversible migration. **Duration: ~2 min.**

Already captured (Stage-3 prerequisite). **Verify it, do not re-take unless missing:**

```bash
jq 'length' docs/release-artifacts/lr5_4b-prerelease-ai_employees-snapshot.json
#   Expected: 12. Success: 12 employee rows with tools_allowed + permissions.
#   Failure: file missing/short → re-capture (see §6.1) BEFORE Stage 7.
```
**§6.1 Re-capture (only if missing):**
```bash
supabase db query --linked "select json_agg(json_build_object('id',id,'slug',slug,
  'tools_allowed',tools_allowed,'permissions',permissions) order by slug) from public.ai_employees;" \
  > docs/release-artifacts/lr5_4b-prerelease-ai_employees-snapshot.json
```
**This snapshot is the ONLY way to restore `tools_allowed/permissions` if LR5.4B is ever reversed.**

## 7. Migration execution ⚠ HIGHEST-RISK STAGE

**Objective:** apply all 54 migrations to prod, in order, as one push. **Duration: ~5–15 min.**
**Runs AFTER Stage 8's deploy is verified healthy** (see the ordering rule in §1). Presented here to keep
all migration detail together; execute in the Stage order (8 → then 7).

**7.1 Dry-run first (mandatory).** Never push blind to prod.
```bash
supabase db push --linked --dry-run
#   Expected: lists exactly the 54 pending migrations 20260730…20260921, in order, no errors.
#   Success: 54 listed, includes 20260812 (LR5.4B) and 20260921. Failure: fewer/more, or an error → STOP.
```
**7.2 Apply.**
```bash
supabase db push --linked
#   Expected: each migration "Applying migration <name>..." → success; ends cleanly.
#   Watch specifically for: 20260806 (capability_registry) + 20260807 (backfill) BEFORE 20260812 (LR5.4B drop),
#   and 20260919/20/21 (WhatsApp) applying monotonically.
```
**7.3 Validate.**
```bash
supabase db query --linked "select count(*) from supabase_migrations.schema_migrations;"   # Expect ~154
supabase db query --linked "select column_name from information_schema.columns
  where table_name='ai_employees' and column_name in ('tools_allowed','permissions');"       # Expect 0 rows (dropped)
supabase db query --linked "select to_regclass('public.whatsapp_webhook_events'),
  to_regclass('public.ai_reply_transports'), to_regclass('public.hq_ai_tasks');"             # Expect all non-null
```

**Per-migration behaviour** (deploy order = filename timestamp; all additive/idempotent except LR5.4B):
| Group | Purpose | Expected behaviour | Validation |
|---|---|---|---|
| `20260730–05` HQ AI substrate | approvals/drafts/comms/tasks tables | create-if-not-exists | tables exist, 0 rows |
| `20260806–11` Capability Registry (+backfill, +memory authority) | new authority + backfill from legacy cols | additive + data backfill | registry populated from `ai_employees` |
| **`20260812` LR5.4B** ⚠ | **drop `ai_employees.tools_allowed/permissions`** | **irreversible** — succeeds because backfill ran + new code doesn't read them | columns gone; boardroom admin still renders |
| `20260813` executor shadow | shadow observations ledger | additive | table exists |
| `20260814–20260909` receptionist engine (28) | conversation engine + reply ledgers + review inbox + claims | additive tables/views/RPCs, append-only | tables exist, 0 rows |
| `20260910–16` integrity hardening | cross-tenant + concurrency fixes on LIVE tables | additive columns/constraints (safe supersets) | constraints present; live data intact |
| `20260917–21` WhatsApp | webhook/routing/dedup/channel-widen/read-status | additive | ledgers exist, CHECK admits `whatsapp`/`read` |

**Success criteria:** 54 applied, ~154 total, legacy columns dropped, new tables present, no error.
**Failure criteria:** any migration errors mid-push. **Rollback trigger:** a push failure → §17/§18.

## 8. Application deployment

**Objective:** get the new (dark) code live BEFORE the migration push. **Duration: ~5 min + build.**

CrewFlow deploys via **Vercel Git integration**: merging to `main` auto-deploys production. **There is no
manual deploy command and no deploy CI job.**

```bash
# 8.1 On CEO go, merge the validated RC into main (this triggers the Vercel production deploy).
gh pr merge 363 --merge     # merge commit; do NOT squash (preserves the reviewed history)
#   Success: PR merged; Vercel dashboard shows a new Production deployment "Building".
```
```bash
# 8.2 Wait for the Vercel production deploy to reach "Ready" (dashboard, ~2–4 min build).
# 8.3 Confirm the new code is live — the sha MUST change from the Stage-4.3 baseline.
curl -s https://crewflow.uk/api/health | jq '.sha, .env'
#   Expected: a NEW 7-char sha (the merge commit), env "production". Success: sha changed. Failure: unchanged → deploy didn't roll.
```
**Now proceed to Stage 7 (migration push).** Between 8 and 7 the new code runs on the OLD schema — this
is SAFE: customer features use existing tables; new features are dark (flags off); the SDK falls back to
the still-present legacy columns; the 2 new crons (`overdue-invoices`, `task-reaper`) soft-fail
harmlessly until their tables exist. Keep the 8→7 gap SHORT (minutes).

**Success:** new sha live, app 200. **Failure:** build fails or health non-200. **Rollback trigger:**
Vercel deploy failed or unhealthy → §18 (instant Vercel rollback; no migration ran yet, so trivial).

## 9. Infrastructure verification (post-deploy, post-push)

**Duration: ~5 min.**
```bash
# 9.1 Crons registered. Vercel Dashboard → Settings → Crons: expect 17 entries incl. the 2 new
#     (/api/cron/overdue-invoices @ '30 9 * * *', /api/cron/task-reaper @ '* * * * *').
# 9.2 Cron auth works (fail-closed on CRON_SECRET):
curl -s -o /dev/null -w "%{http_code}" https://crewflow.uk/api/cron/task-reaper      # Expect 401 (no secret) — good, it's protected
# 9.3 Edge/runtime: /api/health served from edge, no-store. (verified in §8.3)
```
**Success:** 17 crons listed; cron endpoints 401 without the secret. **Failure:** crons missing → confirm
`vercel.json` deployed; secret 200 (unprotected) → **STOP**, investigate `CRON_SECRET`.

## 10. Feature-flag verification (must all be DARK)

**Duration: ~3 min.** The release must land with everything off.
```bash
# 10.1 The 4 flags default false; confirm none is set to "true" in Vercel prod env.
#      Vercel → Settings → Env: NEXT_PUBLIC_FEATURE_{WHATSAPP,MISSED_CALL_TEXTBACK,BOOKING_EXECUTION,VOICE_NOTES}
#      Expected: unset or "false". Success: none is "true".
# 10.2 Behavioural proof — WhatsApp webhook is dark:
curl -s -o /dev/null -w "%{http_code}" -X POST https://crewflow.uk/api/webhooks/whatsapp   # Expect 404 (not_enabled)
# 10.3 No outbound armed:
supabase db query --linked "select count(*) from ai_reply_transports where status='sent';"   # Expect 0
```
**Success:** all flags off/false; webhook 404; 0 sent transports. **Failure:** any flag "true" or a `sent`
row → a feature is armed unexpectedly → set the flag false + redeploy env immediately (§18 flag path).

## 11. Third-party service verification

**Duration: ~5 min.**
| Service | Check | Expected | If fails |
|---|---|---|---|
| Supabase | §7.3 queries | tables/migrations present | STOP — migration issue |
| Vercel | §8.3 health | new sha, 200 | STOP — deploy issue |
| Stripe (live) | trigger a test webhook / check Stripe dashboard event log | events 2xx | investigate; billing is live, not new |
| Resend (live email) | send a test / check Resend dashboard | delivered | non-blocking (email path unchanged) |
| Sentry/BetterStack | events arriving after deploy | error rate flat | if silent → observability blind (see §3.6) |
| Meta WhatsApp / Twilio | n/a this deploy | DARK (no creds) | activation-time only |

## 12. Smoke tests (post-deploy + post-push, DARK)

**Duration: ~10 min.** All must pass.
```bash
# 12.1 App boots on new build:      curl -s https://crewflow.uk/api/health | jq .ok         # true, new sha
# 12.2 Customer plane regression-free: load a jobs page, a quotes page, an invoices page, the customer portal — all render.
# 12.3 WhatsApp webhook dark:        curl -sX POST https://crewflow.uk/api/webhooks/whatsapp -o /dev/null -w "%{http_code}"  # 404
# 12.4 New ledgers empty:           supabase db query --linked "select count(*) from whatsapp_webhook_events;"   # 0
# 12.5 Registry authoritative:      load /admin/ai-boardroom → an employee page renders (proves LR5.4B cutover OK)
# 12.6 Stripe webhook still live:   confirm a recent subscription event processed (Stripe dashboard)
# 12.7 Crons healthy:               after ~2 min, no error spike from task-reaper/spine-drain (Sentry / logs)
```
**Success:** all seven pass. **Failure:** any → classify (product / data / config) → §17.

## 13. Health checks

- **Endpoint:** `GET https://crewflow.uk/api/health` → 200 `{ok:true, sha:<new>, env:"production"}`.
- **Cadence:** every 1–2 min for the first 30 min (BetterStack monitor + manual).
- **Green:** 200 + correct sha, stable. **Red:** non-200, wrong sha, or flapping → §17.

## 14. Production verification (correctness, dark)

- [ ] 54 migrations applied (`~154` total); `ai_employees` has no `tools_allowed/permissions`.
- [ ] `/api/health` returns the new merge sha.
- [ ] Customer features (jobs/quotes/invoices/portal/scheduling) regression-free.
- [ ] All `NEXT_PUBLIC_FEATURE_*` dark; WhatsApp webhook 404; 0 `sent` transports.
- [ ] Integrity hardening effective (spot-check an invoice-payment is org-scoped).
- [ ] Sentry error rate flat vs the Stage-4 baseline.
- [ ] 17 crons registered; no cron error spike.

## 15. Monitoring checklist (first 24h)

| Signal | Where | Healthy |
|---|---|---|
| App error rate | Sentry | flat vs baseline (dark = no new errors) |
| Uptime / health | BetterStack `/api/health` | 200, stable |
| Stripe webhooks | Stripe dashboard | success rate unchanged |
| Cron execution | Vercel logs / Sentry | all 17 run; no auth failures |
| `whatsapp_webhook_events` in-flight | DB query | 0 (dark) |
| `ai_reply_transports status='sent'` | DB query | **0** (the "armed unexpectedly" canary) |
| Event-spine drain | logs | no stuck rows |

## 16. Alert thresholds

| Metric | Warn | Critical (page) |
|---|---|---|
| 5xx error rate | > 0.5% over 5 min | > 2% over 5 min |
| `/api/health` | 1 failed probe | 3 consecutive fails |
| Sentry new-issue rate | any new issue post-deploy | > 5 new issues / 10 min |
| Cron failure | 1 failure | same cron fails 3× consecutively |
| Unexpected `sent` transport | **any** (while dark) | any (investigate immediately) |
| Stripe webhook failure | > 1% | > 5% |

## 17. Rollback decision tree

```
Is the app serving 5xx / failing /api/health?
├─ YES → was `db push` already run (Stage 7)?
│        ├─ NO  → Stage 18-A: Vercel instant rollback to the prior deployment. DONE (no schema change).
│        └─ YES → is the failure caused by the schema (query errors referencing new/old columns)?
│                 ├─ likely NO (additive) → Stage 18-A Vercel rollback; migrations stay applied (harmless, dark).
│                 └─ YES + LR5.4B implicated → Stage 18-B (restore ai_employees from snapshot) + Vercel rollback.
├─ NO, but a FEATURE looks armed (sent transport / unexpected send)
│        → Stage 18-C: set the feature flag false + clear provider creds; redeploy env. No rollback needed.
└─ NO, healthy but a cron/integration soft-failing
         → do NOT roll back; fix forward (transient; self-heals once tables exist / config corrected).
```
**Default bias:** if the app is unhealthy and `db push` has NOT run, roll back the deploy — it is instant
and lossless. Migrations are additive, so even post-push a code rollback is safe (old code + new additive
schema coexist; the only exception is LR5.4B, handled in 18-B).

## 18. Emergency rollback procedures

**18-A · Instant deploy rollback (most common).** Duration: ~2 min.
```
Vercel Dashboard → Deployments → the last-known-good production deployment → "Promote to Production".
(Or: git revert the merge on main → push → Vercel redeploys the prior code.)
Verify: curl /api/health → sha reverts to the old value; app 200.
```
**18-B · LR5.4B column restore (only if a rollback needs the dropped columns).** Duration: ~10 min.
```
1. Re-add the columns:  supabase db query --linked
     "alter table public.ai_employees add column tools_allowed jsonb, add column permissions jsonb;"
2. Restore data from the snapshot (docs/release-artifacts/lr5_4b-prerelease-ai_employees-snapshot.json):
     for each row, update ai_employees set tools_allowed=..., permissions=... where id=...;
   (script the 12 rows from the snapshot JSON.)
3. Promote the prior Vercel deploy (18-A).
NOTE: operationally this should never be needed — the new code does not read these columns.
```
**18-C · Feature kill (no rollback).** Duration: ~1 min.
```
Vercel → Env: set the offending NEXT_PUBLIC_FEATURE_* = false (or clear WHATSAPP_ACCESS_TOKEN) → Redeploy.
Verify: the feature path returns dark (webhook 404 / provider no_provider).
```
**18-D · Full DB restore (catastrophic only).** Supabase Dashboard → Backups → PITR → restore to the
Stage-5 timestamp. Duration: 15–60 min. Last resort; coordinate with CEO.

## 19. Incident response

- **App down post-deploy, pre-push:** 18-A. **Sev-2.** ~2 min recovery.
- **Migration push fails mid-way:** the failed migration + all prior applied. Additive migrations already
  applied are harmless. Fix the failing migration cause OR 18-A (roll code back; leave partial additive
  schema — inert). **Sev-1** (single prod DB). Do NOT re-run blindly; inspect which migration failed
  (`supabase_migrations.schema_migrations`).
- **A dark feature armed:** 18-C immediately, then investigate the gate. **Sev-2.**
- **Data integrity concern:** 18-D + CEO. **Sev-1.**
- **Escalation contact:** CEO/founder (single-operator platform). Every migration anomaly is Sev-1
  because there is no staging.

## 20. Recovery validation (after any rollback)

```bash
curl -s https://crewflow.uk/api/health | jq '.sha'                 # sha = the restored version
# Customer pages render; Stripe webhooks process; error rate returns to baseline.
supabase db query --linked "select count(*) from supabase_migrations.schema_migrations;"  # matches the restored state
```
**Success:** health green, customer plane working, error rate baseline, migration count consistent.
Document what happened in the incident log before resuming.

## 21. Post-deployment checklist

- [ ] All Stage-14 verification items green.
- [ ] 30-min monitoring soak clean (error rate flat, health stable).
- [ ] LR5.4B snapshot + pre-deploy dump archived in the ops vault.
- [ ] Deployment logged (who, when, merge sha, migration count, anomalies).
- [ ] Feature flags confirmed dark; activation deferred to the §22 sequence.
- [ ] CEO notified: release live + dark; ready for phased activation on a separate go.

## 22. Go / No-Go checkpoints

| Gate | Go criteria | No-Go action |
|---|---|---|
| **G0 Pre-flight** | §3 all true; §4 baseline healthy | fix prerequisite; do not start |
| **G1 Backup** | PITR + dump confirmed (§5) | STOP — no restore point |
| **G2 Deploy** | new sha live, app 200 (§8) | 18-A rollback; abort |
| **G3 Migration dry-run** | 54 pending, no error (§7.1) | STOP; investigate; do not push |
| **G4 Migration apply** | 54 applied, validation green (§7.3) | 19 (migration incident) |
| **G5 Smoke** | all §12 pass | 17 decision tree |
| **G6 Soak** | 30-min monitoring clean | hold; investigate before declaring done |
| **G7 Activation** | *separate CEO go, later* | keep dark |

## 23. Estimated timings

| Stage | Duration |
|---|---|
| 3–4 Prereq + pre-flight | 10 min |
| 5–6 Backup + snapshot verify | 10 min |
| 8 Merge + Vercel deploy | 5 min + ~3 min build |
| 7 Migration dry-run + push + validate | 5–15 min |
| 9–14 Infra/flags/services/smoke/verify | 20 min |
| 15 Monitoring soak (active) | 30 min |
| **Total active** | **~75–90 min** |

## 24. Common operator mistakes (avoid these)

1. **Running `db push` BEFORE deploying the code.** Breaks prod (old code reads the LR5.4B-dropped
   columns). **Always deploy first, then push.**
2. **Skipping the dry-run** (§7.1). Never push blind to the single prod DB.
3. **Squash-merging PR #363.** Use a merge commit (preserves reviewed history + the migration chain).
4. **Setting a feature flag "true" during deploy.** The release is DARK; activation is a separate step.
5. **Assuming a green preview = green prod.** Confirm the prod `/api/health` sha actually changed (§8.3).
6. **Forgetting the snapshot** before LR5.4B. It is the only rollback path for the dropped columns.
7. **Panicking at cron soft-fails in the 8→7 window.** They self-heal once tables exist; keep the gap short.
8. **Not confirming Sentry env** — deploying blind. Confirm §3.6 first.
9. **Re-running a partially-failed `db push` blindly.** Inspect `schema_migrations` first (§19).

## 25. Lessons learned (carry into future releases)

- **Additive + dark + flag-gated** is what makes a 54-migration cutover safe as one push — keep every
  future feature dark-by-default with a fail-closed flag.
- **Irreversible migrations demand code-before-migration ordering** and a pre-migration data snapshot;
  prefer the expand/contract pattern (drop columns a release *after* the code stops reading them).
- **Single prod DB, no staging** makes every migration Sev-1 — the mandatory dry-run + one CEO-reviewed
  push + PITR are non-negotiable. Consider a disposable branch DB for future dry-runs.
- **`db push` is manual and not in CI** — deployment is Vercel-Git-auto but migrations are a deliberate
  human step; never wire them to auto-apply.
- **The authoritative proof is the executed CI run** (file counts, zero skips), not "it built."
- Reconcile governance canon (#017/#018 ADRs) so the next operator inherits a complete ledger.

---
*Canonical Production Deployment Runbook. Execute in Stage order (note 8→7 for the code-before-migration
rule). Change nothing outside this procedure without CEO approval.*
