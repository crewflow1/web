# CrewFlow Architecture & Code-Quality Audit

**Scope:** current-state, evidence-based audit of the `crewflow1/web` application (Next.js 15 App Router · React · TypeScript · Supabase). All figures are measured from the tree at branch base `origin/main` (tip `0118d070`) on 2026-11-02 with `rg` / `wc`. Line counts are whole-file LOC. This document describes **what is**; the companion `CREWFLOW-TARGET-ARCHITECTURE.md` describes where to take it.

## 0. Headline

CrewFlow is **better-factored than its size suggests**. The scary numbers are mostly in generated/data files, and the cross-cutting concerns that usually rot (auth, money, notifications, read-failure handling, pagination) already have single canonical homes that are widely adopted. The real debt is concentrated in a **small number of true god-files** (a handful of 1,000–3,200-LOC server services / action files / route handlers) and a **long tail of small copy-pasted helpers** — one of which (`escapeHtml`, 12 copies) is security-relevant.

Corpus size (excluding `node_modules`, `.next`, tests):

| Metric | Count |
|---|---|
| App pages (`page.tsx`) | 320 |
| Route handlers (`route.ts`) | 163 |
| Server-action files (`actions.ts`) | 94 (29,986 LOC) |
| `server/services/*.ts` | 273 files (88,083 LOC, avg ~323 LOC) |
| Source `.ts`/`.tsx` (excl tests) | 2,157 files |
| Migrations | 431 |

## 1. Typing health — a genuine strength, not a hotspot

The audit brief asked for "weak typing hotspots (`any`/unsafe casts)". The finding is the opposite of the usual story:

- `tsconfig.json` has `"strict": true` **and** `"noUncheckedIndexedAccess": true` (line 7, 21).
- Across the entire app (excluding `lib/supabase/types.ts` and tests) there are only **48** occurrences of `: any` / `as any` / `<any>` / `any[]`.
- Worst offenders are ≤2 per file: `server/services/tenant-attachments.ts` (2), `server/services/org-cash.ts` (2), `server/services/intelligence.ts` (2). No file is riddled with it.
- `@ts-ignore`: **0**. `@ts-expect-error`: **0**. `eslint-disable`: 106 (spread thin; not concentrated).

**Verdict: typing is tight. No remediation needed.** Record this as a baseline to protect (see target doc's "lightweight checks"), not a debt to pay down. Do not let a future PR introduce a new `any` without a comment justifying it.

## 2. The biggest files ("god files") — top 20 by LOC

Two of the top three are **not code** and should be read as data/generated, not refactor targets:

| # | File | LOC | Kind | Notes |
|---|---|---|---|---|
| — | `lib/supabase/types.ts` | 24,498 | **generated** | Supabase schema types. Do not edit (CLAUDE.md). Excluded from all "god file" conclusions. |
| — | `lib/weather/geo/district-centroids.ts` | 3,002 | **data** | Static UK district centroid table. Not logic. |
| 1 | `server/services/receptionist.ts` | 3,184 | service | AI receptionist orchestration; 9 `.from()` queries + strategy + transport in one module. True god-service. **P2**. |
| 2 | `server/services/hq-sales.ts` | 2,027 | service | HQ sales pipeline service. **P3**. |
| 3 | `app/(app)/quotes/actions.ts` | 2,009 | server actions | **49 `.from()` calls** in one action file — the densest data-access file in the app. **P2**. |
| 4 | `app/admin/sales/companies/[id]/page.tsx` | 1,892 | page | Admin company detail. 0 inline `.from()` (delegates well) but enormous presentation file. **P3**. |
| 5 | `app/(app)/dashboard/page.tsx` | 1,729 | page | **15 inline `.from()` queries** in the page component (see §4). **P2**. |
| 6 | `server/services/hq-research.ts` | 1,656 | service | **P3**. |
| 7 | `server/services/automation-dispatcher.ts` | 1,488 | service | Workflow automation engine. **P3**. |
| 8 | `app/(app)/imports/actions.ts` | 1,373 | server actions | CSV/data import. **P3**. |
| 9 | `server/services/hq-memory.ts` | 1,327 | service | |
| 10 | `lib/sales/model.ts` | 1,326 | domain | |
| 11 | `lib/hq/roster-workers.ts` | 1,300 | domain | |
| 12 | `lib/payroll/compute.ts` | 1,269 | domain | Pure-ish compute; large but cohesive. |
| 13 | `app/admin/ai-boardroom/[slug]/page.tsx` | 1,246 | page | |
| 14 | `app/(app)/jobs/[id]/page.tsx` | 1,135 | page | 7 inline `.from()`. |
| 15 | `lib/schedule/solver.ts` | 1,120 | domain | Scheduling solver; cohesive algorithm. |
| 16 | `lib/schedule/recommendations.ts` | 1,108 | domain | |
| 17 | `server/sdk/tasks.ts` | 1,102 | sdk | |
| 18 | `server/services/intelligence.ts` | 1,095 | service | |
| 19 | `sdks/src/generator.ts` | 1,091 | sdk | Codegen; large by nature. |
| 20 | `server/services/offline-writes.ts` | 1,046 | service | Offline write replay. |

Largest **route handlers**: `app/api/search/route.ts` (822 LOC, **21 inline `.from()`** — the global search palette backend; see §4), `app/api/demo/route.ts` (416), `app/api/webhooks/vapi/route.ts` (394), `app/api/invoices/export/route.ts` (360).

Largest **client components** (`"use client"`): `app/(app)/suppliers/[id]/payments/_forms.tsx` (850), `app/(app)/settings/automations/WorkflowCanvas.tsx` (837), `app/(app)/jobs/[id]/blueprints/_pdf-viewer.tsx` (679), `components/ui/data-table.tsx` (654).

**Takeaway:** the god-file problem is real but *bounded* — roughly a dozen files, not a systemic sprawl. The avg `server/services` file is ~323 LOC, which is healthy. Target the outliers (§ target doc) rather than a mass split.

## 3. Duplication clusters (≥5 concrete, cited)

CrewFlow has largely *won* the cross-cutting-concern battle (see §5). The remaining duplication is small, pure helpers that were copy-pasted before a shared home existed.

### C1 — `escapeHtml` × 12 (security-relevant) — **P2** ✅ FIXED (partial)
Twelve local definitions of an HTML escaper, in three variants:
- **5-char (full)** `& < > " '` — 9 byte-identical copies: `app/(app)/reviews/actions.ts:318`, `lib/email/send-leave.ts:16`, `lib/email/templates/statement.tsx:28`, `lib/email/templates/invoice.tsx:27`, `lib/email/templates/quote.tsx:25`, `lib/email/templates/report-published.ts:28`, `lib/email/templates/reminders.tsx:24`, `lib/email/templates/portal-reply.ts:24`, `lib/email/send-material-request.ts:31`.
- **4-char** `& < > "` — `app/api/cron/report-delivery/route.ts:170`.
- **3-char** `& < >` — `lib/notifications/preferences.ts:250`, `lib/comms/policy.ts:107`.

Risk: a hand-rolled escaper is exactly where an XSS regression hides, and 12 copies means 12 chances to diverge (they already have — the narrower variants do not escape quotes, so interpolating tenant text into a double-quoted attribute in those code paths is weaker). **Remediated here:** the 9 identical copies now import a single audited `escapeHtml` from `lib/html.ts` (unit-tested). The cron 4-char and the two 3-char variants were left in place deliberately — unifying them is an output-byte change and `report-delivery` has a behaviour test (`__tests__/reports/report-delivery.test.ts`); see follow-up FU-1.

### C2 — Inline `Intl.NumberFormat(..currency..)` × 7 (bypasses `lib/money.ts`) — **P3**
`lib/money.ts` is the canonical money layer (`formatCurrency`, `formatMoney`, `penceToPounds`, `formatPence`, `apportion`) and is imported by **115** files. Seven files still inline their own GBP `NumberFormat` instead: `components/marketing/calculators/calc-ui.tsx`, `app/customer-portal/[token]/valuations/page.tsx`, `app/(app)/assets/[id]/page.tsx`, `app/(app)/assets/[id]/_depreciation.tsx`, `app/(app)/purchase-orders/page.tsx`, `app/(app)/purchase-orders/[id]/page.tsx`, `app/(app)/purchase-orders/_builder.tsx`. Low risk but it is drift waiting to happen (e.g. a locale/decimal tweak in `lib/money` won't reach these). Migrate opportunistically when touching those files.

### C3 — `formatPence` defined twice, divergent — **P3**
`lib/money.ts:183` → `GBP.format(penceToPounds(pence))` (Intl, thousands separators: `£1,234.56`). `lib/ai/governor/policy.ts:343` → `` `£${(safe/100).toFixed(2)}` `` (no thousands separators: `£1234.56`), re-exported via `lib/ai/governor` and used throughout `app/admin/ai-costs/page.tsx`. **Not consolidated** because the outputs genuinely differ and the governor copy is an intentionally self-contained module; unifying would change admin-cost display formatting. Flag only — decide whether the governor should adopt the Intl form.

### C4 — `escape`/clone family: `clamp` × 6 (divergent signatures) — **P3**
`components/forms/NumericInput.tsx:144` `clamp(n, min?, max?)`, `lib/retention/signals.ts:804` `clamp(n, lo, hi)`, `lib/memory/retrieval.ts:66` `clamp(x, lo=0, hi=1)` (exported), `lib/hq/analytics.ts:567`, `lib/assets/depreciation.ts:122`, `lib/staff/holiday.ts:76`. Six copies with three slightly different signatures (optional bounds vs required, defaulted vs not). A shared `clamp` is worthwhile but requires picking one signature; not behaviour-trivial, so left as a follow-up.

### C5 — `formatBytes` × 3 — **P3** ✅ FIXED
`lib/customers/portal-documents.ts:184`, `app/(app)/documents/page.tsx:337`, `app/(app)/jobs/[id]/_job-documents-client.tsx:39`. Two byte-identical; the third added a null/zero guard returning `""`. **Remediated here:** consolidated into `lib/format/bytes.ts` (the defensive `number | null | undefined → ""` signature, which is behaviour-preserving for all three call-site patterns), unit-tested.

### C6 — `formatDuration` × 3 — **FALSE cluster, do not merge**
`app/(app)/dashboard/_insights.tsx:28` (`sec`), `lib/sales/calling.ts:278` (`seconds`), `lib/ai-employees/stats.ts:62` (`ms`). Same name, **different input units** (seconds vs milliseconds). Merging these blindly would be a correctness bug. Documented so a future "dedup" pass doesn't fall into the trap.

## 4. Mixed-responsibility layers (DB access where it shouldn't be)

The App-Router norm of fetching in Server Components is fine, but several pages/routes have grown into de-facto data layers:

- **`app/(app)/dashboard/page.tsx`** — 15 inline `.from()` queries *in the page component*, alongside presentation. It already delegates some work to `server/services/*-snapshot.ts` modules, so the pattern exists; the page just hasn't finished moving. **P2** — extract the remaining raw reads into a `server/services/dashboard-*` loader so the page is composition-only. (Also relevant to the known dashboard query-fan-out perf note in memory.)
- **`app/api/search/route.ts`** — 21 inline `.from()` queries. This is the global search palette's whole backend: entity-by-entity queries, ranking, and shaping in one 822-LOC handler. **P2** — the per-entity search queries belong in a `server/services/search/` module (one function per entity), leaving the route as auth + fan-out + merge.
- **`app/(app)/quotes/actions.ts`** — 49 `.from()` calls across one 2,009-LOC action file. Business rules (quote build, line items, templates, approval) + raw data access interleaved. **P2** — split by sub-concern (lines, templates, approval) into cohesive action modules sharing a quotes service.
- **DB client construction inside leaf components:** 17 `.tsx` files that are not `page`/`layout` call `createClient()` / `createAdminClient()` directly (e.g. `app/(app)/jobs/[id]/_assignments.tsx`, `_job-safety.tsx`, `_variation-request-panel.tsx`, `components/attachments/AttachmentsPanel.tsx`). These are Server Components / inline server actions (not `"use client"`), so it is not a bundle-safety violation, but it does scatter data access into the presentation tree. **P3** — acceptable short-term; prefer passing data/actions as props from a container.

Overall call-site counts: `createClient()` appears 753×, `createAdminClient()` 668× — both via the two canonical factories (good — no ad-hoc client construction), but the sheer `createAdminClient` count is worth a periodic audit that each service-role use is genuinely server-only and necessary (CLAUDE.md invariant).

## 5. What is already well-factored (protect these)

Evidence that the cross-cutting concerns are centralized — the opposite of debt, and the reason a rewrite would be wrong:

- **Auth / org context:** `server/auth/session.ts` is the single source — `getUser` (React-`cache`d), `requireUser`, `getOrgForUser`, `requireOrgContext` (cached), `requireManagementContext`, `requireManagementApi`, `isManagementRole`. Only **6 files** call `supabase.auth.getUser()` directly (13 sites) — i.e. auth is near-fully funnelled.
- **Money:** `lib/money.ts`, 115 importers (see C2/C3 for the few stragglers).
- **Notifications:** `server/services/notifications-service.ts` (`createNotification`, `createBulkNotifications`, `emitNotifications`). Only **1** file writes the `notifications` table directly, and it's the service's own action wrapper (`app/(app)/_components/notifications-actions.ts`). Effectively fully centralized.
- **Read-failure discipline:** `lib/supabase/read-failure.ts` (`readFailure`) and volume-safe reads `lib/supabase/paginate.ts` (`fetchAllRows`) are the house pattern and widely used.
- **Two-client discipline:** `lib/supabase/{server,admin}.ts` are the only factories; no inline `createClient` from the SDK found in app code.

## 6. Coupling / circular-import risk

`madge` / `dependency-cruiser` are **not installed and could not be installed offline** (local-first policy; `npx madge` was refused for lack of the package), so a full strongly-connected-component graph was **not** machine-generated. This is an honest gap — see the target doc's recommendation to add a circular-import guard to CI so this is answered continuously rather than by spot check.

Spot observations (not exhaustive):
- Barrel re-exports exist (e.g. `lib/ai/governor.ts` re-exports from `lib/ai/governor/*`), which is the classic seed for cycles. No concrete cycle was proven here; treat as "unverified, add the guard."
- The `server/services` layer is large (273 files) and services import each other freely; without a dependency rule this is where a cycle will eventually appear.

## 7. Dead-code CANDIDATES (all need a usage check before deletion)

No dead-code deletions were made. `ts-prune`/`knip` are not installed, and CrewFlow has many legitimately-"unreferenced-by-static-import" entry points — **dynamic imports, server actions invoked from forms, cron route handlers, and dark/feature-flagged providers** (the roadmap explicitly builds capabilities *dark* so activation is a config flip). Any symbol that looks unused must be checked against: `rg` for dynamic `import()`, form `action={}` wiring, `app/api/cron/*`, and the governor/provider dark-flag registry **before** it is called dead.

**Candidates to investigate (not assertions):**
- The narrower `escapeHtml` variants in `lib/notifications/preferences.ts` and `lib/comms/policy.ts` are now the only remaining local copies of that helper (candidate to fold into `lib/html.ts` — see FU-1), not dead but redundant.
- `lib/ai/governor/policy.ts#formatPence` — candidate for removal *iff* `app/admin/ai-costs` migrates to `lib/money#formatPence` and the thousands-separator change is accepted (C3).

No file was asserted dead. Recommend adding `knip` in a report-only (non-failing) CI mode (target doc) to build an evidence base safely.

## 8. Defect / debt ledger (for the lead)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| D1 | P2 | 12 copies of hand-rolled `escapeHtml` (XSS-surface drift); 3 variants escape fewer chars | §3 C1 — **9 consolidated in this PR**, 3 remain (FU-1) |
| D2 | P2 | `app/api/search/route.ts` is a 822-LOC god-route with 21 inline queries | §2, §4 |
| D3 | P2 | `app/(app)/quotes/actions.ts` — 2,009 LOC, 49 inline `.from()` | §2, §4 |
| D4 | P2 | `app/(app)/dashboard/page.tsx` — 15 inline queries in the page component | §4 |
| D5 | P2 | `server/services/receptionist.ts` — 3,184-LOC god-service | §2 |
| D6 | P3 | 7 files inline GBP `Intl.NumberFormat` instead of `lib/money` | §3 C2 |
| D7 | P3 | `formatPence` defined twice with divergent output | §3 C3 |
| D8 | P3 | `clamp` × 6 with 3 divergent signatures | §3 C4 |
| D9 | P3 | 3× `formatBytes` duplication | §3 C5 — **fixed in this PR** |
| D10 | P3 | 17 leaf `.tsx` build their own Supabase client | §4 |
| D11 | P3 | No circular-import / oversized-file guard in CI; cycle risk unverified | §6 |
| D12 | P3 | `formatDuration` name collision across unit systems (trap for future dedup) | §3 C6 |

**Follow-ups (safe, not done here to keep the PR behaviour-preserving):**
- **FU-1:** fold the cron (4-char) and the two notification/comms (3-char) `escapeHtml` variants into `lib/html.ts`. This *adds* quote-escaping to those paths (strictly safer) but changes output bytes — do it with the `report-delivery` behaviour test in front of you and update any pinned snapshots deliberately.
- **FU-2:** migrate C2's 7 inline currency formatters to `lib/money`.
- **FU-3:** add the CI guards in D11 (see target doc §7).
