# CrewFlow — Production Deployment Runbook (RC3)

> **⚠ SUPERSEDED — this cutover was EXECUTED on 2026-07-20 (`94eeea8`).**
> Historical runbook of the completed deployment. Current state:
> `docs/stage-one-reconciliation.md`.

Companion to `docs/RELEASE-MANIFEST-RC3.md`. Covers the cutover of `release/rc3-full-platform` (PR #397) into production `main`. **Single production Supabase, no staging** — so pre-flight verification and backups are load-bearing.

> **Authorization gate:** this runbook is not to be executed without an explicit human go/no-go. The one irreversible step (LR5.4B) additionally requires named authorization. Nothing here is run by the assistant.

## 0. Deployment prerequisites (all TRUE before Stage 5)

- [ ] PR #397 CI is fully green (6 gates + Vercel).
- [ ] The `ai_employees` pre-migration snapshot exists in the ops vault (12 rows, `tools_allowed` + `permissions`). Captured pre-RC2; re-verify it is still readable.
- [ ] Supabase PITR / daily backup is enabled and the window covers "now".
- [ ] Required env vars are set in the Vercel production project (see manifest §7). In particular `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` — **without `CRON_SECRET` all 19 crons 401 silently**.
- [ ] Feature flags confirmed absent or `false` (WhatsApp, missed-call, booking, voice-notes stay dark).
- [ ] Named authorization recorded for the LR5.4B column drop.

## 1. Pre-flight verification (production DB)

1.1 Confirm prod is reachable and at the pre-release migration state — expect **~100** applied migrations (main's count). If the count already exceeds 100, STOP and reconcile.
1.2 Confirm the two LR5.4B target columns still exist (`ai_employees.tools_allowed`, `ai_employees.permissions`) — proves prod is `< 20260812`. If absent, LR5.4B may already be applied → STOP + investigate.
1.3 Record current prod app health + the deployed SHA (you will confirm it changes post-deploy).

## 2. Backup (belt-and-braces on top of PITR)

2.1 Confirm the latest automatic backup timestamp.
2.2 Take an on-demand logical dump of the HQ set (the only irreversible change is on `ai_employees`); store OUTSIDE the repo.
2.3 Re-verify the `ai_employees` snapshot file (§0) is complete: 12 rows with both legacy columns.

## 3. Migration dry-run

3.1 List pending migrations — expect exactly the **70** new files `20260730…20261007`, in order, no gaps. Confirm the list includes `20260807` (registry backfill) **before** `20260812` (LR5.4B), and ends at `20261007`.
3.2 Confirm zero duplicate timestamp prefixes in the pending set.

## 4. Migration execution ⚠ HIGHEST-RISK STAGE

4.1 Apply migrations in filename-timestamp order (Supabase applies the pending set).
4.2 Watch specifically for:
   - `20260806` (capability_registry) → `20260807` (backfill) landing **before** `20260812` (LR5.4B drop).
   - `20260812` — the irreversible column drop. After it, `tools_allowed`/`permissions` are gone with no down-migration.
   - The `tenant_attachments` CHECK redefinitions (`20260919…20261002`) each succeeding (idempotent DO-blocks).
   - The 4 non-concurrent index builds (`20260912–20260915`) — brief; fine on today's small prod.
4.3 On ANY error: STOP. Do not deploy the app. Assess whether the failed migration is safe to fix-forward or whether a PITR restore is warranted (see §7).

## 5. Application deployment

5.1 Merge PR #397 (or promote the built candidate) so Vercel builds & deploys `main`.
5.2 Confirm the build passes env validation and the deployed SHA changes to RC3's.

## 6. Post-deploy smoke tests

- [ ] Health endpoint returns `ok:true` with the new SHA.
- [ ] Owner login → dashboard renders (no RLS/500).
- [ ] Create a job → raise a quote → accept it (auto-invoice/job) — commercial spine.
- [ ] Open the customer portal via a token — invoices/quotes/documents visible, correctly customer-scoped.
- [ ] `/assets` register loads; a QR label PDF renders.
- [ ] `/purchase-orders` new → create → status transition.
- [ ] One cron route returns 200 with the `CRON_SECRET` header (e.g. `inspections-due`).
- [ ] Confirm dark features stay dark (WhatsApp webhook rejects without flag; missed-call inert).

## 7. Rollback / recovery

**App/deploy rollback (fast, always safe):** revert the Vercel deployment to the previous production SHA (recorded in §1.3). The app is stateless; this is instant and non-destructive. Because every new migration is **additive** (except LR5.4B), the *old* app runs fine against the *new* schema — so an app-only rollback is the first and usually sufficient response to an app-layer regression.

**Migration rollback:**
- Migrations `20260730…20260811`, `20260813…20261007` are additive/idempotent → "rollback" = leave them; they are inert to an older app (new tables/columns simply unused). No down-migrations are provided by design (forward-fix preferred).
- **LR5.4B (`20260812`) has no rollback.** If a restore of the dropped `ai_employees` columns is ever required, restore from the pre-migration snapshot (§2.3) into a temporary table and re-add the columns manually — operationally never expected, since the Capability Registry is the sole authority and no reader depends on the dropped columns.
- **Catastrophic recovery:** Supabase PITR to the pre-cutover timestamp (see `docs/backup-recovery-runbook.md`), then re-deploy the previous app SHA.

**Decision rule:** app regression → app rollback first. Data/migration regression on an additive migration → forward-fix. Only a corruption event touching pre-existing data warrants PITR.

## 8. Post-cutover

- [ ] Regenerate `lib/supabase/types.ts` against the new prod schema (clears the 216-cast tech-debt) and open a follow-up PR.
- [ ] Close the superseded/obsolete PRs per manifest §5.
- [ ] Schedule the deferred decision-items (manifest §8) as fast-follows.
