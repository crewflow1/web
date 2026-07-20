# RC3 — Maintenance-Window Cutover Runbook

**Strategy:** controlled maintenance-window cutover (CEO-approved). **Do not mutate production until the operator sends `PITR VERIFIED — PROCEED`.**
**Candidate:** PR #397, branch `release/rc3-full-platform`, head **`a2842c0`** (includes the maintenance-window gate).
**Prod project:** `jzntbskdqdopzwdqwvkp` (crewflow, West EU / Ireland).
**Author's note on risk:** production is currently **effectively empty** (verified read-only: 0 customers / 0 organizations / 0 quotes / 0 invoices / 0 automation_runs / 0 billing_events; only `ai_employees` = 12 internal rows). The customer-data blast radius of this cutover is therefore near-zero. The maintenance window is retained as correct hygiene (code/schema transition + cron/webhook safety) and to prove the mechanism for future populated releases.

---

## 1. Migration reconciliation (verified, read-only)

| Set | Value |
|---|---|
| Prod applied (`schema_migrations`) | **90** |
| RC3 migration files | **170** |
| main migration files | 100 |
| Prod-only (divergent) migrations | **0** — prod is a clean prefix of RC3 |
| **Pending to apply** | **80** (`20260720040000` → `20261007000000`), contiguous, no gaps |
| Timestamp collisions in RC3 | 0 |
| Destructive pending migrations | **1** — LR5.4B (`20260812`) only |
| LR5.4B prerequisite (`20260807` backfill) | in pending, **ordered before** LR5.4B ✓ |

**Verdict: reconciliation PASS** — no drift, no collision, no renamed/remote-only entries; the exact pending set is unambiguous.

## 2. The 80 pending migrations (grouped)

| Group | Range | Count | Nature |
|---|---|---|---|
| **Main-era catch-up** (prod is 10 behind main) | `20260720040000`–`20260729` | 10 | HQ timeline/lead-qualification/memory substrate + outreach. Additive, dark. |
| **Directive foundation** (HQ, Capability Registry, **LR5.4B**, Shadow Executor, Receptionist engine, tenant-integrity hardening, WhatsApp-inbound) | `20260730`–`20260918` | ~49 | Additive except LR5.4B. Registry backfill (`20260807`) precedes the LR5.4B drop (`20260812`). |
| **Site Management** (snags, diary, toolbox, site-reports + portal) | `20260919`–`20260923` | 5 | Additive tenant tables + `tenant_attachments` CHECK widening. |
| **Asset Management** (register…service schedules) | `20260924`–`20261003` | 10 | Additive; custody/QR/inspection/maintenance invariants. |
| **Commercial** (accepted-quote immutability, retention, purchase orders) | `20261004`–`20261006` | 3 | Additive; DB-enforced freeze/retention/PO constraints. |
| **Release hardening** (accepted-quote freeze side-channel) | `20261007` | 1 | `CREATE OR REPLACE` of two trigger functions. |

- **Shared constraint** (`tenant_attachments.target_table` CHECK) altered by **8** pending migrations — monotonic, no target dropped, final 15 targets. Each is a brief `ACCESS EXCLUSIVE` constraint swap; instant on the empty table.
- **Non-concurrent indexes**: the majority are created on tables *born in the same migration* (empty → instant). The few on pre-existing tables (`customers`, `invoices`, `automation_runs`, `billing_events`) are **all empty in prod** → zero lock time.
- **LR5.4B**: drops `ai_employees.tools_allowed` + `permissions` (12 rows). Irreversible; no down-migration.

## 3. Authoritative deployment order (proven)

Current prod code = **`main @ ed6b6ee`** (from `/api/health`), and `git grep` proves **main reads `ai_employees.tools_allowed` in 7 places** → **migration-first would break the live app.** RC3 code does not read the legacy columns (Capability Registry is the authority). Therefore:

> **Deploy RC3 *with maintenance ON first*, then migrate, then lift maintenance.**

This is the safe order: while maintenance is on, RC3's middleware returns 503 **before any DB query**, so RC3 serving on the not-yet-migrated 90-schema is harmless; and once RC3 (not main) is the deployed code, dropping the legacy columns is safe. Compatibility proof: *new code (RC3) never reads the dropped columns; old code (main) is no longer deployed at drop time.*

## 4. Maintenance mechanism (built + proven — commit `a2842c0`)

Smallest reliable mechanism: an **env-var gate**, DB-free, inert unless `MAINTENANCE_MODE=on`.
- `lib/maintenance.ts` — `isMaintenanceMode()` / `isMaintenanceBypassed()` / retry-safe `maintenanceResponse()`. **8 unit tests, green.**
- `middleware.ts` — customer/app routes → retry-safe **503** before session/DB work. Operators bypass with `MAINTENANCE_BYPASS` token (`?maint_bypass=`, `x-maintenance-bypass` header, or cookie).
- `lib/cron/auth.ts` — **all 19 crons** suppressed at the shared chokepoint; resume automatically after.
- `app/api/webhooks/{stripe,whatsapp,twilio}` + `app/api/receptionist/inbound` — return **503** so providers re-deliver after the window.
- `/api/health` stays reachable (excluded from the matcher) for operator verification.

**Env vars to set at cutover (values not printed here):** `MAINTENANCE_MODE=on`, `MAINTENANCE_BYPASS=<random token>`. Clear `MAINTENANCE_MODE` to reopen.

### Webhook provider behaviour during the 503 window
| Provider | Route | Behaviour on 503 |
|---|---|---|
| Stripe | `/api/webhooks/stripe` | Retries with backoff up to ~3 days → **not lost**. |
| Meta/WhatsApp | `/api/webhooks/whatsapp` | Dark (flag off) anyway; retries on non-2xx. |
| Twilio | `/api/webhooks/twilio/sms-status` | Status callback; retries a few times. Delivery-receipt only (non-critical). |
| Receptionist inbound | `/api/receptionist/inbound` | Caller retries; low volume, dark-adjacent. |

## 5. Cron freeze
All 19 crons are suppressed centrally (`isCronAuthorised` returns false while `MAINTENANCE_MODE=on`) — no `vercel.json` change, nothing removed. Highest-frequency crons that would otherwise fire mid-window: `spine-drain`, `spine-backfill`, `task-reaper` (every minute); `memory-embed` (2 min); `notifications-drain`, `memory-lifecycle` (15 min). All skip cleanly and resume on the next tick after reopen.

## 6. LR5.4B snapshot procedure (read-only; run at cutover)
Affected: `public.ai_employees` — columns `tools_allowed`, `permissions` (+ stable `id`). Row count: **12**.
Generate to an **operator-specified durable location** (NOT Git, NOT the ephemeral scratchpad):
```
supabase db query --linked "select id, tools_allowed, permissions, now() as snapshot_at,
  'jzntbskdqdopzwdqwvkp' as project_ref, '20260806(backfill)->20260812(drop)' as baseline
  from public.ai_employees order by id" > "$SNAPSHOT_DEST/ai_employees_lr5_4b_snapshot.json"
```
Then verify: file exists, non-zero, contains 12 ids + both legacy columns; compute a hash (`shasum`). Store only in the approved vault. **Preview only until the operator supplies `$SNAPSHOT_DEST`** — no production row values are printed to chat.

## 7. PITR verification checklist (operator — I cannot reach the dashboard)
1. Supabase Dashboard → project **crewflow** (`jzntbskdqdopzwdqwvkp`) → **Database → Backups**.
2. Confirm **Point-in-Time Recovery** is **enabled** (distinct from plain daily backups — PITR shows a *recovery window*, e.g. "7 days", and a WAL-based restore-to-timestamp control).
3. Confirm the **latest restorable point** is recent (within minutes) and the recovery window covers now.
4. Confirm the **project ref** on screen = `jzntbskdqdopzwdqwvkp`.
5. **PASS** = PITR enabled + recent recovery point + correct project. **NO-GO** = PITR disabled or only daily backups, or an active incident banner.
6. Send the confirmation text (or a screenshot) as `PITR VERIFIED — PROCEED`.

## 8. Dry-run preparation (run from the RC3 tree, not the stale clone)
The linked clone `~/Code/web` is on `seo/foundation-and-content` (63 files) — **do not run the cutover from there.** Link the RC3 tree to prod:
```
cd ~/Code/web-impl && git rev-parse --short HEAD   # must be a2842c0 (or later RC3)
supabase link --project-ref jzntbskdqdopzwdqwvkp   # link RC3 tree to prod
supabase migration list --linked                    # confirm 80 pending
supabase db push --dry-run --linked                 # MUST list exactly the 80 reconciled versions
```
Pre-flight asserts: repo=`web-impl`, branch=`release/rc3-full-platform`, SHA=`a2842c0`, files=170, project=`jzntbskdqdopzwdqwvkp`, pending=80, first=`20260720040000`, last=`20261007000000`. **Any dry-run difference from the 80 = NO-GO.**

## 9. Minute-by-minute cutover (after `PITR VERIFIED — PROCEED`)

**Before the window** · confirm RC3 green (`gh pr checks 397`) · take + verify the LR5.4B snapshot to the vault · baseline `/api/health` (record old SHA `ed6b6ee`) · re-run reconciliation · run + approve the dry-run (exactly 80).

**Enter maintenance** · set `MAINTENANCE_MODE=on` + `MAINTENANCE_BYPASS=<token>` in Vercel prod · **merge PR #397** (this deploys RC3 *with maintenance on*) · confirm the Vercel prod deploy is Ready and the deployed SHA = merge SHA · verify a customer route returns **503** and `/api/health` returns `ok:true` with the new SHA · confirm crons are suppressed. *(Deploying RC3 first is how we put prod into maintenance, since `main` has no maintenance gate.)*

**Migrate** · `supabase db push --linked` · capture full output · watch `20260807`→`20260812` order · confirm LR5.4B applied · record final tip `20261007000000` · **stop on any error** (see §10).

**Verify (still in maintenance)** · run §11 schema/invariant checks · run smoke tests via the bypass token (§ Phase-10 list) · confirm no 500s in Vercel/Supabase logs.

**Reopen** · clear `MAINTENANCE_MODE` (redeploy env or `vercel env rm`) · confirm customer routes serve 200 · crons resume · final smoke pass · begin soak.

## 10. Rollback decision tree
- **Migration fails BEFORE LR5.4B (`20260812`):** additive migrations only applied; safe. Stay in maintenance, diagnose the failing migration, fix-forward or restore last-applied. Old (main) code + RC3 both tolerate the partially-applied additive schema. Do **not** proceed to deploy-reopen until resolved.
- **Migration fails AT/AFTER LR5.4B:** columns already dropped. RC3 code is already deployed and does not need them → **fix-forward** the failing later migration; do **not** roll back the app to main (main needs the dropped columns). If unrecoverable → **PITR restore** to the pre-window timestamp, then re-deploy old SHA `ed6b6ee`.
- **Migration OK, deploy/merge already done, health FAILS:** `vercel rollback` to the previous production deployment is **unsafe** (old code on new schema, post-LR5.4B) → fix-forward RC3 or PITR-restore + old SHA.
- **Schema OK, smoke tests FAIL (in maintenance):** customers never saw it. Keep maintenance on, fix-forward, re-verify. Reopen only when green.
- **When NOT to forward-fix:** any suspected data corruption on a populated table, or LR5.4B left `ai_employees` inconsistent → PITR restore, do not improvise.
- **PITR restore threshold:** irrecoverable migration error, data corruption, or >~30 min stuck. Restore to pre-window point; redeploy `ed6b6ee`; post-mortem before retry.

## 11. Schema & invariant verification (read-only, post-migrate)
- `select count(*) from supabase_migrations.schema_migrations` → **170**; max version `20261007000000`.
- public table count ≈ **133** (from ~103 pre-cutover).
- `ai_employees.tools_allowed`/`permissions` → **absent** (LR5.4B done); `to_regclass('public.capability_registry')` → not null.
- `tenant_attachments` CHECK contains the **15** targets.
- Spot-check triggers/constraints exist: `tg_quotes_freeze_accepted` (keys on `accepted_at`), retention over-release guard, invoice line-item snapshot, `asset_assignments_one_open_idx`, QR one-active, inspection snapshot immutability, PO generated total.
- RLS enabled on the new tenant tables; no `using(true)` except `demo_requests`.

## 12. Timing (estimate vs fact)
- **Fact (CI):** full 170-migration apply on a fresh DB completes inside the integration gate (~3–4 min including `supabase start`). The 80-migration suffix is a subset → **estimate ~1–3 min** to apply against empty prod.
- **Estimate:** maintenance enable + merge→Vercel deploy ~2–5 min; migrate ~1–3 min; verify+smoke ~5–10 min; reopen ~1–2 min. **Minimum window ~15 min; recommended ~30 min** with buffer. Soak ≥ 30–60 min.
- No migration is expected to lock a populated table (all target tables empty in prod).

## 13. Rehearsal status (honest)
- **Proven:** CI applies **all 170** migrations on a fresh Postgres and is green on `a2842c0` — this covers the exact pending SQL end-to-end. Maintenance gate proven by 8 unit tests + a clean production build (middleware compiled).
- **Not independently rehearsed:** the literal "reconstruct prod's 90-migration state, apply the 80 suffix, boot RC3" — **no local Docker/Postgres and no staging** in this environment. Mitigation: prod is a *verified clean prefix* of RC3, so the 80-suffix apply is a sub-sequence of the CI-proven full apply; and RC3 is served only behind the maintenance 503 until the schema is complete. Residual risk is low but non-zero and is stated as such.

## 14. Readiness
**`READY — WAITING FOR PITR CONFIRMATION`.** All reconciliation, mechanism, and preparation gates pass; the only remaining precondition is operator PITR verification (§7). On `PITR VERIFIED — PROCEED`, execute §9 end-to-end without pausing between successful phases, stopping only for the §10 conditions.
