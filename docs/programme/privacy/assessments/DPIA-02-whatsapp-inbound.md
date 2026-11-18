# DPIA-02 — WhatsApp inbound (Meta Cloud API) with AI-drafted replies

Draft 2026-11-16 · for `[LEGAL REVIEW]` · CrewFlow role: **processor** for the tenant's customers' messages; Meta is an independent controller for its own platform.

**Status.** ARMED in production (F-19): `/api/health` `comms.whatsapp=true`; 1 `whatsapp_number_routes` row, 1 `whatsapp_webhook_events` row, 0 messages/conversations/opt-outs/media; real inbound delivery from Meta not yet flowing (`PROVIDER-REGISTER.md` §2.12). **This DPIA should be completed before the first real message.**

## 1. Nature of the processing

1. Meta POSTs to `app/api/webhooks/whatsapp/route.ts`. The body is verified with the app secret (`x-hub-signature-256`, fail-closed **before** parsing); the GET handshake uses the verify token. Flag `NEXT_PUBLIC_FEATURE_WHATSAPP`.
2. `server/services/whatsapp-webhook-handler.ts` claims each message in `whatsapp_webhook_events` (raw provider payload kept; at-least-once protocol), resolves the tenant from `phone_number_id` via `whatsapp_number_routes`. A message with no route is ack-dropped, never guessed onto a tenant.
3. Opt-out: STOP/START handled by `lib/receptionist/optout.ts` + `server/services/whatsapp-optout.ts` (`whatsapp_optouts`, first opt-out timestamp kept; an opted-out sender gets **no** AI turn: `receptionist.ts`).
4. Hand-off to the shared `processInboundEnquiry` (`server/services/receptionist.ts`): caller recognition (`caller-recognition.ts`), conversation rows (`receptionist-conversations.ts`), lead/enquiry creation, AI extraction (`receptionist.inbound_extraction`) and an AI **reply draft** (`receptionist.reply_draft`, `receptionist-draft.ts`) subject to the policy chokepoint `lib/receptionist/policy.ts` — default "the AI drafts, a human sends".
5. Media (photos, voice notes, documents): `server/services/whatsapp-media-pipeline.ts` fetches bytes from Meta's media API, **now strips image metadata** (PD-4), hashes (SHA-256) and stores them privately; `whatsapp-assistant-actions.ts` files a photo as a `tenant_attachments` evidence row on a job and notes on `jobs.notes`; commitments (price/booking) go to `pending_review`, never auto-created. Voice-note transcription via OpenAI is **dormant** (`lib/ai/transcription`).
6. Stale/failed events are retried by `/api/cron/whatsapp-events-sweep` (`server/services/whatsapp-events-sweep.ts`, every 15 min, 5 attempts then dead-letter). Sweeping retries only; it does **not** delete.

**Data:** sender phone number (WhatsApp id), profile name, message text, media, delivery statuses, opt-out state. **Subjects:** members of the public who message a tenant (customers, prospects) — not CrewFlow's users. **Recipients:** tenant staff; Anthropic (draft/extraction text, DPIA-01); Meta (platform); Resend for staff notifications.

## 2. Necessity and proportionality
- Purpose: answer enquiries faster and capture site photos/notes — a message the person sent **to the tenant on purpose**. Lawful basis (tenant): legitimate interests / steps at the customer's request. `[LEGAL REVIEW]`.
- Outbound is draft-first. Template/marketing messages to people who have not opted in are a PECR/Meta-policy matter for the tenant; CrewFlow's default is no auto-send (`isAutoSendable`).
- **Transparency to the sender:** WhatsApp offers no pre-message notice. The tenant's privacy notice and the first auto-acknowledgement should name the business and link the notice. `[FOUNDER]` decide the acknowledgement wording; `[LEGAL REVIEW]`.
- Meta transfers: Meta is its own controller; CrewFlow's DPA must say so (`../PROVIDER-REGISTER.md` §2.12).

## 3. Risks

| # | Risk | L | S | Inherent |
|---|---|---|---|---|
| R1 | Raw webhook payloads (phone, name, text) kept indefinitely in `whatsapp_webhook_events` | High (certain once live) | Medium | Medium-High |
| R2 | Messages mis-attributed to the wrong tenant | Low | High | Medium |
| R3 | AI reply sent without human review, wrong or inappropriate | Low | Medium | Low-Medium |
| R4 | Photo EXIF/GPS from a customer's phone stored | High (before PD-4) | Medium | Medium |
| R5 | Opt-out ignored | Low | Medium | Low-Medium |
| R6 | Special-category or child data in free text/media | Low | Medium-High | Medium |
| R7 | Forged webhook injects data | Low | Medium | Low |
| R8 | Prompt injection in message text | Medium | Medium | Medium |

## 4. Measures and residual risk
| Risk | Measure (evidence) | Gap / proposal | Residual |
|---|---|---|---|
| R1 | Org erasure removes them (`gdpr-erase`) | **No age rule** (PD-15) — needs founder period; `RETENTION-PROCEDURES.md` | Medium until PD-15 |
| R2 | Route lookup, ack-drop of unrouted (`whatsapp-webhook-handler.ts`); tenant isolation proven in the comms sandbox (memory: comms sandbox 2026-11-11) | — | Low |
| R3 | Policy chokepoint, audit record of every draft (`receptionist.ts`) | — | Low |
| R4 | **Built here**: stripped before store (`whatsapp-media-pipeline.ts`); HEIC passes through unchanged (sharp has no HEVC decoder) | WhatsApp normally delivers JPEG; verify `[FOUNDER]` with a real phone | Low |
| R5 | `whatsapp_optouts`; no AI turn after STOP | — | Low |
| R6 | Human review before any reply; no redaction | Staff guidance | Medium |
| R7 | HMAC verification fail-closed | — | Low |
| R8 | Draft-only, closed prompts | See security workstream | Low-Medium |

## 5. Sign-off
`[LEGAL REVIEW]` ______ · `[FOUNDER]` ______ · Review at first real inbound message, then 6-monthly.
