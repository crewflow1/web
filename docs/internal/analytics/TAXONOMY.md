# CrewFlow Analytics — Taxonomy, Privacy & Founder Dashboard

> Scaffold spec for the typed event layer in `lib/analytics/events.ts`.
> Status: code scaffold + tests shipped locally; **provider NOT activated**
> (no `NEXT_PUBLIC_POSTHOG_KEY`). Activation is a founder decision. 2026-10-23.

## 1. Principle — every event answers a product question

CrewFlow is **B2B**: analytics are modelled at the **organisation** level
(pseudonymous `org_id`), not consumer vanity metrics. We track the *smallest* set
that answers real questions, not everything.

| Question | Events that answer it |
|---|---|
| Are companies reaching first value? | `organisation_created` → `first_customer_created` / `first_job_created` / `first_quote_created` / `first_invoice_created` |
| Do orgs finish onboarding? | `signup_started` → `signup_completed` → `onboarding_completed` |
| Which features drive engagement/retention? | `job_created/updated`, `quote_created/sent`, `invoice_created/sent`, `payment_recorded`, `timesheet_submitted`, `customer_portal_opened` |
| Is AI actually useful (and safe)? | `ai_insight_viewed`, `ai_draft_created/approved/rejected`, `ai_action_applied`, `ai_governor_rejected` |
| Does the human-in-the-loop gate work? | `approval_requested` → `approval_completed` |
| Does quoting convert to work and cash? | `quote_sent` → `job_created` → `invoice_sent` → `payment_recorded` |

Event names are a **closed, typed set** (`ANALYTICS_EVENTS`); no ad-hoc strings.

## 2. Privacy classification (enforced in code)

The sanitiser (`sanitizeEventProperties`) is the last line of defence; upstream
callers must still pass safe values.

**SAFE to send** (primitives only): `org_id` (pseudonymous), `plan`, `role_type`,
`stage`, `feature`, counts (`line_count`), booleans (`has_vat`), `source`,
duration **buckets**, status enums.

**PROHIBITED — dropped by key substring** (`PROHIBITED_KEY_SUBSTRINGS`): anything
containing name, email, phone, mobile, address, postcode, note, description,
content, message, subject, body, text, **amount/total/price/value/balance**
(money), token, secret, password, key, auth, ssn, dob, iban, sortcode,
account_number.

**Also dropped**: non-primitive values (objects/arrays carry whole PII rows),
empty strings, strings > 64 chars (free-text smell), non-finite numbers.

Never send: customer/contact identity, addresses, free text (notes/descriptions/
quote content/message bodies), **raw money amounts**, auth tokens/secrets. Bucket
anything sensitive upstream (e.g. `amount_band: "1k-5k"`) rather than raw values.

## 3. Consent & activation (inherited, not re-built)

- `lib/analytics/consent.ts` + `load.ts` already enforce **no analytics unless
  CONFIGURED (PostHog key present) AND consent === "granted"**, init once,
  autocapture off, session recording off, `person_profiles: identified_only`,
  EU host. The customer portal and public quote pages set **no** tracking cookies.
- `events.ts` plugs in via a sink registered only *after* that consent-gated init,
  so `trackEvent` is a silent no-op until opt-in — and `posthog-js` stays out of
  the path for non-consenting users.
- **Activation (founder, MOE APPROVAL REQUIRED):** set `NEXT_PUBLIC_POSTHOG_KEY`
  (+ optional `NEXT_PUBLIC_POSTHOG_HOST`, default `https://eu.i.posthog.com`) in
  Vercel env. No code change needed to turn it on. PostHog chosen over adding a
  second tool (Umami) — one tool, not two.

## 4. Instrumentation plan (where to call `trackEvent`, server-first)

Fire from the authoritative server action/service that performs the mutation (not
scattered client handlers), passing only safe props. Examples:
- org/onboarding flow → `signup_*`, `organisation_created`, `onboarding_completed`
- the create paths for customer/job/quote/invoice/staff → the `*_created` events,
  and the matching `first_*` the first time per org (a cheap "does an earlier row
  exist" check, or a PostHog first-time insight).
- quote send / invoice send / payment record → `quote_sent` / `invoice_sent` /
  `payment_recorded`.
- the HQ/AI draft + approval surfaces → the `ai_*` and `approval_*` events (these
  also validate the governor and the human-in-the-loop story).

Wiring the call sites is the next slice (small, per-surface, review-gated); the
typed layer + tests are in place so each call is type-checked and auto-sanitised.

## 5. Founder dashboard spec (build in PostHog once activated)

Organisation-first funnels + cohorts:
- **Activation funnel:** `organisation_created` → first customer → first job →
  first quote → first invoice (conversion + median time-to-each).
- **Time-to-value:** median time org_created → first_job / first_quote / first_invoice.
- **Weekly / monthly active orgs** (WAO/MAO): orgs with ≥1 engagement event in the window.
- **Quote→invoice conversion:** `quote_sent` → `invoice_sent` rate + lag.
- **AI adoption & trust:** draft created/approved/rejected rates; `ai_governor_rejected`
  frequency (safety signal); `ai_action_applied` per active org.
- **Feature adoption:** % of active orgs using each pillar (jobs, quotes, invoices,
  timesheets, portal, H&S).
- **Retention:** week-1 and month-1 org retention cohorts.

These tell the founder where activation leaks (→ feeds Docs/onboarding priorities)
without any individual-level surveillance.
