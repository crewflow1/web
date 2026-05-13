# CrewFlow — `crewflow/web`

> **AI receptionist + quotes for construction companies.**
> Never miss another construction lead.

Single Next.js 15 application that contains the marketing site, authenticated
app, API routes, and webhook handlers. Built mobile-first for UK construction
SMBs (3–50 employees). Deployed on Vercel + Supabase + Stripe.

This repo is the entire product — there is no separate API, mobile app, or
admin panel in v1. We split when there's a reason; not before.

---

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS v3 + shadcn/ui |
| Database | PostgreSQL (Supabase, eu-west-2 London) |
| Auth | Supabase Auth (magic link + Google) |
| ORM | Drizzle |
| Hosting | Vercel (web + serverless API) |
| Telephony | Twilio (numbers + SMS) + Vapi (AI voice agent) |
| AI | Anthropic Claude (reasoning), OpenAI Whisper (transcription) |
| Payments | Stripe (UK) |
| Email | Resend + React Email |
| Background jobs | Inngest |
| Errors | Sentry |
| Analytics | PostHog (EU instance) |
| Logs / uptime | BetterStack |

See `/docs` for architecture deep-dives (Vapi flow, schema, onboarding,
receptionist prompt).

---

## Prerequisites

- Node.js 20+
- pnpm 9+ (`npm i -g pnpm`)
- A Supabase project (staging) — see `docs/03_SUPABASE_SCHEMA.sql`
- Filled `.env.local` — copy from `.env.example`

## Quick start

```bash
pnpm install
cp .env.example .env.local        # fill in your dev secrets
pnpm db:generate                  # generate Drizzle types
pnpm dev                          # http://localhost:3000
```

To run background jobs locally:

```bash
pnpm dlx inngest-cli@latest dev
```

To preview transactional emails:

```bash
pnpm email                        # http://localhost:3001
```

---

## Project layout

```
app/                  Next.js routes (marketing, auth, onboarding, app, api)
components/           Shared React components (marketing, app, ui)
db/                   Drizzle schema + migrations
emails/               React Email templates
inngest/              Background job functions
lib/                  Pure utilities (env, format, vat, phone, validators)
server/               Server-only: auth, ai, telephony, billing, services
public/               Static assets, OG images, favicon
styles/               globals.css + tailwind layer
tests/                Vitest unit + Playwright e2e
scripts/              Seed, migration helpers, one-off ops
```

Full conventions are in `docs/02_REPO_STRUCTURE.md`.

---

## Environment

Every env var is documented in `.env.example`. The list is also validated at
boot in `lib/env.ts` via Zod — the server refuses to start with a missing or
malformed variable, so a misconfigured deploy fails fast at build time rather
than mysteriously at runtime.

Three environments:

| Env | Branch | Supabase | Stripe | Twilio | Domain |
|---|---|---|---|---|---|
| Production | `main` | `crewflow-prod` | live keys | live numbers | `crewflow.uk` |
| Preview | every PR | `crewflow-staging` | test keys | test numbers | `*.vercel.app` |
| Local | local dev | `crewflow-staging` | test keys | test numbers | `localhost:3000` |

---

## Data model

19 tables across organisations, customers, leads/conversations/calls, voice
notes, quotes, jobs, invoices, payments, notifications, audit log. Multi-tenant
via `org_id` on every row, enforced by Postgres Row-Level Security — a bug in
application code cannot leak data across tenants.

Schema source of truth: `docs/03_SUPABASE_SCHEMA.sql` (run once via Supabase
SQL editor). All subsequent changes via Drizzle migrations under
`db/migrations/`.

---

## Working on this codebase

**Branch strategy:** trunk-based. Short-lived feature branches off `main`,
merge via PR with green CI. No long-running release branches.

**Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`,
`docs:`).

**Reviewing:** every PR needs CI green (typecheck + lint + tests) and at least
one approval. UI changes attach a screenshot or short Loom.

**RLS rule:** any new table holding tenant data MUST have `org_id`, an index
on it, and RLS policies. PR template will remind you.

**Secrets:** never in the repo, never in chat, never in screenshots. Vercel
env vars are the deploy-time source; 1Password is the canonical store.

---

## Pricing tiers (in code: `lib/plans.ts`)

| Tier | Price | Seats | AI receptionist | Missed-call SMS | Voice notes | WhatsApp |
|---|---|---|---|---|---|---|
| Starter | £149/mo | 1 | ✓ | — | — | — |
| Pro ⭐ | £249/mo | 5 | ✓ | ✓ | ✓ | ✓ |
| Scale | £399/mo | 15 | ✓ + custom voice | ✓ | ✓ | ✓ |

First 25 NI contractors get Pro free for 6 months.

---

## Tagline & positioning (do not change without product sign-off)

- **Primary:** Never miss another construction lead.
- **Secondary:** AI receptionist + quotes for construction companies.

**Do NOT use** "operating system", "platform", "enterprise", or any of the
banned words listed in `docs/05_LANDING_PAGE_COPY.md` § Copy lints.

---

## Links

- Production: https://crewflow.uk
- Status: https://status.crewflow.uk (BetterStack)
- Issue tracker: GitHub Issues on this repo
- Docs: `/docs` folder + Notion (private)

---

© 2026 CrewFlow. Built in Belfast.
