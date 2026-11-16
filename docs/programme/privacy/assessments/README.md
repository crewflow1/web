# Privacy assessments — DPIA screening, DPIAs and Legitimate Interests Assessments

Status: **DRAFTS for legal review** (prepared 2026-11-16 on `privacy/data-minimisation`). Nothing here is legal advice, and no
document is signed off. Every processing statement is tied to a file path in this repository (evidence label VERIFIED = read in
code; NEEDS-FOUNDER = a fact only the founder / provider dashboard can confirm). `[FOUNDER]` = decision or fact needed from the
founder; `[LEGAL REVIEW]` = a judgement a qualified person must make.

## Who is the controller?

CrewFlow is a **processor** for tenant business data (customers, leads, staff, site visitors) and a **controller** for its own
data (prospects, account holders, telemetry about tenant users) — `DATA-PROCESSING-REGISTER.md` §1. This changes who owns each
assessment:

| Assessment | CrewFlow's role | Consequence |
|---|---|---|
| DPIA-01 AI on tenant data | processor (tenant instructs) + controller for the AI usage ledger | The tenant (controller) must decide whether a DPIA is needed for its own use; CrewFlow supplies this document as the processor's input under UK GDPR Art. 28(3)(f). |
| DPIA-02 WhatsApp inbound | processor for the tenant's customers' messages; Meta is an independent controller of its platform | Same. |
| DPIA-03 AI voice receptionist + recording | processor; the call is the tenant's | Same; plus PECR / Wireless Telegraphy / recording-consent rules fall on the tenant. |
| DPIA-04 Vehicle telematics | processor; the tenant is the employer tracking its vehicles/drivers | Employer monitoring — the tenant's DPIA; CrewFlow's draft is a starter. |
| LIA-01 Sentry | controller | CrewFlow's own balancing test. |
| LIA-02 B2B prospecting | controller | CrewFlow's own balancing test (plus PECR). |

## DPIA screening (UK GDPR Art. 35; ICO "likely to result in high risk" list and the nine EDPB criteria)

| Processing | Trigger(s) | Screening result | Reason |
|---|---|---|---|
| AI on tenant data (`lib/ai/governor`, `lib/ai/vision`) | innovative technology; may include children's/special-category data by accident in free text/CVs; systematic evaluation (lead scoring is deterministic, not AI) | **DPIA recommended** — drafted (DPIA-01) | New technology + third-country transfer + the model sees whatever the tenant uploads (CVs, V5C, imports) with no redaction layer. Human-in-the-loop and no automated decisions lower, but do not remove, the risk. |
| WhatsApp inbound | innovative tech + members of the public (non-customers of CrewFlow) + media (photos, voice notes) + AI-drafted replies | **DPIA recommended** — drafted (DPIA-02) | Armed in production with no traffic yet (F-19); the assessment should be finished **before** the first real message. |
| AI voice receptionist + call recording | recording of voices; innovative tech; large-scale potential; third-country processors (Twilio, Vapi) | **DPIA required** — drafted (DPIA-03) | Recording identifiable callers and AI processing of speech is on the ICO's list of processing needing a DPIA when combined with innovative technology. Dark today. |
| Vehicle telematics | systematic monitoring of employees' location | **DPIA required** — drafted (DPIA-04) | ICO: tracking employee location is high-risk monitoring. Dark today. |
| Sentry error capture | none of the high-risk triggers (no profiling, no special category, scrubbed) | **No DPIA**; LIA instead (LIA-01) | Low risk once the free-text scrub on `security/injection-secrets-hardening` ships. |
| B2B prospecting | direct marketing; data from a public register (Companies House) — Art. 14 notice | **No DPIA**; LIA + PECR note instead (LIA-02) | Small scale, business contacts. |
| Photo upload metadata | location data | **Mitigated by design** — PD-4 build (`lib/uploads/strip-image-metadata.ts`) | No DPIA needed once stripped; HEIC residual noted in DPIA-02/DPIA-04 and `DATA-MINIMISATION.md`. |
| Account/company deletion (#1091), consent banner (#1092) | privacy-enhancing | none | — |

Not screened here because they are not in this brief: payroll / staff secrets (NI number, DOB) — covered by the tenant's own
HR DPIA if any; the AI Boardroom (HQ-internal, CrewFlow's own data).

## Index

- `DPIA-01-ai-processing-tenant-data.md`
- `DPIA-02-whatsapp-inbound.md`
- `DPIA-03-ai-voice-receptionist-call-recording.md`
- `DPIA-04-vehicle-telematics.md`
- `LIA-01-sentry-error-capture.md`
- `LIA-02-b2b-prospecting.md`

Open decisions these documents depend on are tracked in `../COMPLIANCE-GAPS.md` (PD-1…PD-17) and `../FOUNDER-DECISION-CHECKLIST.md`.
