# Launch readiness — Recovery (DR) + Performance/Reliability

Consolidated launch-readiness evidence for the two operational pillars that a
first-customer launch rests on: **can we recover from disaster**, and **does the
app stay fast and reliable under real data volume**. Builds on PR #985 / #989.

Scope discipline: this doc separates what is **VERIFIED in-repo** (a file, test,
migration or grant I can point at) from what **NEEDS A LIVE / CEO ACTION** (a
fact I cannot observe from the repository — e.g. that the backup actually ran on
a real Mac, or a human PITR decision). Nothing here claims operational proof
that the repository cannot demonstrate.

Verified at: worktree off `main` (tip migration `20261240000000`), 2026-10-30.

---

## 1. Backup / Disaster Recovery

### 1.1 VERIFIED in-repo

| # | Control | Evidence (file / test / migration) | What it proves |
|---|---------|-----------------------------------|----------------|
| R1 | Off-platform encrypted backup **script** exists and is complete | `scripts/ops/off-platform-backup.sh` | Captures Postgres schema + public data + **auth** data + **all Supabase Storage** objects; validates (checksums + dump completeness) **before** recording success; encrypts locally (AES-256/openssl) so the remote receives only ciphertext; `set -Eeuo pipefail` + `trap on_error ERR` → non-zero exit + `failed` heartbeat on any stage error; retention prune floored at ≥1 (never prunes to zero); never prints DB/storage/remote credentials. |
| R2 | **launchd** scheduling unit exists | `scripts/ops/com.crewflow.backup.plist` | Weekly Sun 03:17 local; a missed run (Mac asleep/off) fires on next wake; install/run/status/uninstall documented inline; PATH set for `/opt/homebrew/bin`; logs to `~/.local/state/crewflow-backup/`. |
| R3 | **Heartbeat ledger** table | `supabase/migrations/20261230000000_ops_backup_runs.sql` | `public.ops_backup_runs` — one row per run (`running` → `success`/`failed`); stores run metadata only (status, stage, migration tip, upload status, manifest) — **no secrets**; indexed on `(status, finished_at desc)` and `(started_at desc)`. |
| R4 | Heartbeat table is **service-role-only** | migration above: RLS enabled, **zero** authenticated/anon policies. Reinforced by `supabase/migrations/20261236000000_slice15_pr2_cclass_least_privilege.sql:273` → `revoke all privileges on table public.ops_backup_runs from anon, authenticated;` | Defence-in-depth: RLS denies non-service-role, and the explicit REVOKE removes the latent Supabase Data-API default grant. Writer = backup script via pooler/superuser; reader = `/admin/ops` via service-role admin client. No client path. |
| R5 | `/admin/ops` **freshness tripwire** (UI) | `app/admin/ops/page.tsx:134-197` (HQ-gated via `requireHqPage()`) | Renders backup status pill + last-success / age / last-run / upload tiles from the heartbeat; states the rule GREEN ≤7d · WARNING >7d · RED >10d/failed. "The Mac scheduler is only an execution mechanism — this heartbeat is the source of truth." |
| R6 | **`classifyBackupHealth`** classifier logic | `server/services/ops-snapshot.ts` (pure fn, extracted this PR) + `__tests__/ops/backup-health.test.ts` (**9 unit tests, all passing**) | Traffic-light rules are now a pure, I/O-free function: RED if latest *completed* run failed / no success on record / >10d stale; AMBER if >7d or a run is stuck `running` >6h; GREEN if ≤7d and nothing stuck. Verified: 7-day boundary is GREEN; a newer `running` row never hides an older `failed`; fails toward AMBER (never false-GREEN) on a read error. |
| R7 | Runbook + automation docs | `docs/backup-recovery-runbook.md`, `docs/ops/off-platform-backup-automation.md` | Written recovery procedure and install/automation guide. |

### 1.2 NEEDS a live / CEO / founder action (NOT observable from the repo)

- **Backup actually running on a real machine.** The repo proves the script,
  unit and reader exist; it cannot prove a `success` row exists in prod
  `ops_backup_runs` or that the launchd agent is loaded on the founder's Mac.
  → Verify via `/admin/ops` (must show GREEN with a recent last-success) or a
  live `ops_backup_runs` read. *Not claimed as proven here.*
- **Encryption-key custody.** `CF_BACKUP_ENC_KEY` lives in a local `600` file.
  A lost key = unrecoverable backups. Key escrow / custody is an off-repo
  operational decision.
- **PITR decision.** Per memory, PITR is CEO-deferred on cost (~$100/mo).
  This doc does **not** enable or schedule anything. Still a pending CEO call.
- **Push / out-of-band alert on a stale backup.** Today staleness is *pull*
  (someone must open `/admin/ops`). There is no proactive page/email when the
  heartbeat goes AMBER/RED. Closing this needs a notification seam (a follow-up,
  not done here).
- **Remote upload destination credentials** (rclone R2/B2) are off-repo by design.

---

## 2. Performance / Reliability

### 2.1 VERIFIED in-repo (documented risks already remediated)

| # | Concern | Evidence | Status |
|---|---------|----------|--------|
| P1 | Auth / membership **re-read per route** (fan-out root cause) | `server/auth/session.ts:139,162,282` — `loadMembershipsWithOrgs`, `getUser`, `requireOrgContext` all wrapped in React `cache()` | **Remediated.** Memberships+orgs read collapses to ONCE per request, not per call site. |
| P2 | **Dashboard query fan-out** (memory: ~85-91 queries, "seconds on Vercel↔Supabase") | `app/(app)/dashboard/page.tsx:264-420` — five `Promise.all` waves (core/payments/time/retention/insights) joined by ONE overlapped `await`; `_insights` behind `<Suspense>` (`:943`); `loading.tsx` present | **Remediated.** Queries run concurrently in-wave; insights no longer block first paint. ~15 `.from/.rpc` calls in the page module. |
| P3 | **Volume-safe reads (F-1)** / pagination | `lib/supabase/paginate.ts` (`fetchAllRows`), used across **224** files | Widely adopted; the pagination helper is the standard read path. |
| P4 | **Loud reads** (error ≠ empty) | `lib/supabase/read-failure.ts` | Standard; prevents a failed read silently reading as "no data". |
| P5 | **N+1 (await inside `.map`)** | Repo-wide grep: only **1** `await Promise.all(...map(...))` site (the correct, batched form); no sequential `await` inside render-path `.map()` loops found | Low risk. |
| P6 | **BANNED hang pattern** — `revalidatePath` + `useActionState` on force-dynamic `[id]` routes (deep-swap commit race, Next 15.5) | `app/(app)/jobs/[id]/progress-actions.ts:15-18`, `.../variation-request-actions.ts:24-25` | **Compliant.** The deep `[id]` job actions explicitly use the mandated pattern — `formSuccess({ redirectTo })` → `window.location.assign`, and **no** `revalidatePath` — and document the ban in-file. `location.assign` is used in 26 files. No new violations found. |

### 2.2 Risk notes / watch items (file:line) — none are launch blockers

- **`app/(app)/invoices/[id]/payment-actions.ts:206,212,233,259,261,266`** —
  `voidInvoice` / `removePayment` use server `redirect()` to the **same**
  `/invoices/[id]` route (same depth, success/error query flag). This is *not*
  the banned deep-swap pattern (no depth-≥4 route change), and `addPayment`
  (the `useActionState` form at `:102-104`) correctly uses `revalidatePath`
  only with no redirect. Flagged only because `redirect()` + `revalidatePath`
  co-occur in the file; verified low-risk on inspection. Watch, don't change.
- **Grep caution:** a coarse `redirect(` + `revalidatePath` co-occurrence grep
  flags several `jobs/[id]/*-actions.ts` as *false positives* — the matches are
  in **comments** documenting that they deliberately avoid the pattern (P6).
  Future audits should confirm by reading, not by grep count alone.

### 2.3 Fix landed this PR

Extracted the backup-health traffic-light rules out of the I/O-bound
`readBackupHealth` DB read into a **pure, exported `classifyBackupHealth(...)`**
in `server/services/ops-snapshot.ts`, and added
`__tests__/ops/backup-health.test.ts` (**9 unit tests, all passing**). Behaviour
is unchanged — `readBackupHealth` now fetches rows and delegates classification.
This makes the DR tripwire thresholds (the thing a silent-backup-gap depends on)
unit-tested instead of untestable. Smallest additive, safe change; no perf
refactor attempted (the documented perf risks are already remediated — §2.1).

---

## 3. Launch verdict (recovery + perf)

- **Engineering (in-repo): GREEN.** Backup script/schedule/heartbeat/tripwire
  all present, service-role-isolated, and now the classifier is unit-tested.
  The documented perf fan-out risks are already remediated in code.
- **Operational: pending the §1.2 live/CEO actions** — above all, a verified
  recent `success` in prod `ops_backup_runs` (confirm via `/admin/ops`),
  encryption-key custody, the PITR decision, and a push alert on stale backups.
  None of these can be proven from the repository and none are claimed proven.
