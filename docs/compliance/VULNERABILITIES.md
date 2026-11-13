# Dependency vulnerabilities: `npm audit` (2026-11-13)

Baseline `origin/main` @ `8cec66a7`, lockfile `package-lock.json` (1,126 entries). Nothing was upgraded; this is a read-only assessment. Raw output: `npm-audit-prod.json` (`npm audit --omit=dev --json`), `npm-audit-full.json` (`npm audit --json`). Per-installed-copy re-evaluation: `audit-instances-prod.json`, `audit-instances-full.json` (script `scripts/compliance/audit-summary.mjs`). Advisory data is npm's live database as of today, so counts will drift.

## 1. Headline numbers (npm's own count: one row per vulnerable *package name*)

| | critical | high | moderate | low | total |
|---|---|---|---|---|---|
| `npm audit --omit=dev` (production graph) | 2 | 14 | 34 | 5 | **55** |
| `npm audit` (incl. dev) | 5 | 16 | 41 | 5 | **67** |

**VERIFIED** (commands run in the worktree, exit output captured to the JSON files).

**Do not read "2 critical" at face value.** `npm audit` flags a package *name* if any advisory range overlaps any installed copy, and it marks everything reachable from `dependencies` as "production" whether or not the code is ever executed in production. Re-evaluating each advisory against each installed copy (script above) gives 39 vulnerable installed copies in the production graph (47 incl. dev), and shows:

* **The Next.js runtime CrewFlow actually runs (`next@15.5.28`) has no applicable advisory.** Every Next advisory in the report has an upper bound <= 15.5.27 for the 15.x line. The 38 "critical Next" advisories apply to a **nested `next@15.1.2` installed under `react-email@3.0.7`** (and `next@16.2.3` under `@react-email/preview-server`, dev). **VERIFIED** (`audit-instances-prod.json`: `next@15.1.2`, chain `react-email@3.0.7 > next@15.1.2`; no entry for `next@15.5.28`).
* `react-email` and `@react-email/components` are in `dependencies` but **no source file imports them** (grep of `app lib components server emails scripts`), and the `email` script points at a non-existent `emails/` directory. They are an unused CLI/preview toolchain sitting in the production graph. Whether the nested `next@15.1.2` is ever present in the *deployed function bundle* is **IMPLEMENTED-UNTESTED** (Vercel traces only imported files, so probably not; but scanners and `npm ci` see it).

## 2. Findings

IDs: V-n. Severity here is *CrewFlow-contextual* (exposure of the actual code path), with npm's severity in brackets.

| ID | Sev | Package (installed) | Advisories (npm sev) | Reaches production runtime? | Fix available | Evidence |
|---|---|---|---|---|---|---|
| V-01 | **P2** | `@xmldom/xmldom` 0.9.11 (direct) and 0.8.14 (via `xml-crypto@6.1.2`) | 11 + 8 advisories (high): XML-injection past `requireWellFormed`, parser acceptance of malformed end tags, quadratic time/memory, ReDoS | **Yes**: `lib/enterprise-sso/saml.ts:3` uses `DOMParser` to parse IdP-supplied SAML XML (lines 120, 171). SSO is a live capability (memory: L1 LIVE). The input is attacker-influenceable (a malicious or compromised IdP/tenant admin posting a SAML response) so the DoS class is reachable; the injection class matters only if CrewFlow re-serialises XML (to check). | **Yes, non-major** (`fix: true`) | `audit-instances-prod.json`; `saml.ts` |
| V-02 | **P2** | `react-email` 3.0.7 (+ `@react-email/components` 0.0.31) -> nested `next@15.1.2` (38 advisories incl. RCE-class, critical), `esbuild@0.23.0`, `glob@10.3.4`, `socket.io`/`engine.io@6.6.9`, `@babel/core@7.24.5`, `prismjs@1.29.0`, `minimatch`, `brace-expansion`, `postcss@8.4.31` | critical/high | **No code imports them** (VERIFIED by grep). They are dead weight in the production graph and the single source of both "critical" rows other than DOMPurify. | **Removal**, not upgrade. Simulated (scratch copy, not applied): `npm uninstall --package-lock-only react-email @react-email/components @react-email/preview-server` reduces prod from 55 to **48** (critical 2 -> 1, high 14 -> 11). | `npm ls`/audit chain; simulation (SIMULATED-ONLY) |
| V-03 | **P2** | `dompurify` 3.4.14 (via `posthog-js@1.422.5`, browser bundle) | 5 advisories (critical): DOM XSS when `IN_PLACE`/hooks used, `SAFE_FOR_TEMPLATES` bypass, SMIL `href` guard skipped under `application/xhtml+xml` | **Client bundle, conditionally.** PostHog uses DOMPurify to sanitise survey HTML. `lib/analytics/load.ts` sets `autocapture: false` and `disable_session_recording: true` but does **not** disable surveys; whether surveys can load depends on the PostHog project's remote config. CrewFlow code never calls DOMPurify directly (grep). The vulnerable options (IN_PLACE, custom hooks, SAFE_FOR_TEMPLATES, XHTML parser) are not ones PostHog's survey path is known to use: **not verified**. | **Yes, non-major** (`fix: true`) | `audit-instances-prod.json`; `lib/analytics/load.ts:56-57` |
| V-04 | P2 | `zod` 3.25.76 (direct, 165 files) | 1 (high): memory exhaustion validating oversized constrained collections (`<4.6.6`) | **Yes**, request-body validation. Mitigated by the platform body-size limit (4.5 MB on Vercel functions) and by schema limits where set. Remedy is a semver-major (zod 4), which also flags `openai@4.104.0` (high **only via zod**, no advisory of its own). | Major bump (`zod@4.6.7`). **Separate decision**; alternative is capping array/collection sizes in the hot schemas. | audit |
| V-05 | P3 | `@sentry/nextjs` 8.55.2 -> `@sentry/node`, 19 `@opentelemetry/*` instrumentations (db username in span attribute; unbounded W3C baggage), `rollup@3.29.5` (path-traversal file write, **build-time**), `uuid@9.0.1`, `glob@9.3.5`/`minimatch@8`/`brace-expansion@2.1.4` (build-time, via `@sentry/webpack-plugin`) | high/moderate | Mostly **build-time** (webpack plugin, rollup) or inert instrumentations (mysql/mongoose/tedious not used; CrewFlow talks to Supabase over HTTP). OTel baggage DoS and db.user attribute exposure are runtime in the Sentry Node SDK but low practical impact. | Only via `@sentry/nextjs@11.12.0` (**semver-major**, v8 -> v11). Separate decision, bundle with a planned Sentry upgrade. | audit-instances |
| V-06 | P3 | `postcss` 8.4.31 **vendored inside `next@15.5.28`** (4 advisories, high): stringify XSS, sourceMappingURL file read/path traversal | **Build-time only**: processes CSS CrewFlow authors, not attacker-supplied CSS, and not at request time. | Only by a Next major (npm suggests `next@16.4.6`, a wrong remedy for this). Track Next 15.5.x patch releases. | audit |
| V-07 | P3 | `follow-redirects` 1.16.0 (via `posthog-node` -> `axios`) | 3 (high): credential-header stripping bypass on cross-origin redirect | Server-side; `posthog-node` calls a fixed PostHog host, no user-supplied URLs. | **Yes, non-major** | audit |
| V-08 | P3 | `qs` 6.15.3 (via `stripe`) | 3 (moderate): DoS in parse/stringify edge cases | Server-side; Stripe SDK stringifies CrewFlow-built params. | **Yes, non-major** | audit |
| V-09 | P3 | `browserslist` 4.28.2, `source-map-js` 1.2.1, `postcss-selector-parser` 6.1.2, `brace-expansion`, `minimatch` (assorted), `baseline-browser-mapping`, `fflate` (0.4.8 via posthog-js: unzip-only advisory, PostHog only compresses), `fast-uri` 3.1.6 (not reachable from root in the lock graph; likely an `ajv` peer chain) | high/moderate | **Build/dev-time tooling** (autoprefixer, tailwind, eslint chain); none parse untrusted input in production. | Mostly **yes, non-major** | audit-instances |
| V-10 | P3 (dev) | `vitest`/`vite`/`tinypool` 2.1.9 / 5.4.21 / 1.1.1 (critical/high dev-server and worker advisories), `esbuild@0.21.5` (dev-server CSRF) | critical (dev) | **Dev/test only.** Not shipped; risk is a developer visiting a hostile page while `vitest --ui`/`vite` dev server is running. | `vitest@5.1.0` (semver-major) | `npm-audit-full.json` |

## 3. Shape of the problem (from the simulations in section 4)

* Steps A + B below (remove the unused react-email tree, refresh the lockfile in range) take the production count from 55 to 37 and remove both criticals. **VERIFIED as a simulation** (scratch copy; SIMULATED-ONLY for the repo).
* Of the 37 that remain, 25 are the Sentry/OpenTelemetry chain (19 `@opentelemetry/*`, `@prisma/instrumentation`, 5 `@sentry/*`) whose only fix is `@sentry/nextjs` v11 (major); 4 are low-severity `resend`/`@react-email/render` -> `html-to-text` -> `deepmerge` (fix: `resend` major); 8 are `next` (vendored postcss), `postcss`, `rollup`, `uuid`, `glob`, `minimatch`, `openai` (via zod) and `zod`: all major-gated.

## 4. Recommended upgrades (listed, not done)

Ordered by value / risk. Simulations ran in a scratch copy of `package.json` + `package-lock.json` (`npm uninstall --package-lock-only`, `npm update --package-lock-only`), **not applied to the repo** (SIMULATED-ONLY):

| Step | Change | Risk | Simulated effect on `npm audit --omit=dev` |
|---|---|---|---|
| A | Remove `react-email`, `@react-email/components`, `@react-email/preview-server` and the dead `email` script (V-02) | Low: no imports. (Confirm `resend` is called with HTML/text strings, not React elements: `@react-email/render` stays as `resend`'s own dependency regardless.) | 55 -> 48 total; critical 2 -> 1; high 14 -> 11 |
| B | In-range lockfile refresh: `npm update --package-lock-only` limited to the packages in V-01, V-03, V-07, V-08, V-09 (dompurify, `@xmldom/xmldom`, `xml-crypto`, follow-redirects, qs, brace-expansion, minimatch, browserslist, source-map-js, fast-uri, fflate, postcss-selector-parser) | Low-medium: run the full tier suite; **SAML tests are the important ones** (`xmldom` behaviour changes touch signature verification) | alone: 55 -> 43; critical 2 -> 1 (the leftover critical is Next@15.1.2, removed by A) |
| A + B | both | as above | **55 -> 37; critical 0; high 5** (`@sentry/nextjs`, `openai`, `postcss`, `rollup`, `zod`, all major-gated) |
| C | Sentry v8 -> v11 (`@sentry/nextjs`) | Medium-high: changes instrumentation config; do alongside observability review | clears most of the 37 |
| D | zod 3 -> 4 | High: 165 files; mechanical but wide | clears V-04 and `openai` flag |
| E | Next 15.5.x -> latest 15.5 patch as released; Next 16 is a **separate major decision** | n/a | clears V-06 only with a Next that vendors postcss >= 8.5.23 |
| F | `vitest` 2 -> 5 (dev) | Medium | clears V-10 |

## 5. Acceptance test for any future fix

`npm audit --omit=dev --json` -> compare `metadata.vulnerabilities`; `node scripts/compliance/audit-summary.mjs npm-audit-prod.json` must show no `scope=prod` instance of `next`, `dompurify`, `@xmldom/xmldom`; SAML integration tests, `__tests__/security/*` and the full unit tier must be green (run through `heavy.sh`).

## 6. Caveats

* The audit database is online-only; findings are as of 2026-11-13. `npm audit` needs the registry (read-only); no code or secrets are sent, only package names/versions from the lockfile.
* "Reaches production runtime" statements are based on static reading (imports, config) and the lockfile graph, not on a deployed-bundle inspection. **IMPLEMENTED-UNTESTED** where stated.
* The partial worktree `node_modules` does not matter here: `npm audit` evaluates the lockfile.
