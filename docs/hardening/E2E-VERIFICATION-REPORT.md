# CrewFlow — E2E / Authenticated-Browser Verification Report

**Date:** 2026-10-28 · prod `aedb9279`.

## Harness (real browser, real build, real DB — never prod)
CrewFlow ships a Playwright E2E tier (`playwright.config.ts`, ~60 specs) that in CI boots the **production build** (`next start`) against a **local ephemeral Supabase** and drives Chromium. `e2e/global-setup.ts` (guarded by `assertLocalE2eTarget` — refuses any non-local target as its first statement) seeds, via service-role, into that local stack:
- **owner** (`owner.json`) — org owner, not on the HQ allowlist.
- **staff** ×2 (`second/third.json`, consumed by logout specs) + a **dedicated** staff (`staff.json`, added this program).
- **HQ super-admin** (`hq.json`, allowlisted only when the e2e shell exports `CREWFLOW_SUPERADMIN_EMAILS`).

This makes authenticated multi-role browser testing **available** (Phase 8 is **not** blocked). It is NOT run against production — real customer data is never touched (program rule).

## What authenticated browser testing proves today
| Claim | Evidence | Status |
|---|---|---|
| Logged-out → `/login`, destination preserved | `e2e/smoke.spec.ts` | ✅ existing |
| Baseline security headers on every response | `e2e/smoke.spec.ts` | ✅ existing |
| Public + auth surfaces render | `e2e/smoke.spec.ts` + ~60 feature specs | ✅ existing |
| **Staff cannot reach management-only `/quotes`, `/invoices` by URL → bounced to `/me`** | `e2e/role-access-boundary.spec.ts` (PR #949) | ✅ added |
| **Staff CAN reach `/me`** (positive control) | same | ✅ added |
| **Non-super-admin owner → 404 on `/admin`** | same | ✅ added |
| Billing redirect for staff | joins the role-access spec once PR #947 merges | ⏳ after merge |
| Feature journeys (jobs, cash, H&S, blueprints, portal, fleet, stock, payments, a11y, mobile) | the existing ~60 specs | ✅ existing coverage |

## Honesty boundary (what is NOT yet browser-verified)
- The AI quote-writer management gate (SEC-03) is covered by a **security unit test**, not a browser test (the dark feature returns `unavailable`, and staff can't reach the UI to drive it).
- The deny-panel pages (`/settings/api-keys` etc.) keep their URL and need a content assertion — not added here.
- Cross-tenant negative tests at the browser level are not added; cross-tenant isolation is proven at the **DB/RLS tier** (integration tests) and by code audit — the stronger layer.
- The broad "does every button do its advertised thing end-to-end" is **not** exhaustively browser-verified; the Phase-3 audit certifies the **code-level** control surface (0 broken controls) and the existing ~60 specs cover the critical journeys. Full per-control live verification would require a much larger authenticated suite — recommended as ongoing work, not a launch blocker.

## Negative-test posture
Destructive exploit payloads and fuzzing against production are **deliberately not performed** — forbidden on live customer data. Negative access tests run against the seeded local stack only.
