# Machine-facing doors — tenant resolution review

Workstream: security · branch `security/injection-secrets-hardening` (off `origin/main` `d24295e8`) · 2026-11-16.
Scope: service-role code that takes ids from webhook payloads, provider callbacks, OAuth returns, SCIM/SSO and the public API — the part the earlier ~110-entry-point trace did not cover. Question asked of each door: **is the tenant resolved from a verified source, and is every write pinned to it?** Signature verification itself is in [`webhook-verification-matrix.md`](./webhook-verification-matrix.md) and is not repeated. Evidence labels per `AGENT-RULES.md` §5.

## Headline

| Sev | Id | Finding | Status |
|---|---|---|---|
| P1 (at activation; feature dark) | S-1 | A tenant-scoped connection row's Stripe connected-account id was trusted by id alone for the onboarding link, the status refresh and portal checkout. | **FIXED** — `eb21e75e`. Ownership is proven from platform metadata stamped at account creation (`accountBelongsToOrg`). 9 adversarial tests fail with the check removed. **VERIFIED** |
| P1 (at activation; channels dark) | S-2 | Write posture of two inbound routing tables (voice/SMS, inbound email). | **NOT FIXED — needs a migration slot.** Staged SQL: [`staged/route-tables-service-role-write.sql`](./staged/route-tables-service-role-write.sql), verified locally inside a rolled-back transaction. Detail in the lead report. |
| P2 (activation gate; dark) | S-3 | Merchant trade-account connection accepts an account number without proof of ownership and falls back to the deployment API key when no per-account secret is given. | **NOT FIXED — NEEDS-FOUNDER.** Depends on the merchant contract: require a per-account secret or merchant-side verification before activation. |
| P3 | S-4 | SSO session minting is not implemented (OIDC callback / SAML ACS stop at "verified + matched"). When wired, the session must be scoped to the IdP's org: a user who is a member of several orgs must not gain the others through one org's IdP. | Advisory — **NOT-IMPLEMENTED** surface. |
| P3 | S-5 | SCIM deprovision can remove an org's last owner (org's own IdP; HQ-recoverable). | Documented. |
| P3 | S-6 | Customer-portal tokens stored in plaintext, expiry optional; quote `public_token` (UUIDv4) has no rotate control (privacy G-19). Rotation exists for portal tokens. Hashing needs a migration. | Documented. |
| P3 | S-7 | Defence in depth: two `inbound_enquiries` updates in `processInboundEnquiry` filter by id only (the id is always org-derived, so not exploitable); `calls` and `calendar_watch_channels` are member/admin-writable through the Data API (ids are provider-generated / random, own-org only). | Documented. |

## Door-by-door

| Door | Tenant source | Writes pinned | Evidence |
|---|---|---|---|
| Twilio voice (`/voice`, `/gather`, `/status`, `/dial-status`) | dialled number in the signed payload → `phone_numbers` (`lib/telephony/router.ts`) | yes — every `calls`/`call_events` read/write carries `org_id`; cross-org CallSid collision refuses (`server/services/telephony.ts:105-125`) | read |
| Twilio `/recording-status` | CallSid → existing `calls` row (`resolveOrgForProviderCall`) | yes (`updateCallCompletion(orgId, …)`) | read |
| Twilio `/sms-status`, WhatsApp statuses | provider message id → our own outbound transport row (RPC `record_ai_reply_delivery_receipt`, not anon/authenticated-executable) | yes | read + catalogue |
| Vapi webhooks | dialled number → `phone_numbers` | yes | read |
| Internal channel door `/api/receptionist/inbound` | destination → route tables (`lib/receptionist/inbound-org-resolver.ts`); body `org_id` only cross-checked | yes | read (see S-2 for the route tables) |
| WhatsApp | `phone_number_id` in the HMAC-signed body → `whatsapp_number_routes` (service-role-write since `20261229`) | yes | read + catalogue |
| Inbound email | destination address → `email_inbound_routes` | yes | read (see S-2) |
| Calendar push | per-channel row (random server-generated id) + constant-time token; composite FK pins channel→connection→org | own org only | read + catalogue |
| Stripe invoice webhook | intent row WE created, looked up by session / PI id; connected account must equal the intent's | yes | read (S-1 closes the creation side) |
| OAuth returns (accounting, calendar, banking, telematics, HMRC, Stripe Connect) | signed-in session's active org + admin role; `state` cookie compared in constant time | yes | read |
| SCIM `/scim/v2/**` | hashed bearer → `org_scim_config.org_id`; no client write grant on that table | yes — every read/delete `.eq("org_id", auth.orgId)`; never creates users or memberships | read + catalogue |
| SSO OIDC / SAML | `[orgId]` path + that org's enabled config; subject mapped only to an existing membership of that org | no session minted (S-4) | read |
| Public API `/api/v1/**` | hashed API key (revocation/expiry re-checked per call) | yes — reads and writes `.eq("org_id", key.orgId)`; foreign `customer_id`/`job_id` verified in-org; PATCH column allow-lists | read (all 15 route files) |

## Auth tokens and sessions

- **Role change / removal:** authority is re-derived from `memberships` on every request (`server/auth/session.ts` `getOrgForUser`, request-scoped `cache()` only; no JWT role claims; RLS uses `current_org_ids()`), so a demotion or removal takes effect on the next request. **VERIFIED (static)**.
- **Tokens in telemetry:** Sentry scrubber now masks path-borne capability tokens, signature headers, emails and phone numbers in free text (`lib/monitoring/scrub.ts`, both test files green); analytics masks path tokens (`c949f78e`). Logs reviewed for token values on the doors above: none found.
- **Client bundles:** see the lead report for the post-build grep of `.next/static`.
