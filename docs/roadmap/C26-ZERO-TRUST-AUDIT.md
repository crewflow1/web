# CrewFlow — C26 Zero-Trust Launch Audit

**Date:** 2026-08-03 · **Audited commit:** `f22ade6c` (= `origin/main` = deployed) · **Migration tip:** `20261108` · **Method:** 12 independent read-only domain auditors + direct re-verification of the strongest claims. Nothing trusted from STATUS.md, prior checkpoints, memory, or prior reports.

## Verdict: ❌ NOT 100% engineering-complete.

The prior conclusion — *"Category 1 (Engineering-now) = EMPTY … every gated feature's activation is a configuration change"* — is **FALSE**. Multiple real engineering gaps were found and independently confirmed. The security/tenancy/DB spine is genuinely excellent; the gaps are in **activation-completeness of the dark integrations** and a handful of real defects.

## Rule Zero (verified directly)
main = deployed = `f22ade6c` (no lag) · tip `20261108` · **268 migration files == 268 applied** (exact, both directions) · no duplicate prefixes · 0 open PRs · all provider flags default `false` · current-tip CI: 6/6 green (but see CI-integrity finding).

---

## 🔴 NOT COMPLETE (real engineering required)

### R1 — The 5 dark OAuth integrations are NOT "config-flip" ready (systemic)
Independently confirmed by two auditors + direct code reads.
- **No token-refresh path exists anywhere** — `grep` for a `refresh_token` grant across `lib/integrations/**` + `server/services/**` is empty. Every substrate does `authorization_code` only. Each integration would work for one token lifetime (Xero 30 min, Google 1 hr, HMRC 4 hr) then break. Writing refresh is real per-provider engineering.
- **Accounting push is a stub with a LIVE caller** — `lib/integrations/accounting/adapters/xero.ts` returns *"Xero push is configured but not yet activated in this build"*; `quickbooks.ts` same. `app/(app)/reports/accounting/actions.ts:87-88` calls `pushInvoices`/`pushPayments`, so on activation a user's "push to Xero" click errors. (CSV export is genuinely complete.) Env mismatch: connect reads `QBO_*`, push reads `QUICKBOOKS_*`.
- **Calendar push is a stub + uncalled** — `server/services/calendar-connections.ts:281-296` live path returns *"Calendar push adapter is not yet implemented (activation-gated)"*; no `calendar_event_links` write; `pushJobToCalendar` has **zero callers**. Calendar sync is non-functional even when switched on.
- **Banking sync is empty + uncalled** — `lib/integrations/banking/adapters/truelayer.ts` maps `normalizeTrueLayerTransactions([])` (always zero transactions); `syncBankTransactions` has no caller.
- **Telematics sync uncalled** — Samsara adapter is complete, but `syncTelematicsReadings` has no caller (no cron/route/button).
- **Connect dead-ends** — calendar (both providers) and Xero/TrueLayer hardcode the account handle to `null` with an unimplemented "resolve at activation" follow-up → connect can never persist a `connected` row.
- Several provider creds (`XERO_*`, `GOOGLE_CALENDAR_*`, `MS_GRAPH_*`, banking/telematics) bypass `env.ts` validation (raw `process.env`).
- HMRC is compose-only (no submit) — this one is *honestly* labelled and additionally legal-gated (see L1).

**Correct classification:** these are dark, safe scaffolds — NOT activation-ready features. Prior docs mislabelled them 🟡; they are 🔴 for activation-completeness.

### R2 — `/stock` horizontal overflow on mobile (shipped defect)
`app/(app)/stock/page.tsx:84` — a `flex gap-2` button row (Replenishment / Van stock / All items / + Add) with **no `flex-wrap`**; min-content 362px vs 343px mobile content width at 375px. Static overflow (constant labels), font-timing-amplified (3px→11px). A real e2e failure at the reorder-merge commit that was masked by a later flaky-green run. **Fix:** `flex gap-2` → `flex flex-wrap gap-2` (measured: 0px overflow after).

---

## 🟠 REAL DEFECTS (conditional / not launch-blocking, must fix)

- **HQ honesty crack (fabricated green from unreadable data):** `server/services/hq-support-snapshot.ts` `countOpenSupportTicketsForHq()` returns `0` on a DB read error (swallowed zero) → `lib/hq/ceo.ts` `supportHealth(0)` → "Healthy / All clear". Test-codified (`__tests__/admin/hq-ceo.test.ts:91,230`). The exact forbidden pattern. Fix: return `null` on error → render `insufficient`.
- **Automation `send_email_queue` trigger unwired:** its only rule triggers on `payment.recorded`, which no code dispatches (`allocate-actions.ts:166` writes the audit log, not `dispatchAutomation`). Action reachable only via a manually-created schedule.
- **Outbound webhooks over-advertise:** `EXPOSABLE_WEBHOOK_EVENTS` lists 8 verbs; the spine producer emits only 6 — `job.scheduled` and `job.cancelled` have **no producer** (migration comment admits it). A subscriber to those gets silence.
- **Orphaned feature `NEXT_PUBLIC_FEATURE_VOICE_NOTES`:** flag + `voice_notes` table exist, **zero wiring** — a dead gate.
- **Corporation-tax marginal relief understates:** `lib/tax/compute.ts:191-203` linearly interpolates the *rate* 19→25% instead of HMRC's marginal-relief formula — ~£3k under at £150k profit. Disclosed as "estimate" but on an HMRC-facing figure.
- **Duplicate VAT calculator:** `app/api/tax/quarterly-pdf/route.ts:85-99` re-implements the VAT sum instead of calling `computeVatQuarter` (drift risk); `computeVatQuarter` also lacks an upper date bound (future-dated `paid_at` leaks into the current quarter).
- **CI can mask mobile-layout regressions:** `e2e/stock.spec.ts:225` measures `scrollWidth` before fonts/stream settle (unlike the repo's own `_settle.ts` used elsewhere). Fix: apply `settleForAxe`/`fonts.ready` before overflow measurement.

---

## 🟡 ACTIVATION / PRODUCT DECISION / SCOPE (no engineering to *build*, but not "done")
- **Public API** — complete + safe (hashed keys, org-scoped, DTO allowlists exclude PII/cost/tokens, GET-only); activation = flip `FEATURE_PUBLIC_API_JOBS`. Caveat: rate-limiter fails-open (fine for a read plane; must go fail-closed before any write API).
- **Voice telephony substrate** — complete + safe (signature-before-parse, org-from-dialed-number, composite-FK, idempotency); would not 500 on a real call. Activation = provider creds + bound inference tier. Live STT/TTS/turn-loop audio is an acknowledged multi-session future build.
- **Offline** — 5 verticals complete + correct end-to-end; scope gaps (no Background Sync — flushes only while app open; no offline photo capture; most entities read-only offline) are honestly disclosed. Background Sync is a product-scope decision.
- **Self-serve gaps** — team member add/remove, billing/plan change, quote duplication are "email us / lands next" (disclosed, with workarounds). Real product-completeness gaps for a SaaS.
- **Comms (SMS/WhatsApp/email)** — genuinely config-flip (real send paths). The one integration class that IS activation-only.
- **types.ts hygiene** — generated types lag the schema, bridged by ~905 `as unknown as` casts (deliberate, consistent) → new RPC/table write paths aren't compile-time checked. Recommend a regenerate pass.

---

## ✅ VERIFIED COMPLETE (survived adversarial audit)
- **DB / migrations** — 268==268, every object from the last 15 migrations present in prod (no phantom no-ops), 0 tables with `org_id` but no RLS (0 RLS-off tables at all), all 5 OAuth token columns proven `authenticated`-unreadable, destructive ops safe. (1 thing to *own*: 96 RLS-on/zero-policy service-role-only tables.)
- **Multi-tenant / #456 / RLS** — 642 admin-client sites checked; no unpinned tenant query, no body-trusted org, no exploitable PK-only read. Prior "closed" holds. (2 non-exploitable defence-in-depth nits.)
- **AI-governance spine** — governor truly dark (`TIER_MODEL` all-null), fail-closed (no key flip can uncap spend), no unwired-but-registered key, no bare-credential bypass, all narratives dark, workflow-saga/apply-on-approval/cadence/shadow provably default-OFF with **no dark-time tenant mutation**.
- **Automation engine core** — cron `*/n` fix present, concurrent-drain CAS claim, dispatcher idempotency, `update_status` a genuine no-op, `create_invoice_draft` correctly wired.
- **Webhook guards** — SSRF/DNS-rebind (re-resolve + pin), HMAC (timestamped), retry/backoff/breaker, per-verb redaction.
- **Customer portal + CRM** — unguessable tokens, single-authority resolution, token stripped from GDPR export, every feature has real read/write, no dead links; pay-now honestly unbuilt (decision).
- **Financial engines** — CIS deduction/statements/export, payroll (incl. employer NI/pension, dated tables), the VAT 9-box composer, invoice/payment/retention/cash-out allocation — all correct.
- **Public API safety, Voice substrate safety** (as above).

---

## Bottom line
Do not certify the launch roadmap as engineering-complete. The security, tenancy, DB, governance, and financial-logic foundations are genuinely strong and survived a hostile audit. But **activating any of the five OAuth integrations requires real engineering** (token refresh + the actual push/sync/submit bodies + connect handle-resolution), there is a **shipped mobile-overflow defect**, and there are several honesty/wiring/tax-accuracy defects. The remediation backlog is enumerated above; until R1 + R2 are closed, "activation = config flip" is not true for accounting, calendar, banking, or telematics.
