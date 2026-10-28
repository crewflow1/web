# HQ Super-Admin Platform — Security Audit

**Scope:** `/admin/*` pages + `/api/hq/*` and `/api/admin/*` route handlers, plus all HQ server actions and the impersonation subsystem.
**Tree:** `/Users/moetalibi/Code/web-main` @ `origin/main` tip `aedb9279` (live prod).
**Method:** READ-ONLY static review. Verified every gate against `server/auth/hq.ts` + `server/auth/superadmin.ts`.
**Date:** 2026-10-28.

---

## Summary

The HQ surface is **soundly gated**. There is **no path by which a non-super-admin
(any construction-company owner/admin/staff, or an anonymous caller) can reach HQ
data or actions**, by URL, param, or cookie manipulation. **Zero P0 findings.**

The single structural strength: every `/admin/**` page inherits one layout
(`app/admin/layout.tsx:40`) that calls `requireHqPage()`, and **every HQ server
action and route handler re-checks the allowlist independently** (defence-in-depth),
so the gate does not rely on the layout alone. Impersonation is cookie-as-session-id
only, re-validated against the DB row + allowlist + a 24h cap on every load, and
cannot be forged.

The remaining findings are **hardening gaps on already-HQ-gated actions**, not
reachability holes. The headline item is that the demo→customer promotion
(which creates a real auth user + org + membership and sends a magic-link invite
email) fires on a plain button submit and on an optimistic kanban drag with **no
confirmation step**.

### Counts

| Metric | Value |
|---|---|
| HQ pages (`app/admin/**/page.tsx`) | 81 |
| HQ layouts | 1 (`app/admin/layout.tsx`, gates all 81 via `requireHqPage()`) |
| HQ pages gated (via layout) | 81 / 81 |
| HQ pages ALSO calling `requireHqPage()` directly (DiD) | 42 |
| HQ pages flagged (missing/wrong gate) | **0** |
| HQ API routes (`/api/hq/**`) | 2 (both `requireHqApi`) |
| Admin API routes (`/api/admin/**`) | 9 |
| Other HQ-relevant routes | `app/admin/switch-to-customer/route.ts`, `app/api/gdpr/erase/route.ts` |
| HQ API routes gated | 11 / 11 (+ GDPR route owner/super-admin + dark flag + confirm token) |
| HQ API routes flagged | **0** for reachability |
| HQ server-action files | 32 — **all 32 re-check the allowlist** |
| Destructive/privileged actions audited | demo promote, memory purge, impersonation start/end/force-end, GDPR erase, Stripe provision/verify, customer lifecycle, analytics export |

### Findings by severity

| Severity | Count |
|---|---|
| P0 (non-super-admin reaches HQ / priv-esc) | **0** |
| P1 (destructive/outbound HQ action lacks confirmation) | 1 |
| P2 | 1 |
| P3 (defence-in-depth / consistency) | 2 |

### Verification of the two previously-reported items

- **`/admin/memory` purge — "missing confirmation": RESOLVED.** `purgeMemoryAction`
  (`app/admin/memory/actions.ts:353`) now requires a Zod-enforced typed confirmation
  word `confirm: z.literal("PURGE")` **and** a mandatory reason (`min(3)`) server-side
  (`actions.ts:345-351`). A replayed/mis-clicked form without the exact word performs
  **zero** writes. Audit row is content-free (`actions.ts:386-398`). Not a current finding.
- **`/admin/demos` promote — "possibly no explicit confirm step": CONFIRMED (P1 below).**
  Still no confirmation on the promotion trigger.

---

## P1 — Demo→customer promotion creates accounts + sends invite email with no confirmation

- **Title:** Irreversible, outbound-effect promotion fires on a single click / drag with no confirm step.
- **Files:**
  - Trigger (button): `app/admin/demos/_detail-panel.tsx:180` (`<StatusButton status="active_onboarding" …>`) → plain `<form action={moveDemoToStatus}>` at `_detail-panel.tsx:377`.
  - Trigger (drag): `app/admin/demos/_kanban.tsx:75-106` (`onDragEnd` → `moveDemoToStatusJson`, optimistic, no prompt).
  - Effect: `app/admin/demos/actions.ts:99-133` and `:281-309` call `promoteDemoToCustomer`, which creates a real auth user, organization, owner membership, and sends a magic-link invite email (lifecycle labels `demo.customer_created` / `demo.org_created` / `demo.membership_created` / `demo.invite_sent`, `_detail-panel.tsx:396-401`). The sibling transitions `won`/`payment_sent`/`payment_received`/`contacted` also send outbound customer emails (`onDemoApproved` / `onSetupPaymentSent` / etc., `actions.ts:189-205`) with no confirm.
- **What's missing:** (b) confirmation before an irreversible + outbound effect. (a) authorization is PRESENT (`requireAdmin()` → `isSuperAdminEmail`, `actions.ts:39-45`, and re-checked in the JSON path `:244-247`). (c) audit is PRESENT and thorough (`recordAdminActivity` on success, failure, and `demo.onboarding_failed`). (d) rate-limit n/a.
- **Reachability:** HQ super-admin only. **Not** a privilege-escalation — a non-HQ user cannot reach it. This is a hardening gap: a mis-drag or double-click provisions a live customer account and emails a stranger.
- **Severity:** **P1** (destructive/outbound HQ action lacks a confirmation step).
- **Smallest robust fix:** Gate the `active_onboarding` transition (both the button and the drag drop) behind the same pattern already used for memory purge / impersonation — a confirm modal that echoes the company + email and requires an explicit click (and ideally a typed company name) before `promoteDemoToCustomer` runs. The server action is already idempotent, so the fix is purely a client-side confirm interstitial; no server change required for safety, though a server-side `confirm` field mirrors the memory-purge belt-and-braces.

---

## P2 — 39 HQ pages rely solely on the layout gate (no direct `requireHqPage`)

- **Title:** Most HQ pages are gated only by the parent layout, not by their own `requireHqPage()` call.
- **Files:** 39 of 81 `app/admin/**/page.tsx` do not call `requireHqPage()` directly (e.g. `app/admin/customers/page.tsx`, `app/admin/billing/page.tsx`, `app/admin/analytics/page.tsx`, `app/admin/demos/page.tsx`, `app/admin/memory/page.tsx`). They inherit the gate from `app/admin/layout.tsx:40`.
- **What's missing:** page-level authorization redundancy. The task explicitly accepts "gated … via a segment layout that does," so this is **compliant**, not a hole. The reason it is noted at all: these pages fetch cross-tenant HQ data via `createAdminClient()` (service-role, RLS-bypassing), and their async data-fetch executes concurrently with the layout in the App Router even when the layout calls `notFound()`. The 404 response is still returned (no RSC payload leaks to the client), so there is **no data disclosure** — but the service-role query runs for an unauthorized request.
- **Reachability:** A non-super-admin gets a 404 and receives no HQ data. Confirmed no leak. This is a defence-in-depth / blast-radius observation.
- **Severity:** **P2** (worth a cheap hardening; not a live exposure).
- **Smallest robust fix:** Add `await requireHqPage()` as the first line of each of the 39 pages (matches the 42 that already do), so the service-role data fetch never runs for a non-HQ request. Alternatively, lint-enforce it.

---

## P3 — Server actions re-implement the gate inline rather than calling a single HQ helper

- **Title:** HQ server actions check `isSuperAdminEmail` via a local `requireAdmin()` and `redirect("/dashboard")` instead of the canonical `requireHqApi()`/`requireHqPage()` helper.
- **Files:** ~24 action files define their own `async function requireAdmin()` that calls `requireUser()` + `isSuperAdminEmail(...)` then `redirect("/dashboard")` (e.g. `app/admin/demos/actions.ts:39-45`, `app/admin/memory/actions.ts:41-45`, `app/admin/customers/actions.ts:31-34`, `app/admin/impersonation/actions.ts:38-44`).
- **What's missing:** single-source-of-truth consistency. These reuse the **canonical `isSuperAdminEmail` predicate** (not a hand-rolled copy of the allowlist parse), so drift risk is low — but they diverge from the helper in behaviour: `redirect("/dashboard")` reveals that the caller is authenticated-but-not-HQ, whereas `requireHqApi` returns an indistinguishable 404 ("don't announce the surface"). For a server action the practical disclosure is negligible.
- **Reachability:** Non-HQ callers are correctly refused (redirected away / early-returned). No action executes for them. No priv-esc.
- **Severity:** **P3** (consistency / defence-in-depth).
- **Smallest robust fix:** Replace the per-file `requireAdmin()` helpers with a single shared `requireHqAction()` in `server/auth/hq.ts` that 404s (or at least centralises the predicate), so there is one HQ decision across pages, routes, and actions.

---

## P3 — (informational) `switch-to-customer` redirect leaks nothing but uses inline allowlist

- **Title:** `app/admin/switch-to-customer/route.ts` gates with inline `isSuperAdminEmail` + redirect rather than `requireHqApi`.
- **File:** `app/admin/switch-to-customer/route.ts:33-36` — non-super-admin is redirected to `/dashboard` (not 404). It only ever issues a redirect to `/dashboard` or `/admin/customers`; it exposes no data and starts no session (impersonation is started only by `startImpersonation`).
- **Reachability / severity:** No exposure; **P3** consistency note, same remedy as the finding above.

---

## Impersonation — explicitly cleared (no finding)

Verified end-to-end; **a company user cannot forge an impersonation session.**

- **Entry requires HQ auth.** Started only by `startImpersonation` (`app/admin/impersonation/actions.ts:59`) behind `requireAdmin()` (`:60`), reason mandatory (`min(3)`, `:52-57`). The customer-detail entry (`app/admin/customers/[id]/_impersonate.tsx`) is a confirm modal ("High-risk action · audit-logged", requires a reason) under the HQ-gated page.
- **Cookie cannot grant access.** `cf_impersonation_session` holds only a session id; `getActiveImpersonation` (`server/services/impersonation.ts:44-110`) returns `null` for any non-super-admin (`:54`), requires a live DB row, enforces `row.admin_email === currentEmail` (`:83-85`), and a 24h hard cap (`:88-90`). Tampering with the cookie yields nothing.
- **Context builder is unreachable without a validated session.** `loadOrgContextForImpersonation` (`server/auth/session.ts:413`) is called only after `getActiveImpersonation` succeeds (`session.ts:206-213`, `:303-308`). The impersonated context is rendered as `role:"owner"` but **on the user-JWT client**, so RLS still refuses writes (no membership row in the target org) — reads are RLS-bounded too (`session.ts:424-435`).
- **Audited + loud.** Start/end/force-end each write `admin_activity_log` (`actions.ts:99-109,143-155,182-189`); start also emits a high-visibility HQ notification (`:110-117`) and captures IP/UA (`impersonation.ts:122-137`).
- **Banner enforced.** `app/(app)/layout.tsx:59-78` renders a persistent red "IMPERSONATING {org}" banner with an Exit button whenever `getActiveImpersonation` returns a session; a super-admin is bounced out of the `(app)` group entirely unless actively impersonating (`session.ts:297-308`).

## Other privileged actions — checked, no reachability issue

- **Stripe provision/verify** (`app/api/admin/stripe/provision/route.ts`, `verify/route.ts`): gated by inline `isSuperAdminEmail`.
- **GDPR erase** (`app/api/gdpr/erase/route.ts`): not an HQ-only surface — org-scoped (`requireOrgContext`), owner-or-super-admin (`:64-72`), DARK behind `FEATURE_GDPR_ERASURE` checked before any auth/DB (`:51-57`), confirmation token must equal org slug (`:75-91`), service re-verifies + writes `gdpr_erasure_log`. Strong.
- **Analytics CSV/PDF export** (`app/api/admin/analytics/export.*`): gated by inline `isSuperAdminEmail`.
- **Memory purge, customer lifecycle, billing, approvals, workflow-sagas, outreach, AI-receptionist actions**: all re-check the allowlist (confirmed across all 32 action files).
