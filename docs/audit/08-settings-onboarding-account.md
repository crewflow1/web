# 08 — Settings · Onboarding · Account/Auth · Help/Support · Imports · Marketplace

Audit domain companion to `docs/audit/CONVENTIONS.md` (status legend + role model live there). Worktree `/Users/moetalibi/Code/web-main`. Roles: **owner, admin, staff** only; `ADMIN_ROLES = owner + admin`. Browser verification was NOT performed (authenticated multi-role prod access out of scope) — every page is classified from code + the authoritative prod flag state in `docs/launch/PRODUCTION-ACTIVATION-MATRIX.md` (stamped 2026-10-19/20). Prod ON/OFF per flag is in the DOMAIN SUMMARY table.

Prod-flag ground truth used throughout (from the activation matrix + `lib/env.ts` defaults):
- **ON in prod:** `FEATURE_ENTERPRISE_SSO`, `FEATURE_MFA_ENFORCEMENT` (inert — no org opted in), `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS`, VAPID push keys (set), Resend email, Stripe SaaS checkout (no flag; super-admin-minted).
- **OFF/dark in prod:** `FEATURE_PUBLIC_API_JOBS`, `FEATURE_MARKETPLACE`, `FEATURE_GDPR_ERASURE`, `FEATURE_RETENTION_PURGE`, `NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING`, `FEATURE_ACCOUNTING_CONNECT`, `FEATURE_CALENDAR_CONNECT`, `NEXT_PUBLIC_FEATURE_HMRC_CONNECT`, `NEXT_PUBLIC_FEATURE_BANKING_CONNECT`, `NEXT_PUBLIC_FEATURE_MERCHANTS`, `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT`, `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS`, `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO`, `NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING`, `NEXT_PUBLIC_FEATURE_VOICE_INBOUND`.
- **No flag (always-on engine):** Automations (gating is per-rule `enabled`; the `delay`/`ai_decision`/`webhook` workflow node kinds are forced to draft/disabled).

---

## SETTINGS

### Page: Settings home — route `/settings` → `app/(app)/settings/page.tsx:29`

- **Status:** LIVE & WORKING (hub + most forms); a few sub-features gated (see per-feature).
- **Roles:** any authenticated member reaches the page (`requireOrgContext`). `isAdmin = role === "owner"||"admin"` (`page.tsx:36`) hides/disables admin-only sections; every write action re-checks role server-side + RLS. Per-role diffs: staff see Profile, Working hours/Tax/FRS (read-only), Notification prefs, Push, Security card, Automations card, AI-receptionist link, Plan card, Members (read-only). Admin-only cards: API keys, Integrations, Data retention, and Webhooks (also flag-gated). Org/branding + working-hours/tax/FRS are read-only for staff (fieldset disabled).
- **Purpose:** single-page account hub — own profile, org identity/branding/logo, org config (working hours, tax defaults, VAT Flat Rate Scheme), notification + push prefs, plus launcher cards into every sub-route and a read-only members list.
- **What the user sees:** trial/status pill (`page.tsx:130`), Profile form, Organisation form + Logo uploader, Working hours, Tax & defaults, VAT Flat Rate Scheme, AI Receptionist card (badge Off/Pending/Live), API keys card (admin), Notification preferences grid + Web Push toggle, Security card, Webhooks card (admin + flag), Integrations card (admin), Automations card, Data retention card (admin), Plan & billing block, Members list.

**Features**
1. **Profile** — edit own full_name/phone. READ `users` (`page.tsx:40`), UPDATE own `users` row (`actions.ts:85`). After-success `revalidatePath("/settings")` (`actions.ts:100`) + client `router.refresh()`. No side-effects. Email field is display-only ("contact us to change"). Connected: authorship/attribution across app. Prod: no flag. **LIVE & WORKING.**
2. **Organisation details** — company identity for quote/invoice PDFs. READ `organizations` (`page.tsx:47`), UPDATE `organizations` on `id=org.id` with `count:"exact"` (`actions.ts:138`); `count===0` → permission error (`actions.ts:164`). Address + bank collapsed to jsonb (`actions.ts:119`). `logo_url` deliberately NOT writable here (`actions.ts:146`). After-success revalidate `/settings`+`/dashboard`. Admin-only (`actions.ts:110`). Prod: no flag. **LIVE & WORKING.**
3. **Company logo** — PNG/JPG/WebP <2MB. Service `uploadCompanyLogo`/`deleteCompanyLogo` (`logo-actions.ts:24,45`) writes `organizations.logo_path` to Supabase storage + audit log; Remove uses a `confirm()`. After-success revalidate `/settings`+`/dashboard`. Admin-only. Prod: no flag. **IMPLEMENTED, NOT LIVE-VERIFIED** (storage service not inspected; wiring complete).
4. **Working hours** — per-day working days + open/close. READ via `readOrgSettings` (`_working-hours.tsx:21`), UPSERT `org_settings.working_hours` onConflict org_id (`org-config-actions.ts:107`). Admin-only (`org-config-actions.ts:69`). Prod: no flag. **LIVE & WORKING.**
5. **Tax & defaults** — default VAT/CIS rate, FY start, payment terms, VAT stagger/scheme. UPSERT `org_settings` (`org-config-actions.ts:139`). Admin-only. Feeds quote/invoice/return pre-fill. Prod: no flag. **LIVE & WORKING.**
6. **VAT Flat Rate Scheme** — sector %, limited-cost, dates. UPSERT `org_settings.flat_rate_config` (`org-config-actions.ts:214`). Amber "16.5%" warning when limited-cost undeclared (`_flat-rate.client.tsx:51`). Admin-only. Feeds `lib/tax/compute`. Prod: no flag. **LIVE & WORKING.**
7. **Notification preferences** (per-user grid) — in-app checkbox, email cadence (off/immediate/daily/weekly), push + SMS toggles per category; critical categories (money/security/urgent) rendered locked "Always on" and never written (`notification-prefs-actions.ts:56`). READ/UPSERT own rows via service (`_notification-prefs.tsx:29`, `notification-prefs-actions.ts:77`). No `revalidatePath` (relies on `router.refresh()`). Side-effects: stored prefs drive downstream email/push/SMS. **LIVE & WORKING** for in-app+email; SMS = IMPLEMENTED NOT LIVE-VERIFIED (transport Twilio-dark).
8. **Web Push device subscription** — Enable → `Notification.requestPermission()` + `pushManager.subscribe()` with VAPID key → UPSERT `push_subscriptions` (`push-actions.ts:45`); Turn off → DELETE + `unsubscribe()` (`push-actions.ts:54`). Section renders only when `getPushPublicKey()` non-null (`_notification-prefs.tsx:53`; `lib/notifications/push.ts:66`). Side-effects: browser permission prompt, service-worker subscription, DB row. Prod: VAPID keys SET → **LIVE & WORKING.**
9. **Members list** — read-only roster (`page.tsx:416`). Add/remove "lands next" (`page.tsx:465`). **PLACEHOLDER** (no member CRUD exists).

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save profile | `_forms.tsx:88` → `actions.ts:76` | zod validate, UPDATE `users` | full_name (req), phone | row updated, revalidate | LIVE |
| Save organisation | `_forms.tsx:263` → `actions.ts:104` | role check, UPDATE `organizations` | trading name (req) | revalidate settings+dashboard | LIVE |
| Upload/Replace logo | `_logo-upload.tsx:104` → `logo-actions.ts:24` | marshal File → service | image file | logo_path set | IMPL, NOT LIVE-VERIFIED |
| Remove logo | `_logo-upload.tsx:112` → `logo-actions.ts:45` | confirm → service delete | — | logo cleared | IMPL, NOT LIVE-VERIFIED |
| Save working hours | `_working-hours.client.tsx:102` → `org-config-actions.ts:65` | per-day zod, upsert | open+close per day | org_settings upserted | LIVE |
| Save tax & defaults | `_tax-defaults.client.tsx:204` → `org-config-actions.ts:126` | zod, upsert | 6 bounded fields | org_settings upserted | LIVE |
| Save Flat Rate Scheme | `_flat-rate.client.tsx:213` → `org-config-actions.ts:179` | zod, upsert | sector %, limited_cost | flat_rate_config upserted | LIVE |
| Save preferences | `_notification-prefs.client.tsx:167` → `notification-prefs-actions.ts:47` | skip critical, upsert | per-category toggles | prefs upserted | LIVE (SMS dark) |
| Enable push | `_push-toggle.client.tsx:152` → `push-actions.ts:25` | permission+subscribe | endpoint/p256dh/auth | subscription saved | LIVE |
| Turn off push | `_push-toggle.client.tsx:144` → `push-actions.ts:54` | unsubscribe + delete | endpoint | row deleted | LIVE |
| (launcher cards) | `page.tsx:211-414` | navigate to sub-routes | — | nav | LIVE |

---

### Page: AI Receptionist — route `/settings/ai-receptionist` → `app/(app)/settings/ai-receptionist/page.tsx:48`

- **Status:** Intake form LIVE & WORKING; the capability it requests is FLAGGED OFF (`NEXT_PUBLIC_FEATURE_VOICE_INBOUND`).
- **Roles:** all members view; `isAdmin` gates editing (`page.tsx:50`); action re-checks owner/admin (`actions.ts:37`).
- **Purpose:** white-glove onboarding intake — the customer submits channel handles + preferences; HQ provisions the actual receptionist. Customer sees a derived status badge + a test checklist + voice-line status.
- **What the user sees:** read-only voice-line status banner, an Enable toggle that reveals fields (business phone (required when enabled), WhatsApp, Instagram, Facebook, preferred UK voice, trade, business hours), a test-progress checklist, and Save.

**Features**
1. **AI Receptionist setup intake** — READ `ai_receptionist_setups` (`page.tsx:53`); UPDATE existing by id (`actions.ts:81`) or INSERT (`actions.ts:101`). After-success revalidate `/settings`, `/settings/ai-receptionist`, `/admin/ai-receptionist` (`actions.ts:138`). Side-effects: `recordAdminActivity` HQ audit (`actions.ts:124`) — **no AI/telephony is provisioned by this action**; purely stores config + notifies HQ. The form itself is not flag-gated. **LIVE & WORKING** as intake.
2. **Voice line status (read-only)** — READ `phone_numbers` by org (`_voice-status.tsx:23`). Gated by `voiceInboundFeatureEnabled()` = `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` (`_voice-status.tsx:20`; `lib/telephony/config.ts:21`); OFF → always renders "Not configured" dark copy. **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_VOICE_INBOUND`).**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Enable toggle | `_form.tsx:92` | reveals/dims fields (client) | — | sets `enabled` | LIVE |
| Save + request setup / Save | `_form.tsx:194` → `actions.ts:31` | role check, zod, upsert + HQ audit | business_phone when enabled | row upserted, HQ notified | LIVE (intake) |
| Back to Settings | `_form.tsx:197` | link | — | nav | LIVE |
| Voice-line status | `_voice-status.tsx:54` | display only | — | "Not configured" while dark | FLAGGED OFF |

---

### Page: Plan & billing — route `/settings/billing` → `app/(app)/settings/billing/page.tsx:47`

- **Status:** Current-plan + catalogue + mailto LIVE; all self-serve Stripe controls FLAGGED OFF (`NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING`).
- **Roles:** any member views; admin gates the Stripe actions (`page.tsx:54`, `actions.ts:29`).
- **Purpose:** self-serve SaaS plan management, built dark behind a two-switch gate `isSelfServeBillingConfigured()` = flag AND `STRIPE_SECRET_KEY` (`lib/billing/self-serve.ts:35`).
- **What the user sees:** current-plan card (plan, status, renews/ends date) + feature checklist; plans catalogue; invoices section (only when configured). While dark: read-only plan + an "Email us to change plan" `mailto:hello@crewflow.uk`.

**Features**
1. **Current plan + entitlement display** — READ `org_subscriptions`+`organizations` via `resolveOrgPlanKey` (`page.tsx:58`; `server/services/entitlements.ts:27`); feature rows from static `lib/billing/plans.ts`. No side-effects. **LIVE & WORKING** (renders even dark).
2. **Manage billing (Stripe portal)** — renders only `configured && isAdmin` (`page.tsx:136`); `openBillingPortal` refuses `feature_disabled` before any Stripe call (`actions.ts:35`; `self-serve-billing.ts:127`). Side-effect: Stripe billing-portal session. **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING`).**
3. **Change plan (Checkout)** — per-plan button when `configured && isAdmin && lookupKey && !isCurrent` (`page.tsx:188`); `changePlan` zod-validates plan enum then `createPlanChangeCheckout` refuses-before-fetch (`actions.ts:62`; `self-serve-billing.ts:160`). Actual plan write lands via the Stripe webhook upsert to `org_subscriptions` (`self-serve-billing.ts:220`). Side-effect: Stripe Checkout (payment when live). **FLAGGED OFF.**
4. **Email-us fallback** — the honest dark state, rendered whenever NOT `configured && isAdmin` (`page.tsx:145`). **LIVE & WORKING.**
5. **Invoices & receipts** — Stripe read (`listOrgSaasInvoices`, refuse-before-fetch) when configured (`page.tsx:206`). **FLAGGED OFF.**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Manage billing | `page.tsx:137` → `actions.ts:35` | opens Stripe portal | admin+configured | redirect / `?error=` | FLAGGED OFF |
| Upgrade/Switch to {plan} | `page.tsx:189` → `actions.ts:62` | Stripe Checkout | admin+configured+lookupKey | redirect to checkout | FLAGGED OFF |
| Email us to change plan | `page.tsx:147` | mailto | — | opens mail client | LIVE |
| View (invoice) | `page.tsx:226` | opens hosted invoice | configured | new tab | FLAGGED OFF |

> Note: Stripe SaaS checkout itself is LIVE in prod (super-admin mints real checkout per the activation matrix); only the tenant *self-serve* surface here is dark.

---

### Page: Security — route `/settings/security` → `app/(app)/settings/security/page.tsx:22`

- **Status:** TOTP MFA + recovery codes IMPLEMENTED NOT LIVE-VERIFIED; identity linking FLAGGED OFF.
- **Roles:** uses `requireUser()` not `requireOrgContext` (`page.tsx:16`) — per-user self-service, no role gate, so a user can always manage their own factors (recovery).
- **Purpose:** opt-in TOTP MFA, backup recovery codes, and (dark) OAuth identity linking.
- **What the user sees:** MFA section (enrol QR or verified-factor list); recovery-codes section (only if a verified factor exists); linked sign-in methods (email/Google/Microsoft).

**Features**
1. **TOTP MFA enrolment** — `enrollTotp` → Supabase `auth.mfa.enroll` returns QR data-URI + manual secret (`actions.ts:61`); 6-digit confirm → `verifyTotpEnrollment` (`mfa.challenge`+`mfa.verify`, `actions.ts:93`). DB: Supabase `auth` schema. Prod: no flag. **IMPLEMENTED, NOT LIVE-VERIFIED.**
2. **Remove factor (unenroll)** — `unenrollFactor` → `mfa.unenroll` + best-effort purge of `mfa_recovery_codes` only when no verified factor remains (`actions.ts:197`). **IMPLEMENTED, NOT LIVE-VERIFIED.**
3. **Recovery codes** — generate/regenerate → `generateRecoveryCodes` (replace = delete-all + insert hashes, plaintext shown once, `actions.ts:148`); remaining count via SECURITY DEFINER rpc `mfa_recovery_codes_remaining` (`page.tsx:50`). DB: C/D `mfa_recovery_codes` (hashes only). **IMPLEMENTED, NOT LIVE-VERIFIED.**
4. **Linked sign-in methods** — Google link button only when `NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING==="true"`; Microsoft also needs `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO` (`page.tsx:56,73`). `linkIdentity` redirects to `?error=linking_disabled` when flag off (`actions.ts:239`). Both flags OFF in prod. **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING`; MS also `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO`).**

> **Gaps:** no password-change form and no session-list/revoke controls exist on this page. The **MFA enforcement toggle is not a control here** — enforcement is a server-side double gate only (`FEATURE_MFA_ENFORCEMENT` + `organizations.require_mfa`), flag ON in prod but inert (no org set `require_mfa`, and there is no self-serve UI to set it).

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Set up authenticator app | `_forms.tsx:170` → `actions.ts:61` | starts TOTP enroll, shows QR+secret | signed-in | QR + confirm form | IMPL, NOT LIVE-VERIFIED |
| Confirm (6-digit) | `_forms.tsx:147` → `actions.ts:93` | verifies pending factor | factorId + 6 digits | MFA active | IMPL, NOT LIVE-VERIFIED |
| Remove (factor) | `_forms.tsx:203` → `actions.ts:197` | unenroll + conditional purge | factorId | factor removed | IMPL, NOT LIVE-VERIFIED |
| Generate/Regenerate recovery codes | `_forms.tsx:305` → `actions.ts:148` | mint fresh set | verified factor | codes shown once | IMPL, NOT LIVE-VERIFIED |
| Copy codes / Done | `_forms.tsx:272` | clipboard / dismiss | — | client only | LIVE |
| Link Google | `_forms.tsx:364` → `actions.ts:257` | OAuth link redirect | flag on | consent / `?error=linking_disabled` | FLAGGED OFF |
| Link Microsoft | `_forms.tsx:369` → `actions.ts:261` | OAuth link redirect | both flags on | consent | FLAGGED OFF |

---

### Page: Single sign-on (SSO) — route `/settings/sso` → `app/(app)/settings/sso/page.tsx:33`

- **Status:** Flag ON in prod → full admin surface renders; per-org `enabled` second switch OFF for every org today ⇒ IMPLEMENTED NOT LIVE-VERIFIED for any tenant.
- **Roles:** owner/admin only (`page.tsx:29`); non-admin (flag on) sees a read-only note. `force-dynamic`.
- **Purpose:** activation surface for built-dark SAML/OIDC SSO + SCIM 2.0 token mint. Gate `isEnterpriseSsoEnabled()` = `FEATURE_ENTERPRISE_SSO` (`lib/enterprise-sso/flag.ts:24`).
- **What the user sees:** three branches — flag OFF → honest amber dark panel (`page.tsx:55`); flag ON non-admin → read-only note; flag ON + admin → lit surface with status badge, SP endpoints (entityID/ACS/redirect), SAML form, OIDC form, SCIM token panel.

**Features** (every action re-enforces flag+admin via `adminGate()` `actions.ts:32`; every config save lands DISABLED — the second switch)
1. **Connection status + per-org enable toggle** — `setSsoEnabledAction` → `setSsoEnabled` requires an existing config row else `no_config` (`actions.ts:87`; `admin.ts:101`). R/U `org_sso_config`. **IMPLEMENTED, NOT LIVE-VERIFIED** (all orgs `enabled=false`).
2. **SP endpoints display** — static derivation from `lib/enterprise-sso/urls.ts` (`page.tsx:144`). **LIVE & WORKING.**
3. **SAML config** — `saveSamlConfigAction` → `upsertSamlConfig` (https SSO URL, cert, entityID; always `enabled:false`, nulls OIDC cols) (`actions.ts:47`; `admin.ts:38`). C/U `org_sso_config`. **IMPLEMENTED, NOT LIVE-VERIFIED.**
4. **OIDC config** — `saveOidcConfigAction` → `upsertOidcConfig` refuses if encryption key missing, `encryptToken(clientSecret)` before store, secret never echoed (`actions.ts:71`; `admin.ts:68`). **IMPLEMENTED, NOT LIVE-VERIFIED.**
5. **SCIM token mint/rotate + provisioning toggle** — `mintScimTokenAction` → `mintScimToken` stores hash+prefix, returns plaintext once (`actions.ts:95`; `admin.ts:118`); enable requires a token row (DB CHECK `org_scim_config_enabled_needs_token`). C/U `org_scim_config`. **IMPLEMENTED, NOT LIVE-VERIFIED.**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Enable/Disable SSO | `_forms.client.tsx:250` → `actions.ts:87` | flips per-org switch | admin+flag+config row | status refresh | IMPL, NOT LIVE-VERIFIED |
| Save SAML configuration | `_forms.client.tsx:141` → `actions.ts:47` | upsert SAML (disabled) | https SSO URL, cert, entityID | saved, disabled | IMPL, NOT LIVE-VERIFIED |
| Save OIDC configuration | `_forms.client.tsx:226` → `actions.ts:71` | upsert OIDC (encrypted, disabled) | issuer, clientId, secret | saved / `encryption_key_missing` | IMPL, NOT LIVE-VERIFIED |
| Mint/Rotate SCIM token | `_forms.client.tsx:330` → `actions.ts:95` | mint hashed token | admin+flag | plaintext shown once | IMPL, NOT LIVE-VERIFIED |
| Enable/Disable provisioning | `_forms.client.tsx:333` → `actions.ts:105` | flips SCIM switch | existing token | status refresh | IMPL, NOT LIVE-VERIFIED |

---

### SCIM 2.0 endpoints — `/scim/v2/*` → `app/scim/v2/{Users,Groups}[/[id]]/route.ts`

- **Status:** Deny-by-default verified by construction; no org has SCIM enabled in prod ⇒ IMPLEMENTED NOT LIVE-VERIFIED. (Not in nav — server HTTP surface.)
- **Auth:** the bearer token IS the credential — `authenticateScim` → `resolveScimConfigByToken` returns null (⇒ **401** with `www-authenticate: Bearer`) when `!isEnterpriseSsoEnabled()`, unknown token, or row `enabled=false` (`lib/enterprise-sso/scim-auth.ts:17`; `config.ts:128`). Token sha256-hashed before compare. With `FEATURE_ENTERPRISE_SSO` ON, routes return 401 (not 404); per-org SCIM off everywhere ⇒ effectively inert.
- **Features:** GET /Users list members (`memberships`+`users`); POST /Users links an EXISTING membership by verified email, unmatched → 404 noTarget + audit (never creates a user, `provisioning.ts:40`); GET/PATCH/DELETE /Users/[id] (PATCH `active:false`/DELETE delete membership row, never auth user, + `sso_provisioning_audit`); GET /Groups + /Groups/[id] read-only single synthetic "Organization Members" group, cross-tenant id → 404. Only write is membership delete; all writes service-role + org-pinned. **No auto-create path anywhere.**

**Buttons & controls** (HTTP, not UI)
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| GET /Users | `Users/route.ts:25` | list members | bearer token | ListResponse / 401 | IMPL, NOT LIVE-VERIFIED |
| POST /Users | `Users/route.ts:35` | link existing by email | bearer + email | 200 / 404 noTarget / 401 | IMPL, NOT LIVE-VERIFIED |
| PATCH/DELETE /Users/[id] | `Users/[id]/route.ts:37,75` | deactivate / remove membership | bearer + id | 200 / 204 / 401 | IMPL, NOT LIVE-VERIFIED |
| GET /Groups[/id] | `Groups/route.ts:19` | read org group | bearer | 200 / 404 / 401 | IMPL, NOT LIVE-VERIFIED |

---

### Page: Integrations — route `/settings/integrations` → `app/(app)/settings/integrations/page.tsx:42`

- **Status:** Every provider IMPLEMENTED but FLAGGED OFF in prod; the hub renders an honest dark state (disabled "Connect" buttons + amber banners), never a fake live link.
- **Roles:** admin only (`page.tsx:44`); non-admin gets a stub. Each action re-checks `isAdminRole` + table RLS.
- **Purpose:** one admin page stacking six provider panels. All six are two-switch gated (feature flag AND credentials/binding), so a stray credential cannot open a live flow. List services synthesize one `disconnected` row per provider so every panel shows its providers while dark.

**Providers / features**
1. **Calendar** (Google, Microsoft) — OAuth; live control is `<a href="/api/integrations/calendar/{provider}/connect">` only when connectable (`CalendarConnectionsPanel.tsx:93`); disconnect `disconnectCalendarConnection` (`actions.ts:58`). DB `calendar_connections`. Gate `isCalendarProviderConnectable` = `FEATURE_CALENDAR_CONNECT` + client id/secret (`calendar/oauth.ts:69`). **FLAGGED OFF (`FEATURE_CALENDAR_CONNECT`).**
2. **HMRC (MTD)** (vat, cis) — OAuth, additionally gated on a VAT-number precondition (`HmrcConnectionPanel.tsx:43`); copy is carefully "prepare/HOLD, not file" (vendor-recognition legal gate). **No disconnect control.** DB `hmrc_connections`; VRN from `organizations.vat_number`. Gate `isHmrcConnectable` = `NEXT_PUBLIC_FEATURE_HMRC_CONNECT` + creds (`hmrc/oauth.ts:65`). **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_HMRC_CONNECT`).**
3. **Banking** (truelayer, plaid, nordigen) — OAuth via aggregator; one OAuth client + explicit `BANKING_PROVIDER` binding so at most one is ever live; disconnect `disconnectBankConnection` (`actions.ts:91`). DB `bank_connections`. Gate `isBankingProviderConnectable` = `NEXT_PUBLIC_FEATURE_BANKING_CONNECT` + provider binding + creds (`banking/oauth.ts:65`). **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_BANKING_CONNECT`).**
4. **Telematics** (samsara, verizon_connect) — OAuth; disconnect `disconnectTelematicsConnection` (`actions.ts:124`). DB `telematics_connections`. Gate = `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT` + creds + binding (`telematics/oauth.ts:57`). **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT`).**
5. **Builders' Merchants** (jp_corry, jewson, travis_perkins, haldane_fisher) — **NOT OAuth**: a `<form>` binds a trade-account number + optional secret (`MerchantConnectionsPanel.tsx:124`) via `connectMerchantConnection` (`actions.ts:161`), secret AES-256-GCM encrypted at rest, refuses loudly without `INTEGRATION_TOKEN_ENCRYPTION_KEY` (`merchant-connections.ts:244`); also "Import price file" → UPSERT `merchant_catalogue_items` (idempotent); disconnect clears secret. DB `merchant_connections`. Gate `isMerchantConnectable` = `NEXT_PUBLIC_FEATURE_MERCHANTS` + per-merchant key+endpoint (`merchants/connect.ts:79`). **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_MERCHANTS`).**
6. **Payments (Stripe Connect)** — tenant binds its OWN connected account so customers pay invoices in the portal; connect/reconnect redirect to `/api/integrations/stripe-connect/connect`; disconnect + refresh-status (`actions.ts:256,279`). DB `org_payment_connections`. Gate `isPortalPaymentsConfigured` = `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` + `STRIPE_CONNECT_SECRET_KEY` (`portal-stripe.ts:50`). **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS`).**

**Buttons & controls** (condensed; all connect controls are disabled while dark)
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Connect Calendar (live) | `CalendarConnectionsPanel.tsx:93` | GET OAuth route | — | redirect to Google/MS | FLAGGED OFF |
| Disconnect Calendar | → `actions.ts:58` | clears tokens → disconnected | provider | row disconnected | FLAGGED OFF |
| Connect HMRC (live) | `HmrcConnectionPanel.tsx:100` | GET OAuth | VAT number on file | redirect to HMRC | FLAGGED OFF |
| Connect Bank (live) | `BankConnectionsPanel.tsx:96` | aggregator OAuth | — | redirect | FLAGGED OFF |
| Disconnect Bank | → `actions.ts:91` | clears tokens | provider | disconnected | FLAGGED OFF |
| Connect Telematics (live) | `TelematicsConnectionsPanel.tsx:94` | GET OAuth | — | redirect | FLAGGED OFF |
| Disconnect Telematics | → `actions.ts:124` | clears tokens | provider | disconnected | FLAGGED OFF |
| Connect Merchant (FORM) | `MerchantConnectionsPanel.tsx:124` → `actions.ts:161` | binds trade acct, encrypts secret | accountNumber (req) | row connected | FLAGGED OFF |
| Import price file | → `actions.ts:229` | fetch + UPSERT catalogue | provider | catalogue imported / `skipped_dark` | FLAGGED OFF |
| Disconnect Merchant | → `actions.ts:197` | clears secret | provider | disconnected | FLAGGED OFF |
| Connect/Reconnect Stripe | `PaymentsConnectionPanel.tsx:92` | onboarding redirect | — | Stripe onboarding | FLAGGED OFF |
| Refresh status (Stripe) | → `actions.ts:279` | poll accounts.retrieve | — | status remapped | FLAGGED OFF |
| Disconnect Stripe | → `actions.ts:256` | unbind account | — | pay-now gate closes | FLAGGED OFF |

---

### Page: API keys — route `/settings/api-keys` → `app/(app)/settings/api-keys/page.tsx:68`

- **Status:** Key create/revoke UI LIVE & WORKING regardless of the API flag; the downstream public jobs API is FLAGGED OFF (`FEATURE_PUBLIC_API_JOBS`).
- **Roles:** owner/admin only (`page.tsx:68`); RLS `api_keys` admin select/insert/update, **no delete**.
- **Purpose:** mint/list/revoke org API keys for the CrewFlow public API. The `/developers` docs link renders only when `isPublicApiJobsEnabled()` (`page.tsx:214`) ⇒ hidden in prod.

**Features**
1. **Create API key** — `createApiKey` (`actions.ts:80`): admin re-check; entitlement gate `orgHasEntitlement(org,'api_access')` **inert (returns true while billing dark)** (`actions.ts:90`); zod name+expiry; scope validation against `SCOPES`; `generateApiKey()` mints plaintext; INSERT `api_keys` storing only `key_prefix`+`key_hash` (sha256), no plaintext readback (`actions.ts:130`). One-time plaintext reveal (`actions.ts:148`). No side-effects. Expiry options Never/30/90/365. **LIVE & WORKING** (keys authenticate the live `/api/v1/me` probe; job endpoints 404 while dark).
2. **Revoke API key** — `revokeApiKey` confirm → UPDATE `revoked_at=now()` pinned id+org+`is(revoked_at,null)` with `.select("id")`; zero rows → explicit error, never fake success (`actions.ts:160`). **No DELETE path** — revoke-never-erase. **LIVE & WORKING.**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Create API key | `_forms.tsx:143` → `actions.ts:80` | mint key, insert hash+prefix | name, ≥1 scope, expiry | one-time plaintext reveal | LIVE |
| Copy key | `_forms.tsx:48` | clipboard | — | ephemeral | LIVE |
| Revoke (confirm) | `_forms.tsx:180` → `actions.ts:160` | stamps `revoked_at` | key_id | row → Revoked | LIVE |
| API developer docs → | `page.tsx:229` | link to `/developers` | — | hidden while flag off | FLAGGED OFF |

---

### Page: Webhooks — route `/settings/webhooks` → `app/(app)/settings/webhooks/page.tsx:69`

- **Status:** LIVE & WORKING in prod (`NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS` ON).
- **Roles:** owner/admin only (`page.tsx:69`); RLS `webhook_endpoints` admin, `secret` column-excluded. Flag OFF → whole page is "Coming soon" (`page.tsx:84`).
- **Purpose:** manage outbound webhook endpoints (SSRF-guarded, HMAC-signed, circuit-broken). Egress only to `status=active` endpoints (second per-org flip) and only when the dispatch cron runs.
- **What the user sees:** add-endpoint form (URL + description + event checkboxes), endpoint list (status pill active/paused/disabled_by_failures, verbs, verified/last-delivery/failure counts), recent deliveries table (last 25).

**Features** (every mutating action first calls `outboundWebhooksEnabled()` and refuses `FEATURE_OFF` if dark)
1. **Create endpoint + verification ping** — `createWebhookEndpoint` (`actions.ts:106`): SSRF validate (reject non-https/IP/private/platform), event validate, `generateWebhookSecret()`, INSERT `webhook_endpoints` status `paused`, then service-role RPC `webhook_enqueue_ping`. One-time secret reveal. Side-effect: outbound HTTPS verification ping via the dispatch cron. **LIVE & WORKING.**
2. **Event subscription** — checkboxes from `EXPOSABLE_WEBHOOK_EVENTS`, ≥1 required, server-validated. **LIVE & WORKING.**
3. **Pause / Resume** — `pauseWebhookEndpoint`/`resumeWebhookEndpoint` (`actions.ts:188,210`); resume re-verifies via fresh ping if never verified, else status `active` + breaker reset. **LIVE & WORKING.**
4. **Send test ping / recover** — `repingWebhookEndpoint` (`actions.ts:270`) resets breaker first on `disabled_by_failures`, then enqueues a ping. **LIVE & WORKING.**
5. **Delete endpoint** — `deleteWebhookEndpoint` hard delete, confirm dialog (`actions.ts:319`). **LIVE & WORKING.**
6. **Rotate secret** — **PLACEHOLDER** (no discrete action; secret is set once at create, column-excluded; rotate = delete + recreate).

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Create webhook | `_forms.tsx:138` → `actions.ts:106` | SSRF+event validate, insert, enqueue ping | https URL, ≥1 event | one-time secret, paused→verify | LIVE |
| Copy secret | `_forms.tsx:57` | clipboard | — | copy | LIVE |
| Pause | `_forms.tsx:196` → `actions.ts:188` | status=paused | endpoint_id | paused | LIVE |
| Resume | `_forms.tsx:198` → `actions.ts:210` | activate or re-ping | endpoint_id | active / re-verify | LIVE |
| Send test ping | `_forms.tsx:200` → `actions.ts:270` | enqueue ping (+breaker reset) | endpoint_id | ping queued | LIVE |
| Delete (confirm) | `_forms.tsx:201` → `actions.ts:319` | hard delete + history | endpoint_id | removed | LIVE |

---

### Page: Automations — route `/settings/automations` → `app/(app)/settings/automations/page.tsx` (+ `/settings/automations/workflow`)

- **Status:** LIVE & WORKING, no feature flag (always-on engine); within it, three workflow node kinds are dark-forced-to-draft, and several built-in catalogue rules ship `enabled:false`.
- **Roles:** owner/admin for all mutations; members read-only. RLS `is_org_admin` on `automation_*` tables is the boundary.
- **Purpose:** no-flag automation engine — built-in rule overrides, cron schedules, no-code custom rules, approval gates, and a visual workflow builder with version history. The dispatcher has no env gate; gating is per-rule `enabled`.

**Features**
1. **Built-in rule on/off** — `toggleAutomationRule` writes an override row over the static catalogue + HQ audit (`actions.ts:67`). Catalogue = 11 rules (`lib/automation/rules.ts`): 6 enabled by default, 5 ship `enabled:false` (producerless or billing-dark, e.g. `payment_recorded_email_receipt`, `*_autoinvoice`). DB `automation_rules`, `hq_admin_activity`. **LIVE & WORKING** (several rules IMPLEMENTED NOT LIVE while disabled).
2. **Schedules** — `createAutomationSchedule` (cron-validated) + toggle/delete (`actions.ts:108,148,188`); fired by `/api/cron/automation-schedules-drain`. DB `automation_schedules`. **LIVE & WORKING.**
3. **Custom rules (no-code builder)** — `CustomRuleBuilder` composes a `definition` JSON → `createCustomRuleAction`/`updateCustomRuleAction` (`actions.ts:267,316`), re-validated server-side via `validateCustomRuleDefinition` (the injection chokepoint; params are data, never code). 10 exposable triggers, 6 custom-available actions (incl. `send_email_queue` with audience enum only — no free-text recipient; `create_invoice_draft`), condition operators, optional approval gate. DB `automation_custom_rules`, `automation_approvals`. Side-effects when fired: in-app notifications, queued org-scoped email, draft invoices, audit notes/alerts/milestones. **LIVE & WORKING.**
4. **Pending approvals** — Approve/Reject → `decideApprovalAction` (race-safe) (`actions.ts:435`). DB `automation_approvals`. **LIVE & WORKING.**
5. **Visual workflow builder** (`/settings/automations/workflow`) — `saveWorkflowAction` compiles the graph into the SAME `automation_custom_rules.definition` the dispatcher runs (no second engine) + version history; Restore writes a new version (`actions.ts:506,572`). Node kinds `delay`, `ai_decision`, `webhook` are **DARK** — any graph containing one compiles to `isDraft=true` and saves disabled so nothing dark runs (`lib/automation/workflow-graph.ts:80`). DB `automation_custom_rules`, `automation_workflow_versions`. **LIVE & WORKING** (dark node kinds = FLAGGED-OFF-equivalent).

**Buttons & controls** (condensed)
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Turn on/off (built-in) | `page.tsx:177` → `actions.ts:67` | override enabled | rule_key | override row + audit | LIVE |
| Add schedule | `page.tsx:300` → `actions.ts:108` | create cron-bound rule | rule_key, valid cron | schedule row | LIVE |
| Pause/Resume/Delete schedule | → `actions.ts:148,188` | toggle/delete | schedule_id | updated | LIVE |
| Approve / Reject | `page.tsx:366` → `actions.ts:435` | decide gate | approval_id, decision | gate decided | LIVE |
| Create/Save custom rule | `CustomRuleBuilder.tsx:469` → `actions.ts:267/316` | validate+persist definition | name, trigger, actions | rule saved | LIVE |
| Toggle/Delete custom rule | `page.tsx:485` → `actions.ts:366/405` | toggle/delete | rule_id | updated | LIVE |
| Save/Create workflow | `WorkflowCanvas.tsx:549` → `actions.ts:506` | compile graph → rule (+version) | compiles | saved (draft if dark) | LIVE |
| Restore version | `workflow/page.tsx:169` → `actions.ts:572` | restore graph as new version | rule_id, version_id | restored | LIVE |

---

### Page: Data retention — route `/settings/data-retention` → `app/(app)/settings/data-retention/page.tsx`

- **Status:** Policy editor + GDPR export LIVE; purge execution FLAGGED OFF (dry-run only); GDPR erasure FLAGGED OFF (triple-locked, honest dark panel).
- **Roles:** owner/admin edit, members read-only; GDPR erasure adds **owner-only** (`page.tsx:112`).
- **Purpose:** per-table retention windows + GDPR export/erasure. Flags `retentionPurgeEnabled()`=`FEATURE_RETENTION_PURGE` (`retention-purge.ts:50`) and `gdprErasureEnabled()`=`FEATURE_GDPR_ERASURE` (`gdpr-erase.ts:42`), both OFF in prod.
- **What the user sees:** mode banner — blue "Preview mode" (records what would be purged, deletes nothing) while flag off vs amber "Purging is live"; per-allowlisted-table policy editors; recent retention activity log; GDPR export section; GDPR erasure section.

**Features**
1. **Save retention policy** — `saveRetentionPolicy` (`actions.ts:47`) validates table against positive allowlist `RETENTION_PURGEABLE_TABLES` + days MIN..MAX, UPSERT `retention_policies` onConflict (org_id,table_name). No save-time side-effect; the daily purge primitive runs `dryRun = !retentionPurgeEnabled()` (`retention-purge.ts:150`) so enabling a policy starts purging the moment the flag flips. **LIVE & WORKING** (editor); purge = FLAGGED OFF (`FEATURE_RETENTION_PURGE`).
2. **Preview (dry run)** — `previewRetentionPolicy` (`actions.ts:107`) counts would-purge rows, deletes nothing, writes a `retention_purge_log` dry_run row. **LIVE & WORKING.**
3. **GDPR export** — admin-only `<a href="/api/gdpr/export">` streaming ZIP (one JSON/table + manifest; credentials/tokens/gov-IDs excluded) (`page.tsx:244`); changes nothing, audited. No flag. **LIVE & WORKING.**
4. **GDPR erasure** — triple-locked: (1) `FEATURE_GDPR_ERASURE` flag; (2) **owner** only; (3) confirmation token = org slug. Dark → honest contact-support panel; `POST /api/gdpr/erase` 503s before any auth/DB work while off (`app/api/gdpr/erase/route.ts:27`). When live: statutory financial/tax/payroll/CIS records anonymised in place, everything else hard-deleted, stored files removed, append-only erasure log. Irreversible. **FLAGGED OFF (`FEATURE_GDPR_ERASURE`).**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save (policy) | `_forms.tsx:145` → `actions.ts:47` | upsert policy | days (MIN..MAX), enabled | policy saved | LIVE |
| Preview (dry run) | `_forms.tsx:146` → `actions.ts:107` | count would-purge | table, days | "N rows would be purged" | LIVE |
| Download data export (ZIP) | `page.tsx:244` → `/api/gdpr/export` | streams GDPR ZIP | admin | file download | LIVE |
| Permanently erase… | `_gdpr-erase.client.tsx:115` → `/api/gdpr/erase` | POST erase, destroys data | slug + checkbox | erasure or 503 if dark | FLAGGED OFF |

---

## MARKETPLACE

### Page: Marketplace (tenant discovery/install) — route `/marketplace` (flag `marketplace`) → `app/(app)/marketplace/page.tsx:64`

- **Status:** FLAGGED OFF (`FEATURE_MARKETPLACE`); **route 404s while dark** (`notFound()` `page.tsx:65`) — does NOT render a dark state (nav entry is flag-conditional).
- **Roles:** any member views the approved catalogue; install/remove admin-only (`page.tsx:68`).
- **Purpose:** tenant discovers approved third-party apps and installs them with scoped consent (install mints a dedicated, revocable, install-bound API key + optional webhook).
- **Feature — Install / Uninstall:** `InstallForm` shows requested scopes + webhook as a consent checklist with a required checkbox; `installApp` refuses if dark, admin-gated, re-validates consent server-side, mints plaintext key + webhook secret, calls service-role RPC `marketplace_install_with_consent` (re-reads scopes authoritatively) (`actions.ts:81`). Uninstall → RPC `marketplace_uninstall` revokes entitlement + bound key + pauses webhook (`actions.ts:172`). Reads `marketplace_listings` (approved) + `marketplace_installs`. Gate `isMarketplaceEnabled()`=`FEATURE_MARKETPLACE` (`lib/marketplace/flag.ts:23`). **FLAGGED OFF.**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Install app | `_forms.tsx:138` → `actions.ts:81` | consent install, mint key | listing_id, consent | key revealed once | FLAGGED OFF |
| Copy key | `_forms.tsx:47` | clipboard | — | ephemeral | FLAGGED OFF |
| Remove app | `_forms.tsx:175` → `actions.ts:172` | confirm → revoke key/access | install_id | install removed | FLAGGED OFF |

### Page: Developer console (settings marketplace) — route `/settings/marketplace` → `app/(app)/settings/marketplace/page.tsx:51`

- **Status:** FLAGGED OFF (`FEATURE_MARKETPLACE`); **route 404s while dark** (`page.tsx:53`). (Not in the settings nav list — reachable only when lit.)
- **Roles:** admin only; non-admin stub.
- **Purpose:** a tenant org publishes apps — create partner identity, create listings (draft→pending_review; a tenant can never self-approve), submit for review.
- **Feature — Partner / Listing publishing:** `createPartner` (slug/https checks, inserts `marketplace_partners` under user RLS, org-pinned) (`actions.ts:63`); `createListing` (scope + webhook-event validation against the same registries, inserts `marketplace_listings` status `draft`) (`actions.ts:145`); `submitListing` → service-role RPC `marketplace_submit_listing` (`actions.ts:234`). Every action short-circuits `FEATURE_OFF` while dark. **FLAGGED OFF.**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Create developer profile | `_forms.tsx:96` → `actions.ts:63` | insert partner | name, slug | partner created | FLAGGED OFF |
| Create listing (draft) | `_forms.tsx:193` → `actions.ts:145` | insert draft listing | name, slug, desc, category, scopes | draft created | FLAGGED OFF |
| Submit for review | `_forms.tsx:206` → `actions.ts:234` | draft→pending_review RPC | listing_id | submitted | FLAGGED OFF |

---

## IMPORTS

### Page: Imports (Migration OS) — route `/imports` → `app/(app)/imports/page.tsx:22`

- **Status:** LIVE & WORKING (session create + list + connector catalogue).
- **Roles:** admin only (`page.tsx:22`); non-admin text stub. RLS `imports` admin.
- **Purpose:** migration entry point — list last 20 sessions, start a new import, browse a guided connector catalogue (Sage/Xero/QuickBooks/Buildertrend).
- **Features:** (1) **Create import session** `createImport` INSERT `imports` status `uploaded` → redirect `/imports/{id}` (`actions.ts:62`). (2) **Past-imports list** org-pinned read. (3) **Connector catalogue** static informational cards. No side-effects. **LIVE & WORKING.**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| New import | `page.tsx:59` → `actions.ts:62` | create session | optional name | redirect to wizard | LIVE |
| Session link | `page.tsx:102` | open wizard | — | `/imports/{id}` | LIVE |
| How to export → | `page.tsx:165` | external docs | — | new tab | LIVE |

### Page: Import wizard — route `/imports/[id]` → `app/(app)/imports/[id]/page.tsx:44`

- **Status:** LIVE & WORKING for CSV/Excel upload→detect→review→commit→rollback; OCR and connector-sync paths are dark.
- **Roles:** admin only (`page.tsx:44`); session org-pinned, `notFound()` if missing.
- **Purpose:** status-driven 5-step wizard (upload→detect→preview→approve→commit) + post-commit rollback. Entities importable: customer, supplier, staff, lead, invoice, cost→finances, quote, job, payment.

**Features**
1. **Upload & parse** — `uploadImportFiles` (`actions.ts:98`): expand zips, parse CSV/TSV via `parseCsvFile`, spreadsheets via SheetJS, PDF/image via `ocrFileToSheet`; raw bytes to `imports` storage bucket; stage `import_files` + chunked `import_rows`; run `annotateDuplicates`; status→`detected`. Side-effects: **file upload** + **governed AI OCR** `invokeWithGovernor("imports.ocr","classification")` (`lib/imports/ocr.ts:230`). OCR = **FLAGGED/DARK** (requires `isTierActivated("cheap")` + a bound vision provider; else `OcrUnavailableError`→`?error=ocr_unavailable`). CSV/Excel path LIVE regardless. `import_rows` has no unique key → re-upload re-inserts (documented). **LIVE & WORKING** (CSV/Excel); OCR = FLAGGED OFF (AI cost-tier + vision provider).
2. **Direct-API connector sync** — `importFromConnector` (`actions.ts:381`) pulls from Xero/QuickBooks; panel renders only if `getAccountingReadiness()` returns connected; `isProviderConnectable` = `FEATURE_ACCOUNTING_CONNECT` + OAuth creds. Always `skipped_dark` today. **FLAGGED OFF (`FEATURE_ACCOUNTING_CONNECT`).**
3. **Detection summary + sheet override** — `overrideSheetEntity` reclassifies all open rows of a detected type (`actions.ts:1067`). **LIVE & WORKING.**
4. **Needs-review queue** — `resolveReviewRow` confirm/skip per row (`actions.ts:950`). **LIVE & WORKING.**
5. **Sandbox preview + duplicate skip** — `ignoreDuplicateRow` keeps existing (`actions.ts:895`); dedupe via `annotateDuplicates` (service-role, org-pinned, never throws → `warn=duplicates_unchecked`). **LIVE & WORKING.**
6. **Commit** — `commitImport` (`actions.ts:649`): service-role read of `pending` rows with confidence ≥50, insert in dependency order; **staff rows are always skipped** (invite path instead); each success writes `import_audit` + marks row `imported`; status→`committed`. Side-effect: fires `dispatchAutomation({type:"import.completed"})` (rule `import_completed_notify` enabled). **LIVE & WORKING.**
7. **Rollback** — `rollbackImport` (`actions.ts:798`) deletes committed rows from live tables in reverse order (org-pinned), resets rows to `skipped`, status→`rolled_back`. **LIVE & WORKING.**
8. **Send staff invites** — `sendStaffInvitesFromImport` (`actions.ts:1153`) per unique email calls `sendStaffInvite` (role hardcoded `staff`). Side-effect: **real Resend magic-link invite email**. **IMPLEMENTED** (Resend-dependent; Resend live in prod).

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Parse + detect | `page.tsx:262` → `actions.ts:98` | upload+parse+detect | ≥1 file | status→detected | LIVE (OCR dark) |
| Sync from Xero/QB | `page.tsx:306` → `actions.ts:381` | pull from API | provider | dark→error | FLAGGED OFF |
| Override | `page.tsx:381` → `actions.ts:1067` | reclassify sheet | entity_type | rows→pending | LIVE |
| Confirm & include / Skip | `page.tsx:452` → `actions.ts:950` | accept/exclude row | entity if unknown | row status | LIVE |
| duplicate · skip | `page.tsx:515` → `actions.ts:895` | keep existing | — | row→skipped | LIVE |
| Commit import | `page.tsx:552` → `actions.ts:649` | write live tables | — | status→committed | LIVE |
| Send invites to imported staff | `page.tsx:616` → `actions.ts:1153` | email staff | staff rows w/ email | invites sent | IMPLEMENTED |
| Roll back entire import | `page.tsx:627` → `actions.ts:798` | delete all | — | status→rolled_back | LIVE |

### Page: Import audit log — route `/imports/[id]/audit` → `app/(app)/imports/[id]/audit/page.tsx:19`

- **Status:** LIVE & WORKING. Admin only. Read-only list of every `import_audit` row joined to `import_rows`+`import_files` + counts-by-target-table, plus the same rollback control when `committed` (→ `rollbackImport` `:91`).

---

## HELP & SUPPORT

### Page: Help centre — route `/help` → `app/(app)/help/page.tsx:45`

- **Status:** LIVE & WORKING (DB-backed; requires `help_articles` rows).
- **Roles:** any authenticated user — `requireUser()` only, **no org/role gate** (`page.tsx:45`). `force-dynamic`.
- **Purpose:** searchable article index. Source is the DB table `public.help_articles` (active only) via user-JWT (`server/services/help-service.ts:52`), NOT static content files. `lib/help/articles.ts` is only the pure search/group model.
- **Features:** (1) **Search** — GET `q`, AND-token ranked over title/keywords/summary/body, with category pre-filter (`articles.ts:117`). (2) **Browse by category** — chips from `HELP_CATEGORIES`, grouped grid. Empty table → empty state + "Raise a ticket". No writes.

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Search | `page.tsx:100` | GET form | q | filtered list | LIVE |
| Category chips | `page.tsx:108` | GET nav | category | filter | LIVE |
| Article card | `page.tsx:26` | open article | — | `/help/{slug}` | LIVE |
| Raise a support ticket | `page.tsx:73` | nav | — | `/support/new` | LIVE |

### Page: Help article — route `/help/[slug]` → `app/(app)/help/[slug]/page.tsx:27`

- **Status:** LIVE & WORKING. `requireUser()`; `getHelpArticleBySlug` (active), null→`notFound()`. Markdown body via XSS-safe `renderMarkdown` (never dangerouslySetInnerHTML). Related rail = same-category siblings (max 5). No writes/search.

### Page: Support tickets — route `/support` → `app/(app)/support/page.tsx:39`

- **Status:** LIVE & WORKING.
- **Roles:** any org member (`requireOrgContext`, no admin gate).
- **Purpose:** customer-side ticket list, org-scoped + F-1 paginated; "awaiting reply" badge. Dual-purpose rows: CrewFlow-helpdesk thread vs portal thread with the org's own customer (distinguished by `customer_id`). GET filter bar (q/status/sort).

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| New ticket | `page.tsx:103` | nav | — | `/support/new` | LIVE |
| Apply / Reset | `page.tsx:169` | GET filter | q/status/sort | filtered | LIVE |
| Ticket row | `page.tsx:198` | open | — | `/support/{id}` | LIVE |

### Page: New ticket — route `/support/new` → `app/(app)/support/new/page.tsx` (+ `createSupportTicket` `actions.ts:41`)

- **Status:** LIVE & WORKING.
- **Roles:** action calls `requireOrgContext()`.
- **Feature — Create ticket:** zod-validated subject/category/priority/body → INSERT `support_tickets` (status `open`, `ticket_number` via trigger) + seed `support_messages` (author_kind `customer`) + `recordAdminActivity("support.ticket_created")` + `dispatchAutomation("support.ticket.created")` → redirect `/support/{id}?saved=1` (`actions.ts:59-138`). Side-effects: **HQ notification via the `support_ticket_created_notify` automation rule** (enabled; `create_notification` to company + HQ) + HQ audit. No direct email at creation.

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Submit ticket | `new/page.tsx:102` → `actions.ts:41` | create ticket + seed message | subject, body (+cat/pri) | redirect to ticket | LIVE |
| Cancel | `new/page.tsx:108` | nav | — | `/support` | LIVE |

### Page: Ticket detail + reply — route `/support/[id]` → `app/(app)/support/[id]/page.tsx` (+ `replyToSupportTicket` `actions.ts:146`)

- **Status:** LIVE & WORKING.
- **Roles:** `requireOrgContext`; ticket org-pinned, null→`notFound()`. Reply box hidden when closed/resolved.
- **Feature — Reply:** INSERT `support_messages` (author_kind `org` for portal thread else `customer`) + audit; **branch-dependent side-effect** — HQ thread → notification `notifyOnSupportReplyToHq`; portal thread → best-effort `sendPortalReplyNotificationEmail` to the org's own customer (Resend). Revalidates `/support`, `/support/{id}`, `/customer-portal`.

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send reply | `[id]/page.tsx:166` → `actions.ts:146` | post reply | ticket_id, body | message added, HQ notified / customer emailed | LIVE |
| ← All tickets | `[id]/page.tsx:50` | nav | — | `/support` | LIVE |

---

## ONBOARDING

### Page: Create company — route `/onboarding/company` → `app/onboarding/company/page.tsx` (+ `actions.ts`)

- **Status:** LIVE & WORKING (core first-run).
- **Roles:** authenticated, no-org-yet. Layout redirects super-admin→`/admin/organizations`, already-onboarded→`/dashboard`; invited users→`/onboarding/join`.
- **Purpose:** first-run create-a-company.
- **Feature — Create company:** `createOrg` (`actions.ts:47`) hard-gates ToS checkbox, zod-validates (incl. UK postcode) → `createOrgWithOwner` (`server/services/bootstrap-account.ts:53`): INSERT `organizations` (status `pending`, or `trial`+14-day `trial_ends_at` if a matching approved/won `demo_requests` row) + INSERT `memberships` role **owner** (membership failure rolls back the org); **seeds sample data** (one customer + draft quote + scheduled job, best-effort). Then stamps org-level ToS, fires HQ `notifyOnCustomerSignup`, revalidate, redirect `/onboarding/setup`. **LIVE & WORKING.**

> **Flag for product (not a flag-gate — a routing caveat):** `createOrg` redirects to `/onboarding/setup` (an `(app)` route), but `requireOrgContext` admits only `active`/`trial` orgs (`server/auth/session.ts:246`) and bounces pending/suspended/rejected/cancelled to `/access-pending` (`session.ts:314`). So a non-pre-approved signup actually lands on `/access-pending`; only trial/active orgs reach the setup checklist.

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| ToS checkbox | `company/page.tsx:91` | required consent | tick | enables submit (server re-checks) | LIVE |
| Continue → | `company/page.tsx:111` → `actions.ts:47` | create org+owner+seed | name, first_name, phone, postcode | →`/onboarding/setup` (or `/access-pending`) | LIVE |

### Page: Join an organisation — route `/onboarding/join` → `app/onboarding/join/page.tsx` (+ `actions.ts`)

- **Status:** LIVE & WORKING.
- **Roles:** authenticated invitee with `app_metadata.invited_org_id`.
- **Feature — Accept invite:** `acceptOrgInvite` (`actions.ts:22`) — role deliberately NOT from the form; authz anchored in admin-only `app_metadata` (submitted `org_id` must equal `invited_org_id`; role from `invited_role`, never owner). Writes (service-role): `users` full_name, `staff_compensation` seed (if empty), `memberships` INSERT, then clears all `invited_*` anchors so the invite can't be replayed. Redirect `/dashboard`.

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Join {org} | `join/page.tsx:103` → `actions.ts:22` | insert membership + hydrate | full_name (org_id/role hidden, role ignored) | →`/dashboard` | LIVE |

### Page: Guided setup — route `/onboarding/setup` (+ `/onboarding/setup/complete`) → `app/(app)/onboarding/setup/page.tsx:37`

- **Status:** LIVE & WORKING.
- **Roles:** authenticated active/trial org (under `(app)`).
- **Purpose:** resume-from-DB setup checklist; page never owns data — progress is derived from live DB (`buildOnboardingSnapshot`). pct 100 → redirect `/onboarding/setup/complete`.
- **Features:** (1) progress + next-step CTA (read-only). (2) Skip/unskip step → read-modify-write `organizations.onboarding_state.dismissed_steps` jsonb (loud read to avoid clobber) (`setup/actions.ts:107,129`); `markCompleted` fires `dispatchAutomation("onboarding.completed")` once. (3) `/complete` celebration (bounces back if pct<100; best-effort `markCompleted`).

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Next step / Step CTA → | `setup/page.tsx:143,197` | deep-link to destination | — | →form | LIVE |
| Skip for now | `setup/page.tsx:206` → `actions.ts:107` | dismiss optional step | step_id | →`?saved=skipped` | LIVE |
| Bring back | `setup/page.tsx:217` → `actions.ts:129` | un-dismiss | step_id | →`?saved=unskipped` | LIVE |

---

## ACCOUNT / AUTH

### Page: Sign in / Sign up — route `/login` → `app/(auth)/login/page.tsx` (+ `(auth)/actions.ts`)

- **Status:** LIVE & WORKING (Google OAuth + magic link + reset LIVE; email/password IMPLEMENTED NOT LIVE-VERIFIED — depends on the Supabase password-grant toggle; Microsoft FLAGGED OFF).
- **Roles:** public / unauthenticated.
- **Purpose:** single sign-in hub — Google OAuth, magic link, email+password (sign-in/sign-up tabs), plus a dark Microsoft SSO button. Auth emails go via Supabase Auth custom SMTP (587, confirmed fixed/live).
- **Features:** (1) **Google OAuth** `signInWithGoogle`→`signInWithOAuth({provider:"google"})` → `/auth/callback` (`actions.ts:39`). **LIVE.** (2) **Magic link** `signInWithMagicLink`→`signInWithOtp({shouldCreateUser:true})` → `/check-email` (`actions.ts:81`); Supabase sends the link. **LIVE.** (3) **Email+password sign-in** `signInWithPassword` + MFA gate via `getAuthenticatorAssuranceLevel` (aal2→`/login/mfa`, else `safeLanding`→`/dashboard`) (`actions.ts:204`); `ensureUserRow` bootstrap. **IMPLEMENTED NOT LIVE-VERIFIED.** (4) **Email+password sign-up** `signUpWithPassword` (`actions.ts:268`); **does NOT create org/membership** — lands `/dashboard` → `requireOrgContext` → `/onboarding/company`. Confirmation-on → check-email first. **IMPLEMENTED NOT LIVE-VERIFIED.** (5) **Microsoft SSO** button renders only when `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO==="true"` (`page.tsx:75`); `signInWithMicrosoft`→`signInWithOAuth({provider:"azure"})` (`actions.ts:442`). **FLAGGED OFF (`NEXT_PUBLIC_FEATURE_MICROSOFT_SSO`).**

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Continue with Google | `login/page.tsx:100` → `actions.ts:39` | OAuth redirect | — | Google consent → callback | LIVE |
| Continue with Microsoft | `login/page.tsx:114` → `actions.ts:442` | Azure OAuth (flag-gated) | — | dark (hidden) | FLAGGED OFF |
| Email me a magic link | `login/page.tsx:154` → `actions.ts:81` | sends OTP email | email | →`/check-email` | LIVE |
| Sign in / Create account tabs | `_email-password-form.tsx:63` | toggle mode | — | swaps form | LIVE |
| Sign in (submit) | `_email-password-form.tsx:184` → `actions.ts:204` | password auth + MFA gate | email, password | →`/dashboard` or `/login/mfa` | IMPL, NOT LIVE-VERIFIED |
| Create account (submit) | `_email-password-form.tsx:184` → `actions.ts:268` | signUp | email, password, confirm | check-email or →onboarding | IMPL, NOT LIVE-VERIFIED |
| Forgot your password? | `_email-password-form.tsx:189` | link | — | →`/reset-password` | LIVE |

### Page: MFA challenge — route `/login/mfa` → `app/(auth)/login/mfa/page.tsx` (+ `_mfa-challenge-form.tsx`)

- **Status:** IMPLEMENTED NOT LIVE-VERIFIED (requires an enrolled user).
- **Roles:** authenticated at aal1. Guards: no session→`/login`; no verified factor→landing (never strands).
- **Features:** (1) **TOTP challenge** `challengeMfa`→`mfa.listFactors`/`challenge`/`verify`→landing (`actions.ts:481`). (2) **Recovery-code redemption** `redeemRecoveryCode` constant-time hash match against `mfa_recovery_codes`, marks code used, deletes TOTP factors (disables MFA), then landing (`actions.ts:563`).

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Verify | `_mfa-challenge-form.tsx:135` → `actions.ts:481` | TOTP verify → aal2 | 6-digit code | →landing | IMPL, NOT LIVE-VERIFIED |
| Use recovery code (submit) | `_mfa-challenge-form.tsx:87` → `actions.ts:563` | redeem + remove factor | recovery code | →landing, MFA off | IMPL, NOT LIVE-VERIFIED |

### Pages: Reset / Update password / Check email — `app/(auth)/reset-password`, `/update-password`, `/check-email`

- **Reset password** (`reset-password/page.tsx`, public): `requestPasswordReset`→`resetPasswordForEmail(redirectTo=/auth/callback?next=/update-password)` (`actions.ts:347`); always returns identical neutral success (no enumeration). **LIVE & WORKING.**
- **Update password** (`update-password/page.tsx`, authenticated/recovery session; no session→`/reset-password`): `updatePassword`→`updateUser({password})`→`safeLanding` (`actions.ts:394`). **LIVE & WORKING.**
- **Check email** (`check-email/page.tsx`, public): confirmation screen; Resend-link reposts to `signInWithMagicLink` with hidden email. **LIVE & WORKING.**

### Route: Auth callback — `/auth/callback` → `app/auth/callback/route.ts`

- **Status:** LIVE & WORKING (core). Public GET route (OAuth/magic-link/email-confirm/recovery landing).
- **Behaviour:** three arrival shapes — `?error=`→`/login?error=`; `?token_hash=&type=`→`verifyOtp`; `?code=`→`exchangeCodeForSession` (`route.ts:92-164`). Then `ensureUserRow` (failure→`bootstrap_failed` bounce). Landing: super-admin→`/admin/organizations`; safe `?next=`; else `/dashboard`. The callback does not itself check org status — `requireOrgContext` on `/dashboard` later routes no-org→`/onboarding/company` and pending/suspended→`/access-pending`.

### Page: Access pending — route `/access-pending` → `app/access-pending/page.tsx:52`

- **Status:** LIVE & WORKING. (Implemented, not in nav — a gate screen; redirect emitted by `server/auth/session.ts:314`.)
- **Roles:** authenticated, non-active org. Super-admin→`/admin/organizations`; no-org→`/onboarding/company`; active/trial→`/dashboard`; otherwise per-status copy (pending/suspended/rejected/cancelled) with hours-elapsed counter for pending.
- **Feature — Refresh status** (`_refresh-button.tsx:18`, pending only): `router.refresh()` re-runs the server gate; auto-redirects to `/dashboard` once approved.

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Refresh status | `page.tsx:132` → `_refresh-button.tsx:25` | re-render gate | — | →`/dashboard` if approved | LIVE |
| Email CrewFlow | `page.tsx:134` | mailto | — | opens mail client | LIVE |
| Sign out / switch account | `page.tsx:140` | link | — | →`/login` | LIVE |

### Pages: Payment return — `/payment/success`, `/payment/cancelled` → `app/payment/*/page.tsx`

- **Status:** LIVE & WORKING (static Stripe Checkout return pages for the one-off setup fee). Public, no auth.
- **`/payment/success`**: reads `?company=`, shows "Payment received / setting up your workspace"; performs NO DB writes or Stripe calls — the Stripe webhook is the real actor (out of this domain's scope). **`/payment/cancelled`**: static "No charge was made" off-ramp.

**Buttons & controls**
| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Back to {appName} | `success/page.tsx:65`, `cancelled/page.tsx:51` | link | — | →`/` | LIVE |

---

## DOMAIN SUMMARY

### Counts
- **Pages / surfaces audited:** 30 — Settings: home, ai-receptionist, billing, security, sso, integrations (6 provider panels), api-keys, webhooks, automations (+workflow), data-retention; marketplace (tenant) + developer-console (settings); imports (list + wizard + audit); help (index + article); support (list + new + detail); onboarding (company + join + setup + complete); auth (login, login/mfa, reset-password, update-password, check-email, auth/callback); access-pending; payment success/cancelled; SCIM endpoint cluster.
- **Buttons/controls catalogued:** ~95 across the tables above.

### Status tallies (by page/surface headline status)
- **LIVE & WORKING:** Settings home, Webhooks, Automations, Imports (list/wizard/audit — CSV/Excel path), Help (index/article), Support (list/new/detail), Onboarding (company/join/setup/complete), Login (Google/magic-link), Reset/Update/Check-email, Auth callback, Access-pending, Payment success/cancelled. (Data-retention policy editor + GDPR export also LIVE within a mixed page.)
- **IMPLEMENTED, NOT LIVE-VERIFIED:** Security (MFA/recovery), SSO (lit admin surface — all orgs `enabled=false`), SCIM cluster, Login email/password sign-in & sign-up, MFA challenge. (Logo upload too.)
- **FLAGGED OFF (headline):** AI Receptionist voice line (`NEXT_PUBLIC_FEATURE_VOICE_INBOUND`), Billing self-serve controls (`NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING`), all 6 Integrations providers, Marketplace both surfaces (`FEATURE_MARKETPLACE`, 404-while-dark), GDPR erasure + retention purge-exec (`FEATURE_GDPR_ERASURE`/`FEATURE_RETENTION_PURGE`), identity linking + Microsoft SSO on login.
- **PLACEHOLDER:** Members add/remove on Settings home; webhook "rotate secret" (delete+recreate only).
- **BROKEN:** none found.

### Hard-to-discover / reachability notes
- **Access-pending** (`/access-pending`) is implemented and reached by redirect but is not in nav (correct — it's a gate screen).
- **AI Receptionist** page is linked from Settings home but is NOT in `nav-model.ts` (settings children omit it). Reachable only via the hub card.
- **Developer console** (`/settings/marketplace`) is not in the settings nav children list; reachable only from the tenant marketplace page's "developer console" link, and only when `FEATURE_MARKETPLACE` is lit (both 404 while dark).
- **SCIM** `/scim/v2/*` is a server HTTP surface with no UI; discoverable only from the SSO page's token panel.
- **Settings home routing caveat:** a non-pre-approved signup is redirected to `/onboarding/setup` by `createOrg` but actually lands on `/access-pending` (pending orgs fail `orgHasActiveAccess`). Worth a product look.

### Implemented but not in nav / orphaned
- `/onboarding/*` (company/join/setup/complete), `/login/mfa`, `/reset-password`, `/update-password`, `/check-email`, `/auth/callback`, `/access-pending`, `/payment/success`, `/payment/cancelled` — all intentionally outside the product nav (auth/onboarding/gate flows).
- No dead/orphaned pages found in this domain; no server action or API handler without a UI except by design (SCIM HTTP surface; `/api/gdpr/*`, `/api/integrations/*/connect` route handlers are the live targets of the audited buttons).

### Notable observations (for the founder)
1. **Settings home "Members" is a placeholder** — the roster is read-only and "add/remove lands next" (`settings/page.tsx:465`). No invite-from-settings; staff invites exist only via the Imports flow and (presumably) staff pages.
2. **No password-change or active-session management UI** on `/settings/security` — only TOTP, recovery codes, and (dark) identity linking. Password change is only reachable via the forgot-password email flow.
3. **No self-serve MFA-enforcement control** anywhere — `FEATURE_MFA_ENFORCEMENT` is ON in prod but inert; enforcing it per-org requires a DB write to `organizations.require_mfa` with no UI.
4. **Webhook secret rotation is not a first-class action** — rotation = delete + recreate (loses delivery history). Worth adding if any customer activates webhooks.
5. **HMRC integration has no disconnect control** (unlike all five other providers) and is deliberately "prepare/HOLD, not file" pending HMRC vendor recognition.
6. **Marketplace diverges from the honest-dark pattern** — both marketplace routes `notFound()` while dark, whereas the six integration panels render visible disabled controls. Both are defensible; worth noting the inconsistency.
7. **`imports.ocr` is the one governed-AI call site in this domain** — dark behind the AI cheap-tier + a bound vision provider; CSV/Excel import works without it.
8. **Signup never creates an org/membership** — org + owner membership + sample-data seed happen only at `/onboarding/company` via `createOrgWithOwner`. Email/password auth additionally depends on the Supabase password-grant toggle being enabled (not verifiable from the repo).
9. **Two-switch discipline is consistent and real** — every dark integration/SSO/billing path requires flag AND credentials/config, and refuses before any network call; a stray credential cannot manufacture a live capability.
10. **SCIM/SSO return 401 (not 404) in prod** because `FEATURE_ENTERPRISE_SSO` is ON, but every org has the per-org second switch off, so no tenant is actually provisioned.

### FEATURE-FLAG → prod ON/OFF table (every flag touched in this domain)
| Flag | Gate helper / file | Prod | Effect in this domain |
|---|---|---|---|
| `FEATURE_ENTERPRISE_SSO` | `lib/enterprise-sso/flag.ts:24` | **ON** | `/settings/sso` lit admin surface; SCIM returns 401 (not 404); per-org `enabled` off everywhere |
| `FEATURE_MFA_ENFORCEMENT` | `lib/env.ts:760` | **ON (inert)** | no UI control; no org sets `organizations.require_mfa` |
| `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS` | `lib/webhooks/flags.ts:17` | **ON** | `/settings/webhooks` manager live (else "Coming soon") |
| VAPID push keys (`VAPID_PUBLIC_KEY`) | `lib/notifications/push.ts:66` | **SET** | Web Push device toggle on Settings home live |
| `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` | `lib/telephony/config.ts:21` | **OFF** | AI Receptionist voice line "Not configured" |
| `NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING` | `lib/billing/self-serve.ts:35` | **OFF** | `/settings/billing` self-serve controls hidden; mailto fallback |
| `FEATURE_PUBLIC_API_JOBS` | `lib/public-api/flag.ts:17` | **OFF** | `/api/v1/jobs` 404; key UI still live; `/developers` link hidden |
| `FEATURE_MARKETPLACE` | `lib/marketplace/flag.ts:23` | **OFF** | `/marketplace` + `/settings/marketplace` 404 while dark |
| `FEATURE_GDPR_ERASURE` | `server/services/gdpr-erase.ts:42` | **OFF** | erase route 503s; data-retention shows contact-support panel |
| `FEATURE_RETENTION_PURGE` | `server/services/retention-purge.ts:50` | **OFF** | daily purge runs dry-run only, deletes nothing |
| `FEATURE_CALENDAR_CONNECT` | `lib/integrations/calendar/oauth.ts:69` | **OFF/unset** | integrations Calendar panel dark |
| `FEATURE_ACCOUNTING_CONNECT` | `lib/integrations/accounting/oauth.ts` | **OFF/unset** | imports connector-sync + (accounting) dark |
| `NEXT_PUBLIC_FEATURE_HMRC_CONNECT` | `lib/integrations/hmrc/oauth.ts:65` | **OFF** | integrations HMRC panel dark (no disconnect) |
| `NEXT_PUBLIC_FEATURE_BANKING_CONNECT` | `lib/integrations/banking/oauth.ts:65` | **OFF** | integrations Banking panel dark |
| `NEXT_PUBLIC_FEATURE_MERCHANTS` | `lib/integrations/merchants/connect.ts:79` | **OFF** | integrations Merchants panel dark (form-bind) |
| `NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT` | `lib/integrations/telematics/oauth.ts:57` | **OFF** | integrations Telematics panel dark |
| `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` | `lib/billing/portal-stripe.ts:50` | **OFF** | integrations Payments (Stripe Connect) panel dark |
| `NEXT_PUBLIC_FEATURE_MICROSOFT_SSO` | `lib/env.ts:737` | **OFF** | Microsoft button hidden on `/login` + security linking |
| `NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING` | `lib/env.ts:745` | **OFF** | identity-linking buttons on `/settings/security` dark |
| (Automations) | none (always-on) | **n/a** | engine always on; `delay`/`ai_decision`/`webhook` workflow nodes forced to draft/disabled |
| Stripe SaaS checkout | `STRIPE_SECRET_KEY` (no flag) | **ON (approval-gated)** | super-admin mints checkout; tenant self-serve surface still dark |
| Resend email | `RESEND_API_KEY` (no flag) | **ON** | magic-link/reset/confirm (Supabase SMTP), staff-invite + portal-reply emails |
