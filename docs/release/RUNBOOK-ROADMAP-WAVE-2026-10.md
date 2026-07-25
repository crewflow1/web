# Production Release Runbook — Roadmap Wave 2026-10

**Executable by any competent engineer with Supabase + Vercel + GitHub access to CrewFlow.**
⛔ Every irreversible step is gated on **explicit CEO authorization**. Do not proceed past a gate without it.

---

## 0. Identity

| | |
|---|---|
| PR | [#421](https://github.com/crewflow1/web/pull/421) — `release/roadmap-wave-2026-10` |
| RC tip SHA | `96fa4e5` (confirm `git rev-parse origin/release/roadmap-wave-2026-10` before acting) |
| Production baseline (main) | `94eeea8` (RC3) |
| Supabase prod ref | `jzntbskdqdopzwdqwvkp` (crewflow, West EU / Ireland) |
| Migrations in wave | **18 additive files**, `20261008 → 20261024` |
| **Pending to prod** | **17** (`20261009 → 20261024`) — `20261008` was applied out-of-band and is **already on prod** (verified: prod `next_quote/invoice_number` use `current_org_ids`). `db push` applies only the 17; do **NOT** reapply `20261008`. |
| New fixed cost | none (one private Storage bucket within plan) |
| External providers | all DARK (no activation) |

---

## 1. Migration list (apply order = filename order)

`20261008` impersonation numbering · `20261009` supplier bills · `20261010` payment allocation ·
`20261011` PO org-integrity · `20261012` retention FOR UPDATE · `20261013` retention schedule ·
`20261014` completion certs · `20261015` blueprints (+`…000100` bucket) · `20261016` blueprint pins ·
`20261017` blueprint markup · `20261018` RAMS · `20261019` permits · `20261020` acknowledgements ·
`20261021` H&S evidence hardening · `20261022` RAMS revisioning · `20261023` H&S evidence hygiene ·
`20261024` tenant FK org-integrity (completion-cert/blueprint/payment guards).

All additive. The only migration-time write to a **populated** prod table is `20261016`'s
`snags_id_org_key` unique-index build (ACCESS EXCLUSIVE, sub-second for a first-customer tenant,
**no `lock_timeout`** — apply during low traffic). `20261022`'s backfill runs against the empty,
same-RC `risk_assessments` table (no-op). No destructive op, no table rewrite, no forward reference.

---

## 2. Pre-flight (all must be TRUE before touching prod)

1. `git fetch origin && git rev-parse origin/main` == `94eeea8` (baseline unchanged).
2. All 8 CI checks green on the RC tip (`gh pr checks 421`): typecheck, lint, tests, security, integration, e2e, Vercel, Vercel-preview.
3. `origin/main` is an ancestor of the RC (`git merge-base --is-ancestor origin/main <tip>` → 0).
4. **PITR positively confirmed** (see §3).
5. CEO has authorized the merge + deploy in writing.

---

## 3. Backup / PITR (HARD GATE — verified 2026-07-25)

Read-only verification (no restore, no disable):
```
supabase backups list --project-ref jzntbskdqdopzwdqwvkp
```
Confirmed: `WALG=true`, **`PITR=true`**, rolling ~7-day window (earliest ≈ 2026-07-18, latest ≈ now).
Re-run this immediately before migrating and confirm PITR is still `true` and the window is current.
**Do not disable PITR.** The latest-timestamp is your restore ceiling if a migration misbehaves.

---

## 4. Migration + deploy (irreversible — CEO-gated)

CrewFlow deploys via Vercel on merge to `main`; DB migrations are applied with the Supabase CLI
against the linked prod project. Recommended order:

1. **Snapshot the restore point:** note the current PITR latest-timestamp from §3 (your rollback target).
2. **Apply migrations** (low-traffic window, because of the `20261016` snags index):
   ```
   supabase link --project-ref jzntbskdqdopzwdqwvkp    # if not already linked
   supabase db push --linked --dry-run                  # CONFIRM it lists exactly 17: 20261009 → 20261024
   supabase db push --linked                            # applies the 17 pending in order
   ```
   Expect **17** migrations applied, exit 0 (`20261008` is already on prod and is skipped by version —
   never reapplied). If any fails, it rolls that file back atomically (all are transaction-safe) —
   STOP, diagnose, do not force.
3. **Merge PR #421** into `main` (this triggers the Vercel production build + deploy of the app whose
   code matches the just-applied schema).
4. Watch the Vercel deployment to `Ready`.

**Migration-before-code ordering:** apply migrations first (step 2), then deploy code (step 3). All
new tables/columns are additive, so RC3 code tolerates the new schema during the brief window between
migrate and deploy (it simply doesn't use the new objects).

---

## 5. Post-deploy smoke test (do immediately after deploy)

Authenticated as an owner on `crewflow.uk`:
- **Commercial:** open a job with a part-paid invoice → "Outstanding" shows billed−received (not £0);
  record a payment allocated across two invoices → no duplicate on double-click; record a supplier
  bill → no duplicate on retry.
- **H&S:** create + issue a RAMS → immutable; a permit with a future start shows **"Not yet valid"**
  on the register (not "Active"); download a RAMS/permit PDF.
- **Blueprint/PWA:** open a job's drawings → viewer paints; "Download for offline"; reload the page →
  **no unexpected reload/flash** on first SW install; go offline → offline shell lists the drawing.
- **Portal:** open a customer portal link → only that customer's data; a bad token → invalid-link page.
- **Cross-tenant spot check:** confirm a second org cannot see org-one's jobs/certs/blueprints.

---

## 6. Monitoring (first 24h)

- Vercel: error rate, function duration, build health.
- Supabase: DB CPU / connections (watch for the dashboard retention-KPI paged reads — bounded, but
  the busiest page), storage growth (blueprints bucket), no unexpected egress spikes.
- Logs: `duplicate submit suppressed` / `duplicate supplier bill suppressed` are EXPECTED info lines
  (the idempotency guards working), not errors.
- No provider/cron/email/SMS traffic should appear (all dark).

---

## 7. Rollback

**Triggers:** a migration fails mid-apply; a P0 cross-tenant/money/H&S defect in smoke test; Vercel
build fails; error-rate spike.

**Procedure (fastest → deepest):**
1. **Code-only revert (preferred, non-destructive):** redeploy `main`@`94eeea8` (or `vercel rollback`).
   All new schema is additive + gated behind new routes/tables, so RC3 code runs cleanly against the
   new schema — new features simply disappear. This resolves almost every issue without a DB change.
2. **Object-level down:** if a specific new object misbehaves, drop it (each migration's objects have an
   isolated `DROP TABLE/COLUMN/TRIGGER/FUNCTION` down path; the `blueprints` bucket is intentionally
   never auto-dropped).
3. **PITR (last resort, destructive):** restore to the pre-migration timestamp from §3 via the Supabase
   dashboard (Database → Backups → PITR). This loses any data written after that point — use only for
   corruption. `supabase backups restore` is available but prefer the dashboard for a controlled restore.

Forward-only caveat: dropping a new table/column after users capture data loses that data. Prefer
code-revert; reach for object-drop/PITR only for genuine corruption.

---

## 8. Known technical debt (non-blocking, post-release)

- `20261016` snags unique-index build has no `lock_timeout` guard (sub-second at first-customer scale;
  add `set local lock_timeout='5s'` in a future migration for large tenants).
- Dashboard "Retention due back" reads all org jobs; a `.gt("retention_percent",0)` filter would trim it.
- Some permit/PPE form inputs are ~42px (pass WCAG 2.2 AA 24px min; below the 44px field-first intent).
- Accurate `lib/supabase/types.ts` regen (RC keeps main's partial types via the established cast pattern)
  would need the receptionist source-boundary scans to exclude the generated file — optional.
- SW first-install reload is fixed; a two-user offline account-switch E2E would make invariant #8 an
  explicit runtime assertion (currently covered by partition unit logic + logout-purge + RLS).

---

## 9. Human gates (must be satisfied, in order)

1. ⛔ **PITR confirmed** immediately before migrating (§3). — *verified enabled 2026-07-25.*
2. ⛔ **CEO authorization** for merge + migrate + deploy.

Nothing in §4 runs until both are green.
