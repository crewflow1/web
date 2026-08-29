# CrewFlow — `crewflow/web`

CrewFlow is a multi-tenant operations platform for UK construction SMBs: leads,
quotes, jobs, invoicing, CIS, health & safety (RAMS/toolbox talks/permits),
stock/fleet, a customer portal, and an internal HQ layer — all in a single
Next.js application deployed at [crewflow.uk](https://crewflow.uk). Email is
the one live outbound channel; every other external integration is **built
dark** (code shipped, feature-flag + credential gated, refuses before any
network fetch) so activation is a config flip, never an engineering project.

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

- Migrations are numbered SQL files in `supabase/migrations/` (currently 387 in
  the repo; production tip `20261220000000` at the time of writing, with
  `20261221`–`20261227` pending in the final-roadmap release train — the DB
  itself, `supabase_migrations.schema_migrations`, is the only authority).
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
refuses before any external fetch. **FUTURE** = not built.

| Capability | Status |
|---|---|
| Leads, quotes (approval-gated), jobs, invoicing (void-capable), customer portal | LIVE |
| CIS: subcontractors, deductions, statements, CIS300 **prepare + CSV export** | LIVE (filing is DARK — HMRC-gated) |
| Health & safety: RAMS, toolbox talks, permits, sign-off, PDFs | LIVE |
| Stock, fleet, materials, warehouse (quantity-tier) | LIVE |
| Payroll: estimates, CSV export, payslips | LIVE (no RTI filing — DARK) |
| Accounting **CSV export** (canonical mapper) | LIVE |
| Email (Resend), in-app notifications, offline read + selected offline writes, PWA | LIVE |
| Public API v1 (key-auth, org-scoped) | DARK (flag) |
| SMS / WhatsApp / voice receptionist / missed-call handling | DARK (provider creds; not live) |
| Stripe portal payments + self-serve billing | DARK |
| Accounting push (Xero/QuickBooks/Sage OAuth) | DARK |
| HMRC MTD VAT / CIS300 filing / RTI | DARK (prepare-only is live) |
| Calendar sync, open banking, telematics/GPS, merchants cXML, marketplace | DARK |
| Enterprise SSO/SCIM, outbound webhooks, web-push, PostHog analytics | DARK |
| Weather pipeline (Open-Meteo adapter, EOT integration) | DARK |
| **All generative AI** (quote writer, receptionist turns, HQ narratives, embeddings) | DARK — governed, every tier unbound (`TIER_MODEL` all null); a key alone is refused |
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
