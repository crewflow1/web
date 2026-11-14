# CrewFlow — privacy compliance gaps and remediation plan (2026-11-13)

Prioritised list of what stands between the product as built and an honest, defensible data-protection position. Written by an engineer; items marked ⚖ need a qualified UK data-protection adviser and nothing here is legal advice.

**Severity** (per `AGENT-RULES.md` §5): **P0** critical security/data loss · **P1** must fix before paying customers · **P2** launch with a documented limitation · **P3** post-launch.
**Evidence label** per finding: VERIFIED / IMPLEMENTED-UNTESTED / NEEDS-FOUNDER / NOT-IMPLEMENTED.
Founder facts (F-n) are in `FOUNDER-FACTS-NEEDED.md`.

No P0 was found: nothing in this audit showed personal data exposed across tenants or to the public.

## Summary

| ID | Sev | Gap | State | Owner |
|---|---|---|---|---|
| G-1 | **P1** | Live privacy policy and terms make statements the code contradicts | Draft ready; blocked on founder facts | Founder + ⚖ |
| G-2 | **P1** | Application code runs in the USA; undisclosed transfer | Config decision | Founder |
| G-3 | **P1** | No tenant DPA and no published sub-processor list | NOT-IMPLEMENTED | Founder + ⚖ |
| G-4 | **P1** | Controller identity, ICO registration, lawful bases not established | NEEDS-FOUNDER | Founder + ⚖ |
| G-5 | **P1** | No deletion at end of contract; no per-person access/erasure tooling; promises unmet | Mechanism exists, switched off | Engineering + founder |
| G-6 | P2 | Plaintext production dumps kept on the backup operator's machine | NEEDS-FOUNDER | Founder / ops |
| G-7 | P2 | Ex-staff sensitive data survives removal indefinitely | NOT-IMPLEMENTED | Engineering (after F-11) |
| G-8 | P2 | Sentry received bearer tokens and identifiers in free text | **Fixed on branch**, not deployed | Lead (merge) |
| G-9 | P2 | Consent banner/analytics can load on the external-worker page; no "change my choice" control | For the consent workstream | Sibling workstream |
| G-10 | P3 | Email address placed in a redirect URL on failed sign-in | Proposed | Engineering |
| G-11 | P2 | Rate-limit table held raw IPs, emails and portal tokens, never expired | **Fixed on branch**, not deployed | Lead (merge) |
| G-12 | P2 | Prospecting/outreach: no Art. 14 notice, PECR position unrecorded | NEEDS-FOUNDER | Founder + ⚖ |
| G-13 | P2 | AI processing undisclosed to tenants; no per-tenant off switch; provider terms unconfirmed | Partly NEEDS-FOUNDER | Founder + engineering |
| G-14 | P2 | Activity log copies customer contact details, is append-only and never purged | Purge exists, unscheduled | Engineering |
| G-15 | P2 | Data-import staging keeps the raw imported rows and files forever | NOT-IMPLEMENTED | Engineering |
| G-16 | P3 | Raw provider webhook payloads and email-event rows never purged | NOT-IMPLEMENTED | Engineering |
| G-17 | P2 | WhatsApp is switched on and credentialed in production, contrary to the records | NEEDS-FOUNDER | Founder |
| G-18 | P3 | Password sign-in overwrites the user's name and phone with nothing (accuracy) | Static evidence; proposed fix | Engineering |
| G-19 | P3 | Customer-portal tokens stored in plaintext; no default expiry; quote links not revocable | For the security workstream | Sibling workstream |
| G-20 | P3 | Supabase Auth audit table is empty in production | NEEDS-FOUNDER | Founder |
| G-21 | P2 | DPIA needed before activating call recording, AI voice, vehicle tracking, WhatsApp | Not started | Founder + ⚖ |
| G-22 | P3 | No Art. 30 record, breach procedure or DSAR procedure as documents | This package is the raw material | Founder + ⚖ |
| G-23 | P3 | Unused personal-data columns and an orphan table remain | Staged SQL awaiting approval | Founder |

---

## P1 — before paying customers

### G-1 · Live policy and terms contain untrue statements — VERIFIED
- **Evidence:** `PRIVACY-POLICY-DRAFT.md` Part A — 37 statements checked: 5 inaccurate, 8 over-claims, 11 incomplete, 7 missing. The worst: "we do not currently run product-analytics tracking" (PostHog is configured; `/api/health`), "we delete the business data within 30 days" (no such mechanism; `gdpr_erasure_log` = 0), "hosted in the European Union" (functions run in the USA), no mention of AI providers (580 logged calls). `app/terms/page.tsx` repeats the 30-day promise.
- **Impact:** a transparency failure (UK GDPR Arts. 5(1)(a), 13) and potentially a misleading commercial statement; it also undermines every tenant's own notice.
- **Reproduce:** read the two pages against Part A.
- **Fix (proposed):** fill the placeholders (F-1…F-15), have the draft reviewed ⚖, transcribe Part E into `app/privacy/page.tsx`, align the terms' "Your data" paragraph, bump `CURRENT_TOS_VERSION` if the terms change. Two corrections need no new facts and can ship first: the analytics sentence and removing the unkept deletion periods.
- **Acceptance:** every factual sentence on the page maps to a line in the provider register or retention schedule; a reviewer re-runs Part A and finds no INACCURATE/OVER-CLAIM row.

### G-2 · Server code executes in the United States — VERIFIED
- **Evidence:** `curl -sI https://crewflow.uk/login` → `x-vercel-id: lhr1::iad1::…` (also `/q/[token]`, `/api/v1/openapi.json`). `vercel.json` has no `regions`; three webhook routes pin `lhr1`. Database: `aws-0-eu-west-1`.
- **Impact:** every request that renders or accepts personal data is processed in the USA — a restricted transfer that is neither disclosed nor (as far as I can see) covered by a recorded safeguard; plus a transatlantic hop on every database query.
- **Fix (proposed, founder decision F-8):** set the function region to `dub1` (same city as the database — best latency) or `lhr1` (UK) in Vercel project settings, or add `"regions": ["dub1"]` to `vercel.json`. No code change. I did not change `vercel.json`: it alters production routing and is a known merge-conflict point.
- **Acceptance:** `x-vercel-id` on `/login` shows `…::dub1::…` or `…::lhr1::…`; p50 server response time recorded before/after.
- **If the region stays in the USA:** the policy must say so and name the safeguard ⚖.

### G-3 · No tenant DPA, no sub-processor list — NOT-IMPLEMENTED
- **Evidence:** no DPA document or route in the repository (`app/dpa`, `app/subprocessors`, `app/legal` do not exist); `app/terms/page.tsx` has no Art. 28 clauses (subject matter, instructions, confidentiality, security, sub-processors, assistance, deletion/return, audit).
- **Impact:** for everything a tenant enters, CrewFlow is a processor. Art. 28(3) requires a written contract; without one both CrewFlow and the tenant are exposed. Production already holds 602 customer records (F-25: whose?).
- **Fix (proposed):** a DPA ⚖ incorporated into the terms; a public sub-processor page built from `PROVIDER-REGISTER.md` §5 (Supabase, Vercel, Resend, Anthropic, Sentry, Backblaze, Vercel KV; OpenAI/Meta/PostHog as conditional); a change-notification route (email to owners — the queue exists).
- **Acceptance:** DPA accepted alongside ToS at onboarding (`organizations.tos_*` already records acceptance and version); sub-processor page matches the register; a test fails if a provider SDK is added to `package.json` without a register entry (proposed guard).

### G-4 · Controller identity, ICO registration, lawful bases — NEEDS-FOUNDER
- F-1…F-6. Nothing can be published or contracted until these exist. Registration with the ICO and the fee are a founder action.

### G-5 · Deletion and data-subject tooling do not match the promises — VERIFIED
- **Evidence:** `FEATURE_GDPR_ERASURE` defaults off → `POST /api/gdpr/erase` returns 503; no scheduled teardown; `removeStaff` deletes only the membership; `deleteCustomer` is refused once a customer has history; no per-person export. `gdpr_export_log` = 0 and `gdpr_erasure_log` = 0 in production.
- **Impact:** the "30 days" promise is unkept; a tenant cannot honour an erasure or access request about one person without CrewFlow doing manual database work; CrewFlow cannot assist tenants as Art. 28(3)(e) requires at any scale.
- **Fix (proposed, in order):**
  1. Decide the end-of-contract period (F-11) and drive the existing erasure primitive from a scheduled job N days after cancellation, with a pre-deletion export offered to the owner. Account deletion itself is the sibling workstream.
  2. A per-person "find everything about this customer/staff member" export for the tenant admin (the search index and `customer_id`/`user_id` links in `data-register.csv` are the map).
  3. A per-person anonymise action for a customer with financial history (keep the invoice, scrub the identity — the same PII-column rule the org erasure uses).
- **Acceptance:** integration test: cancel → N days → erasure log row, storage empty, statutory rows anonymised; a customer with invoices can be anonymised and the invoice totals are unchanged.

## P2 — launch with a documented limitation

### G-6 · Plaintext production dumps on the operator's machine — VERIFIED by documentation
- **Evidence:** `docs/ops/off-platform-backup-automation.md` → "newest backups kept locally (plaintext dated dirs + encrypted artifacts)"; `scripts/ops/off-platform-backup.sh` stages dumps (schema, data, **auth data**, all storage objects) before encrypting.
- **Impact:** up to 8 complete, unencrypted copies of production — including password hashes and every uploaded file — on a laptop. Loss or compromise of that machine is a reportable breach of everything.
- **Fix (proposed):** delete the plaintext staging directory once the encrypted artifact has passed its decrypt self-test (the script already performs that test); keep only ciphertext locally. Confirm FileVault and key escrow (F-18). Not changed here: the script is production DR tooling owned by ops and was just stabilised (PR #1085).
- **Acceptance:** after a run, `find <backup dir> -name '*.sql'` returns nothing; restore drill from ciphertext still passes.

### G-7 · Ex-staff sensitive data — VERIFIED
- **Evidence:** foreign keys — `staff_secrets`, `payroll_tax_profiles`, `staff_compensation`, `pension_enrolments`, `time_entries` reference `users(id)`, not the membership; only `staff_qualifications` cascades from `memberships`. `removeStaff` (`app/(app)/staff/actions.ts`) deletes the membership row only.
- **Impact:** NI number, date of birth, pay rate and a third party's emergency-contact details remain with no end date after the person leaves, and — with the membership gone — no screen through which the tenant could find or remove them.
- **Fix (proposed, needs F-11):** on removal, delete the emergency contact immediately; schedule NI/DOB/tax profile for deletion after the tenant's chosen payroll-records period; show ex-staff in an "archived" list until then.
- **Acceptance:** integration test: remove staff → `staff_compensation.emergency_contact` is null; after the window the secrets row is gone; payroll lines remain.

### G-8 · Sentry scrubbing — fixed on branch — VERIFIED (fix), not deployed
- **Evidence:** synthetic event through `scrubEvent` before the change kept `/customer-portal/<token>/…`, an email in `exception.values[].value` and an email + phone in a console breadcrumb. Commit `932c189a`; tests `__tests__/monitoring/scrub-free-text.test.ts` (6) + existing `scrub.test.ts` (9) pass.
- **Residual:** names and addresses in free text are not pattern-detectable; the policy should say reports "may incidentally include" such text.

### G-9 · Consent surfaces — for the cookie-consent workstream — VERIFIED
- **Evidence:** `isFirstPartySurface()` in `lib/analytics/consent.ts` excludes only `/q` and `/customer-portal`. `/worker-portal/<token>` (external worker sign-off) therefore shows the banner and, on Accept, sends a page view whose URL contains the bearer token unless it happens to be UUID-shaped (only UUIDs are masked; the worker-token format was not verified). There is no in-product control to withdraw consent; the live policy says "clear the cookie".
- **Fix (proposed):** add `/worker-portal` (and any future bearer route) to the exclusion; mask by route pattern, not by UUID shape; add a "Cookie settings" link in the footer.

### G-11 · Rate-limit identifiers — fixed on branch — VERIFIED (fix), not deployed
- **Evidence:** `consume("portal_write", token, …)`, `consume("auth", email, …)`, `consume("quote_action", ip, …)` → `rate_limit_counters.key = "<route>:<identifier>"`; `rate_limit_sweep()` had no caller; production held 11 rows, oldest window 115 days. Commit `253aece3`: keyed digest + daily sweep; `__tests__/security/rate-limit.test.ts` 18 pass.

### G-12 · Prospecting and outreach ⚖ — NEEDS-FOUNDER
- **Evidence:** the product has a sales CRM (`hq_sales_*`), an approval-gated outreach sender with a suppression list (`hq_communications`, `hq_comms_suppressions`) and a Companies House sourcing pipeline; all hold 0 prospect rows in production. Outreach also happens outside the product.
- **Impact:** named contacts at prospects are data subjects for whom CrewFlow is controller. Art. 14 requires telling them where their details came from within a month; PECR restricts unsolicited email to sole traders and partnerships; a suppression list must be honoured across every channel used.
- **Fix (proposed):** record the sources and basis (F-7); one suppression list for all outreach; an Art. 14 line and opt-out in every first email; a retention period for non-responders (F-11).

### G-13 · AI transparency and control — VERIFIED (code) / NEEDS-FOUNDER (terms)
- **Evidence:** `lib/ai/governor/registry.ts` — receipts, imported files and uploaded documents go to Anthropic vision; lead and enquiry text to Anthropic; no per-organisation switch to turn AI off was found under `app/(app)/settings` or `lib/ai/governor`; the live policy does not mention AI. The quote writer is the only feature with an enforced disclosure contract (`lib/ai/quote-context.ts`).
- **Fix (proposed):** disclose (draft §5); confirm no-training/retention terms (F-10); add an org-level "AI features" toggle honoured by the governor; extend the disclosure-contract idiom to lead summary; consider a DPIA for document autofill (CVs, vehicle logbooks).
- **Acceptance:** with the toggle off, every governed feature returns its deterministic fallback and no provider call is made (the governor already has that path for "not activated").

### G-14 · Activity log — VERIFIED
- **Evidence:** `_tg_customers_activity` writes `{name, email, phone}` into `activity_log.metadata` on insert and `{name}` on delete; the table is append-only (migration `20261214000000`); `purge_activity_log` exists (`20260710000000`) but `pg_cron` is absent in production and no code calls it.
- **Impact:** deleting a customer leaves their contact details in the feed indefinitely.
- **Fix (proposed):** stop copying email/phone into trigger metadata (a new forward migration replacing the trigger function — the id and name are enough for the feed); schedule the purge through an existing daily cron.

### G-15 · Import staging — VERIFIED
- **Evidence:** 1,803 `import_rows` (the raw row verbatim), 598 `import_audit`, 7 files in the `imports` bucket in production; no purge code (`grep` of `lib/imports`, `server/services`).
- **Fix (proposed):** purge rows and source files N days after commit or rollback, mirroring `purgeExpiredFormImports`.

### G-17 · WhatsApp armed — VERIFIED
- **Evidence:** `/api/health` `comms.whatsapp=true` ⇒ token + phone-number id + `NEXT_PUBLIC_FEATURE_WHATSAPP=true` (`lib/comms/readiness.ts`); 1 route row, 1 webhook event. The activation register (2026-11-10) and programme baseline say dark.
- **Impact:** a customer-facing channel to a US provider can send today; the documents everyone relies on say it cannot.
- **Fix:** founder confirms intent (F-19); if not intended, turn the flag off; correct the register either way.

### G-21 · DPIAs before activation ⚖
Call recording and transcription (`calls.recording_url`, `ai_receptionist_setups.recording_enabled`), AI voice turns, vehicle telematics (`telematics_readings.latitude/longitude` — in effect, tracking drivers), WhatsApp. Each is systematic monitoring or a new technology applied to individuals; assess before the switch is flipped, not after.

## P3 — post-launch

### G-10 · Email address in a URL — VERIFIED
`bounceToLogin()` (`app/auth/callback/route.ts`) appends `?email=<address>` on bootstrap failure → hosting logs, browser history, referrer. **Fix:** drop the hint or carry it in a short-lived cookie.

### G-16 · Raw webhook payloads and `comm_events` — VERIFIED
`billing_events.payload`, `whatsapp_webhook_events.payload`, `email_webhook_events.payload`, `call_events.payload`, `comm_events.payload` have no age rule. **Fix:** null the payload once processed + N days; keep the envelope.

### G-18 · Password sign-in clears name and phone — static evidence
- **Evidence:** `ensureUserRow` upserts `full_name: input.fullName ?? null, phone: input.phone ?? null`; `signInWithPassword`/`signUpWithPassword` call it with only `{id, email}` (`app/(auth)/actions.ts`), so each password sign-in writes NULL over both. Production aggregate is consistent: 2 of 3 email-identity users have a NULL `full_name`. Not reproduced end-to-end — IMPLEMENTED-UNTESTED as a finding.
- **Impact:** inaccurate personal data (Art. 5(1)(d)); staff names disappear from rotas, payslips, audit entries.
- **Fix (proposed):** include `full_name`/`phone` in the upsert only when a value is supplied. **Acceptance:** integration test — set a name, password sign-in, name unchanged. Outside this workstream's remit; raised for the lead.

### G-19 · Bearer tokens (security workstream)
`customers.portal_token` / `customer_contacts.portal_token` are stored in plaintext (worker tokens are hashed); expiry is optional and null by default; no revoke control for a quote link was found.

### G-20 · Auth audit trail
`auth.audit_log_entries` = 0 rows in production. Confirm where Supabase Auth events are retained and for how long (F-17).

### G-22 · Governance documents ⚖
An Art. 30 record (this package supplies the content), a breach-response procedure (F-21), a DSAR procedure, a short DPIA template.

### G-23 · Legacy columns and orphan table — staged
`time_entries.gps_lat/gps_lng`, `users.avatar_url`, `demo_requests.user_agent`, table `waitlist`. Writes already stopped on this branch; drops are in `staged-migrations/` awaiting approval (F-24).

---

## Suggested order of work

1. Founder: F-1…F-5 and ICO registration; decide G-2 (region) — a settings change that removes the largest undisclosed transfer.
2. Lead: merge this branch (G-8, G-11 fixes; GPS and avatar minimisation).
3. Founder + ⚖: DPA, lawful bases, AI terms, transfers → publish the policy (G-1, G-3, G-4).
4. Engineering: end-of-contract erasure job and ex-staff clean-up (G-5, G-7) once F-11 is decided; import-staging purge (G-15); activity-log trigger + purge (G-14).
5. Before any dormant channel is activated: G-21.
