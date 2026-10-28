# CrewFlow — Security Audit

**Date:** 2026-10-28 · **Target:** production `aedb9279`, migration tip `20261240000000` · **Method:** read-only static audit by 4 parallel specialist auditors (route-authz, cross-tenant/RLS/grants, secrets, HQ super-admin) against the live production code, reconciled by an orchestrator. Detailed per-area evidence: `docs/hardening/findings/01-04`.

> **Headline verdict: NO P0, NO P1 cross-tenant or privilege-escalation hole anywhere.** The security spine — tenant isolation, secret hygiene, and HQ isolation — is genuinely strong and backed by non-vacuous CI gates. The remaining findings are defence-in-depth consistency items (P2/P3), one of which is a P1 destructive-action *hardening* gap (confirmation UX), all CLEAR and being remediated via PRs #947–#949. A separate class of **policy** questions (intended staff access) is held for CEO decision — these are not defects, they are decisions.

---

## 1. Authentication & session controls — PASS
- All `app/(app)/**` pages sit on a hard **member floor**: the root `app/(app)/layout.tsx` resolves `requireOrgContext()`, so nothing under `(app)` is anonymous-reachable. Anonymous → `/login` with destination preserved (proven by `e2e/smoke.spec.ts`).
- Protected API routes authenticate under differently-named guards: cron (shared secret), webhooks (signature), v1 public (API-key + flag), SSO, telephony. `dev/test-login` is env-fail-closed.
- Baseline hardening headers present on every response (`x-content-type-options`, `x-frame-options: DENY`, referrer-policy, permissions-policy `geolocation=()`); CSP intentionally Report-Only pending validation.

## 2. Direct-URL access & role-based authorization — PASS (with P2 consistency items)
- **Management boundary** (`requireManagementRole/Context/Api`, owner+admin) correctly enforced on Money, Quotes, and Staff/Payroll. Every quote CRUD **server action** re-checks management inside the action body (layouts do not protect server actions — verified individually). Money mutations route through `requireManagementApi`. CIS actions re-check `isManager`.
- **Fixed this wave (CLEAR):** `/settings/billing` read-before-gate (SEC-02, PR #947); AI quote-writer member-vs-management (SEC-03, PR #947).
- **Held for CEO (policy, not defect):** several nav-ADMIN surfaces enforce only the member floor and are *readable* by a signed-in staff member by URL — Operations area (POLICY-01), Site & Safety admin registers (POLICY-02), Inbox customer-comms reads (POLICY-03). RLS still scopes rows to the member's org; no cross-tenant exposure. Two member-*writable* asymmetries (`recordSupplierBill`, inspection-template publish/archive — POLICY-04) likewise reflect deliberate RLS policy. Tightening any of these needs a confirmed intended-access decision **and** (for POLICY-04) a coordinated action-guard + RLS migration.

## 3. HQ super-admin security — PASS
- 81/81 HQ pages and 11/11 HQ/admin APIs gated by the single env-allowlist predicate (`isSuperAdminEmail` via `requireHqPage`/`requireHqApi`); all 32 action files re-check. **No non-super-admin can reach any HQ surface by URL, param, or cookie.**
- **Impersonation is unforgeable:** cookie holds only a session id, re-validated every load against the DB row + allowlist + `admin_email` match + 24h cap; impersonated context runs on the user-JWT client so RLS still bounds it.
- `/admin/memory` purge already hardened (typed `PURGE` token + mandatory reason). GDPR erase is owner/super-admin, dark-flagged, slug-confirmed.
- **SEC-01 (P1, CLEAR, PR #948):** demo→customer promotion created a real auth user+org+invite on a bare click/drag with no confirmation — now gated by a server confirm token in both actions + a two-step UI. Hardening, not priv-esc (was already HQ-only + audited + idempotent).

## 4. Cross-tenant isolation & database/RLS — PASS
- ~190 SECURITY DEFINER functions: the client-executable uuid-arg class is systemically guarded (`current_org_ids()` + `42501`), enforced by `secdef-org-rpc-guard` integration test. **0 unguarded.**
- 421 `createAdminClient()` (service-role) call sites: request-reachable paths all re-derive tenant scope and pin `org_id`(+`customer_id`). **0 IDOR.**
- Data-API grant discipline clean; no blanket client grants; service-role-only tables carry no client grant; enforced by `migration-data-api-grant-guard`.
- 14 signed-URL sites all mint from an ownership-verified row; byte writes/deletes service-role-only. **0 cross-tenant object read.**
- Defence-in-depth coverage items only (theoretical, fail-closed): cross-file grant-guard coupling (SEC-06), secdef predicate-vs-effect (SEC-07) — test-tier hardening, queued.

## 5. API keys & secret exposure — PASS (CLEAN)
- gitleaks runs in CI SHA-pinned over full history; 0 confirmed exposures. 26 `NEXT_PUBLIC_*` vars all expected-public (Supabase anon, Stripe publishable, PostHog public, Sentry DSN, flags). Server secrets (service-role, Stripe secret/webhook, Resend/Twilio/LLM) referenced only in server-only modules via the single `lib/env.ts` schema. `/api/health` returns booleans/counts, no values. See `SECRETS-EXPOSURE-AUDIT.md`.

## 6. Attack-surface checks performed (OWASP-aligned)
Direct-URL · BOLA/BFLA · horizontal/vertical priv-esc · IDOR · session expiry/revocation · storage bucket perms · cross-tenant leakage · insecure admin endpoints — all exercised at code level; no reachable exploit found. CSRF/XSS/open-redirect/SSRF: outbound webhooks are SSRF-guarded; no reflected-param redirect sinks found in the sampled set. (Live fuzzing/pen-test against prod deliberately NOT performed — forbidden on real customer data.)

## 7. Confirmed vulnerabilities remaining
**None at P0/P1 as exploitable security holes.** Open items are: CLEAR hardening in review (PRs #947–#949); CEO policy decisions (POLICY-01..04 — not defects); and test-tier DiD hardening (SEC-04..07). See `REMEDIATION-TRACKER.md`.
