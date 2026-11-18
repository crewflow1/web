# Consent evidence — what the network proof shows

Two independent captures, both by intercepting real browser traffic and reading the real cookie jar / storage:

1. **Production, as deployed** (`main` `8cec66a`) — read-only, no interaction. Raw: `prod-capture-2026-11-13.json`.
2. **This branch, locally, with trackers armed** — the permanent Playwright spec. Raw: `armed-run-evidence.jsonl` (one line per phase, printed by the spec itself).

## 1. Production today (before this branch)

Method: fresh headless Chromium context per page, `https://crewflow.uk` `/`, `/features`, `/pricing`, `/login`, `/privacy`; wait for network idle + 6 s; **no click, no form, nothing accepted**. Every request host, every `Set-Cookie`, the cookie jar, localStorage, sessionStorage, IndexedDB, CacheStorage and service-worker registrations were recorded.

| Page | Requests | Hosts contacted | Cookies | Storage keys | Banner |
|---|---|---|---|---|---|
| `/` | 42 | `crewflow.uk` ×41, **`o<org>.ingest.de.sentry.io` ×1** | none | none | shown — `Reject` / `Accept` |
| `/features` | 36 | `crewflow.uk` ×35, **Sentry ×1** | none | none | shown |
| `/pricing` | 33 | `crewflow.uk` ×32, **Sentry ×1** | none | none | shown |
| `/login` | 28 | `crewflow.uk` ×27, **Sentry ×1** | none | none | shown |
| `/privacy` | 28 | `crewflow.uk` ×27, **Sentry ×1** | none | none | shown |

The one third-party request on each page is `POST /api/<project>/envelope/`. Its body was read on a second load of `/` and `/login`: a single envelope item of type **`session`** with fields `sid`, `init`, `started`, `timestamp`, `status`, `errors`, `attrs.{release, environment, user_agent}`. It is Sentry's release-health ping, not an error report.

**Plain statement:** production today sends **one non-essential request before consent on every page load** — the Sentry session ping. It sets no cookie and writes no storage. Production does **not** load PostHog, set any cookie, or write any storage before consent. No other third party is contacted. (VERIFIED, five pages. Authenticated app pages and token portals were not loaded on production; the same root layout and the same Sentry config serve them, so the same ping is expected there — that part is inference, not observation.)

What production also lacks (VERIFIED by reading `main`): no way to change or withdraw the choice; Reject styled weaker than Accept; binary record with no version or timestamp; banner + analytics able to mount on `/worker-portal/<token>` and `/l/<slug>`.

## 2. This branch — armed network proof

### How the test is made meaningful

Trackers only load when their env IDs are set, so a consent test against an un-configured build proves nothing. `playwright.consent.config.ts` boots its own dev server with **dummy** IDs (`e2e/_consent-harness.ts`):

| Env | Value | Why |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_KEY` / `_HOST` | dummy key, `https://posthog.e2e.invalid` | a missing analytics gate fires a real request at this host |
| `NEXT_PUBLIC_SENTRY_DSN` | `…@sentry.e2e.invalid/1` | same for Sentry |
| `NEXT_PUBLIC_VERCEL_ENV` | `preview` | the browser SDK is silent in `development` |
| `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` | `e2e-consent-armed` | Sentry discards sessions with no release — production always has one |

`.invalid` is a reserved TLD that cannot resolve, and every non-first-party request is intercepted and answered locally (`route.fulfill`, never `continue`), so **nothing leaves the machine**. Sentry requests are classified by reading the envelope item types from the request body: `event`-only = error report (allowed); anything else = performance (consent-required). Any other host = `unknown-third-party` = failure.

The **positive control** is the Accept test: with the same dummy IDs, requests to both tracker hosts *do* appear once consent is given — proving the trackers are live and the harness sees them. Without that, the silences below would be meaningless.

### Result

`heavy.sh npx playwright test --config playwright.consent.config.ts` (config boots its own server, port 3101) → **16 passed, 1 skipped, 0 failed** (2.3 min). The skip is the unarmed-only test.

### Before / after, from the run log

| Phase | Third-party requests | Cookies | localStorage | sessionStorage | IndexedDB |
|---|---|---|---|---|---|
| Before interaction — `/` | **none** | none | none | none | none |
| Before interaction — `/features/construction-crm` | **none** | none | none | none | none |
| Before interaction — `/login` | **none** | none | none | none | none |
| Before interaction — `/dashboard` (signed in) | **none** | `sb-…-auth-token` | `crewflow-offline-identity` | none | `crewflow-offline-{photos,reads,writes}` |
| After **Reject all** | none | `cf_cookie_consent` | none | none | none |
| …then reload + navigate | none | `cf_cookie_consent` | none | none | none |
| After **Accept all** (same page) | PostHog ×2 | `cf_cookie_consent`, `ph_…_posthog` | `__ph_opt_in_out_…`, `ph_…_posthog` | `ph_…_posthog` | none |
| …then reload | PostHog ×2, **Sentry `[session]` ×1** | same | same | same | none |
| After **withdrawal** via Cookie settings, then in-page activity, navigation and reload | **none** | `cf_cookie_consent` | none | none | none |
| **Customise: analytics only**, after reload | PostHog ×2, Sentry **none** | `cf_cookie_consent`, `ph_…_posthog` | PostHog keys | PostHog keys | none |
| **Customise: performance only**, after reload | Sentry `[session]` ×1, PostHog **none** | `cf_cookie_consent` | none | none | none |

Read against the five things the brief asked to prove:

1. **Before any interaction** — marketing home, a deep marketing page, login and an in-app page make zero consent-required requests; an anonymous visitor has nothing at all on the device; the signed-in app has only registered, exempt keys. ✔ VERIFIED
2. **Reject** — still nothing sent; the only thing stored is the record of the rejection; the banner does not return after reload or navigation. ✔ VERIFIED
3. **Accept** — tracker requests and tracker storage appear only after the click. ✔ VERIFIED
4. **Withdraw** through the Cookie settings entry point — tracker cookies and storage are removed from the device immediately (no reload), and nothing consent-required is sent afterwards across in-page activity, a navigation and a hard reload. ✔ VERIFIED
5. **Customise** — each category runs if and only if its own switch is on, in both mixed combinations. ✔ VERIFIED

Also asserted by the same spec:

| Property | How it is checked |
|---|---|
| Reject as prominent as Accept | computed background, colour, font size/weight, border, height and vertical position of the two buttons are **identical** |
| Default-denied | every switch in the dialog is `aria-checked="false"` on first open |
| Banner causes no layout shift and does not block content | `position: fixed`; document height and the `<h1>` position are identical with and without the banner; a header link under test still receives the click; body stays scrollable; banner < 50 % of viewport — at 1280×800 and 375×812 |
| Dialog accessibility | `role="dialog"`, `aria-modal`, named by its heading; focus moves in; Tab / Shift+Tab cannot leave (15 presses); switches toggle with Space and Enter; axe (WCAG 2.0–2.2 A/AA) reports **0 violations** on the dialog and on the banner |
| Closing is not a choice | Escape closes with **no** cookie written, the banner returns, focus returns to "Customise" |
| Returning visitor | a stored record is honoured with no banner |
| Legacy cookie | `denied` → no banner, nothing sent; `granted` → analytics only, performance stays off, banner re-asks (a category was added) |
| External surfaces | with a full-consent cookie, `/q/…`, `/customer-portal/…`, `/worker-portal/…`, `/l/…` show no banner, send nothing consent-required, store no tracker key — then the same cookie on `/` *does* start both trackers (control) |
| Signed-in app | Accept in the app starts analytics; Reject all from the app's footer link clears and stops it |

### Limits of this proof — stated plainly

- The PostHog traffic observed after consent is the SDK's **config fetch and `/flags/` call** (2 requests per load; the latter carries the visitor's distinct id). I did not separately confirm that `$pageview` event batches were posted in the harness, so "tracking starts" is proven at the level of *the SDK initialising, identifying the visitor to the vendor host and persisting its id*, not at the level of individual events. "Tracking stops" is proven by **zero** requests to the host afterwards, including on a fresh load where the SDK is not initialised at all.
- The armed run uses `next dev`, not a production build (`NEXT_PUBLIC_*` is inlined at build time; arming a build means a second full build sharing `.next`). The consent code path is the same. The **unarmed** half of the spec runs against the production build in the normal E2E tier — that run was **not executed in this session** (IMPLEMENTED-UNTESTED for the unarmed branch: 5 baseline tests + 1 unarmed-only test).
- Service workers are blocked in the spec so that every request is page-initiated and interceptable; the SW's own behaviour is covered by the existing PWA specs, not re-proven here.
- Chromium only.
- The fix is on a local branch. **Production still behaves as in §1 until this is reviewed, merged and deployed.**

## 3. Unit-level evidence

`npx vitest run __tests__/privacy/consent.test.ts __tests__/analytics __tests__/monitoring` — see the final report for the exact count. What each file pins:

| File | Guarantee |
|---|---|
| `__tests__/privacy/consent.test.ts` | record round-trip; parsing fails closed on 12 malformed shapes; legacy mapping; per-category `categoryAllowed`; `needsDecision`; external-surface list incl. worker portal + enquiry form and no prefix over-reach (`/login`, `/leads`); withdrawal key matcher never matches a first-party key |
| `__tests__/analytics/load.test.ts` | PostHog initialises opted-out and only then opts in; refuses without key / consent / on external surfaces; `before_send` drops external-surface events; every optional PostHog product pinned off + no remote script loading; `stopAnalytics` opts out, clears the opt flag, purges only `ph_*` keys on every candidate cookie domain; re-grant resumes without a second init |
| `__tests__/monitoring/consent-transport.test.ts` | allow-list: 12 non-error item types dropped without consent, errors always pass, unknown types dropped, fail-closed if the consent check throws |
| `__tests__/monitoring/sentry-client-consent-wiring.test.ts` | the real `sentry.client.config.ts` routes envelopes through the gate and the real consent cookie: no cookie / reject / analytics-only / legacy `granted` → session dropped; performance → sent; never on the four external surfaces |

## 4. Reproduce

```sh
source /Users/moetalibi/Code/cf-wt/_shared/local-env.sh        # local Supabase env
heavy.sh npx playwright test --config playwright.consent.config.ts   # armed matrix (boots its own dev server on 3101)
npx vitest run __tests__/privacy/consent.test.ts __tests__/analytics __tests__/monitoring
```

Do not run the armed config in the same job as the production-build E2E tier: both write `.next`.
