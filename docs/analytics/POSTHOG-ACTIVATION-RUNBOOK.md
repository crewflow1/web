# PostHog activation runbook

**Status: DARK (optional).** Analytics is wired end-to-end but captures nothing until a founder sets the keys. This runbook is the exact activation path and the privacy posture it assumes.

## What is wired (code-complete)
- **Client** (`lib/analytics/load.ts`): the ONLY `posthog.init`. Runs in the browser only; refuses unless a key is configured AND the consent cookie is `granted`; idempotent; never throws. `autocapture:false`, `disable_session_recording:true`, `person_profiles:"identified_only"`, EU host default.
- **Consent** (`lib/analytics/consent.ts` + `app/_components/cookie-consent.tsx`): GDPR/PECR banner; `analyticsAllowed()` requires key + `cf_cookie_consent=granted`.
- **Server sink** (`lib/analytics/server.ts`, registered from `instrumentation.ts`): dark unless `ANALYTICS_SERVER_ENABLED` is truthy AND `POSTHOG_SERVER_KEY` is present; `posthog-node` lazy-imported; failure-isolated; key never logged.
- **Taxonomy** (`lib/analytics/events.ts`): typed events; `sanitizeEventProperties` drops non-primitives, >64-char strings, and a PII/money/free-text denylist.

## Privacy posture (enforced in code)
- **Distinct id is de-identified** — a stable one-way hash of the org (`org_<hash>`), never the raw org UUID (`lib/analytics/identity.ts`). Funnels/retention still join per-org.
- **Pageview URLs are UUID-masked** — `sanitize_properties` replaces resource UUIDs in `$current_url`/`$pathname`/`$referrer` with `:id` (`lib/analytics/sanitize-url.ts`), so `/jobs/<uuid>` is never shipped.
- No autocapture, no session replay, no PII event properties, EU ingestion.
- **`CUSTOMER_PORTAL_OPENED` is defined but NEVER emitted** — do not wire it without a separate privacy decision (it would attribute a portal visit to a specific customer link).

## To activate (founder env — all in Vercel prod)
1. **Client:** set `NEXT_PUBLIC_POSTHOG_KEY` (and optionally `NEXT_PUBLIC_POSTHOG_HOST`, default `https://eu.i.posthog.com`).
2. **Server (optional, separate opt-in):** set `POSTHOG_SERVER_KEY` **and** `ANALYTICS_SERVER_ENABLED=true` (+ optional `POSTHOG_SERVER_HOST`).
3. Confirm the cookie-consent banner is live and the legal/privacy-policy copy reflects analytics cookies (see Consent decision below).

Nothing captures until (1) at minimum, AND a visitor grants consent.

## Consent / legal decision (BLOCKED on founder/legal)
PostHog with a key + cookie counts as a non-essential cookie under UK PECR, so the consent gate must precede capture — which it does. Confirm with legal whether the current banner copy + privacy policy adequately describe PostHog before go-live. A cookieless/no-persistence configuration is a possible alternative posture but is not implemented; do not claim it.

## Verify after activation
- Browser: grant consent → a `$pageview` appears in PostHog with a `:id`-masked URL; decline → nothing sent.
- Server: with the flag on, a server-action event appears with an `org_<hash>` distinct id (never a raw UUID).
- Disabled/no-key/failure paths stay silent (covered by `__tests__/analytics/{load,server,identity,sanitize-url}.test.ts`).

## Blockers (cannot be done in code)
- `NEXT_PUBLIC_POSTHOG_KEY` / `POSTHOG_SERVER_KEY` + `ANALYTICS_SERVER_ENABLED` (founder env).
- Final consent/legal posture sign-off.
- Activation authorisation (providers are dark by default — CLAUDE.md).
