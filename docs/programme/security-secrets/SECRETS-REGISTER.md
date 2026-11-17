# CrewFlow — Secrets register & credential-exposure audit

**Date:** 2026-11-13/14 · **Baseline:** `origin/main` `8cec66a7` · **Branch:** `security/secrets-and-ai-spend`
**Scope:** Part A of the secrets + AI-spend workstream. Part B is `AI-SPEND-GOVERNANCE.md`.

No secret VALUE appears in this document, in any commit on this branch, or in any
command output produced during the audit. Secrets are referred to by NAME, file
path, commit SHA and gitleaks fingerprint only.

Evidence labels: **VERIFIED** (ran it, saw it) · **IMPLEMENTED-UNTESTED** ·
**SIMULATED-ONLY** · **BLOCKED** · **NEEDS-FOUNDER** · **NOT-IMPLEMENTED**.
Severity: **P0** critical · **P1** before paying customers · **P2** launch with
documented limitation · **P3** post-launch.

---

## 1. Headline

| | |
|---|---|
| **Credentials that must be rotated because they were exposed in git** | **None.** No real provider credential, service-role key, database password or signing secret has ever been committed, on any ref. **VERIFIED** (§3). |
| Credentials that should be rotated for hygiene (not exposure) | Two local, never-committed copies — see §2. |
| The repository is **PUBLIC** | `crewflow1/web` is a public GitHub repository. **VERIFIED** (`gh api repos/crewflow1/web` → `private:false`). Everything ever committed is world-readable. That makes §3 the load-bearing result, and it is why the two founder decisions in §9 matter. |
| Client bundle | The service-role key and every provider secret are absent from the production client bundle. **VERIFIED** on a real build with canary values (§5). |
| The Supabase anon key | **Public by design.** It is not a secret; RLS + grants are the boundary. What it can reach is being tested by another workstream. (§7) |

---

## 2. Rotation register (the short list)

| Secret NAME | Where the copy is | Ever in git? | Rotate? | Why |
|---|---|---|---|---|
| *(none)* | git history, all refs | — | **No rotation required from exposure** | §3 |
| `ANTHROPIC_API_KEY` | `/Users/moetalibi/Code/web-main/.env.local` **and** a stray editor backup `/Users/moetalibi/Code/web-main/.env.local.save` | No — **VERIFIED** (value-in-history scan, §3.4) | **Recommended (hygiene), NEEDS-FOUNDER** | A real key sits in two plaintext files on a laptop, one of them an accidental `nano` save-file. Both are git-ignored (`.env*.local` / `.env.*`). Delete `.env.local.save`; if this is the production key rather than a separate test key, rotate it and keep production keys out of local files. |
| `TWILIO_AUTH_TOKEN` (+ `TWILIO_ACCOUNT_SID`) | `/Users/moetalibi/Code/web-main/.env.local` | No — **VERIFIED** | **Recommended (hygiene), NEEDS-FOUNDER** | Same reasoning. The auth token is account-wide; prefer an API key SID/secret pair (`TWILIO_API_KEY_SID`/`TWILIO_API_KEY_SECRET`, already supported) that can be revoked independently. |
| `DEV_TEST_LOGIN_TOKEN` | `/Users/moetalibi/Code/web/.env.development.local` | No — **VERIFIED** | **Rotate if it is set in Vercel Preview — NEEDS-FOUNDER** | See finding S-2. |
| `STAGING_DB_PASSWORD` | `/Users/moetalibi/Code/web/.env.staging` | No — **VERIFIED** | NEEDS-FOUNDER | There is no hosted staging today. If this password still opens a database, rotate or delete it; if the database is gone, delete the file. |

---

## 3. Git history (PUBLIC repo) — VERIFIED clean

### 3.1 gitleaks, full history, as CI runs it
`gitleaks detect --source . --config .gitleaks.toml --redact` (v8.30.1, the CI
version) over **2,215 commits on every local ref** → **2 findings, both false
positives, neither on `origin/main`**:

| Fingerprint | Ref | Verdict |
|---|---|---|
| `bfd0062654…:__tests__/stripe/sandbox-gate.test.ts:stripe-access-token:139` | local branches `pr988`, `stripe-sandbox-followup`, `test/stripe-sandbox-lifecycle-harness` | A 9-character `rk_test_` placeholder (entropy 2.97) in a unit test. Not a key. |
| `2275a07907…:docs/strategy/11-local-ai-tts.md:generic-api-key:204` | local branch `overnight/11-local-ai-tts` | A Hugging Face model path in a "Sources" list. Not a key. |

CI scans `main`'s history on push and the PR range on PRs; both are green there.

### 3.2 gitleaks with the allow-list REMOVED — every allow-listed item scrutinised
Re-ran with `useDefault = true` only and an empty ignore file → **18 findings**.
Each was inspected at source (payloads decoded, signatures never printed):

| Allow-list entry | What it actually is | Real credential? |
|---|---|---|
| `sk_live_abc123`, `rk_live_abc123`, `sk_test_abc123`, `rk_test_abc123`, `pk_live_abc123`, `startsWith("sk_live_")` | Prefix literals + a 6-char dummy body in `lib/stripe/client.ts`, `lib/payments/portal-stripe.ts` and Stripe unit tests | No |
| `E2e-Harness-Pw-2f9c1a` | Password of the synthetic E2E account `e2e-owner@crewflow.test` (`e2e/global-setup.ts`, `e2e/core-journey.spec.ts`, `e2e/first-customer-sim.spec.ts`) | **No** — the harness refuses any non-local target (`assertLocalE2eTarget`), and production has **0** users at `@crewflow.test` (**VERIFIED**, aggregate count on prod) |
| `fb9202308f44aabbcc…` | A hand-written fake token hash in `__tests__/staff/staff-invite-service.test.ts` | No |
| `SIGNATUREMATERIAL` | A JWT in `__tests__/lib/destructive-db-guard.test.ts` whose payload is `{"role":"service_role"}` and whose signature segment is the literal text `SIGNATUREMATERIAL` | No — not a signed token |
| `sup3r-s3cret-db-passw0rd` (+ a `hunter2` DB URL) | Fixture connection strings in the same test | No |
| `qoRrOsCJYmdr9yUc6idY` | The **production anon key** hard-coded in `scripts/war-test-seed.mjs:285` (payload: `iss=supabase, role=anon, ref=jzntbskdqdopzwdqwvkp`) | **Not a secret** — public by design (§7). Hygiene finding S-6. |
| `rk_live_restricted`, `sk_live_realmoney`, `sk_test_LEAKCHECK` | Word-based placeholders quoted in a deleted status doc (commit `8c216488`, not on `main`) | No |
| `.gitleaksignore` → `78464a47…:lib/hq/finance.ts:generic-api-key:432` | A metric-id constant; the commit is no longer reachable | No |

**Verdict: every allow-listed item is a genuine false positive. Nothing was
allow-listed in place of being rotated.**

### 3.3 Provider-shape sweep of every blob (beyond gitleaks' rules)
A purpose-built scan of **12,066 blobs** (every version of every text file on
every ref) for 23 provider-specific shapes — Stripe live/test/webhook keys,
Anthropic, OpenAI, Resend, Twilio SIDs, Supabase PATs / secret keys, GitHub,
Sentry tokens, AWS, Google, Meta, Slack, PEM private keys, Postgres URLs with
passwords, bearer literals, and every JWT (payload decoded) → **5 hits, all
already accounted for above** (the anon JWT, the fixture JWT, three fixture
Postgres URLs). **0** live provider credentials.

### 3.4 Value-in-history scan (the strongest check)
The values of every secret currently held in local env files
(`web-main/.env.local`, `web-main/.env.local.save`, `web/.env.local`,
`web/.env.staging`, `web/.env.development.local`) were loaded **in memory only**
and searched for in all 12,181 blobs. **No secret value appears anywhere in
history.** The only matches were two non-secret e-mail addresses
(`CREWFLOW_SUPERADMIN_EMAILS` test value, `DEV_TEST_USER_EMAIL`) used as test
fixtures. So `web-main/.env.local` — which holds real Anthropic and Twilio
credentials — **was never committed. VERIFIED.**

### 3.5 Files that should never be in git
`git log --all -- '.env*' '*.pem' '*.key' …` → the only match is
`e2e/.auth/owner.json` + `e2e/.auth/second.json`, added in `920b799a`
(2026-07-25) and deleted in `96fa4e5f` — **on `main`'s history**. Inspected
structurally: Playwright storage state for `e2e-…@crewflow.test`, issuer
`http://127.0.0.1:54321/auth/v1` (the local Supabase), access tokens **expired
2026-07-23/25**, 12-character local refresh tokens. A local-stack session for a
synthetic account, long expired. **Not a production credential; no rotation.**
The path is now git-ignored (`/e2e/.auth/`).

### 3.6 GitHub's own scanners
Secret scanning **enabled**, push protection **enabled**, **0** alerts open or
resolved (**VERIFIED** via the alerts API, metadata only). Dependabot security
updates are **disabled** (out of scope here; noted for the supply-chain stream).

---

## 4. Working tree — VERIFIED clean
`gitleaks dir .` with no allow-list → the same test fixtures as §3.2 plus the
git-ignored local `.env.local` (local Supabase demo keys). No hard-coded key,
token or password in `app/`, `lib/`, `server/`, `components/`, `scripts/`,
`sdks/`, `public/`, `docs/` or `.github/workflows/`. CI workflows carry only
`test-anon-key` / `test-service-role-key` placeholders and `localhost` URLs.

The one workflow that takes real secrets —
`.github/workflows/companies-house-bulk-sourcing.yml` — reads
`secrets.SUPABASE_SERVICE_ROLE_KEY` and runs only on `schedule` /
`workflow_dispatch`, never on `pull_request` (so a fork cannot reach it); no
workflow uses `pull_request_target`. `gh secret list` returned no rows, so
whether that secret is actually configured is **NEEDS-FOUNDER** (if it is, the
production service-role key has a second home that must be rotated in step).

---

## 5. Client exposure — VERIFIED on the build artefact

**Static analysis.** 196 `"use client"` modules; their transitive (non-type,
non-`use server`) import closure is 323 modules. None reads a server-only
variable by name, none imports `lib/env.ts` or `lib/supabase/admin.ts`.
`import "server-only"` is present on `lib/supabase/admin.ts`,
`lib/supabase/server.ts`, `lib/stripe/client.ts`, `lib/payments/portal-stripe.ts`,
`lib/comms/providers/twilio.ts` and every AI provider door
(`lib/ai/{text,vision,embeddings}/index.ts`, `lib/ai/transcription/openai.ts`).
`lib/env.ts` itself has **no** `server-only` marker (finding S-7) — today nothing
client-side imports it.

**The artefact.** One production build
(`heavy.sh npm run build`, exit 0) was run with **inert canary values**
(`cfcanary_<NAME>_7f3a9c`) injected for 27 server-only secrets
(`CRON_SECRET`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`,
`INTEGRATION_TOKEN_ENCRYPTION_KEY`, `VAPID_PRIVATE_KEY`, `WHATSAPP_*`, …), so the
scan is non-vacuous. Then every file was scanned:

| Check | Result |
|---|---|
| Canary values in `.next/static` (1,014 files) | **0** |
| Canary values in prerendered HTML / RSC / meta / JSON under `.next/server` (759 files) | **0** |
| The service-role key value (and its signature tail alone) in `.next/static` or prerendered output | **0** |
| Secret-shaped strings in `.next/static` (Stripe, Anthropic, OpenAI, Resend, Twilio, Supabase secret, GitHub, PEM, Postgres URL, **any JWT**) | **0** |
| Values of the founder's real local secrets in `.next/static` | **0** |
| NAMES of 152 server-only variables in client `.js` | 3 names in one chunk: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TRANSCRIPTION_API_KEY` (plus the platform name `VERCEL_ENV`) — the readiness table from `lib/ai/governor/readiness.ts`, pulled into the quote-writer panel. **Names only, no values.** Informational (S-8). |

Notably the build contains **no JWT at all**: the app has no browser Supabase
client, so even the public anon key is not shipped to browsers.

**`NEXT_PUBLIC_*` inventory (26).** `APP_URL`, `APP_NAME`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `STRIPE_PUBLISHABLE_KEY`, `SENTRY_DSN`, `POSTHOG_KEY`,
`POSTHOG_HOST`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, and 16
`NEXT_PUBLIC_FEATURE_*` flags. **None is privileged.** The flags only reveal
which dark capabilities exist; every one is paired with a server-side credential
gate, so flipping one in a browser enables nothing.

---

## 6. Leakage paths

| Path | Finding | Status |
|---|---|---|
| Logging | No `console.*` call logs request headers, `authorization`, cookies, raw bodies, `process.env`, tokens or signatures (grep over `app/ lib/ server/ middleware.ts`). | **VERIFIED** clean |
| Sentry config | All three configs: `sendDefaultPii: false`, `beforeSend` + `beforeSendTransaction` → `scrubEvent`, session replay sample rates 0. Monitoring is dark today (no DSN) per the code comments — **NEEDS-FOUNDER** to confirm. | **VERIFIED** (config) |
| Sentry scrubber | Gaps closed on this branch — finding **S-3**. | **FIXED + tested** |
| Analytics | PostHog: `autocapture: false`, session recording disabled, UUIDs masked in URLs, never mounted on `/q` or `/customer-portal`. Gap closed — finding **S-4**. | **FIXED + tested** |
| Tokens in URLs | Four surfaces carry a bearer token as a PATH segment (`/customer-portal/[token]`, `/worker-portal/[token]`, `/q/[token]`, `/a/[token]`). `Referrer-Policy: strict-origin-when-cross-origin` keeps them out of cross-origin referrers. They still appear in Vercel access logs (inherent to the design). | **VERIFIED**; residual documented |
| API keys | `lib/api-auth/keygen.ts`: CSPRNG, shown once, only the SHA-256 digest is stored (`api_keys.key_hash`); lookup is by digest (no secret-dependent comparison). | **VERIFIED** (code) |
| Outbound webhook secrets | `whsec_…`, CSPRNG, shown once, immutable; stored in **plaintext** in `webhook_endpoints.secret` (needed to sign), with column privileges excluding read-back. Feature is flag-dark. | **VERIFIED** (code); P3 note S-9 |
| OAuth tokens (integrations) | Encrypted at rest with `INTEGRATION_TOKEN_ENCRYPTION_KEY`. All integrations dark. | Code-read only |
| Webhook verification | HMAC + `timingSafeEqual` on WhatsApp, inbound email, Resend events, receptionist inbound, OAuth state. | **VERIFIED** (code) |
| Cron secret | All 48 cron routes call `isCronAuthorised`; fail-closed when `CRON_SECRET` is unset. Comparison was `===` — finding **S-5**. | **FIXED + tested** |
| Error responses | Not swept route-by-route in this workstream (168 handlers). The AI routes and the cron helper return generic bodies. | **NOT-IMPLEMENTED** (out of time; belongs with the API workstream) |
| Client source maps | Production serves `/_next/static/chunks/*.js.map` (HTTP 206 on a live probe). 366 maps with full `sourcesContent` of client modules. Redundant while the repo is public; matters the day it goes private. Finding **S-10**. | **VERIFIED** |

---

## 7. Public-key reality check

`NEXT_PUBLIC_SUPABASE_ANON_KEY` (and `NEXT_PUBLIC_SUPABASE_URL`) are **public by
design**. The anon key identifies the project and selects the `anon` Postgres
role; it authorises nothing by itself. The security boundary is RLS + table/
function grants, not the secrecy of this key. It is committed in
`scripts/war-test-seed.mjs` and discoverable from any Supabase-backed site, and
that is fine. **Do not rotate it for "exposure".** What the anon role can
actually reach in production is being tested by a separate workstream; this one
makes no claim about it. The same reasoning applies to the Stripe publishable
key, the Sentry DSN and the PostHog project key.

---

## 8. Findings

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| **S-1** | **P1 decision** | **The repository is public.** Source, all 445 migrations (schema, RLS policies), security audit documents describing weaknesses (`docs/hardening/*`), internal strategy docs, AI system prompts and the internal e-mail address used as `DEV_TEST_USER_EMAIL` (40 files) are world-readable. No credential is exposed (§3), so this is not an incident — but it is almost certainly not a deliberate product decision for a commercial multi-tenant ERP, and it removes obscurity from every other finding in the programme. | `gh api repos/crewflow1/web` → `visibility: public`; `.github/workflows/security-scan.yml` comment "free for this public repo" | **NEEDS-FOUNDER**: confirm intent. If unintended, make it private (history stays clean, so no rewrite is needed). |
| **S-2** | **P2** | **Preview-only login route.** `GET /api/dev/test-login?token=…` mints a magic link for `DEV_TEST_USER_EMAIL` (an internal `@crewflow.uk` address) using the service-role client whenever `VERCEL_ENV` is `preview`/`development`. It 404s in production (**VERIFIED**, code). But there is a single production database and no staging: if Preview deployments carry the production Supabase credentials **and** `DEV_TEST_LOGIN_TOKEN`, the token is a login to **production data** from any Preview URL. The token travels in the query string and is compared with `!==`. | `app/api/dev/test-login/route.ts`; token present in `web/.env.development.local` (26 chars, random, never committed) | **NEEDS-FOUNDER**: (a) is `DEV_TEST_LOGIN_TOKEN` set in Vercel Preview? (b) do Previews use the production Supabase? (c) is Vercel Deployment Protection on? If (a)+(b): remove the variable from Preview (or delete the route) and rotate the token. Not changed in code — the route is in use for QA. |
| **S-3** | **P2** | **Sentry scrubber let tokens through.** Exact-name matching missed every webhook-signature / shared-secret header (`stripe-signature`, `x-twilio-signature`, `x-hub-signature-256`, `svix-signature`, `x-webhook-secret`…); only query strings were redacted, so path-borne portal/quote/worker tokens shipped in `request.url`, the transaction name, exception text and span descriptions; breadcrumbs were not scrubbed at all. | `lib/monitoring/scrub.ts` before `6e60f7ad` | **FIXED** `6e60f7ad` — anchored key-shape matching (keeps token *counts*), path-token redaction, breadcrumb/exception/span scrubbing. **VERIFIED**: `__tests__/monitoring/scrub.test.ts` 14/14. Must be in place before a DSN is set. |
| **S-4** | **P2** | **Worker-portal tokens could reach the analytics vendor.** `isFirstPartySurface` excluded `/q` and `/customer-portal` but not `/worker-portal`; the worker token is base64url (not a UUID), so the UUID mask did not cover `$current_url`. | `lib/analytics/consent.ts`, `lib/analytics/sanitize-url.ts` | **FIXED** `95e8b227` — worker portal excluded; path tokens masked as `:token`. **VERIFIED**: `__tests__/privacy/consent.test.ts`, `__tests__/analytics/sanitize-url.test.ts`. |
| **S-5** | **P3** | `CRON_SECRET` compared with `===` (early-exit string compare) on the helper guarding all 48 cron routes. | `lib/cron/auth.ts` | **FIXED** `3f6ed98b` — SHA-256 digests + `timingSafeEqual`. **VERIFIED**: `__tests__/ops/cron-auth.test.ts` 5/5. |
| **S-6** | **P3** | Production anon key + project ref hard-coded in `scripts/war-test-seed.mjs:285`. Not a secret; but a seed/stress script that embeds a **production** project reference is one env-var typo away from being pointed at production with a service-role key. | file | **NOT-IMPLEMENTED** — proposed: read the key from env and add the `assertLocalDestructiveTarget` guard the test tiers already use. |
| **S-7** | **P3** | `lib/env.ts` has no `import "server-only"`. A future client import would not leak values (Next inlines only `NEXT_PUBLIC_*`) but would ship all 155 variable names and crash at runtime. | file; §5 | **NOT-IMPLEMENTED** — proposed: add the marker (needs a check that no edge/client path imports it). |
| **S-8** | Info | Three AI credential NAMES in one client chunk (via `lib/ai/quote-writer-readiness.ts` → `governor/readiness.ts`). No values. | build scan | Accepted. |
| **S-9** | **P3** | Outbound webhook signing secrets are stored in plaintext (flag-dark feature). | migration `20261087000000` | Documented; encrypt with `INTEGRATION_TOKEN_ENCRYPTION_KEY` before activation. |
| **S-10** | **P3** | Client source maps are publicly served in production (`hideSourceMaps: true` hides the reference, not the file). | live probe → 206 | **NEEDS-FOUNDER** with S-1. Fix when/if the repo goes private: `sourcemaps: { deleteSourcemapsAfterUpload: true }` in `withSentryConfig`. |
| **S-11** | **P3** | `SUPABASE_SERVICE_ROLE_KEY` is reused as the salt for `hashIp` (`lib/security/ip-hash.ts`). Rotating the service-role key silently changes every stored `ip_hash`, breaking continuity of abuse/audit correlation — a hidden cost that discourages rotation. | file | **NOT-IMPLEMENTED** — proposed: a dedicated `IP_HASH_SALT`. |
| **S-12** | **P2** | Real provider credentials in plaintext on the founder's laptop, including an accidental editor backup (`.env.local.save`). Never committed. | §2 | **NEEDS-FOUNDER** (I did not touch the files, as instructed). |
| **S-13** | Info | There was no `.env.example`. | — | **FIXED** `130540eb` — 156 names, classified, value-free, kept honest by `__tests__/security/env-example-coverage.test.ts` (9/9). |

---

## 9. What must live in Vercel — NEEDS-FOUNDER (I cannot read Vercel's store)

I could not verify any of this; it is the list to check against the Vercel
project's **Production** environment. "Preview" should carry **none** of the
production secrets unless Previews are deployment-protected.

**Required for the live product**

| NAME | Notes |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. Production (and Preview only if protected). Mark as *Sensitive*. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL` | Public. |
| `CRON_SECRET` | Without it every cron refuses (fail-closed). |
| `STRIPE_SECRET_KEY` (restricted live key), `STRIPE_WEBHOOK_SECRET`, `STRIPE_INVOICE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Billing is live. |
| `RESEND_API_KEY` | Transactional e-mail is live. |
| `ANTHROPIC_API_KEY` | **AI is live in production** — the ledger holds 584 invocations (229 in the last 30 days, £2.74) across both production orgs (**VERIFIED**, aggregate read). See Part B for the provider-side cap that must accompany it. |
| `OPENAI_API_KEY` | Reported ACTIVE by a sibling workstream: OpenAI serves HQ-internal memory embeddings. I did not verify this independently (the ledger read here was an aggregate, not split by provider). Needs its own provider-side cap — Part B. |
| `CREWFLOW_SUPERADMIN_EMAILS`, `CREWFLOW_INTERNAL_ORG_ID` | Not secrets, but security-relevant config. |

**Present only if the capability is intentionally on** (each should be ABSENT
while its capability is dark): `TRANSCRIPTION_API_KEY`,
`TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SECRET`, `VAPI_WEBHOOK_SECRET`,
`CHANNEL_INBOUND_SECRET`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_ACCESS_TOKEN`, `INBOUND_EMAIL_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET`,
`VAPID_PRIVATE_KEY`, `STRIPE_CONNECT_SECRET_KEY`, `INTEGRATION_TOKEN_ENCRYPTION_KEY`,
`HMRC_CLIENT_SECRET`, `XERO_CLIENT_SECRET`, `QBO_CLIENT_SECRET`, `SAGE_CLIENT_SECRET`,
`GOOGLE_CALENDAR_CLIENT_SECRET`, `MS_GRAPH_CLIENT_SECRET`, `BANKING_CLIENT_SECRET`,
`TELEMATICS_CLIENT_SECRET`, `MERCHANT_*_API_KEY`, `MET_OFFICE_API_KEY`,
`OPEN_METEO_API_KEY`, `KV_REST_API_TOKEN`, `POSTHOG_SERVER_KEY`,
`COMPANIES_HOUSE_API_KEY`, `GITHUB_TOKEN`, `VERCEL_TOKEN`, `SENTRY_AUTH_TOKEN`
(build env), `MAINTENANCE_BYPASS`.

**Must NOT be in Production:** `DEV_TEST_LOGIN_TOKEN`, `DEV_TEST_USER_EMAIL`.

**Founder checklist**
1. Confirm the repo's visibility is intended (S-1).
2. Confirm `DEV_TEST_LOGIN_TOKEN` is absent from Production and decide its fate in Preview (S-2).
3. Confirm no dark-capability credential is sitting in Production "just in case" — a credential with a bound tier/flag is one switch from live.
4. Confirm whether `SUPABASE_SERVICE_ROLE_KEY` exists as a GitHub Actions secret (§4).
5. Delete `web-main/.env.local.save`; decide on rotating the two local provider credentials (S-12).
6. Mark every `[SECRET]` in `.env.example` as *Sensitive* in Vercel (write-only after creation).

---

## 10. Full register — every secret NAME

`Store` = where the value must live. `V` = Vercel env (Production; Preview only
if protected). All are server-only; none may use a `NEXT_PUBLIC_` name.
"Exposure" is the verdict of §3–§5 for that name: **Clean** = never in git, not
in the client bundle.

| NAME | Provider / purpose | Used in (representative) | Store | Exposure | Rotate? |
|---|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (bypasses RLS) | `lib/supabase/admin.ts`, `lib/health/cron-freshness.ts`, `lib/security/ip-hash.ts` (S-11) | V (+ GitHub Actions secret? NEEDS-FOUNDER) | Clean | No |
| `STRIPE_SECRET_KEY` | Stripe API (restricted live) | `lib/stripe/client.ts`, admin customer actions | V | Clean | No |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature | `app/api/webhooks/stripe/route.ts` | V | Clean | No |
| `STRIPE_INVOICE_WEBHOOK_SECRET` | Stripe invoice webhook signature | `app/api/webhooks/stripe-invoice/route.ts` | V | Clean | No |
| `STRIPE_CONNECT_SECRET_KEY` | Stripe Connect (portal payments, dark) | `lib/payments/portal-stripe.ts`, `lib/payments/stripe-connect.ts` | V when live | Clean | No |
| `RESEND_API_KEY` | Resend (e-mail) | `lib/email/*`, `lib/comms/*` | V | Clean | No |
| `RESEND_WEBHOOK_SECRET` | Resend events signature (dark) | `lib/comms/providers/resend-events.ts` | V when live | Clean | No |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | Inbound e-mail HMAC (dark) | `lib/comms/providers/inbound-email.ts` | V when live | Clean | No |
| `ANTHROPIC_API_KEY` | Anthropic (text + vision) | `lib/ai/text/index.ts`, `lib/ai/vision/index.ts`, `server/services/{lead-summary,receptionist,research-llm}.ts` | V | Clean in git/bundle; **local plaintext copies** | Hygiene — §2 |
| `OPENAI_API_KEY` | OpenAI (embeddings, STT default) | `lib/ai/embeddings/index.ts`, `lib/ai/transcription.ts` | V when live | Clean | No |
| `TRANSCRIPTION_API_KEY` | Dedicated STT key (optional) | `lib/ai/transcription.ts` | V when live | Clean | No |
| `TWILIO_AUTH_TOKEN` | Twilio (dark) | `lib/comms/providers/twilio.ts`, `lib/telephony/config.ts` | V when live | Clean in git/bundle; **local plaintext copy** | Hygiene — §2 |
| `TWILIO_API_KEY_SECRET` | Twilio API key (dark) | `lib/telephony/provisioning.ts` | V when live | Clean | No |
| `VAPI_WEBHOOK_SECRET` | Vapi webhook auth (dark) | `lib/telephony/providers/vapi.ts` | V when live | Clean | No |
| `CHANNEL_INBOUND_SECRET` | `/api/receptionist/inbound` shared secret | `app/api/receptionist/inbound/route.ts` | V when live | Clean | No |
| `WHATSAPP_APP_SECRET` | Meta webhook HMAC (dark) | `lib/comms/providers/meta-whatsapp.ts` | V when live | Clean | No |
| `WHATSAPP_VERIFY_TOKEN` | Meta subscription handshake (dark) | `app/api/webhooks/whatsapp/route.ts` | V when live | Clean | No |
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API (dark) | `lib/comms/providers/meta-whatsapp-sender.ts` | V when live | Clean | No |
| `VAPID_PRIVATE_KEY` | Web push signing (dark) | `lib/notifications/push.ts` | V when live | Clean | No |
| `CRON_SECRET` | Vercel cron bearer | `lib/cron/auth.ts` (48 routes) | V | Clean | No |
| `KV_REST_API_TOKEN` | Vercel KV / Upstash | `lib/cache/kv.ts` | V | Clean | No |
| `SENTRY_AUTH_TOKEN` | Source-map upload | `next.config.ts` (build) | V build env | Clean | No |
| `POSTHOG_SERVER_KEY` | PostHog server capture | `lib/analytics/server.ts` | V when live | Clean | No |
| `COMPANIES_HOUSE_API_KEY` | Companies House (HQ research) | `server/services/research-fetch.ts` | V | Clean | No |
| `GITHUB_TOKEN` | GitHub (HQ CTO/QA dashboards) | `lib/integrations/github/adapter.ts` | V when live | Clean | No |
| `VERCEL_TOKEN` | Vercel API (HQ dashboards) | `lib/integrations/vercel/adapter.ts` | V when live | Clean | No |
| `INTEGRATION_TOKEN_ENCRYPTION_KEY` | Encrypts stored OAuth tokens | integration OAuth callbacks | V when live — **back it up; loss orphans all stored tokens** | Clean | No |
| `HMRC_CLIENT_SECRET` | HMRC OAuth (dark) | `lib/integrations/hmrc/oauth.ts` | V when live | Clean | No |
| `XERO_CLIENT_SECRET`, `QBO_CLIENT_SECRET`, `SAGE_CLIENT_SECRET` | Accounting OAuth (dark) | `lib/integrations/accounting/oauth.ts` | V when live | Clean | No |
| `GOOGLE_CALENDAR_CLIENT_SECRET`, `MS_GRAPH_CLIENT_SECRET` | Calendar OAuth (dark) | `lib/integrations/calendar/oauth.ts` | V when live | Clean | No |
| `BANKING_CLIENT_SECRET` | Bank feed OAuth (dark) | `lib/integrations/banking/oauth.ts` | V when live | Clean | No |
| `TELEMATICS_CLIENT_SECRET` | Telematics OAuth (dark) | `lib/integrations/telematics/oauth.ts` | V when live | Clean | No |
| `MERCHANT_JP_CORRY_API_KEY`, `MERCHANT_JEWSON_API_KEY`, `MERCHANT_TRAVIS_PERKINS_API_KEY`, `MERCHANT_HALDANE_FISHER_API_KEY` | Merchant price feeds (dark) | `lib/integrations/merchants/connect.ts` | V when live | Clean | No |
| `MET_OFFICE_API_KEY`, `OPEN_METEO_API_KEY` | Weather | `lib/weather/index.ts` | V when live | Clean | No |
| `MAINTENANCE_BYPASS` | Maintenance-mode bypass secret | `lib/maintenance.ts`, `middleware.ts` | V (only during a window) | Clean | No |
| `DEV_TEST_LOGIN_TOKEN` | Preview test login | `app/api/dev/test-login/route.ts` | **Never Production**; Preview only if protected | Clean in git; local copy | **If set in Preview — S-2** |
| `CREWFLOW_API_KEY` | A CrewFlow public-API key used by SDK examples | `sdks/src/generator.ts` | Developer machine only | Clean | No |
| `STAGING_DB_PASSWORD` | (not read by the app) | local file only | Delete or rotate | Never in git | NEEDS-FOUNDER |
| `E2E harness password` (`E2e-Harness-Pw-…`) | Synthetic local E2E account | `e2e/*.ts` (committed, allow-listed) | n/a | **Committed by design**; no production account exists (**VERIFIED**) | No |

Tenant-held secrets (not environment variables): API keys → hashed
(`api_keys.key_hash`); outbound webhook secrets → plaintext column, no
read-back (S-9); integration OAuth tokens → encrypted at rest.

---

## 11. How this was verified (reproduce)

```
gitleaks detect --source . --config .gitleaks.toml --redact            # 2 findings, off-main, false positives
gitleaks detect --source . --config <useDefault only> --redact         # 18 findings, all triaged in §3.2
python3 .scratch/histscan.py                                           # 12,066 blobs × 23 provider shapes → 5 known fixtures
python3 .scratch/valscan.py history                                    # local secret VALUES vs 12,181 blobs → none
.scratch/build-canary.sh  &&  python3 .scratch/bundlescan.py           # one prod build + artefact scan (§5)
npx vitest run --config vitest.security.config.ts __tests__/security/env-example-coverage.test.ts
npx vitest run __tests__/monitoring __tests__/analytics __tests__/privacy __tests__/ops/cron-auth.test.ts
```

The `.scratch/` helpers are git-ignored working files (they read local env
files in memory and print names only); they are not part of the branch.
