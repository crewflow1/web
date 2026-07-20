# RC3 — Production Release Record

**Status: `MERGED — DEPLOYED — MIGRATED — SCHEMA-VERIFIED — REOPENED — HEALTHY`**
*(Authenticated feature smoke tests: **NOT TESTED / BLOCKED** — see §Smoke. No production incident. No rollback.)*

Executed as a controlled maintenance-window cutover per `docs/RC3-MAINTENANCE-CUTOVER-RUNBOOK.md`, under CEO authorization, on **2026-07-20**.

## Evidence (all command/production-confirmed)

| Item | Value |
|---|---|
| PR merged | #397 → `main`, `state=MERGED`, `mergedAt=2026-07-20T22:12:04Z` |
| Merge commit | `295d8102d6790686e8677c8c51cd7301e2772e95` |
| `main` before → after merge | `ed6b6ee` → `295d810` |
| Reopen commit (clear maintenance) | `94eeea8` (empty commit → `main`) |
| Final live production SHA | **`94eeea8`** (`/api/health` `ok:true`, `env:production`, `branch:main`) |
| Pre-flight CI | 8/8 green on RC3 head `3e9e74a` (typecheck, lint, tests, integration [real PG], security, e2e [real app+PG], Vercel ×2) |
| LR5.4B snapshot | `~/crewflow-release-artifacts/ai_employees_lr5_4b_snapshot_3e9e74a.json` — 12 rows, both legacy columns, sha256 `809839d5…`, durable + outside Git |
| PITR | operator-verified (dashboard) before mutation |
| Dry-run | exactly the reconciled **80** migrations (`diff` = empty) |
| Migration apply | `supabase db push --linked` → all 80 applied in order, `Finished supabase db push`, exit 0. Only NOTICEs (idempotent `drop … if exists` + 63-char identifier truncation) — zero errors, no partial application |
| Applied migrations after | **170** (was 90), tip **`20261007000000`** |
| LR5.4B result | `ai_employees.tools_allowed` + `permissions` **dropped** (legacy_cols_remaining = 0) |
| Public tables | 158 (153 base tables, all RLS-enabled; 0 without RLS) |

## Migration reconciliation (pre-cutover, verified)
Prod was a **clean 90-migration prefix** of RC3 (0 prod-only, 0 collisions); pending = **80** (`20260720040000`→`20261007000000`); prod was 10 behind `main`. Only 1 destructive migration (LR5.4B); its backfill (`20260807`) ordered before it.

## Deployment order (proven)
Current prod code (`main @ ed6b6ee`) read the legacy columns (7 refs) → migration-first unsafe. Executed **RC3-deploy-with-maintenance-first → migrate → reopen**: RC3 middleware returned 503 before any DB call, so serving on the pre-migration schema was harmless, and `main` was no longer live when LR5.4B dropped the columns.

## Maintenance window
- Enabled via `MAINTENANCE_MODE=on` (Vercel prod); RC3 deployed with it on.
- **Verified live:** customer routes → 503 (+`retry-after: 120`); Stripe webhook → 503 (retry-safe); operator bypass (`?maint_bypass=`) → 200; `/api/health` → 200; all 19 crons suppressed at the shared chokepoint.
- Lifted by removing `MAINTENANCE_MODE` + redeploying `main` (`94eeea8`).

## Schema & invariant verification (read-only, post-migrate) — PASS
170 migrations / tip `20261007`; LR5.4B columns absent; `hq_capabilities` + `hq_capability_grants` present; `quotes_freeze_accepted`, `retention_releases_guard`, `asset_assignments_one_open_idx`, `tenant_attachments_target_table_check` (15 targets) all present; 153/153 base tables RLS-enabled.

## Smoke tests
- **App-boots-on-new-schema (via bypass): PASS** — `/login` 200, `/q/[token]` 200 (quotes queried), `/customer-portal/[token]` 200 (customers/portal queried), `/a/[token]` 307, `/api/health` 200; **no 5xx / `relation does not exist` in logs**.
- **Authenticated + data flows: NOT TESTED / BLOCKED** — production is empty (0 orgs/customers/quotes/invoices) so there is no internal test organisation, and no operator login credentials were available to the operator running the cutover (account creation is out of scope). Sign-in, customer/quote/job/invoice/portal-with-data, and asset/site/commercial CRUD remain to be exercised by a human with credentials.

## Post-reopen health & soak — PASS
`/`, `/login`, `/q/`, `/customer-portal/`, `/api/health` all 200; health `ok:true` SHA `94eeea8`; dark features dark (`sms/whatsapp/missedCallTextbackReady` = false); no errors in production logs.

## Dark features (unchanged — remain off)
WhatsApp, missed-call text-back, booking execution, voice-notes: all default-off flags, confirmed dark. WhatsApp #360–362 + telephony #113 remain **deferred** (not in RC3).

## Remaining human follow-ups
1. Run the authenticated feature smoke suite with operator credentials against a seeded test org.
2. Regenerate `lib/supabase/types.ts` against the deployed schema (clears the 292-cast tech-debt) — the exact next engineering milestone.
3. Rotate/remove the `MAINTENANCE_BYPASS` env var now the window is closed (optional hygiene).
