# CrewFlow — `crewflow/web`

CrewFlow is a multi-tenant operations platform for UK construction SMBs: leads,
quotes, jobs, invoicing, CIS, health & safety (RAMS/toolbox talks/permits),
stock/fleet, a customer portal, and an internal HQ layer — all in a single
Next.js application deployed at [crewflow.uk](https://crewflow.uk). Live
external surfaces today: Resend email, Stripe subscription checkout, Sentry,
enterprise SSO/SCIM + outbound webhooks + web push (customer-configurable), and
the governed generative-AI estate (all five AI Cost Governor tiers armed).
Every other external integration is **built dark** (code shipped,
feature-flag + credential gated, refuses before any network fetch) so
activation is a config flip, never an engineering project.

> This README describes what is actually deployed. If a doc and the code
> disagree, the code wins. `__tests__/docs/readme-truth.test.ts` pins the
> claims below so they cannot silently rot.

---

## Stack (as deployed)

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS v3 + shadcn/ui |
| Database | PostgreSQL (Supabase, single production project, ~311 tables, RLS on tenant data) |
| Migrations | Plain SQL files in `supabase/migrations/` (numbered, forward-only) |
| Auth | Supabase Auth — magic link, Google OAuth, email+password, optional TOTP MFA (Microsoft SSO built dark) |
| Hosting | Vercel (deploys from `main`) |
| Email | Resend (live) + React Email templates |
| Errors | Sentry (live in production) |
| Tests | Vitest (unit / integration / security tiers) + Playwright (e2e) |
| Package manager | npm (`package-lock.json` is the lockfile) |

There is **one** Supabase project — production. There is no second database
environment. Local development runs the Supabase local stack (Docker);
integration/e2e CI does the same. Treat every `--linked` command as touching
production.

Not in the stack (historical fiction, since removed from docs): no ORM
(queries go through `@supabase/supabase-js` typed against generated
`lib/supabase/types.ts`), no third-party background-job service (scheduled
work runs via Vercel cron hitting `CRON_SECRET`-gated routes).

---

## Local development

```bash
npm install
npx supabase start           # local Postgres + auth (Docker)
npm run dev                  # http://localhost:3000
```

Minimal `.env.local` (no secrets beyond your own local/dev keys):

```
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=<from `npx supabase start` output>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from `npx supabase start` output>
SUPABASE_SERVICE_ROLE_KEY=<local service role, optional but needed for admin/server paths>
```

Everything else in `lib/env.ts` is optional and validated with Zod at boot —
the server fails fast on a malformed variable. Provider keys (Resend, Sentry,
Stripe, Twilio, …) are unnecessary locally; the dark-feature gates refuse
before fetch when credentials are absent.

## Tests

Four tiers, each its own CI gate so a failure is attributed correctly:

```bash
npm run typecheck            # tsc --noEmit
npm run lint
npm test                     # unit — mocked, no DB, no network
npm run test:integration     # real local Postgres (supabase start first)
npm run test:security        # trust-boundary proofs (real local Postgres)
npm run test:e2e             # Playwright against a real build + local stack
```

CI (`.github/workflows/ci.yml` + `security-scan.yml`) runs 6 blocking gates —
typecheck, lint, unit, integration, security, e2e — plus gitleaks secret
scanning.

## Migration discipline

- Migrations are numbered SQL files in `supabase/migrations/` (currently 389 in
  the repo; production tip `20261229000000` at the time of writing, 389/389
  repo↔DB parity — the DB itself, `supabase_migrations.schema_migrations`, is
  the only authority).
- **Never take the "next free" prefix from a doc.** Ask the database:
  `select max(version) from supabase_migrations.schema_migrations;` — claim a
  prefix above the production tip AND above every in-flight branch slot, and
  re-check immediately before merging.
- Migrate-first: apply to production before (or in the same train as) the code
  merge that depends on it; verify the catalogue (tables/columns), not just the
  version row.
- Additive and reversible by default; RLS policies land in the same migration
  as the table.

## Deploy

Vercel builds and deploys `main` on push. Rollback is instant re-promotion of
a previous Vercel deployment (code) — database changes are managed separately
and are designed additive so old code runs safely against new schema. Batch
work locally and push at milestones; CI is free, Vercel builds are not.

---

## Capabilities: LIVE vs DARK vs FUTURE

**LIVE** = deployed and usable in production today. **DARK** = fully built and
tested, but gated behind a feature flag + missing credential/decision; the code
refuses before any external fetch. **ARMED** = provider-bound and spending real
credits under the AI Cost Governor's fail-closed ceiling. **FUTURE** = not built.

| Capability | Status |
|---|---|
| Leads, quotes (approval-gated), jobs, invoicing (void-capable), customer portal | LIVE |
| CIS: subcontractors, deductions, statements, CIS300 **prepare + CSV export** | LIVE (filing is DARK — HMRC-gated) |
| Health & safety: RAMS, toolbox talks, permits, sign-off, PDFs | LIVE |
| Stock, fleet, materials, warehouse (quantity-tier) | LIVE |
| Payroll: estimates, CSV export, payslips | LIVE (no RTI filing — DARK) |
| Accounting **CSV export** (canonical mapper) | LIVE |
| Email (Resend), in-app notifications, offline read + selected offline writes, PWA | LIVE |
| Public API v1 (key-auth, org-scoped) + `/developers` docs portal + SDKs | DARK (flag — CEO queue; docs portal, OpenAPI + SDKs built) |
| SMS / WhatsApp / voice receptionist / missed-call textback (answered-guarded trigger) | DARK (provider creds; engineering complete — not live) |
| Stripe Connect portal payments + self-serve billing | DARK (the platform's own subscription checkout is live separately, approval-gated) |
| Accounting push (Xero/QuickBooks/Sage OAuth) | DARK (vendor creds + token key; CSV export above covers all three) |
| HMRC MTD VAT / CIS300 / RTI submission | DARK (submit orchestrator wired behind a triple dark-gate; prepare + export are live; the CIS statements ledger is structurally unsubmittable) |
| Calendar sync (Google/MS Graph, two-way + renewal cron) | DARK (engineering complete; OAuth creds pending) |
| Open banking, telematics/GPS, merchants cXML (4 real adapters + connect flow), marketplace | DARK (legal/contract gates; adapters complete) |
| Enterprise SSO/SCIM, MFA enforcement, outbound webhooks, web-push | LIVE — customer-configurable (per-org opt-in) |
| PostHog analytics | DARK (key + consent) |
| Weather pipeline (Open-Meteo adapter, EOT integration) | DARK (commercial licence) |
| **Generative AI estate** (quote writer, OCR, receptionist drafting, HQ narratives, embeddings, transcription) | ARMED — all five governor tiers bound; cheap/mid/high/embedding production-proven, transcription provider-proven (its only producing channel stays dark); £100/org/month fail-closed ceiling; portal-chat auto-reply held off by CEO decision |
| Native mobile apps | FUTURE |

The authoritative, evidence-based capability reconciliation is
[`docs/roadmap/MASTER-ROADMAP-RECONCILIATION.md`](docs/roadmap/MASTER-ROADMAP-RECONCILIATION.md).

---

## Working on this codebase

- Trunk-based; short-lived branches off `main`, merge via PR with all gates
  green. Conventional commits.
- Any new tenant-data table MUST have `org_id`, an index on it, and RLS
  policies — and server reads additionally pin `.eq("org_id", activeOrg)`
  (RLS spans every org a user belongs to; the active-org pin is what prevents
  cross-org blending).
- Secrets never enter the repo (gitleaks blocks CI), chat, or screenshots.

## Pointers

- Roadmap truth: [`docs/roadmap/MASTER-ROADMAP-RECONCILIATION.md`](docs/roadmap/MASTER-ROADMAP-RECONCILIATION.md) (canonical) + [`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md) (programme history)
- Security model: [`docs/SECURITY.md`](docs/SECURITY.md)
- Customer success runbooks: [`docs/customer-success/`](docs/customer-success/) (onboarding + support/incident drills)
- Backup & recovery: [`docs/backup-recovery-runbook.md`](docs/backup-recovery-runbook.md)
- AI governance: [`docs/ai-quote-writer.md`](docs/ai-quote-writer.md) + `lib/ai/governor/`

---

Production: https://crewflow.uk — © 2026 CrewFlow. Built in Belfast.
