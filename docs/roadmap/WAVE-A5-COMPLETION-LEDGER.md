# Roadmap Completion — WAVE A.5 (Pre-Customer Hardening + Roadmap Reconciliation)

NOT feature-building. Verify Wave A prod state, close small deferred debts sensible before first customer, reconcile the whole roadmap vs actual code. ZERO customers → do NOT activate any dark/paid/external capability. Do NOT touch PR #838.

## Rule Zero — current truth (2026-08-23, ~14:03 UTC)
- origin/main SHA: **346caa98** (Wave A merge #839)
- production SHA: **346caa9** (= 346caa98) — /api/health healthy, db:ok
- comms: email=true (pre-existing Resend), sms/whatsapp=false; weather dark → NO dark provider activated
- Prod DB: **375 applied, tip 20261215** == 375 migration files → exact parity
- PR #838 (product/ux-rebuild): OPEN, draft=true, **1ea34993** — UNTOUCHED
- Wave A.5 branch: roadmap/wave-a5-hardening @ 346caa98 (worktree web-wave-a5)
- Next free migration prefix: **20261216**

## Cron verification loop (A.1 closure)
- Latest runs: alerts-poll 2026-08-23 03:01 FAIL, hq-decision-autopropose 2026-08-23 03:15 FAIL — BUT both were BEFORE the Wave A deploy (~13:45 UTC). Crons run DAILY 03:00/03:15 UTC; next fire ~2026-08-24 03:xx (post-deploy first run).
- Deployed fix RE-PROVEN read-only against current prod schema: corrected `demo_requests` read (linked_org_id/approved_at) runs clean (rows:[]), old `org_id` shape still 42703. Real-PG integration test (hq-alerts-snapshot) green in CI.
- **A.1 status: code fix deployed + verified; NOT "still failing on Wave A code" (only pre-deploy runs failed). Operational green cron_runs row pends next natural 03:xx fire (no force-trigger, no CRON_SECRET handling per rules).**

## Central migration allocation (coordinator-owned)
| Prefix | Purpose |
|---|---|
| 20261216000000 | (only if a FIX-NOW item needs schema — e.g. A5.7 clone_job_template default null) |

## A5.1–A5.8 hardening (verify → classify → maybe fix)
| # | Verdict | Evidence / rationale |
|---|---|---|
| A5.1 CIS email idempotency | **FIX-NOW → FIXED (review SAFE-TO-DEPLOY)** | Real race: check-then-insert, no DB constraint → concurrent clicks double-queue a CIS statement email. Fix: mig 20261217 adds cis_statement_key + unique(org_id,cis_statement_key) non-partial (NULLs-distinct → non-CIS unconstrained); upsert ON CONFLICT DO NOTHING; reissue still queues; retry-in-place preserved. Real-PG 7/7. Adversarial review (a5558038 stalled on host-sleep; completed by coordinator): org_id NOT NULL (no null edge); non-partial index correct; intra-batch DO NOTHING safe (not DO UPDATE); prod queue empty → zero lock risk on index build; tenant-isolated. SAFE. |
| A5.2 portal token | **VERIFIED → DEFER (not an isolation break)** | 122-bit randomUUID, server-only, single fail-closed authority (_helpers.ts, 13 routes funnel through it), no in-JS compare (DB equality lookup → constant-time N/A), not logged, Referrer-Policy set, least-exposure projection, rotation=revocation. NOT an isolation break. **PROD HAS 600 customer rows w/ live cleartext never-expiring links** → TTL/hash would break them (no clean cutover) + are product/UX decisions; expiry mechanism already complete for a later flip. No code change; +13 real-PG contact-token tests (43/43 portal integration green). Migration 20261218 NOT used. |
| A5.3 supplier due date | **REVERTED → DEFER (collides with a deliberate tested invariant)** | Real inconsistency exists: aged-creditors dates supplier bills (billDueDate = bill_date + payment_terms_days, 30d default — PR #535/mig 20261088) but the CASH-OUT *forecast timeline* treats them as undated. HOWEVER the attempted fix imported `billDueDate` (from overdue-payables) + payment_terms_days into `lib/commercial/cash-out.ts`, which trips a DELIBERATE, TESTED double-count tripwire: `__tests__/security/supplier-payment-terms.test.ts` §"overdue payables must not be added into the cash-out position" — cash-out.ts must not learn payment terms because unpaidBills is already fully inside `outflowDueNow`; coupling the position module to overdue-payables risks double-counting the same cash. Per the wave rules ("FIX THE CODE not the test", "do not weaken existing tests", "if the accounting rule is ambiguous, DEFER rather than guess"), I did NOT weaken the guard. The genuinely-safe fix is a careful refactor — keep the position module (cash-out.ts) free of payment-terms knowledge and enrich each unpaid bill with `billDueDate` in the layer that *already* legitimately reads supplier terms (`server/services/org-cash-out.ts` / `server/services/forecasting.ts`), so the forecast timeline gets dated placement while the guard stays intact and Σ is provably unchanged. That is a financial refactor needing its own adversarial review, not warranted pre-customer for a LOW-severity, already-disclosed timing gap (the aged-creditors report already shows correct supplier due dates; only the forward *forecast* week-placement is affected, and with zero customers no one relies on it). **All A5.3 edits reverted to origin/main; guard back to 15/15.** Documented fix-path for a future dedicated wave. |
| A5.4 request-id persistence | **DEFER** | request-id generated + propagated (lib/api/request-id.ts, header/Sentry) but NOT persisted to audit (no request_id column). Low value at ZERO traffic; persisting = schema churn on now-append-only tables. Defer to when real traffic/incidents exist. |
| A5.5 v1 POST Idempotency-Key | **DEFER (hard activation prerequisite)** | CONFIRMED absent in app/api/v1; public API dark-gated (FEATURE_PUBLIC_API_JOBS→404). Zero customers + no consumer → build at activation, not speculatively. Documented as a MUST-DO before public API launch. |
| A5.6 VAT RC box7 | **DEFER** | Edge is box-7 NET only (RC accounted on tax-point; unpaid RC bill → £0 box7-net). NET-NEUTRAL for VAT DUE (box 1/3/4/5 unaffected). Financial change needs adversarial proof it doesn't move VAT due across standard/cash/FRS/RC; zero customers/no filings → DEFER (prompt: "if uncertain, DEFER"). |
| A5.7 clone_job_template default null | **FIX NOW** | live sig `p_anchor_date date` (no default); gen-types → required string; Wave A added a narrow cast. Migration 20261216 adds `default null` (body byte-identical). Type regen + cast removal done in DEPLOY step via `npm run db:types` (--linked) AFTER prod apply — `--local` regen carries env-specific event-spine partition names, so can't cleanly pre-apply. |
| A5.8 NI cat-A on-cost | **DEFER (intentionally conservative)** | job-cost-input.ts:170 omits niCategoryByUser → on-costs default to cat A (highest employer NI) → OVERSTATES cost / UNDERSTATES margin = SAFE direction (never overstates margin). Correct category IS used in payslip/CSV path. Proper fix = plumb per-user NI category into buildJobCostInput + its 5 caller sites (new reads) — non-trivial; not warranted pre-customer for a safe-direction approximation. Documented fix-path. |

## Observed pre-existing (NOT Wave A.5, not fixed here)
- `__tests__/integration/rls/site-compliance-isolation.test.ts` "visitor sign-in then sign-out" can flake locally: `site_visitors.signed_in_at` defaults to Postgres `now()` (server clock) but the test sets `signed_out_at` from JS `new Date()` (client wall-clock), checked by `signed_out_at >= signed_in_at`. On a local Docker DB whose VM clock has drifted ahead of the host, client time < server time → CHECK violation. File is byte-identical to main; neither Wave A.5 migration (20261216/20261217) touches `site_visitors`; CI shares one clock so it stays green there. Left untouched (out of wave scope; a real but microscopic test-robustness debt — proper fix: set `signed_out_at` server-side or clamp to `>= signed_in_at` in the test).

## Local gate results (post-A5.3-revert, roadmap/wave-a5-hardening)
- typecheck `tsc --noEmit`: exit 0
- lint `next lint`: exit 0 (2 pre-existing warnings in sms.ts/completion-certificate-pdf.tsx — not in my diff)
- unit (vitest.config): 10831/10831 passed
- security (vitest.security.config): 8146/8146 passed (invariant guard `supplier-payment-terms` 15/15 — A5.3 reverted so it no longer trips)
- integration A5.1 (real local PG): `cis/statement-email-idempotency` 7/7 passed
- migrations applied+verified LOCAL: `notification_email_queue.cis_statement_key` + unique index present; `clone_job_template(...,p_anchor_date date DEFAULT NULL)` present

## Security + data-integrity recheck (prod, read-only) — ALL PASS
1-2. append-only triggers live: activity_log(3) + admin_activity_log(3) [update/delete/no_truncate]. 3-5. UPDATE GDPR-scrub-only + DELETE marker/teardown-constrained + TRUNCATE blocked (Wave A integration-tested). 6. impersonation_sessions: NO anon/authenticated grant (fully locked). 7. receptionist_conversation_actions: authenticated keeps SELECT (GDPR export works). 8. no INSERT/UPDATE/DELETE/TRUNCATE for authenticated on receptionist_* (writes revoked). 9. RLS 306/306 public base tables. 10. comms email=true (pre-existing), sms/whatsapp/weather dark — NO dark provider activated. No tenant-isolation regression.

## Roadmap reconciliation — truth probes (post-Wave-A, current main)
- AI: governor TIER_MODEL ALL null (cheap/mid/high/embedding/transcription/vision) → hasAnyModel=false → NO production model bound. Every AI capability = deterministic-fallback / BUILT-DARK, not LIVE-AI.
- Phase-15 AI collaboration: still NO registerTaskHandler("saga_step") → saga steps dispatch but never execute → PARTIAL.
- Integrations: email LIVE (Resend); SMS/WhatsApp/voice/weather/telematics/accounting/HMRC/banking/SSO/SCIM/marketplace/Stripe-Connect all dark. Public API (v1, 15 endpoints) BUILT-DARK (FEATURE_PUBLIC_API_JOBS off → 404).
- MISSING: supplier price list (per-supplier cost catalogue) — still absent (price_book_items is the firm's own selling rate card, not supplier price lists).

## Supabase types recheck
(populated)

## Roadmap reconciliation
(populated)

## Deploy log
(append)
