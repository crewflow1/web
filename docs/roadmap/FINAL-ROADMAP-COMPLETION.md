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
- **QUEUE 3 NON-CURRENT (evidence):** offline full-app scope (Wave-10 recorded carve-outs → G; **ADR-0013 written**, and the light-theme decision is **ADR-0014**) · voice intelligent legs (provider) · pgvector retrieval (embedding tier = provider) · PITR/dashboard-restore (external/CEO) · pentest-external (E, planned doc) · SDKs (roadmap: Open API "future vision" wording) · <200ms as guarantee (H→ evidence harness will measure and record honestly; promise remains conditional)

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
- **G3 tables (1889eb53 + review wave):** canonical DataTable (sticky/sort/filter/resize/bulk/keyboard/group; inline-edit documented-omitted) + adoption invoices/customers/suppliers/staff, and **jobs** (desktop; the mobile Today-first sections are kept deliberately). **Leads is a DECISION, not a gap:** /leads is a kanban pipeline — the stage-value columns ARE the surface; flattening it into a table would demote the pipeline UX, so DataTable is not adopted there.
- **G4 charts (fdd00fe9):** zero-dep server-SVG system; reports home/cashflow/profit + dashboard revenue trend; engine-parity by construction; proportionality-tested; sr-only table alternatives. **"Interactive" is deliberately traded for server-rendered + zero-dep + a11y-testable** — the charts carry native SVG titles, not client hover state; a client charting layer is a future product decision, recorded here rather than silently dropped.
- **G5 CIS verify (65d84f8f):** dark HMRC verification adapter (mig 20261224 verification_source); READY vs ACTIVATED separated.
- **G6 saga (530a3f59):** canonical saga_step runner — sagas now roll their step CHAIN to `done` deterministically (lifecycle/failure/concurrency proven on real PG; orphans structurally recovered). Stated precisely: a saga_step execution advances the chain and records the step outcome — the department WORK behind a step happens in the department engines, not inside the step runner.
- **Reachability (7d43818d):** notifications nav; flag-conditional marketplace nav; /settings/sso activation page; GDPR export+erase surfaces (posture-matched); Outreach AI at /admin/outreach (draft-only pinned).
- **Docs+hygiene (8517df9f):** README truth rewrite; STATUS control-plane reset (NEXT-FREE trap eliminated); runbook stamps; superseded banners; inngest removed; npm lockfile canonical; 18 truth pins. NOTE: `npm audit` = 51 prod-dep vulns (1 critical, ws/uuid chains) — fix pass scheduled post-Wave-2.

## Wave 2 consolidation (503031d2 + 7cb70c39 + integration fixes)
- **Guard trips fixed per doctrine (503031d2):** KPI month-window reads paged (fetchAllRows) + loud (readFailure); hq_approvals single-module pin restored via two sanctioned doors (countApprovalsRequestedByEmployee, listRecentApprovalsByEmployee); ledgers updated honestly (ai_invocations COVERAGE_REVIEWED; loud-read outside-(app) 14→15 for the handled retire error-banner path).
- **Hygiene (7cb70c39):** npm audit fix non-breaking 51→33 prod vulns; ALL residual 33 need semver-major (next 16 / react-email 6 / @sentry/nextjs 10) — the "critical" next flag is a chained via (nested postcss 8.4.31 + sharp 0.33.5); installed next 15.5.24 (backport tip) is outside every direct advisory range. launch-readiness cron copy now derives from CRON_ROUTES.
- **Integration debts (this commit):** mig 20261227 seeds explicit deny-floor grants for the 20261225 cohort (20261205 precedent; the registry invariant — every operable employee served FROM the registry — outranks 20261225's "floor is honest" note). Production confidence sweep + 6 registry test sweeps scoped to `retired_at is null` (retirement is DB-terminal: a retired row refuses every update, so it can never operate — decommissioned history, not a registry gap). variation_requests classified into the DSAR census (known → export; erasure default hard-delete is correct — the converted variation/quote is the statutory record). site-compliance sign-out test orders its timestamp after the row's own DB stamp (Docker clock skew ~85ms; the check constraint is the subject working as designed).

## Wave 2 — COMPLETE (5/5 lanes: 17be50ba L12 · cd479ca3 L10 · 9b28e9cb L11 · 78464a47 L9a+L9b · consolidation above)
L9a HQ dept engines (P6/P7/P8/P10) · L9b (P3 recall, P4 stages, P11 product→decisions, P12 real MRR/LTV/forecast, P13 support draft seam) · L10 contract+roster (migs 20261222/20261225, ADR-0012) · L11 platform (ops 45-cron, email requeue, ToS 20261223, request-id 20261226, HQ user listing, Sentry link) · L12 performance evidence.
- **Honesty notes (devil's-advocate wave):** contract item "conversation" is the DERIVED interaction feed (tasks + config decisions + approvals merged newest-first — lib/ai-employees/interaction-feed.ts documents why no literal chat transcript exists) and "impact" is the honest derived triple (completed/failed/approvals) — derived readings of real telemetry, stated as such, never invented revenue.

## Adversarial review wave (15 reviewers A–O + verification, 2026-08-30)
44 findings (20 serious) → every confirmed finding FIXED (611701a5 + follow-ups):
- **P1s:** real-MRR £0 sinkhole (mrr_gbp DEFAULT 0 made the list-price fallback unreachable); ops 45-cron stats over a silently-clamped 1000-row read (now fetchAllRows + loud); L9a engine legs were DEAD CODE (zero production callers — the exact pattern the reconciliation condemned): the three cadence legs (content brief / design review / release notes) now ride the roster-workers tick, and event-shaped cto_pr_review has its production door on /admin/cto-ai (P13 shape).
- **P2s:** seam spend now attributed per-employee (activation-day KPI complete); retirement trigger admits the manager_slug FK cascade + refuses born-retired inserts (probed); KPI reads roster-bounded; portal change-requests degrade EXPLICITLY (never healthy-empty over a broken read) + truncation indicator; nav orphans linked (design-ai, documentation-ai); ToS: terms now PRESENTED (link + required tick, server-gated), version aligned to the published /terms revision (2026-05) with a drift pin, backfill scoped to membered orgs; DataTable CSV exports ALL selected rows; ADR-0012 grants note superseded in-file by 20261227.
- **P3s:** retire pre-check read loud (wrong-copy defect); worker-portal error-code allowlist; review-race zero-row surfaced; keyboard column resize + inner-control key-guard (WCAG); amber series → -600 contrast; release-notes window ordering insert-stable; SCIM config read loud (mint-overwrite guard); portal audit write de-PII'd (references only); api_request_log DSAR rationale covers request_id; guard re-keys carry move notes; ADR-0013 (offline scope) + ADR-0014 (light theme) written.
- **Known accepted (pre-existing, out of this gate):** retention-milestones check-then-emit is non-atomic over the onboarding_state blob (pre-dates this branch; idempotent per milestone; worst case a duplicate low-priority notification).

## Zero-based re-audit + gate (2026-08-30)
- 237/237 atoms re-verified from zero (15 independent section auditors; previous statuses = hints only). 14 current-stage breakers surfaced → 6 BUILT (R033 decision search, R106 charter consumption, R113 unified recommendations, R088 dark lead-sourcing, R092 dark CI-signal, R229 measured-win-rate forecast — commit 07242255) + 8 evidence-reclassified with citations (ADR-0013/0014/0015, provider/CEO gates, recorded readings).
- **GATE: current-stage C=0 · D=0 · H=0** (155 `cur` atoms: A/B/E/G/F/P only). Final distribution A179 B22 C16 D2 E3 F3 G5 H2 P5 — every residual C/D/H is `std`-horizon (standing standards), enumerated openly in MASTER-ROADMAP-RECONCILIATION.md.
- Gates at `07242255`: tsc 0 · unit 11,275 · security 8,186 · integration 2,618/2,618 · E2E 165 (10 documented conditional skips) · production build green · performance evidence recorded (local conditions MET; production topology honestly UNPROVEN pending a prod load test).
- NEXT: release sequence (PR → CI → merge → migrations 20261221-27 dry-run+apply from ~/Code/web → deploy → verify parity 387 / tip 20261227 → smoke) → 63-item final report.

