# CLAUDE.md — CrewFlow working agreement

CrewFlow is a multi-tenant construction/trades ERP: Next.js 15 (App Router) · React · TypeScript · Supabase (Postgres + RLS) · Stripe · Tailwind/shadcn-style primitives · Vercel. This file is a short pointer to the canonical rules — it does **not** restate them. When this file and a linked doc disagree, the linked doc wins.

## Workflow (non-negotiable)
- **Branch → preview → human-approved merge.** Never merge or apply to production autonomously. Production merges and migrations happen only on explicit human approval.
- **Atomic changes.** One concern per branch/PR; smallest change that works; never bundle unrelated work. Inspect the diff and confirm there are no unrelated edits before opening a PR.
- **Local-first.** GitHub CI is free; Vercel preview builds are not — don't push speculative previews, batch to milestones. Current roadmap truth is `docs/roadmap/STATUS.md` (prefer it over older roadmap docs).

## Security invariants (never weaken)
- Never weaken RLS, tenant isolation, column ACLs, or tests to make something pass. Never use blanket grants.
- Two Supabase clients: **`createClient()`** = user-JWT (anon/authenticated, subject to RLS + grants); **`createAdminClient()`** = service_role (bypasses RLS + grants — server-only, never reachable from a client path). See `lib/supabase/`.
- Data-API grant discipline (the Supabase 30-Oct-2026 change): a new client-reachable table needs an explicit `GRANT` or a `data-api:exempt:` marker; service-role-only tables carry **no** client grant. Enforced by `__tests__/security/migration-data-api-grant-guard.test.ts`.
- Every anon/authenticated-executable `SECURITY DEFINER` function taking an org id must be guarded (`current_org_ids()` + `42501`): `__tests__/integration/rls/secdef-org-rpc-guard.test.ts`.
- Never expose, print, request (in chat), or commit secrets/credentials. Secret scanning: `.github/workflows/security-scan.yml` (gitleaks).
- Full security baseline: `docs/SECURITY.md`; the trust-boundary test tier lives in `__tests__/security/`.

## Database
- Migrations are **additive / forward-only**, prefix-unique, and verified against the live catalogue; never manually mark a migration applied, never skip one. Single production Supabase — **no staging**.
- Correctness guards (pagination / active-org pins / composite-FK / SECDEF / loud-reads / cron-fairness / …): `docs/engineering/CORRECTNESS-GUARDS.md`. Connection/scale doctrine ("rule out a query fix before a tier change"): `docs/connection-pooling-and-scale.md`.
- Reads must fail loud (error ≠ empty): `lib/supabase/read-failure.ts`. Volume-safe reads (F-1): `lib/supabase/paginate.ts`.

## Testing (all green before a PR is mergeable)
- Four tiers: unit (`vitest.config.ts`), integration against real Postgres (`vitest.integration.config.ts`), security (`vitest.security.config.ts`), and Playwright E2E (`playwright.config.ts`). CI runs all gates in `.github/workflows/ci.yml`.
- Pre-deploy: `npm run typecheck && npm run build`. A flaky test is a defect to fix, never to paper over with a retry. **Do not weaken a test to get green CI.**

## Design authority
- Two deliberate, CEO-locked systems: **dark** marketing (graphite-navy + gold) and **light** product. The `crewflow-brand-design` skill is the single visual source of truth; `docs/redesign/` holds the locked decisions. Product primitives + AA-enforced tokens: `components/ui/`.
- **Product truth:** never market or imply that a built-dark capability is available.

## Evidence
- Back claims with repository evidence (file path, test, migration, workflow). Report outcomes faithfully — if tests fail, say so with the output; if a step was skipped, say that.

## Prohibited autonomous production actions
Never, without explicit human action: merge/apply to production · modify production directly · send customer communications · make HMRC submissions · create real Stripe charges · enable autonomous customer-facing AI actions · activate a dark provider/integration. AI usage is metered by the cost governor (`docs/ai-cost-governor.md`); providers are dark by default.

## Further reading
Architecture & ownership: `docs/engineering/SUBSYSTEM-OWNERSHIP.md`, `docs/engineering/README.md`. Constitution: `docs/crewflow-v1.0-constitution.md`. CI / supply-chain hygiene: `docs/roadmap/A7-CI-SUPPLY-CHAIN-HYGIENE.md`. Deep per-domain docs: `docs/` (incl. `docs/bible/`).
