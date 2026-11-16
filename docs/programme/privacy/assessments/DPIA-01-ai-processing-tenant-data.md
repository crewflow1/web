# DPIA-01 — AI processing of customer / tenant data (Anthropic, OpenAI)

Draft 2026-11-16 · for `[LEGAL REVIEW]` · CrewFlow role: **processor** (Anthropic / OpenAI = sub-processors); controller for the AI usage ledger.

## 1. Nature of the processing

**What happens.** Staff of a tenant company trigger a feature; the server builds a prompt from tenant data and sends it to a model provider; the answer is stored as a draft/summary that a human reviews. Every call goes through one chokepoint, `invokeWithGovernor` (`lib/ai/governor.ts`, features and tiers in `lib/ai/governor/registry.ts`), which enforces a per-organisation spend ceiling and writes a ledger row.

| Feature (registry id) | Trigger | Data sent to the provider | Code |
|---|---|---|---|
| `lead.summary` | staff open/action a lead | lead fields incl. contact name and message text | `app/(app)/leads/actions.ts`, `lib/ai/governor` |
| `quote.writer_draft` | staff click "draft with AI" | **closed disclosure contract**: no customer name/email/phone/full address — outward postcode only; typed notes as written | `lib/ai/quote-context.ts`, `lib/ai/quote-prompt.ts` |
| `site_manager.answer`, `insights.narrative`, `insights.question` | staff ask / view | job and business aggregates; free text from diaries/snags | `lib/ai/aggregates.ts`, `lib/ai/insight-narrative.ts` |
| `expense.receipt_extraction` | receipt upload | the receipt image/PDF (vision) | `app/(app)/expenses/actions.ts`, `lib/ai/vision/anthropic.ts` |
| `imports.ocr` | data import of a scan/PDF/image | the uploaded file — may be a full customer or staff list | `app/(app)/imports/actions.ts`, `lib/ai/vision` |
| `document.form_autofill` | "import a document" | the uploaded document (CVs, V5C logbooks, insurance certificates) | `server/services/document-autofill.ts` |
| `receptionist.reply_draft`, `receptionist.inbound_extraction`, `chat.auto_reply` | inbound channel message | enquiry text + caller reference — see DPIA-02 / DPIA-03 | `server/services/receptionist.ts` |
| `memory.embedding_*` (OpenAI) | HQ notes | CrewFlow's own memory text (not tenant data) | `lib/ai/embeddings` |
| tenant-search embeddings (OpenAI) | **dormant** (DB flag `tenant_search_embed_enabled`) | text from `tenant_search_documents`; money/secrets/NI numbers denied by `lib/search/semantic/mappers.ts` | |
| `voice_note.transcription` (OpenAI) | **dormant** | audio | `lib/ai/transcription/openai.ts` |

**Models and bindings.** Tiers cheap/mid/high are bound to Anthropic models in `TIER_MODEL` (`lib/ai/governor/registry.ts`); Anthropic is the default text and vision vendor (`lib/ai/text/anthropic.ts`, `lib/ai/vision/anthropic.ts`); OpenAI is a configured optional text provider (`lib/ai/text/openai.ts`) and is used for embeddings/transcription. Credentials alone cannot arm a tier (`lib/ai/governor/readiness.ts`).

**What CrewFlow keeps.** `ai_invocations`: user id, feature, model, token counts, cost, a **hash** of the prompt — not the prompt or response. Outputs live in feature tables (`leads.ai_summary`, `ai_quote_drafts`, `expense_drafts`, `form_import_drafts`). Uploaded originals for autofill are purged after 7 days (`purgeExpiredFormImports`, `server/services/document-autofill.ts`).

**Scale (production, 2026-11-13).** 580 `ai_invocations`; the HQ and imports features carry most real spend; tenant feature use is near zero (4 users). VERIFIED (register).

**Data subjects.** Tenant customers, leads, enquirers, subcontractors and — through CVs, imports and free text — tenant staff and third parties named in notes. Special-category data (health in site-diary free text; criminal-offence data is unlikely) can arrive by accident; CrewFlow has **no redaction layer** except the quote-writer contract (`PROVIDER-REGISTER.md` §2.5).

## 2. Necessity and proportionality

- **Purpose** (tenant's): drafting quotes, summarising leads, reading receipts/documents to save keying. Each has a manual alternative, which stays available (extraction failure is non-fatal: `document-autofill.ts`).
- **Lawful basis.** The tenant's, usually legitimate interests (or contract for quotes). CrewFlow acts on instruction. `[LEGAL REVIEW]` confirm the DPA names AI features and Anthropic/OpenAI as sub-processors (`../SUBPROCESSORS.md`, `../DPA-DRAFT.md`).
- **Minimisation.** Aggregates not rows for insights; quote contract excludes identifiers; embeddings deny-list; no prompt/response retention in CrewFlow's ledger. Weakness: receipts/imports/documents go whole.
- **Automated decisions (Art. 22).** None: AI "never changes invoices/quotes/jobs, never sends, never deletes" (`lib/ai/safety.ts` contract; `receptionist.ts` doctrine "the AI drafts, a human sends"). Lead scoring is deterministic (`lib/leads/score.ts`).
- **Transparency.** Tenants are not yet told which features send data to which provider (G-13). Policy draft §5 covers it once published. `[FOUNDER]` + `[LEGAL REVIEW]`.
- **Data-subject rights.** Prompts are not stored, so there is little to retrieve/erase in CrewFlow; drafts/summaries are ordinary tenant rows reachable by the DSAR export (`../DSAR-PROCEDURE.md`).
- **International transfer.** Anthropic and OpenAI process in the USA. Transfer mechanism (UK Addendum / DPF), **zero-retention / no-training terms and the retention period of API inputs** are `NEEDS-FOUNDER` (F-10, PD-6) — do not assert them publicly until confirmed from the provider's DPA/console.

## 3. Risks to individuals

| # | Risk | Likelihood | Severity | Inherent |
|---|---|---|---|---|
| R1 | Whole-document uploads send more personal data than needed (CVs, ID-like documents, staff lists) | Medium | Medium | Medium |
| R2 | Provider retains or trains on inputs contrary to what tenants were told | Low (API terms normally exclude training) — **unconfirmed** | High | Medium |
| R3 | Prompt injection via inbound text (lead/enquiry/WhatsApp) steers a draft or leaks context | Medium | Medium | Medium |
| R4 | Inaccurate AI summary/draft acted on without checking | Medium | Medium | Medium |
| R5 | Special-category or third-party data appears in free text and is sent unredacted | Low-Medium | Medium | Medium |
| R6 | Cross-tenant leakage in a prompt | Low | High | Medium |
| R7 | No per-company off switch: a tenant (or its customers) cannot opt out of AI (G-13, PD-6) | Medium | Low-Medium | Medium |
| R8 | Metadata in photographed receipts/documents (GPS, device) sent to a third country | Medium (before PD-4) | Low-Medium | Medium |

## 4. Measures and residual risk

| Risk | Existing measure (evidence) | Proposed | Residual |
|---|---|---|---|
| R1 | Quote contract; file size caps; human review of extraction; originals purged after 7 days (`document-autofill.ts`) | Tell tenants not to upload ID/CVs where not needed; consider a pre-send document-type allow-list `[FOUNDER]` | Medium |
| R2 | None in code (contractual) | Obtain and file provider DPAs and retention/zero-retention settings (`NEEDS-FOUNDER`); state in policy only what is true | **High until confirmed** |
| R3 | Prompts built from closed templates; AI outputs are drafts only; receptionist policy chokepoint (`lib/receptionist/policy.ts`); injection-hardening workstream (`security/injection-secrets-hardening`, `lib/ai`-adjacent — not this branch) | Reference its test results here once merged | Low-Medium |
| R4 | Labelled confidence, human approval (`lib/ai/safety.ts`) | — | Low |
| R5 | Prompt hash only in ledger; no redaction | Optional redaction pass for NI numbers/phone/email in free text before send — design only | Medium |
| R6 | Prompts are assembled inside the active-org context (governor requires org attribution: `lib/ai/governor/attribution.ts`); RLS | — | Low |
| R7 | Spend ceiling per org (`docs/ai-cost-governor.md`); platform kill switch = unset `ANTHROPIC_API_KEY` | Per-company AI off switch before publishing (PD-6) `[FOUNDER]` | Medium until built |
| R8 | **PD-4 built on this branch**: EXIF/GPS stripped server-side before storage (`lib/uploads/strip-image-metadata.ts`) — the stored copy is the copy sent to vision | HEIC gap noted | Low |

## 5. Consultation, sign-off, review
- Prior consultation with the ICO (Art. 36) is **not** indicated if R2 is resolved by contract; reconsider if the provider cannot give no-training/retention terms.
- Tenant consultation: publish the feature list and the right to disable (PD-6).
- Sign-off: `[LEGAL REVIEW]` ______ · `[FOUNDER]` ______ · Review date: on any new AI feature, new provider, tier rebind, or by 2027-05.
