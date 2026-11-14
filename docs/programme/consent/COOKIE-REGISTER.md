# Cookie & device-storage register

Every cookie, `localStorage`, `sessionStorage`, IndexedDB and CacheStorage key the CrewFlow web app can put on a device, with purpose, lifetime, category and the justification for that category. Written for the privacy-policy workstream to reference directly.

Source of truth in code: the consent categories live in `lib/analytics/consent.ts`; the exempt allow-list this register describes is enforced by `e2e/_consent-harness.ts` (`EXEMPT_COOKIES`, `EXEMPT_LOCAL_STORAGE`, `EXEMPT_INDEXED_DB`) — the network spec **fails** on any key that is not in that list, so this register cannot silently go stale. Machine-readable copy: `cookie-register.json`.

Categories:
- **Strictly necessary** — exempt from consent under PECR reg. 6(4)(b): needed to provide a service the user explicitly asked for. No toggle.
- **Functional (exempt, user-initiated)** — written only as the direct result of a user action in the signed-in product, never transmitted, no identifier. Treated as exempt; flagged honestly as a judgement call (§4).
- **Analytics** — consent required. Off by default.
- **Performance** — consent required. Off by default. Uses no device storage (network-only), listed for completeness.

How each row was established: **[R]** observed at runtime in the armed run / prod capture; **[C]** from code (path given), not exercised in a browser by this workstream.

## 1. Cookies

| Name | Set by | Purpose | Lifetime | Flags | Surfaces | Category | Justification |
|---|---|---|---|---|---|---|---|
| `sb-<project-ref>-auth-token` (may be chunked `.0`, `.1`) | Supabase Auth via `@supabase/ssr` (`lib/supabase/server.ts`, `middleware.ts`) | The signed-in session (access + refresh token). | 400 days rolling (library default), cleared on sign-out. | `SameSite=Lax`, `Path=/`, not HttpOnly (library default) | Auth pages after sign-in, app, HQ | Strictly necessary | Authentication for a service the user asked to sign in to. Without it no page behind login can be served. **[R]** |
| `sb-<project-ref>-auth-token-code-verifier` | Supabase Auth | PKCE verifier for magic-link / OAuth sign-in. | Minutes; removed when the sign-in completes. | as above | Auth pages during sign-in | Strictly necessary | Security of the sign-in the user started. **[C]** `@supabase/ssr` |
| `active_org_id` | `app/(app)/org-actions.ts` | Which workspace a multi-workspace user is working in. | 1 year. | `HttpOnly`, `Secure`, `SameSite=Lax` | App | Strictly necessary | Set only when the user explicitly switches workspace; needed to show the right tenant's data. **[C]** |
| `cf_impersonation_session` | `app/admin/impersonation/actions.ts` | An HQ support-access session (CrewFlow staff only, audited). | 24 hours max. | `HttpOnly`, `Secure`, `SameSite=Lax` | HQ staff only | Strictly necessary | Security + audit of an access the staff member deliberately started. Never set for customers. **[C]** |
| `cf_cookie_consent` | `lib/analytics/consent-client.ts` | The record of the visitor's cookie choice: notice version, time of choice, per-category yes/no. Format `v2.t<unix-seconds>.analytics<0\|1>.performance<0\|1>`. | 1 year. Written only when the visitor makes a choice. | `SameSite=Lax`, `Path=/`, `Secure` on https | Marketing, auth, app | Strictly necessary | Remembering the answer is necessary to honour it (and to not ask on every page). Contains no identifier. **[R]** |
| `acct_oauth_state_<p>`, `acct_oauth_verifier_<p>`; `cal_…`; `telem_…`; `bank_…`; `hmrc_oauth_state_<f>`, `hmrc_oauth_verifier_<f>`, `hmrc_oauth_vrn_<f>` | `app/api/integrations/*/connect/route.ts` | CSRF state + PKCE verifier (and, for HMRC, the VAT number being connected) for an integration the user clicks "Connect" on. | 10 minutes; cleared on callback. | `HttpOnly`, `Secure`, `SameSite=Lax` | App (integrations) — **all of these integrations are dark today** | Strictly necessary | Security of a flow the user starts. Cannot fire without a deliberate click. **[C]** |
| `cf_oidc_state_<org>`, `cf_oidc_nonce_<org>`, `cf_oidc_verifier_<org>` | `app/api/sso/oidc/[orgId]/start/route.ts` | CSRF state, nonce and PKCE verifier for enterprise SSO sign-in. | 10 minutes; cleared on callback. | `HttpOnly`, `Secure`, `SameSite=Lax`, path-scoped to the SSO route | Auth (SSO customers only) | Strictly necessary | Security of the sign-in the user started. **[C]** |
| `ph_<key>_posthog` | PostHog (`posthog-js`), only after analytics consent | Random visitor id (`distinct_id`), session id and SDK state for product analytics. | 365 days (SDK default). **Deleted immediately when consent is withdrawn.** | `SameSite=Lax`, `Secure` on https; set on the registrable domain (`.crewflow.uk`) | Marketing, auth, app — never the external surfaces in §6 | **Analytics** | Usage statistics the service works without → consent. **[R]** appears only after Accept / the analytics switch; removed on withdrawal. |

## 2. localStorage / sessionStorage

| Key | Store | Set by | Purpose | Lifetime | Surfaces | Category | Justification |
|---|---|---|---|---|---|---|---|
| `crewflow-offline-identity` | local | `lib/blueprints/offline-store.ts` (`OfflineIdentityMarker`) | Which user + workspace the offline data on this device belongs to, so one person's cached data is never shown to the next on a shared tablet. | Until sign-out (purged) | App | Strictly necessary | A security control for the offline feature. Holds user id + org id, never transmitted. **[R]** |
| `cf-nav-expanded` | local | `app/(app)/_components/sidebar.tsx` | Which sidebar groups the user expanded. | Until cleared | App | Functional (exempt, user-initiated) | Written only when the user clicks a nav group. No identifier, never transmitted. See §4. **[C]** |
| `cf-hq-nav-expanded` | local | `app/admin/_components/hq-sidebar.tsx` | Same, HQ console. | Until cleared | HQ staff only | Functional (exempt, user-initiated) | As above. **[C]** |
| `cf-cmd-recents` | local | `app/(app)/_components/search-palette.tsx` | The last six destinations chosen in the command palette (label + URL). | Until cleared — **not cleared on sign-out (finding C-6)** | App | Functional (exempt, user-initiated) | Written only when the user picks a result. **Contains record titles (can be personal data: customer / staff names).** Exempt from consent, but the shared-device leak in C-6 should be fixed. **[C]** |
| `ph_<key>_posthog`, `__ph_opt_in_out_<key>` | local | PostHog, only after analytics consent | SDK state mirror; the SDK's own opt-in flag. | Persistent; **deleted on withdrawal** | as cookie | **Analytics** | Consent. **[R]** |
| `ph_<key>_posthog`, `ph_<key>_window_id`, `ph_<key>_primary_window_exists`, `ph_<key>_session_registered_properties` | session | PostHog, only after analytics consent | Per-tab session bookkeeping. | Tab lifetime; **deleted on withdrawal** | as cookie | **Analytics** | Consent. **[R]** |

An anonymous visitor who has not interacted has **nothing** in either store (**[R]**: prod capture and armed run, all pages).

## 3. IndexedDB, CacheStorage, service worker, third-party cookies

| Name | Kind | Set by | Purpose | Lifetime | Surfaces | Category | Justification |
|---|---|---|---|---|---|---|---|
| `crewflow-offline-reads` | IndexedDB | `lib/offline/read-cache.ts` | Copy of jobs / customers / invoice headers so the app renders with no signal on site. Partitioned by user + org, 8 MB cap. | Until sign-out (purged) | App | Strictly necessary | Offline working is a core function of a site-crew product the user signed in to use. **[R]** |
| `crewflow-offline-writes` | IndexedDB | `lib/offline/write-queue.ts` | Diary entries etc. written with no signal, waiting to sync. | Until synced or sign-out (user is warned) | App | Strictly necessary | The user's own unsent work. **[R]** |
| `crewflow-offline-photos` | IndexedDB | `lib/offline/photo-queue.ts` | Photos/files captured offline, waiting to upload. | Until uploaded or sign-out | App | Strictly necessary | As above. **[R]** |
| `crewflow-blueprints-offline` | IndexedDB | `lib/blueprints/offline-store.ts` | Drawings the user chose to "make available offline". | Until removed or sign-out | App (job blueprints) | Strictly necessary | Explicitly requested by the user, per drawing. **[C]** |
| `crewflow-pwa-static-v1`, `crewflow-pwa-shell-v1` | CacheStorage | `public/sw.js` | Hashed static assets and the public `/offline` page. Never `/api`, never authenticated HTML. | Until the next worker version | App | Strictly necessary | Technical delivery cache for the offline shell; same-origin public assets only. **[C]** — the network spec blocks service workers so every request is interceptable; covered by the existing `pwa-*` specs and `__tests__/security/pwa-worker.test.ts`. |
| Service worker `/sw.js` (scope `/`) | SW registration | `app/(app)/_components/sw-register.tsx` | Offline shell + (dark) web push display. | Until unregistered | Registered from the app only | Strictly necessary | As above. Push is dark: no subscription exists unless the user turns it on in settings (`_push-toggle.client.tsx`), which is itself an explicit request. **[C]** |
| `__cf_bm` | Third-party cookie on `.supabase.co` | Cloudflare (in front of Supabase Storage) | Bot management for the file host. | 30 minutes | Anywhere the browser loads a signed file URL (logos, photos, documents) — app **and customer portal** | Strictly necessary (security), set by a sub-processor | Protects the storage service the user is fetching a file from. CrewFlow does not read it. VERIFIED present: `Set-Cookie: __cf_bm` on a response from the production Supabase storage host. Browsers that block third-party cookies drop it. **Policy note:** the "portal sets no tracking cookies" promise stays true (this is not tracking), but the policy should say a security cookie may be set by the file host. |

## 4. The honest edge cases

- **`cf-nav-expanded`, `cf-hq-nav-expanded`, `cf-cmd-recents`** are not "strictly necessary" in the narrowest sense — the app works without them. They are classed exempt on the *user-initiated UI state* basis (Article 29 WP Opinion 04/2012 §3.6; ICO: storage is exempt where it delivers something the user explicitly asked the interface to do): each is written only as the direct result of a click in the signed-in product, holds no identifier, and never leaves the device. If counsel takes the stricter view, the fallback is to keep that state in memory only (a few lines each) — not to add a consent toggle for it. **NEEDS-FOUNDER (legal) only if the stricter view is wanted.**
- **`sb-…-auth-token` lifetime (400 days)** is the library default, not a decision. Lifetime is a UK GDPR storage-limitation point for the policy, not a consent point.
- **Next.js dev-server keys** (`__next_hmr_refresh_hash__` etc.) exist only under `next dev` and are not part of the product; the harness filters them with an explicit prefix list (`DEV_TOOLING_KEYS`) before asserting.

## 5. For the privacy-policy workstream

1. **Replace** the sentence in `app/privacy/page.tsx` § Cookies — "You can change your mind later by clearing the consent cookie" — with: the visitor can review, change or withdraw their choice at any time using **Cookie settings** in the footer of every page (and at the bottom of every page in the app). Withdrawing stops the category immediately and deletes its cookies from the device.
2. The banner now offers **Reject all / Accept all / Customise**, with two optional categories: **Product analytics** (PostHog, EU; cookie with a random visitor id; no session recording, no surveys, no advertising) and **Performance monitoring** (Sentry; session-health and page-speed measurements; no cookies).
3. State that **error reports** (Sentry, Germany) are sent when a fault occurs, without consent, as strictly necessary; list Sentry and PostHog as sub-processors.
4. The policy's promise that the customer portal and public quote pages set no analytics cookies now also covers the **worker sign-off portal** and the **public enquiry form** (§6).
5. The list of essential cookies in the policy is incomplete: add the consent record, the short-lived sign-in / connect security cookies, and the offline storage in §3.
6. Bump `CONSENT_VERSION` (`lib/analytics/consent.ts`) whenever a category is added or its meaning changes; visitors who previously accepted are then asked again.

## 6. Surfaces where nothing optional ever runs

`/q/…` (public quote), `/customer-portal/…`, `/worker-portal/…`, `/l/…` (public enquiry form). No banner, no PostHog, no Sentry performance telemetry — even for a browser that accepted everything elsewhere on the site (`isFirstPartySurface`, enforced in the banner, the PostHog loader, PostHog `before_send`, and the Sentry transport). VERIFIED by the armed spec. Sentry error reports still apply.
