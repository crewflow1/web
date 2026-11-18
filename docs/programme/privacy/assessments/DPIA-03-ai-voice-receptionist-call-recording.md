# DPIA-03 — AI voice receptionist and call recording (Twilio, Vapi)

Draft 2026-11-16 · for `[LEGAL REVIEW]` · CrewFlow role: **processor**; Twilio and Vapi are sub-processors.

**Status.** DARK. `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` defaults `"false"` (`lib/env.ts`), no Twilio/voice-provider credentials, `calls`/`call_events`/`phone_numbers` = 0 rows in production; the founder's Twilio account is a trial (activation gated on upgrade and UK number regulatory bundle). Recording is **off per tenant by default** (`lib/telephony/answering-config.ts`: `recordingEnabled: false`, `transcriptionEnabled: false`). This DPIA must be signed off **before** any tenant switches voice on.

## 1. Nature of the processing

| Step | What happens | Code |
|---|---|---|
| Inbound call | Twilio posts to the voice webhook; request signature checked; the dialled number resolves to a tenant via `phone_numbers` | `app/api/webhooks/twilio/voice/route.ts`, `lib/telephony/router.ts` |
| Staff-first | Rings the tenant's staff numbers in hours; only unanswered/after-hours calls reach the AI (modes in `answering-config.ts`) | `answering-config.ts`, `dial-status/` |
| Consent line | If recording is enabled, the caller hears the configured consent message **before** the recorded leg; default "this call may be recorded for quality and training purposes" | `voice/route.ts` (`DEFAULT_CONSENT`), settings UI `app/(app)/settings/ai-receptionist/_form.tsx` |
| AI conversation | Vapi hosts the voice agent (speech-to-text, LLM, text-to-speech); CrewFlow answers its webhook with the assistant config and tool results; turns are persisted | `app/api/webhooks/vapi/route.ts`, `lib/telephony/providers/vapi.ts`, `lib/telephony/ai-turn.ts` |
| Recording | Twilio recording-status callback stores `recording_url` on the call row; Vapi's end-of-call report carries its own `recordingUrl`, transcript and summary | `voice/recording-status/route.ts`, `server/services/telephony.ts` (`updateCallCompletion`), `vapi.ts` |
| Extraction | Transcript → lead/enquiry via governed AI (`receptionist.inbound_extraction`), AI summary on the call | `server/services/receptionist.ts` (`refreshVoiceExtractionFromTranscript`) |
| Urgent transfer | Optional urgent number the AI can transfer to | `answering-config.ts` (`urgentNumber`) |
| Missed-call text-back | SMS to the caller | `processMissedCallTextback`, `missed_call_textbacks` |

**Data:** caller number, voice audio (biometric-capable but not processed as biometric ID), transcript (`calls.transcript`, `transcript_json`), AI summary/extraction (`ai_extracted`), spoken name/address/postcode/job description, call metadata; tenant-selected recording and transcript flags. **Subjects:** callers (members of the public, tenant customers, sometimes tenant staff). **Recipients:** Twilio (US), Vapi (US `[FOUNDER]` confirm region), Anthropic/OpenAI per `ai_*` binding, tenant staff. `calls` rows are RLS-scoped to the tenant (service-role writes only for enrichment: `telephony.ts`).

## 2. Necessity and proportionality
- Purpose: never lose a lead when staff cannot answer. Alternative (voicemail) exists and remains the fallback when the AI is off.
- **Recording is the highest-risk element and is optional.** Tenant-level choice, off by default, with a mandatory pre-recording disclosure. `[LEGAL REVIEW]` confirm: wording sufficient for UK GDPR transparency and for PECR/Telecoms (Lawful Business Practice) rules; whether callers can **decline** recording (today there is no keypress opt-out: `[FOUNDER]` decide).
- **AI disclosure.** The caller should be told they are speaking to an AI. Check the default greeting (`buildReceptionistGreeting`, `lib/telephony/receptionist-profile.ts`) says so; `[FOUNDER]`/`[LEGAL REVIEW]`.
- Lawful basis (tenant): legitimate interests for answering/recording for quality; consent where the tenant wants to rely on it. Recording of calls with special-category content (health, e.g. "I'm disabled, need a stairlift") is possible → tenant guidance.
- Minimisation: transcripts and recordings only if the tenant enables the flags; recording URL is a provider-hosted URL, audio not copied into CrewFlow storage (`recording-status/route.ts` stores the URL only). `NEEDS-FOUNDER`: how long Twilio/Vapi keep audio and transcripts, and who can open the URL.
- **Retention:** no age rule for `calls`, `call_events`, `recording_url`, `transcript` (PD-13/PD-15 region; `RETENTION-PROCEDURES.md`). **Needs a founder-decided period before activation.**
- Rights: erasure/DSAR must reach `calls.*` and, separately, the provider-held audio; procedure not yet defined for provider-side deletion. `[FOUNDER]`.

## 3. Risks

| # | Risk | L | S | Inherent |
|---|---|---|---|---|
| R1 | Recording without adequate notice or lawful basis | Medium | High | High |
| R2 | Recordings/transcripts kept indefinitely | High | Medium | Medium-High |
| R3 | Provider-hosted recordings accessible by anyone with the URL / retained by provider beyond CrewFlow's deletion | Medium | High | High |
| R4 | AI mis-hears or invents details; staff act on wrong data | Medium | Medium | Medium |
| R5 | Callers do not realise they speak to an AI | Medium | Medium | Medium |
| R6 | Special-category data in speech (health) processed by AI providers | Low-Medium | High | Medium |
| R7 | Caller number/voice reused for anything beyond the call | Low | Medium | Low |
| R8 | Cross-tenant routing error | Low | High | Medium |
| R9 | Transfer to US processors | Certain | Medium | Medium |

## 4. Measures and residual risk
| Risk | Measure | Gap / proposal | Residual |
|---|---|---|---|
| R1 | Off by default; consent line plays before recording (`voice/route.ts`) | Decline path; legal wording | Medium until reviewed |
| R2 | none | Founder retention period then a purge (do **not** build until set) | High until decided |
| R3 | URLs stored RLS-scoped; org erasure covers rows | Confirm provider access controls + deletion API `NEEDS-FOUNDER` | High until confirmed |
| R4 | Transcript kept for owner verification; AI never books/prices (`receptionist.ts` doctrine) | — | Low |
| R5 | Greeting configurable | Mandate an AI disclosure phrase `[FOUNDER]` | Medium |
| R6 | Tenant controls recording/transcription flags | Staff guidance | Medium |
| R7 | Purpose-limited to enquiry | — | Low |
| R8 | `phone_numbers` route table; route writes restricted to service role (security workstream migration 364) | — | Low |
| R9 | — | DPA + transfer mechanism with Twilio/Vapi `NEEDS-FOUNDER` | Medium |

## 5. Sign-off
Not recommended to activate until R1-R3 and R5 are closed. `[LEGAL REVIEW]` ______ · `[FOUNDER]` ______.
