# WhatsApp AI Assistant — Architecture, Operations & Go-Live

> Directive #018 R6. Draft-first, human-gated WhatsApp channel for the AI Receptionist.
> **Status: built, tested, DARK. Not live** — activation is gated behind external Meta
> provisioning (see [External blockers](#external-blockers)) and per-org enablement.

This document is the operational source of truth for the WhatsApp channel. It describes what
ships across PRs #359 (inbound foundation), #360 (draft-first engine) and #361 (outbound +
receipts), the safety model, the configuration runbook, and the go-live checklist.

---

## 1. What it is (and is not)

The WhatsApp AI is **Employee #27** (`docs/bible/workforce/employees/27-whatsapp-ai.md`): a
Tier-**T3 channel** agent that **triages, classifies, drafts and routes** — and **sends nothing
substantive without a human approval**. It is **not a second AI system**: an inbound WhatsApp
message runs the *existing* AI Receptionist reasoning engine (`runConversationTurn`) and surfaces
its draft in the *existing* operator review inbox. WhatsApp is a **channel configuration** of that
substrate, not a fork of it.

**Governing safety posture (Part 4):** the system may autonomously receive, classify, load
context, draft, recommend, route and create internal notifications. It **must not** autonomously
send a substantive message to a real customer. All substantive outbound is enforcement-gated,
feature-flagged, org-scoped, auditable, and human-approved. **No SMS fallback.** With no configured
WhatsApp provider, transport fails **dark** and records the reason.

---

## 2. End-to-end architecture

```
Inbound (Meta → us)                         Outbound (us → Meta, human-approved, DARK by default)
────────────────────                        ─────────────────────────────────────────────────────
Meta Cloud API webhook                       Operator opens the review inbox
  POST /api/webhooks/whatsapp                  sees draft + confidence + policy verdict + channel badge
  1. rate-limit                                approves / edits  ──► dispatchHumanReviewedReply
  2. read RAW body                                                    │ re-enforces policy (block refused)
  3. verifyMetaSignature (HMAC, timing-safe)                          │ transportChannelForInbound → "whatsapp"
  4. parse envelope                                                   │ getTransportProvider("whatsapp")
  5. processMetaWhatsAppPayload                                       ▼
       normalize messages + statuses          getWhatsAppProvider()  ── null (dark) ─► record no_provider, SEND NOTHING
       per item: claimEvent (atomic)                     │ configured ─► Meta Graph POST /{id}/messages
         message → resolveOrgForNumber                   ▼                     │ 2xx → wamid ─► transport 'sent'
           routed → processInboundEnquiry       ai_reply_transports (channel='whatsapp')   │ non-2xx → throw → 'failed'
             → runConversationTurn (the engine)                                             ▼
             → draft + verdict → ai_reply_audits          Meta delivery/read webhook (status)
             → review verdict → review inbox                POST /api/webhooks/whatsapp
           unrouted → ack-drop (HQ audit)                    handleStatus → recordWhatsAppDeliveryReceipt
         status → recordWhatsAppDeliveryReceipt                correlate by wamid → ai_reply_delivery_receipts
```

### Components

| Concern | Where | Notes |
|---|---|---|
| Webhook edge | `app/api/webhooks/whatsapp/route.ts` | GET hub.challenge · POST verify→dispatch |
| Signature / parse / normalize | `lib/comms/providers/meta-whatsapp.ts` | fail-closed HMAC, permissive parse |
| Ingress claim + routing + hand-off | `server/services/whatsapp-webhook-handler.ts` | claim-before-act, ack-drop unrouted |
| Channel eligibility (the ONE gate) | `server/services/receptionist-channel-eligibility.ts` | `canRunReceptionistChannel` |
| Reasoning engine (reused) | `server/services/receptionist.ts` `runConversationTurn` | intent/goal/…/policy/audit |
| Transport chokepoint | `receptionist.ts` `transportReply` + `transportChannelForInbound` | channel-aware, no fallback |
| Provider registry | `lib/comms/index.ts` `getTransportProvider`/`getWhatsAppProvider` | dark by default |
| Outbound sender | `lib/comms/providers/meta-whatsapp-sender.ts` | Graph API, throw-on-failure |
| Receipt authority | `receptionist.ts` `recordWhatsAppDeliveryReceipt` | shared core, distinct writer |
| Operator review | `app/admin/ai-receptionist/review/*` | channel-agnostic + WhatsApp badge |

---

## 3. Routing model (Part 14)

`whatsapp_number_routes` maps a Meta `phone_number_id` → one `org_id`.

- `phone_number_id` is **globally UNIQUE** — one active route per number, so **cross-org takeover
  fails** at the DB (a second org cannot claim a number another org owns).
- `active` gates processing: a deactivated route resolves to no org → the inbound is **ack-dropped**,
  never processed against a guessed org.
- An unroutable number writes an **HQ audit event** (`whatsapp.unrouted_number`), never tenant data.
- Changing a route does not rewrite historical messages (enquiries/audits carry their own `org_id`).

**Per-org enablement** is a SECOND gate on top of routing: `ai_receptionist_setups.enabled = true`
AND `status = 'live'`. Routing attributes an inbound to an org; enablement decides whether that org's
messages reach the AI. Both must hold (plus the global flag) for a WhatsApp message to be drafted.

---

## 4. Claim / retry / idempotency model

Meta delivers **at-least-once** and retries on any non-2xx. Every message and status is **claimed
before it is acted on** (`whatsapp_webhook_events`, the billing_events/automation_runs protocol):

- `event_key` UNIQUE (`msg:<wamid>` / `status:<wamid>:<st>`) — an atomic INSERT is the claim; a
  concurrent/retry loser reclaims ONLY a `processed_at IS NULL` row that failed or whose 15-min
  lease expired. `processed_at` — never row existence — is the sole proof of completion.
- **Downstream backstop:** `inbound_enquiries` partial-unique `(org_id, provider_message_id)` makes a
  second ingestion of the same wamid a no-op (23505 → short-circuit).
- **Receipts** are append-only, idempotent (`on conflict (provider_message_id, status) do nothing`),
  and **out-of-order-safe**: each `(wamid, status)` is one immutable row; `read` is **non-terminal**,
  so a late `delivered` after `read` cannot regress state.

A verified delivery always returns **200** (the per-item claim makes Meta's whole-batch retry safe);
only a signature/verification failure is 401/403.

---

## 5. AI draft-first + human-approval policy (Parts 4, 7, 8, 13)

- Inbound WhatsApp runs the **unchanged** engine: intent → goal → information → gap → strategy →
  prompt → response → outcome → action, then policy enforcement produces an `allow | review | block`
  verdict recorded in `ai_reply_audits` (channel = `whatsapp_msg`).
- Substantive replies (commitment categories — price/booking/legal/guarantee — or any clean draft
  over the acknowledgement length) are held for **review**; only a short clean acknowledgement is
  `allow`. The engine **never fabricates** prices, dates, availability, invoice/payment facts — those
  come from deterministic CrewFlow authorities; missing context yields a safe clarification draft.
- **Safe tool access (Part 13):** WhatsApp reuses the existing engine's tool posture — read/draft
  capabilities only; booking execution is default-OFF and the strongest autonomy is
  `requires_human_review`. No WhatsApp-specific business logic; no new autonomous action.
- **Review inbox (Part 8):** a `review` verdict surfaces automatically in the channel-agnostic
  operator inbox (`receptionist_review_queue`, filtered only by `verdict='review'`) with a WhatsApp
  channel badge. The operator sees the draft, confidence, verdict, conversation history, and can
  approve/edit/reject. An operator-approved send routes over the **WhatsApp** transport (never SMS);
  while the provider is dark it records `no_provider` and sends nothing.

---

## 6. Feature-flag model

| Flag / config | Default | Gates |
|---|---|---|
| `NEXT_PUBLIC_FEATURE_WHATSAPP` | `false` | the entire inbound + engine path (global dark switch) |
| `ai_receptionist_setups.enabled` + `status='live'` | off / `not_started` | per-org WhatsApp enablement |
| `COMMS_WHATSAPP_PROVIDER` + `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` | unset | outbound sender (absent ⇒ dark, `no_provider`) |
| Autonomous acknowledgements | **not built in v1** (deferred) | see §9 |

**Launch sequence:** dark (flag off) → per-org enable (`enabled+live`) with outbound still dark →
provision Meta creds to enable operator-approved outbound → (future, governance-gated) autonomous
acknowledgements. Each step is independently reversible.

---

## 7. Configuration runbook (Meta setup)

1. **Meta developer app** + a WhatsApp Business Account (WABA); complete business verification.
2. **Register a sender** (business phone number) → note its `phone_number_id`.
3. Set env (see [readiness matrix](#env-readiness)): `WHATSAPP_APP_SECRET` (signs webhooks),
   `WHATSAPP_VERIFY_TOKEN` (handshake), `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (sender).
   Secrets go in Vercel project env — **never** in a tenant table, never exposed to the browser.
4. **Subscribe the webhook**: `https://<host>/api/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`.
   Meta issues a GET `hub.challenge`; the route echoes it iff the token matches (else 403).
5. Insert a **route**: `whatsapp_number_routes(phone_number_id, org_id, active=true)`.
6. Enable the org: `ai_receptionist_setups(enabled=true, status='live')`.
7. Flip `NEXT_PUBLIC_FEATURE_WHATSAPP=true`.

Until step 7 (and per-org enablement) the channel is dark; until the access token is set, outbound
is dark regardless.

---

## 8. Troubleshooting

- **Webhook not verifying:** wrong `WHATSAPP_VERIFY_TOKEN`, or the flag is off (GET returns 404 when
  `!isWhatsAppInboundLive()`). Check the token matches Meta's subscription config.
- **Inbound not drafting:** confirm the global flag, the route (`active=true`, correct
  `phone_number_id`), AND per-org `enabled+status='live'`. An unrouted number logs
  `whatsapp.unrouted_number` in the HQ audit log.
- **Replay / duplicate delivery:** expected and harmless — the ingress claim + the enquiry
  partial-unique fold it to one side-effect set. Look for `duplicates` in the batch result.
- **Outbound "sends nothing":** provider is dark — `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`
  unset. The transport row shows `channel='whatsapp', status='failed', failure_reason='no_provider'`.
- **Outbound `provider_error`:** Meta rejected the send (out-of-window free-form #131047/#470, bad
  token, rate-limit). The reply is preserved for re-approval; nothing is silently lost.
- **Receipt not recorded:** an `unknown_message` result means no SENT transport matched the wamid
  (every wamid while outbound is dark) — benign. A genuine write error leaves the status event retryable.

---

## 9. Known limitations & deliberate deferrals

- **Media v1 boundary (Part 12):** METADATA ONLY. `has_media` is persisted on the enquiry; a media
  message's caption folds into `raw_text`; the operator sees a safe placeholder (`[image] …`). Rich
  media is **not** downloaded, stored, or interpreted; no provider secret or signed URL is exposed.
  Raw provider references live only in `whatsapp_webhook_events.payload`. Rich-media download + AI
  interpretation is a future ring.
- **Autonomous acknowledgements (Part 15): NOT built in v1.** The spec permits only a narrow,
  pre-approved, templated acknowledgement set as the single sanctioned autonomous exception, default
  disabled. To keep v1 maximally safe (everything human-approved), the acknowledgement system is
  **deferred**, not invented. When built it must be: default-off, per-org, deterministic/templated,
  versioned, auditable, and security-tested. No broad autonomy is introduced here.
- **Templates:** outbound is free-form text only (an operator-approved reply is by construction inside
  Meta's 24-hour customer-care window). Out-of-window sends are Meta-rejected → recorded failures.
  Template classification awaits the gateway's template registry (a later ring).
- **`read` read-model precedence:** `read` is recorded but non-terminal; the lifecycle view surfaces
  `delivered` over `read` when both exist (an under-report, never a write-path error). Ranking
  `read > delivered` in the view is an optional read-only follow-up.

---

## 10. Deployment, rollback & monitoring

- **Migration order (additive, dark):** `20260917` (webhook events) → `20260918` (routes) →
  `20261043` (enquiry provider metadata) → `20261044` (transport/receipt channel widen) → `20261045`
  (receipt `read` status). All additive supersets — safe to apply ahead of code with zero customer
  impact while the flag is off. See the release inventory for the full directive-to-main plan.
  The last three were **renumbered** from `20260919`/`20260920`/`20260921` when this stack was
  consolidated onto `main` — those version prefixes were already applied in production by unrelated
  migrations (snags / site-diary / toolbox-talks), and Supabase keys identity on the numeric prefix,
  so the originals would have been silently skipped. `20260917`/`20260918` are already applied
  (#359) and are unchanged.
- **Rollback:** `NEXT_PUBLIC_FEATURE_WHATSAPP=false` is an **instant** kill switch (inbound path
  fails closed). Outbound is separately killed by clearing the access token. Migrations are additive,
  so **no schema rollback is required** — the tables simply sit unused.
- **Monitoring:** watch `whatsapp_webhook_events` for `processed_at IS NULL` inflight rows and
  `error_message` (stuck/failed ingress); transport `no_provider` counts (expected while dark);
  review-queue depth (operator SLA); receipt correlation misses (`unknown_message`).

<a id="external-blockers"></a>
## 11. External blockers (must be provisioned before "live")

The feature is **NOT live** until all of these are provisioned and production is deployed:

- Meta developer app + WhatsApp Business Account
- Business verification (where required by Meta)
- Sender (phone number) registration → `phone_number_id`
- App secret (`WHATSAPP_APP_SECRET`) · verify token (`WHATSAPP_VERIFY_TOKEN`)
- Access token / system-user token (`WHATSAPP_ACCESS_TOKEN`)
- Webhook subscription pointing at `/api/webhooks/whatsapp`
- Approved message templates (only if out-of-window sending is later required)

<a id="env-readiness"></a>
## 12. Environment readiness matrix

| Var | Purpose | Required to activate? | Secret? |
|---|---|---|---|
| `NEXT_PUBLIC_FEATURE_WHATSAPP` | global dark switch (inbound + engine) | yes (`true`) | no |
| `WHATSAPP_APP_SECRET` | signs/verifies inbound webhooks (HMAC) | yes | **yes** |
| `WHATSAPP_VERIFY_TOKEN` | GET hub.challenge handshake | yes | **yes** |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph bearer (outbound) | to send | **yes** |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta business number id (outbound) | to send | no |
| `WHATSAPP_GRAPH_VERSION` | pins Graph API version (default `v21.0`) | no | no |
| `COMMS_WHATSAPP_PROVIDER` | selects the outbound provider (`auto`/`meta`/off) | no | no |

## 13. Go-live checklist

- [ ] Meta app + WABA + business verification complete
- [ ] Sender registered; `phone_number_id` recorded
- [ ] All secrets set in production env (app secret, verify token, access token)
- [ ] Webhook subscribed + verified (GET hub.challenge returns the challenge)
- [ ] `whatsapp_number_routes` row for the org (active)
- [ ] `ai_receptionist_setups` enabled + `status='live'` for the org
- [ ] Migrations `20260917`, `20260918` (already applied via #359) and `20261043`–`20261045` applied in production
- [ ] Smoke test (dark): signed synthetic POST → enquiry + review draft created, **no outbound**
- [ ] Operator trained on the review inbox WhatsApp flow
- [ ] `NEXT_PUBLIC_FEATURE_WHATSAPP=true` (final step)
- [ ] Monitoring dashboards live (ingress inflight/errors, review depth)
