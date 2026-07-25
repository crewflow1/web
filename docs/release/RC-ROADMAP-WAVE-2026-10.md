# Release Candidate — Roadmap Wave 2026-10

**Branch:** `release/roadmap-wave-2026-10` · **Base:** `origin/main` (RC3, `94eeea8`) · **PR:** #421
**Status:** GATE-VERIFIED RELEASE CANDIDATE — ⛔ **NOT MERGED, NOT DEPLOYED.** Awaiting explicit CEO release authorization.

This document is the release manifest, rollback plan, and GO/NO-GO record for the consolidated post-RC3 backlog. It performs no production mutation.

---

## 1. Scope — what ships

ONE canonical branch cut from `origin/main`, consolidating the entire unmerged post-RC3 backlog via sequenced `--no-ff` merges (every feature/fix preserved and auditable). 39 commits, 228 files, +24 127 / −279.

| Layer | Source | Migrations | Notes |
|---|---|---|---|
| Impersonation numbering | #398 (migration only) | `20261008` | `types.ts` regen **excluded** (see §5) |
| Supplier bills | #399 | `20261009` | committed → actual on job P&L |
| Payment allocation | #400 | `20261010` | one receipt → many invoices, concurrency-safe |
| Commercial lifecycle | #401 | — | **Defect C fix** (ledger cash) |
| Programme-E reconciliation | #402 | `20261011`, `20261012` | **Defects A + B fixes** |
| Retention scheduling | #403 | `20261013` | DLP release forecast |
| Completion certificates | #404 | `20261014` | operator + portal PDF |
| Blueprint Centre (tip) | #411 (cumulative #405–#410) | `20261015`, `20261015000100`, `20261016`, `20261017` | pins, markup, offline, PWA |
| Health & Safety (tip) | #420 (cumulative #412–#419) | `20261018`–`20261023` | RAMS, permits, sign-off, revisioning |

**17 new migrations, `20261008 → 20261023`.** Monotonic, no timestamp collisions, all additive (independent audit: no destructive ops; the only backfill runs against an empty new table — no-op in prod; three mutually-independent stacks referencing only baseline objects already live in prod).

---

## 2. Three live-production defects — fixed & regression-tested

| # | Defect (live on `main`) | Fix | Regression test |
|---|---|---|---|
| **A** | Retention over-release race (TOCTOU — no row lock) | `FOR UPDATE` in `20261012` | `programme-e-fixes.test.ts` · F3 concurrent-release |
| **B** | PO cross-tenant binding (bare FKs) | org-match triggers in `20261011` | `programme-e-fixes.test.ts` · F1 cross-tenant |
| **C** | Part-paid invoice shows £0 outstanding (status heuristic) | ledger `billed − received` in `lib/commercial/cash.ts` | `cash.test.ts` · asserts `outstanding === 15000` |

Consolidation-integrity verified: the job page renders `commercialCash.outstanding` (Defect C), **not** the reverted status heuristic — confirmed after all 8 merges.

---

## 3. Migration manifest & rollback

All additive; rollback = drop the new object(s) / restore prior function body. No migration alters or drops any object applied at or before `20261007`.

- `20261008` — `CREATE OR REPLACE` next_quote/invoice_number (idempotent; restore prior body to roll back).
- `20261009` — finances +cols + org-integrity trigger (drop cols/trigger/fn).
- `20261010` — new `payments` table + `invoice_payments.payment_id` + `allocate_payment` RPC (drop table/col/fn).
- `20261011` — PO/line-item org-integrity triggers (drop triggers/fns).
- `20261012` — `CREATE OR REPLACE tg_retention_release_guard` adding `FOR UPDATE` (restore prior body).
- `20261013` — 3 retention-schedule cols on `jobs` (brief ACCESS EXCL, `lock_timeout=5s`; drop cols).
- `20261014` — new `completion_certificates` table + number fn + immutability trigger (drop table/fn).
- `20261015` / `…000100` — `blueprints` + immutable `blueprint_versions` + private storage bucket (bucket intentionally never auto-dropped).
- `20261016` — `blueprint_pins` + `create_pin_with_snag` RPC (brief `snags` unique-index build; drop table/fn).
- `20261017` — `blueprint_markup` (schema-only down).
- `20261018`–`20261023` — H&S: RAMS, permits, acknowledgements, evidence hardening, revisioning, evidence hygiene (drop tables/fns; born-draft, provenance-pin, delete-guard, one-current-revision invariants).

**Rollback strategy:** because every migration is additive and the new surfaces are gated behind new routes/tables, a code-only revert (redeploy `main`) disables all new features while leaving the additive schema inert and safe. A schema rollback is only needed if a specific new object misbehaves, and each has an isolated down path above.

---

## 4. Gate results

**Local (RC tip):** `typecheck` clean · `lint` 0 errors (12 pre-existing warnings) · `security` 118 files / 3328 tests · `unit` 268 files / 5085 tests · `next build` succeeds (pdf.js SSR-safe across integrated tree).

**CI (PR #421):** see the PR checks — `integration (real Postgres)`, `e2e (real app, real Postgres)`, `security`, `tests`, `typecheck`, `lint`, `Vercel`. CI is authoritative for the DB-backed gates (fresh-DB migration apply, RLS, real-app E2E) that cannot run locally. GO requires all green **by name**.

**PWA service-worker first-install reload — REAL DEFECT, FIXED PRE-RELEASE.**

*Defect:* the service worker registered on every authenticated page and, on first
install, reloaded the page the instant it CLAIMED control (`controllerchange` →
`window.location.reload()`). On a user's first-ever visit this could flash a reload
out from under them mid-form (RAMS entry, quotes, onboarding) and lose unsaved input.

*Why the naive fix broke offline (root cause, traced from source):* the first-install
reload was the only path that loaded the page *through* the controlling SW, which is
the only mechanism that writes the shared `/_next/static/**` app-shell chunks into
`STATIC_CACHE`. `clients.claim()` controls *future* fetches but does not retroactively
cache the page's already-completed uncontrolled loads. Without those chunks the
precached `/offline` shell serves but cannot **hydrate** offline, so its `list()` effect
never runs and downloaded drawings never appear.

*Fix (two coordinated app changes; no migration, no cache-policy change):*
1. `app/(app)/_components/sw-register.tsx` — reload ONLY on a **user-accepted update**
   (a `useRef` armed by the Refresh click; both first-install and post-`SKIP_WAITING`
   claims fire the same `controllerchange`, so user intent is the only reliable
   discriminator). Decision extracted to pure `lib/pwa/sw-lifecycle.ts` for unit tests.
2. `app/(app)/jobs/[id]/blueprints/_offline-controls.tsx` — on download, after the SW
   is controlling, explicitly re-fetch this document's `/_next/static` chunks through
   the SW so the shared app-shell the `/offline` route needs is cached. Replaces the
   reload's accidental caching side-effect; makes offline init explicit.

*Proof:* new `e2e/pwa-first-install-no-reload.spec.ts` (real browser) asserts first
install does **not** reload (main-frame nav counter + document-start controller canary
+ window sentinel) and that unsaved form input survives the claim; new unit +
source-contract tests in `__tests__/security/pwa-worker.test.ts` lock the reload gate
and the app-shell warm. The real offline journey (`pwa-offline.spec.ts`) stays green
with the SW enabled. Update→refresh reload is proven at the unit tier (`next start`
serves an immutable `/sw.js`, so a byte-changed update can't be simulated in-browser
without a race the `retries:0` policy forbids). **This issue is pre-release closed.**

**E2E service-worker scoping (retained, complementary):** the SW is a cross-cutting PWA
layer, so the E2E config blocks it by default and `pwa-offline` + `blueprint-offline`
re-enable it (`serviceWorkers: "allow"`). This keeps unrelated specs deterministic and
is orthogonal to the app fix above.

---

## 5. Types decision (`lib/supabase/types.ts` unchanged from `main`)

All 8 stacks are green against `main`'s partial `types.ts` via the established `(c as FromChain).from` / `(supabase as unknown as …).rpc` cast pattern; **none of them modify it**. Regenerating (as #398 did) produces a ~10 000-line diff that trips the receptionist source-boundary invariant scans (they match bare RPC names, which a full `Functions` map contains) for **zero functional benefit**. The RC keeps `main`'s `types.ts`; the security suite therefore passes unchanged. Accurate-types-with-scan-exclusion is a separate optional post-release PR, not a release gate.

---

## 6. Cost, infra, env, external providers

- **Cost (§23):** no new fixed monthly cost. Only new infra is one **private Supabase Storage bucket** (`blueprints`) within the existing plan — marginal per-GB only. No new cron/queue/external service.
- **Env/flags (§24):** RC references only the three existing Supabase vars already in prod (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). No new provider vars. No secret values recorded here.
- **External providers (§25):** **stay dark.** No activation code (WhatsApp/Twilio/Stripe-send/OpenAI/Anthropic/SendGrid) is introduced. All AI/comms/telephony/payment-send paths remain gated on absent external credentials.
- **PITR (§22):** **VERIFIED ENABLED (2026-07-25)** via the Supabase Management API (`supabase backups list --project-ref jzntbskdqdopzwdqwvkp`, read-only): `WALG=true`, `PITR=true`, rolling ~7-day window. Re-confirm immediately before migrating. Do **not** disable PITR.

## Pre-release hardening (2026-07-25)

A 12-agent adversarial pre-release pass found and closed **4 P1s** (zero P0) before the boundary — this is why the RC now carries **18** migrations (`…08→…24`):
- **completion_certificates** bare FKs → cross-tenant write + one-live-per-job DoS: new migration `20261024` adds `tg_completion_certificate_org_integrity` (+ closes inert `blueprints.job_id`/`payments.customer_id` gaps) · real-PG cross-tenant test.
- **cash.ts** cross-invoice overpay understated `outstanding` → per-invoice cap · test.
- **allocate + supplier-bill** had no double-submit guard → added `DEDUPE_WINDOW_MS` idempotency · source-contract test.
- P2s: future-valid permit showed "Active" on lists → `not_yet_valid` state; untracked committed test JWTs; portal route-array coverage.

---

## 7. GO / NO-GO checklist

| Gate | Requirement | Status |
|---|---|---|
| Migration graph | additive, monotonic, no collisions/cross-stack coupling | ✅ audited |
| 3 live defects | fixed + regression-tested + survive consolidation | ✅ verified |
| Local gates | typecheck/lint/security/unit/build green | ✅ green |
| CI DB-backed gates | integration/RLS/E2E green **by name** | ⏳ PR #421 |
| Types strategy | no `as never` breakage; security suite green | ✅ (main types kept) |
| Providers dark | no external activation | ✅ verified |
| PITR | enabled + verified before mutation | ⛔ human pre-merge |
| Release authorization | explicit CEO GO | ⛔ pending |

**Decision rule:** GO only when every CI gate is green by name **and** the CEO authorizes. The two ⛔ items are human-gated by design — this candidate stops here.
