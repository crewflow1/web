# CrewFlow Target Architecture (pragmatic, incremental)

**Companion to** `CREWFLOW-ARCHITECTURE-AUDIT.md`. This is **not** a rewrite proposal. CrewFlow's foundations are sound (strict typing, centralized auth/money/notifications, disciplined two-client Supabase access). The goal is to **name the layering that already mostly exists**, make its few violations visible, and pay down the bounded god-file / duplication debt opportunistically. Every step below is independently shippable and behaviour-preserving.

## 1. Layer model (names for what is already there)

```
┌─────────────────────────────────────────────────────────────┐
│ PRESENTATION   app/**/page.tsx · layout.tsx · *.tsx          │  React Server/Client components. Compose + render.
│                components/**                                  │  NO raw SQL/business rules. Receives data + actions as props.
├─────────────────────────────────────────────────────────────┤
│ ORCHESTRATION  app/**/actions.ts · app/api/**/route.ts       │  Entry points. Auth gate (requireOrgContext/requireManagementApi),
│                                                               │  input validation (zod), call domain/data, revalidate/redirect.
│                                                               │  Thin — no multi-step business logic inline.
├─────────────────────────────────────────────────────────────┤
│ DOMAIN         lib/<domain>/** · server/services/**          │  Business rules, pure where possible (payroll, schedule, money,
│                                                               │  tax, quotes). Deterministic, unit-testable, no request globals.
├─────────────────────────────────────────────────────────────┤
│ DATA           lib/supabase/** · per-domain data modules     │  createClient()/createAdminClient(), read-failure + pagination,
│                                                               │  query construction. The ONLY layer that writes `.from(...)`.
├─────────────────────────────────────────────────────────────┤
│ INTEGRATION    lib/integrations/** · lib/email/** · lib/ai/**│  External edges: accounting adapters, email, AI governor/providers,
│                                                               │  telephony. Dark-by-default; all AI through the cost governor.
├─────────────────────────────────────────────────────────────┤
│ SECURITY       server/auth/** · RLS (migrations) · grants    │  Cross-cutting. Every orchestration entry passes through it;
│                                                               │  R5 assigned-job isolation + column ACLs are invariant.
└─────────────────────────────────────────────────────────────┘
```

### Dependency direction (the one rule)
Presentation → Orchestration → Domain → Data → Integration, with Security cross-cutting. **Dependencies point downward only.** Concretely:
- Presentation must not `.from(...)`. (Today: dashboard/page.tsx and ~17 leaf components violate this — see audit §4. Acceptable interim for Server Components; the direction of travel is to push reads down.)
- Domain modules must stay free of `next/*` request globals (`cookies`, `headers`, `revalidatePath`) so they remain pure and testable. Keep those in Orchestration.
- Data is the sole owner of `.from(...)`. Routes/pages/actions should call a data or domain function, not build queries inline.

## 2. Domain modules (the seams that already exist)

CrewFlow is naturally organized by business domain under `lib/<domain>` and `server/services`. Treat these as the module boundaries; keep each one's public surface small:

`quotes` · `invoices` · `jobs` · `customers` · `staff`/`payroll` · `schedule` · `fleet`/`operations` · `stock`/`materials` · `health-safety` (RAMS/permits) · `cis` · `retention` · `tax`/`vat` · `receptionist` · `hq`/sales · `ai`/governor · `offline` · `notifications`/`comms` · `reports`/documents.

**Shared-type ownership:** DB row types come from `lib/supabase/types.ts` (generated — never hand-edit). Each domain owns its *derived/DTO* types next to its domain module and re-exports them; presentation imports the domain's DTO, not raw DB rows, wherever a shaping step exists (the dashboard snapshot services already model this well).

## 3. Incremental migration strategy

Do these as small, independent PRs, each green on typecheck + unit + the existing integration/security gates. **No big-bang.**

**Wave 0 — lock the baseline (this PR).** Consolidate the two clearly-duplicated pure helpers (`escapeHtml` → `lib/html.ts`, `formatBytes` → `lib/format/bytes.ts`) with unit tests. Zero behaviour change. Done.

**Wave 1 — finish the already-started consolidations (low risk).**
- FU-1: fold remaining `escapeHtml` variants into `lib/html.ts` (watch `report-delivery` snapshot).
- FU-2: migrate the 7 inline currency formatters to `lib/money`.
- Resolve the `formatPence` divergence (C3): decide whether admin AI-costs adopts the Intl form, then delete the governor copy.

**Wave 2 — de-god the worst three, one at a time (medium risk, high value).** For each, extract *data access* first (mechanical, testable), then business rules, leaving a thin entry point:
1. `app/api/search/route.ts` → `server/services/search/<entity>.ts` (one query fn per entity) + route = auth + fan-out + merge.
2. `app/(app)/dashboard/page.tsx` → move the 15 inline reads into `server/services/dashboard-*` loaders (pattern already exists there); page becomes composition-only. Dovetails with the known dashboard query-fan-out perf work.
3. `app/(app)/quotes/actions.ts` → split by sub-concern (lines / templates / approval) over a shared quotes domain service.
Then `server/services/receptionist.ts` by cohesion (strategy vs transport vs persistence) if receptionist work resumes.

**Wave 3 — tail cleanups (opportunistic, touch-when-nearby).** `clamp` unification (pick one signature); push leaf-component `createClient()` up into containers; DTO boundaries per domain.

**Rule:** never do a repo-wide mechanical rename or restructure as its own PR — fold each small consolidation into work that already touches the file, or ship it as a tiny isolated PR with tests. This is what keeps R5 RLS, API contracts, and product behaviour safe.

## 4. Lightweight architectural checks worth adding

These answer the audit's open questions continuously and cheaply (all run in free GitHub CI, not Vercel):

1. **Circular-import guard** — add `madge` (or `dependency-cruiser`) as a devDependency and a `npm run check:cycles` that fails on any cycle. Audit §6 could not verify cycles offline; this closes that gap permanently. Dependency-cruiser additionally lets you encode the §1 direction rule (e.g. "`app/**` may not import from `lib/supabase/admin` except via a service").
2. **Client-bundle server-module guard** — a test/lint rule asserting no `"use client"` file transitively imports a `server-only` / `createAdminClient` module. (`_job-documents-client.tsx` already documents this hazard in a comment — make it enforced.)
3. **Oversized-file tracker** — a non-failing report (or a soft threshold, e.g. warn >800 LOC for `page.tsx`/`route.ts`/`actions.ts`) so new god-files are visible in review before they reach 2,000 LOC. Pair with a hard cap that only applies to *new* files to avoid churning the known dozen.
4. **Dead-code evidence (report-only)** — add `knip` in non-failing mode to build a vetted unused-symbol list over time, respecting dynamic imports / server actions / cron / dark providers. Never auto-delete.
5. **Typing ratchet** — keep `any` at its current low (~48). A simple count-guard test that fails if `: any`/`as any` rises above the committed baseline protects the §1 strength for free.

## 5. What NOT to do
- No framework migration, no folder-structure "big move," no ORM introduction. The Supabase + two-client + RLS model is a deliberate security boundary (CLAUDE.md) — changing it trades a real guarantee for cosmetics.
- Do not merge same-named helpers without checking semantics (`formatDuration` differs by unit; `clamp` by signature).
- Do not weaken a test, RLS policy, column ACL, or grant to make a refactor land.
