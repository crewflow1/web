# Analytics typed-event layer — Merge-readiness

> Branch `overnight/07-analytics`. Diff vs `origin/main`: 4 files, +422, 0 deletions.
> `lib/analytics/events.ts` (+195), `lib/analytics/load.ts` (+10),
> `__tests__/analytics/events.test.ts` (+126, 36 tests), `docs/internal/analytics/TAXONOMY.md` (+91).

## Safety checklist (all PASS)

| Requirement | Status | Evidence |
|---|---|---|
| Provider absent → no-op | ✅ | `trackEvent` returns early when no sink is registered; the sink is only registered *inside* `loadAnalyticsIfAllowed` after `posthog.init`. No key ⇒ no init ⇒ no sink ⇒ silent no-op. |
| Consent remains required | ✅ | The sink is registered inside the existing consent-gated loader, after `analyticsAllowed(consent, configured)` and `posthog.init`. The consent logic (`lib/analytics/consent.ts`) is unchanged. |
| No PII leaves the browser | ✅ | `sanitizeEventProperties` drops any key matching the PROHIBITED substrings (name/email/phone/address/postcode/note/description/content/message/body/text/amount/total/price/value/balance/token/secret/password/key/auth/ssn/dob/iban/sortcode/account_number) and all non-primitive values. 36 tests assert this. |
| No arbitrary free-text properties | ✅ | Strings > 64 chars and empty strings are dropped; objects/arrays dropped entirely. |
| Org-centric schema | ✅ | Taxonomy is organisation-first (pseudonymous `org_id`); no individual vanity metrics. |
| No double initialisation | ✅ | `load.ts`'s `started` guard is unchanged (init runs once). `setAnalyticsSink` is idempotent (last-writer); re-registration is harmless. |
| No unexpected client-bundle expansion | ✅ | `events.ts` imports **no** provider SDK (pure TS). `load.ts` still dynamic-imports `posthog-js` exactly as before (lazy, post-consent). The only new static import is the tiny pure `events.ts`. `posthog-js` is **not** pulled earlier for non-consenting users. |
| Never throws into a user flow | ✅ | `trackEvent` wraps everything in try/catch; the sink wraps `posthog.capture` in try/catch. |

## Tests
`__tests__/analytics/events.test.ts` — **36/36 pass** (typecheck clean): event-name
closed set, denylist key matching, sanitiser (strips PII/money/free-text/objects/
non-finite), `trackEvent` no-op without sink, forwards sanitised props to a sink,
swallows a throwing sink.

## What this does NOT do (by design)
- Does **not** activate PostHog — `NEXT_PUBLIC_POSTHOG_KEY` stays unset (founder decision).
- Does **not** wire any call-sites yet — the typed layer + tests are the safe first slice.
  Wiring (e.g. `trackEvent(ANALYTICS_EVENTS.ORGANISATION_CREATED, { org_id })` in the
  org/customer/job/quote/invoice create paths) is the next review-gated slice, server-first.

## Verdict
**MERGE-READY.** Safe to merge independently of provider activation — it is inert
until a key is set and consent granted. Recommended order: merge this → wire 4–5
activation call-sites (separate PR) → set the PostHog key.
