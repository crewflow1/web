# Final Roadmap Completion — programme ledger

CEO directive: build every current-stage roadmap gap; freeze lifted for the reconciliation findings. Branch `roadmap/final-completion` off `88cbe193`. Completion standard: DB+domain+server+permissions+UI+reachability+mobile+errors+audit+tests+E2E where relevant. No stubs, no fake AI, no provider activation, no denominator games.

## Phase 0 baseline (2026-08-29 ~20:3x UTC)
- origin/main = prod = `88cbe193` · healthy · db:ok · parity 380/380 tip `20261220` · dark providers unchanged · Auth email GREEN (same-day evidence)
- Local gates pre-modification: tsc 0 · unit 10916 · security 8146. (Latest main-CI run: known fleet-fuel fixture flake; PR #851 CI was 8/8.)
- Reconciliation baseline committed: 237 atoms — A141 B14 C46 D19 E2 F3 G4 H3 P5; current-stage 155/120 satisfied.

## Central migration allocation (coordinator-owned; tip 20261220)
| Prefix | Purpose | Lane |
|---|---|---|
| 20261221000000 | variation_requests intake | L2 |
| 20261222000000 | AI employee contract fields (manager, retired_at, ai_invocations.ai_employee_id) | L10 |
| 20261223000000 | ToS/consent acceptance stamp | L11 |
| 20261224000000 | CIS verification schema additions (only if needed after inspection) | L5 |
| 20261225000000 | HQ roster completion seeds (#27-36 mapped to existing engines) | L10 |
| 20261226000000 | API request-id persistence | L11 |
| 20261227000000 | deny-floor registry grants for the 20261225 cohort (consolidation) | coordinator |
| 20261228000000+ | reserve — ask coordinator |

## Queues (Phase 1 triage of C/D/H)
- **QUEUE 1 BUILD:** G1 search families · G2 variation intake · G3 table system · G4 charts · G5 CIS verify dark adapter · G6 saga_step handler · reachability pack (/notifications, marketplace nav, /settings/sso page, GDPR UI, Outreach surface) · HQ dept contracts P6/P7/P8/P10 (governed dark seams + deterministic engines) · P12 finance real MRR/LTV/forecast · P13 support draft seam · P11 product→decisions wiring · P4 stage progression · P3 recall-into-prompt wiring · AI contract manager/conversation/cost/impact/retire/KPI · roster seeds+ADR · ops page 45-cron coverage · ToS persistence · docs truth reset · dependency hygiene · performance evidence harness
- **QUEUE 2 VERIFY:** DB soft-delete-where-required · recommendations-unified · confidence semantics
- **QUEUE 3 NON-CURRENT (evidence):** offline full-app scope (Wave-10 recorded carve-outs → G, ADR to be written) · voice intelligent legs (provider) · pgvector retrieval (embedding tier = provider) · PITR/dashboard-restore (external/CEO) · pentest-external (E, planned doc) · SDKs (roadmap: Open API "future vision" wording) · <200ms as guarantee (H→ evidence harness will measure and record honestly; promise remains conditional)

## Lane ownership (Wave 1) — no file overlaps; agents do NOT commit (coordinator commits per lane)
L1 search: app/api/search/route.ts + __tests__/security/search-*
L2 variation intake: mig 20261221 + lib/variation-requests/* + app/(app)/jobs/[id]/variation-requests* + app/worker-portal/[token]/* (request form) + app/customer-portal/[token]/requests/* + quotes/actions.ts (convert hook)
L3 tables: components/ui/data-table* + list pages: invoices, jobs, customers, staff, leads, suppliers
L4 charts: lib/charts/* + components/ui/chart* + reports/*/page chart panels + dashboard trend panel
L5 CIS verify: lib/cis/verification.ts + lib/integrations/hmrc/cis-verify.ts + app/(app)/cis (panel) + mig 20261224 if needed
L6 saga: server/services/hq-workflow.ts + server/services/hq-saga-runner.ts (new) + tests
L7 reachability: app/(app)/_nav/nav-model.ts + notifications bell + app/(app)/settings/sso/page.tsx + settings data/GDPR panel + marketplace nav gating + app/admin/outreach/*
L8 docs+hygiene: README.md, docs/roadmap/STATUS.md, backup runbook, bible adoption tracker, ai-quote-writer doc + package.json (inngest, packageManager)

(Progress + results appended per lane.)

## Wave 1 — COMPLETE (8/8 lanes, consolidated gates green: tsc 0 · unit 11,069 · security 8,180)
- **G1 search (d9227ad2):** 12→22 families, nav-locked role boundary, money-column-free finance hits, 34 new security pins.
- **G2 variation intake (1fb86968):** `variation_requests` (mig 20261221), 3 intake surfaces (site/portal/worker-token), trigger-guarded forward-only lifecycle, convert hook — variation engine stays sole commercial authority. 9/9 RLS integration.
- **G3 tables (1889eb53):** canonical DataTable (sticky/sort/filter/resize/bulk/keyboard/group; inline-edit documented-omitted) + adoption invoices/customers/suppliers/staff.
- **G4 charts (fdd00fe9):** zero-dep server-SVG system; reports home/cashflow/profit + dashboard revenue trend; engine-parity by construction; proportionality-tested.
- **G5 CIS verify (65d84f8f):** dark HMRC verification adapter (mig 20261224 verification_source); READY vs ACTIVATED separated.
- **G6 saga (530a3f59):** canonical saga_step runner — sagas reach `done`; real-PG lifecycle/failure/concurrency proven; orphans structurally recovered.
- **Reachability (7d43818d):** notifications nav; flag-conditional marketplace nav; /settings/sso activation page; GDPR export+erase surfaces (posture-matched); Outreach AI at /admin/outreach (draft-only pinned).
- **Docs+hygiene (8517df9f):** README truth rewrite; STATUS control-plane reset (NEXT-FREE trap eliminated); runbook stamps; superseded banners; inngest removed; npm lockfile canonical; 18 truth pins. NOTE: `npm audit` = 51 prod-dep vulns (1 critical, ws/uuid chains) — fix pass scheduled post-Wave-2.

## Wave 2 consolidation (503031d2 + 7cb70c39 + integration fixes)
- **Guard trips fixed per doctrine (503031d2):** KPI month-window reads paged (fetchAllRows) + loud (readFailure); hq_approvals single-module pin restored via two sanctioned doors (countApprovalsRequestedByEmployee, listRecentApprovalsByEmployee); ledgers updated honestly (ai_invocations COVERAGE_REVIEWED; loud-read outside-(app) 14→15 for the handled retire error-banner path).
- **Hygiene (7cb70c39):** npm audit fix non-breaking 51→33 prod vulns; ALL residual 33 need semver-major (next 16 / react-email 6 / @sentry/nextjs 10) — the "critical" next flag is a chained via (nested postcss 8.4.31 + sharp 0.33.5); installed next 15.5.24 (backport tip) is outside every direct advisory range. launch-readiness cron copy now derives from CRON_ROUTES.
- **Integration debts (this commit):** mig 20261227 seeds explicit deny-floor grants for the 20261225 cohort (20261205 precedent; the registry invariant — every operable employee served FROM the registry — outranks 20261225's "floor is honest" note). Production confidence sweep + 6 registry test sweeps scoped to `retired_at is null` (retirement is DB-terminal: a retired row refuses every update, so it can never operate — decommissioned history, not a registry gap). variation_requests classified into the DSAR census (known → export; erasure default hard-delete is correct — the converted variation/quote is the statutory record). site-compliance sign-out test orders its timestamp after the row's own DB stamp (Docker clock skew ~85ms; the check constraint is the subject working as designed).

## Wave 2 — IN FLIGHT
L9a HQ dept engines (P6/P7/P8/P10: real task handlers + governed dark seams + GitHub/Vercel dark adapters + executor-gated merge/deploy tools) · L9b (P3 recall consumption fix, P4 stage mapping, P11 product→decisions, P12 real MRR/LTV/forecast, P13 support draft-reply seam) · L10 contract fields+roster (migs 20261222/20261225 + ADR-0012) · L11 platform (ops 45-cron, email requeue, ToS mig 20261223, request-id persistence mig 20261226, HQ user listing, Sentry link) · L12 performance evidence harness.
