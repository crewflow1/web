# 03 — Secrets Exposure Audit

**VERDICT: CLEAN — 0 confirmed exposures.**

- Repository: `/Users/moetalibi/Code/web-main`, origin/main tip `aedb9279` (live prod), 1,454 commits.
- Date: 2026-10-28 · Scope: committed secrets, NEXT_PUBLIC inventory, server/client boundary, runtime surfaces, example/fixture files.
- Counts: **0** tracked `.env*` files · **0** real secret-body literals in tracked source · **26** distinct `NEXT_PUBLIC_*` vars, all EXPECTED-PUBLIC · **0** server secrets referenced in any `"use client"` file.

This audit is **READ-ONLY**. No code changed, no PR opened, no secret rotated. No secret value is printed below — findings reference secrets by name/location only.

---

## 1. Repository secret scan

- **gitleaks (local):** NOT installed on this machine (`which gitleaks` → not found). Could not run a local `gitleaks detect`. This is a tooling gap only, not a finding — CI covers it (below).
- **CI secret scan:** `.github/workflows/security-scan.yml` runs `gitleaks/gitleaks-action` **SHA-pinned** to `e0c47f4f…` (not a moving tag) on every `pull_request` and on `push` to `main`, with `fetch-depth: 0` (full history, so a secret in any earlier commit is caught, not just the tip). Dedicated workflow (free GitHub-Actions minutes, zero Vercel cost). Config `.gitleaks.toml` extends the default ruleset and adds a **narrow** allowlist of **prefix literals / `abc123` test fixtures only** (`sk_live_abc123`, `rk_live_abc123`, `pk_live_abc123`, `startsWith("sk_live_")`, etc.) — no real secret body is allowlisted, and there are no blanket path exemptions. `.gitleaksignore` contains one fingerprint for a false-positive identifier constant (`revenue_forecast_3m`), not a secret.
- **Manual high-signal sweep** (substitute for the local gitleaks run) over tracked non-test source for AWS/GCP/GitHub/Slack/Resend/SendGrid keys and PEM private-key blocks: **0 matches**.
- **Stripe live/restricted/webhook bodies** (`sk_live_`/`rk_live_`/`whsec_` + ≥12 real chars, excluding `abc123` fixtures): **0 matches**.
- **JWT literals** (`eyJ…`, the shape of a Supabase service-role/anon key) in tracked non-test source: **0 matches**.
- **Tracked `.env*` files:** none. `.env.local` exists on disk but is **untracked and gitignored** (`.gitignore:66` `.env*.local`; `.gitignore` also ignores `.env` / `.env.*` with a `!.env.example` exception). `git ls-files --error-unmatch .env.local` → not known to git.
- `.next/` build output and `/e2e/.auth/` (live-JWT storageState) are gitignored and not tracked.

## 2. NEXT_PUBLIC_* inventory — all EXPECTED-PUBLIC

26 distinct client-exposed vars. Classified by `lib/env.ts` (the single zod-validated env schema). None is a server secret.

| Variable | Class | Classification |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | EXPECTED-PUBLIC |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (RLS-gated) | EXPECTED-PUBLIC |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable `pk_` | EXPECTED-PUBLIC |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` | PostHog browser ingest key + host | EXPECTED-PUBLIC |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN (public by Sentry design) | EXPECTED-PUBLIC |
| `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_APP_NAME` | Site origin + display name | EXPECTED-PUBLIC |
| `NEXT_PUBLIC_VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` | Platform build metadata | EXPECTED-PUBLIC |
| `NEXT_PUBLIC_FEATURE_*` (16: WHATSAPP, VOICE_INBOUND, MISSED_CALL_TEXTBACK, HMRC_CONNECT, BANKING_CONNECT, TELEMATICS_CONNECT, MERCHANTS, SELF_SERVE_BILLING, BOOKING_EXECUTION, OUTBOUND_WEBHOOKS, MICROSOFT_SSO, INBOUND_EMAIL, PORTAL_PAYMENTS, MAINTENANCE_REMINDERS, RESEND_EVENTS, ACCOUNT_LINKING) | `"true"`/`"false"` boolean flags | EXPECTED-PUBLIC |

- No `NEXT_PUBLIC_*` name carries `SERVICE_ROLE`, `SECRET`, `PRIVATE`, `AUTH_TOKEN`, or `PASSWORD`. The only `NEXT_PUBLIC_*_KEY` names are the three browser-safe keys above.
- Two bare `NEXT_PUBLIC_FEATURE_*` grep hits are **documentation strings** (`app/admin/settings/page.tsx:392`, `lib/hq/settings.ts:92`) rendering the flag-name pattern to operators — not variables.
- `NEXT_PUBLIC_FEATURE_PUBLIC_API_JOBS` appears **only** in `__tests__/security/public-api-jobs.test.ts:35`, which **asserts the flag is NOT exposed as NEXT_PUBLIC** (`FEATURE_PUBLIC_API_JOBS` is server-only) — the boundary is positively tested.

## 3. Server/client boundary — CLEAN

- **Env split source of truth:** `lib/env.ts` — one zod schema. Every server secret is a **plain (non-`NEXT_PUBLIC`) optional** var: `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_INVOICE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `TWILIO_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `WHATSAPP_APP_SECRET`/`WHATSAPP_ACCESS_TOKEN`, `*_CLIENT_SECRET` (HMRC/Sage/Xero/QBO/Google/MS/Banking/Telematics), `INTEGRATION_TOKEN_ENCRYPTION_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `POSTHOG_SERVER_KEY`, `GITHUB_TOKEN`, `VERCEL_TOKEN`, `KV_REST_API_TOKEN`, etc. The schema comments explicitly flag server-only vars (e.g. `POSTHOG_SERVER_KEY`, `FEATURE_MFA_ENFORCEMENT`, `FEATURE_PUBLIC_API_JOBS`, `FEATURE_GDPR_ERASURE`) as deliberately **not** `NEXT_PUBLIC`.
- **No `"use client"` file imports `@/lib/env`.**
- **No `"use client"` file references any server-secret name** (`SERVICE_ROLE_KEY`, `STRIPE_SECRET`, `*_WEBHOOK_SECRET`, `RESEND_API_KEY`, `AUTH_TOKEN`, `ANTHROPIC/OPENAI_API_KEY`, `CRON_SECRET`, `*_APP_SECRET`, `*_CLIENT_SECRET`, `INTEGRATION_TOKEN_ENCRYPTION_KEY`, `VAPID_PRIVATE`, `createAdminClient`). The single scan hit — `app/(app)/reports/ReportSubscriptionsPanel.tsx` — is a **code comment** mentioning `RESEND_API_KEY`, with no `process.env` read and no value. Classification: NOT A FINDING.
- **Service-role client** (`lib/supabase/admin.ts`): reads `SUPABASE_SERVICE_ROLE_KEY` from `process.env` in a server-only module, throws a name-only (valueless) error if unset. Matches the CLAUDE.md `createClient()` (RLS) vs `createAdminClient()` (service-role, server-only) invariant.
- **Sentry client config** (`sentry.client.config.ts`): reads only `NEXT_PUBLIC_SENTRY_DSN` / `NEXT_PUBLIC_VERCEL_*` — no server DSN or token in the browser bundle. `SENTRY_AUTH_TOKEN` is server/build-only.

## 4. Runtime exposure surfaces — CLEAN

- **`/api/health` (`app/api/health/route.ts`):** returns booleans/counts only (`configured`, `webhookConfigured`, `clientConfigured`, `operatorConfigured`, implemented/endpoint counts) plus env name, 7-char commit SHA, and branch. In-file comments state it must "neither name env vars nor leak the DSN." No secret value is returned. Classification: EXPECTED (readiness booleans are safe).
- **`next.config.ts`:** no `env:` / `publicRuntimeConfig` / `serverRuntimeConfig` injection block; no `productionBrowserSourceMaps: true`. Sentry wrapper sets `hideSourceMaps: true` (server source maps are uploaded to Sentry, not served to the browser). No server secret is forced into the client bundle.
- **`public/`:** contains only `icons/`, `landing/`, `product-shots/`, `pdf.worker.min.mjs`, `sw.js`. No `.env`, `.key`, `.pem`, or stray `config`/`.json` credential file committed.

## 5. Example / fixture files — CLEAN

- No tracked `.env.example` / `.env.*.example` exists (none needed; env contract is documented inline in `lib/env.ts`). `.gitignore` is configured to allow such example files if added (`!.env.example`).
- Test fixtures use dummy bodies only (`abc123` suffixes for Stripe key-kind detection), which are the exact strings the `.gitleaks.toml` allowlist pins — surgical, not blanket.

---

## Findings summary

| # | Finding | Location | Classification | Severity |
|---|---|---|---|---|
| — | No committed secrets; manual + CI gitleaks sweep clean | repo-wide | CLEAN | — |
| — | All 26 `NEXT_PUBLIC_*` vars are browser-safe identifiers/flags | `lib/env.ts` | EXPECTED-PUBLIC | — |
| — | All server secrets are non-public, server-only; no client import | `lib/env.ts`, `lib/supabase/admin.ts`, `sentry.client.config.ts` | EXPECTED | — |
| — | `/api/health` returns booleans/counts only | `app/api/health/route.ts` | EXPECTED | — |
| N1 | gitleaks not installed locally (tooling gap, not an exposure) | dev machine | NEEDS-REVIEW (ops) | Info |

**No CONFIRMED-EXPOSURE findings. No P0.** The secret-hygiene posture matches the CLAUDE.md invariant "never expose, print, request, or commit secrets" and the tested server/client boundary.

### Recommendation (non-blocking)
- **N1:** Install gitleaks locally (`brew install gitleaks`) so engineers can pre-flight-scan before pushing, mirroring the SHA-pinned CI gate. Optionally add a pre-commit hook that runs `gitleaks protect --staged`. No value exposure risk — tooling parity only.
