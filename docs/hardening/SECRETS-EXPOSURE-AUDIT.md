# CrewFlow — Secrets & Data-Exposure Audit

**Date:** 2026-10-28 · prod `aedb9279` · Full evidence: `docs/hardening/findings/03-secrets-exposure.md`.

> **VERDICT: CLEAN — 0 confirmed exposures. No credential rotation required.** No secret value was printed, copied, or committed during this audit.

## Scanning
- **CI (authoritative):** `.github/workflows/security-scan.yml` runs `gitleaks/gitleaks-action` **SHA-pinned** (not a moving tag) on every PR and push to `main` with `fetch-depth: 0` (full history). `.gitleaks.toml` allowlists only prefix literals / `abc123` test fixtures — no real secret body, no blanket path exemptions. Verified green on `main` and on fix PRs #947–#949.
- **Local substitute:** gitleaks is not installed on the audit host (tooling gap, not an exposure); high-signal manual sweeps (AWS/GCP/GitHub/Slack/Resend/SendGrid/PEM, Stripe `sk_live_`/`rk_live_`/`whsec_`, `eyJ…` JWT literals) over tracked non-test source → **0 matches**. No tracked `.env*`; `.env.local` gitignored.

## Server/client boundary — verified intact
- Single `lib/env.ts` zod schema splits server-only from `NEXT_PUBLIC_*`. No `"use client"` module imports `@/lib/env` or references a server-secret name. `lib/supabase/admin.ts` reads `SUPABASE_SERVICE_ROLE_KEY` server-side only. `sentry.client.config.ts` reads only `NEXT_PUBLIC_*`.
- `next.config.ts`: no env-injection block, no `productionBrowserSourceMaps`. `public/` holds no credential files.
- `/api/health` returns booleans/counts + env name + short SHA — **no values**.

## Classification of public identifiers (expected-public — NOT leaks)
Supabase URL + anon key · Stripe publishable `pk_` · PostHog public key + host · Sentry DSN · app URL/name · Vercel build metadata · 16 `"true"/"false"` feature flags. **26 `NEXT_PUBLIC_*` total, all correctly public.**

## Server secrets confirmed non-public
`SUPABASE_SERVICE_ROLE_KEY`, Stripe `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_CONNECT_SECRET_KEY`, `RESEND_API_KEY`, Twilio `TWILIO_AUTH_TOKEN`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, webhook signing secrets (`WHATSAPP_APP_SECRET`, `VAPI_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET`, `INBOUND_EMAIL_WEBHOOK_SECRET`), HMRC client secret, VAPID private key. All server-only; a positive security test asserts `FEATURE_PUBLIC_API_JOBS` is not exposed.

## Note (Stripe live)
Prod uses a **restricted** `rk_live_` least-privilege Stripe key (per `project_stripe_live_activation`). Restricted-live is a server secret and is handled server-only; not exposed.

## Recommendation (non-blocking, Info)
Install gitleaks on engineer machines for pre-push parity with CI. No rotation, no incident, no notification obligation triggered.
