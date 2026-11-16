# LIA-01 — Legitimate Interests Assessment: consent-free Sentry error capture (PD-5)

Draft 2026-11-16 · for `[LEGAL REVIEW]` · CrewFlow role: **controller** (about the people who use the site/app).

## What is being assessed
Capturing **crash/error events** (not product analytics) from browsers, the Node server and the edge runtime and sending them to Sentry (EU region, `*.ingest.de.sentry.io`) **without waiting for the cookie banner**. Product analytics (PostHog) stays consent-gated (#1092).

Code facts (VERIFIED):
- Three init files: `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`; enabled only when a DSN is set and not in development (`lib/monitoring/readiness.ts`).
- `sendDefaultPii: false`; Session Replay off (`replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 0`); `Sentry.setUser` is never called; every event passes `beforeSend: scrubEvent` and `beforeSendTransaction: scrubEvent` (`lib/monitoring/scrub.ts`).
- On this branch the scrubber works by **key name** (authorization, cookie, secret-named keys, secret query parameters, user reduced to `{id}`). The free-text and URL-path-token masking (emails/phones in messages and breadcrumbs, `/q/<token>`, `/customer-portal/<token>`) is on `security/injection-secrets-hardening` (commits `be7140af`, `a0c26962`) — **this LIA assumes it ships**. Until then the risk assessed below is higher.
- Sentry stores IP as seen by its ingest; events carry URL, stack trace, browser/OS, release, a request id. Event retention depends on the Sentry plan `NEEDS-FOUNDER`.
- `tracesSampleRate` 0.1 in production (**performance traces are a separate matter**: treat as analytics needing consent unless founder/legal decide otherwise — PD-5, open).

## Three-part test

**1. Purpose.** Detect and fix defects, keep a security- and availability-critical service working, and meet the security duty of Art. 32 (ability to detect failures). A legitimate interest of CrewFlow and, indirectly, of its tenants. `[LEGAL REVIEW]` agree.

**2. Necessity.** Without error capture CrewFlow only learns of failures when a user complains; the 2026-11 incidents (auth redirects, file-access fix) were found through monitoring. A less intrusive alternative (server logs only) does not see browser-side crashes. Scope is already narrowed: errors only (not sessions), no replay, no user id, scrubbed. Necessity is accepted for **error events**; it is weak for 10% performance traces, which is why those are carved out above.

**3. Balancing.**

| Factor | Assessment |
|---|---|
| Nature of data | Technical (URL, stack, user-agent, IP at Sentry). Residual risk: identifiers inside URLs/messages (emails in magic-link redirects were removed by commit `924774c1`; free-text scrub pending) |
| Reasonable expectation | A user of a web application expects crash reporting; the privacy policy discloses it (policy draft §3.4, §4) |
| Impact | Low: not used to profile, no decisions, not shared beyond the processor; EU storage |
| Vulnerable people | Tenants' staff and customers (portal/quote pages carry bearer tokens — the main residual risk until the path scrub ships) |
| Safeguards | Scrub on all three runtimes; no replay; no user identification; DPA with Sentry `NEEDS-FOUNDER` (confirm DPA signed and retention set) |
| Opt-out | Objection route: privacy contact; practical opt-out is not offered per-user (events are anonymous). `[LEGAL REVIEW]` decide whether a banner category "essential error reporting" is wording-sufficient |

**Outcome (draft):** legitimate interests is a defensible basis **for scrubbed error events** provided (a) the free-text/path scrub is deployed, (b) a Sentry DPA and a short retention (e.g. 30-90 days) are confirmed `[FOUNDER]`, (c) the policy says plainly what is sent. PECR reg. 6 (storage/access to terminal equipment): the Sentry SDK sets no cookie for errors but may use storage; "strictly necessary" exemption is arguable for security/stability error reporting, **not** for performance tracing — `[LEGAL REVIEW]`.

**Review:** when the scrub changes, when replay or performance tracing is proposed, or yearly. Sign-off `[LEGAL REVIEW]` ______ `[FOUNDER]` ______.
