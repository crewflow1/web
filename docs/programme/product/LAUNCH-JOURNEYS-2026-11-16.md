# Core product & staff journeys — launch verification (2026-11-16)

Branch `product/launch-journeys` (off main `d24295e`). Everything below was run locally: production build
(`next start`), real local Postgres + Auth + Storage, Chromium. No email, SMS or provider call was made.

## Defects found and fixed

| # | Sev | Defect | Fix | Proof |
|---|-----|--------|-----|-------|
| 1 | P1 | **Quote email bypassed the approval gate.** `POST /api/quotes/[id]/send` emailed the PDF + portal link and set status `sent` for a quote in ANY status. The page only shows the button for approved/sent/viewed, and "Mark as sent" requires approval, but the route did not check. A `sent` quote can be accepted online (job + invoice), so a draft, unapproved or rejected price could reach the customer and be accepted — the same class #1100 closed for the public accept link. Needs a direct request (the UI hides it). | `sendQuoteEmail` refuses statuses outside `EMAILABLE_STATUSES` (approved, sent, viewed) before anything is rendered, sent or minted; route answers 409. | `__tests__/quotes/send-quote-approval-gate.test.ts` (9 cases; 6 fail on the old code). Not browser-provable locally: without a mail key the route stops earlier (503). |
| 2 | P2 | **Quote/invoice VAT and line totals off by 1p on half-pennies.** `computeTotals` used `Math.round(n*100)/100`, so a half-penny went up or down depending on binary representation: £2.90 @ 5% VAT = £0.145 → £0.14 (but £0.10 @ 5% → £0.01); 0.15 × £4.30 = £0.645 → £0.64. The database's own `round(x,2)` (billing-plan stages, cost log) rounds these up. Invoices copy the quote's figures, so the error reached invoices. | Snap the scaled value to 6 dp before rounding (half away from zero). | `__tests__/quotes/totals.test.ts` (10 cases incl. exhaustive sweeps; 4 fail on the old code) + browser: the lead→quote spec shows and stores £202.90 / £40.15 / £243.05. |
| 3 | P3 | **Loading skeleton scrolled sideways on phones.** `SkeletonHeader` (fixed 288 px bar) beside a 112 px action in `SkeletonDetail` made every detail page's loading state ~42 px wider than a 390 px screen (7 detail routes; list skeletons share the header). | `min-w-0` + `max-w-full` on the header bars. | `launch-staff-phone.spec.ts` "while a job streams in…" (holds the page payload so the skeleton is measured). |
| 4 | test infra | **E2E tier aborted at global setup** once the shared local Auth held > 1,000 users ("could not create or find seed user"): every lookup read only page 1 of `listUsers`. | `findAuthUserId` in `e2e/_actors.ts` pages through all users; used by global setup, core-journey, first-customer-sim and the new specs. | the tier runs again (1,136 local users). |

## Journeys verified in the browser (new specs)
- `e2e/launch-owner-journeys.spec.ts` — customer create with only a name → edit (confirms < 3 s, persists across reload) → list search by postcode and by phone, negative search; lead → "Create a quote" pre-fills customer + lead → mixed-rate lines → saved, linked, lead `quoted`; request approval → distinct approver approves → "Mark as sent"; "Email quote PDF" without a mail provider shows a message and changes nothing; job diary entry from the job, team document upload, photo upload. No hydration errors.
- `e2e/launch-staff-phone.spec.ts` (390 px, staff) — every staff navigation destination + area landings + D-17 field pages + every job tab on an assigned job: renders, not bounced, no 404, no sideways scroll, no hydration error; assigned-jobs list shows own job only and a colleague's job is 404; loading skeleton fits; clock in on the job → clock out (both confirm, persist); team document + private drop-off stored, private list hidden.
- `e2e/launch-onboarding-phone.spec.ts` (390 px) — sign up → company form → leave → sign in again returns to the form; bad postcode refused visibly, nothing created; good one creates one company (owner, terms stamped, `pending`) → access pending; coming back while pending lands on access pending, still one company; after activation the set-up wizard works and a skipped step stays skipped after reload.
- Existing specs re-run on this build: dashboard-money-reconciliation, staff-rams-signoff, staff-job-view, staff-field-operations, core-journey, and the photo spec from #1104 (run uncommitted; it stays in #1104).

## Gates (final build)
typecheck clean · unit 12,082/12,082 (745 files) · security 8,744/8,744 (349 files) · full Playwright `--workers=1`:
335 passed, 12 skipped (HQ-allowlist specs), 2 failed — both shared-local-data noise, not this branch:
`insights-mobile` (known) and `cash-owner` (its /cash queues show 8 rows; the shared harness org now holds 21 overdue
invoices from earlier runs, many with the same 2020-01-01 due date, so the new fixture can fall past row 8).

## Findings not fixed (P3, recorded)
- Blank optional customer fields (phone, notes, address lines, postcode, city, county, country) are stored as `""`, not NULL: `z.string()…optional().or(z.literal("").transform(…))` never reaches its blank branch because `""` is a valid string. All display paths treat `""` as empty, and no query found depends on NULL, so there is no visible effect today. The same idiom appears in 18 files; fix as a class (preprocess blank → undefined) when convenient.
- The company form (`/onboarding/company`) clears what was typed when the server refuses it (observed at 390 px: a non-UK postcode clears all five fields and the tick), and a failed create shows the raw code `create_failed`.
- A staff member opening a colleague's job URL gets the not-found page (no details leak) but HTTP 200, not 404: the job route streams behind its loading boundary, so `notFound()` arrives after the headers.
- Job-document uploads/deletes write no activity-log row: the service calls `_record_activity` with the user's client and that function's EXECUTE grant was revoked (`42501` in the server log on every upload; already noted in `server/services/blueprints.ts`). The upload itself succeeds.
- Locally the "Email quote PDF" error names `RESEND_API_KEY` / Vercel to the user — only reachable when mail is unconfigured.

## Founder decisions (not built)
Staff "report work completion"; timesheet "submit" step; customer duplicate handling (warn vs block); quote discounts. Unchanged from the tracker.

## Verifying one real sign-up confirmation in production (safely, no customer data)
Email confirmation is OFF in the local stack, so it cannot be proven here. Suggested founder check (≈10 min):
1. Supabase dashboard → Authentication → Sign In / Providers → Email: note whether "Confirm email" is ON (read-only look). Authentication → URL Configuration: Site URL `https://crewflow.uk`, and `https://crewflow.uk/auth/callback` in the redirect allow-list. Authentication → SMTP: Resend sender on the verified domain.
2. In a private window on `https://crewflow.uk/login` → "Create account" with an address you own (e.g. a `+confirm-test` alias of your own mailbox).
   - If confirmation is ON you should see "Account created. Check your email…"; the email should come from your domain, and its link should go via Supabase to `https://crewflow.uk/auth/callback` and land on `/onboarding/company`.
   - If it lands straight on `/onboarding/company` with no email, confirmation is OFF — decide whether that is acceptable (sign-ups land `pending` anyway, so access still needs HQ approval).
3. STOP on the company form — do not create a company (company deletion is disabled, and it would notify HQ).
4. Optional: from the same window, "Forgot password" for that address → the reset email arrives → set a new password → it signs in.
5. Delete the test user in Supabase → Authentication → Users (no company or membership exists, so nothing else to clean up).
