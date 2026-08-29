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
| 20261226000000+ | reserve — ask coordinator |

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
