# Document-to-form autofill (Feature 2) — Phase 1

Upload a document next to any supported "Create" button, let a vision model
propose the form's values, review them, and save the record through the normal
validated form. One shared pipeline, not dozens of integrations.

Status: **Phase 1** — the shared pipeline + a shared `<ImportButton>`, proven
end-to-end on one representative form per domain. Not merged, not deployed; no
production migrations applied. Full form coverage is an explicit follow-up
(`DOCUMENT-AUTOFILL-COVERAGE.md`).

---

## What the operator sees

1. A secondary **Import** button (upload icon) sits immediately beside the
   create button, shown only where the operator can create that record type.
2. They pick a PDF or photo (the native picker offers the camera on mobile).
3. A dialog reads the document and shows proposed values with per-field
   confidence / "check this" / "not found" markers. **Nothing is saved.**
4. "Use these values" carries the proposal into the **existing** create form
   (prefilled, with a banner). They edit anything and save as normal.

If AI reading is off (today's production default) the dialog says so and
"Continue to form" still opens the (empty) create form — extraction never blocks
manual entry.

## Architecture

```
<ImportButton formType>                         components/import/import-button.tsx
   │ file picked (PDF/JPG/PNG/WEBP/HEIC, ≤15MB; camera on mobile)
   ▼
startImportAction (FormData)                     components/import/actions.ts  ("use server")
   ▼
startDocumentImport()                            server/services/document-autofill.ts
   ├─ requireOrgContext()                        auth + tenant
   ├─ authorise (capability / admin / member)    mirrors the create action
   ├─ validate type + size                       (bucket enforces again)
   ├─ upload → private bucket  {org}/{draft}/…    form-imports (RLS: org folder + owner)
   ├─ extractForForm()                           lib/imports/autofill/extract.ts
   │     └─ getVisionProvider() → invokeWithGovernor("document.form_autofill","classification")
   │          parse → STRICT zod schema          lib/imports/autofill/schemas.ts
   ├─ insert form_import_drafts (tenant client)  RLS: org + self
   └─ recordAdminActivity (NO document contents)
   ▼
review dialog → "Use these values"
   ├─ route target:  /<new>?import=<draftId>     → page reads loadImportDraftDefaults() → form `defaults`
   └─ event target:  window event + prefill      → existing modal prefills itself (staff invite)
   ▼
operator edits → existing create ACTION saves the record (the only writer)
```

### The one pipeline, the reused parts

- **Vision transport + cost governance are NOT new.** Extraction goes through
  the shared vision door (`lib/ai/vision`) and the AI Cost Governor
  (`lib/ai/governor`, feature `document.form_autofill`, classification → cheap
  tier) — the same path `server/services/expense-drafts.ts` and
  `lib/imports/ocr.ts` already use. No new SDK construction, no new credential
  read (pinned by `__tests__/security/ai-governance-closure.test.ts`).
- **The registry** (`lib/imports/autofill/registry.ts`) is the single source of
  truth per form: capability, target, schema, field labels, prompt, upload hint.

## Security

- **Auth + tenant isolation.** Every entry resolves `requireOrgContext`. The
  draft row is written through the tenant client so its RLS (org + self) is the
  enforcement; the document lands under the org's storage folder (bucket RLS,
  owner-scoped read/delete). Integration-proven:
  `__tests__/integration/rls/form-import-drafts-isolation.test.ts`.
- **Capability gating.** The server action authorises the operator for the
  target record's **create** permission — the same check the create action makes
  (customer → `customers:create`; staff → `canManageStaff`; supplier/job/RAMS →
  org member). The `<ImportButton>` is render-gated on the same decision.
- **Field-level scoping (the allowlist).** The extraction schema is strict: zod
  strips unknown keys, so no crafted document can smuggle a field the form does
  not declare. **Staff autofill carries identity fields only — never pay,
  emergency contacts, or role** (column-ACL-restricted / privileged). Pinned by
  `__tests__/security/document-autofill-field-scoping.test.ts`.
- **Never silently creates/modifies.** A draft is suggestions; the existing
  create action is the only writer, after human review. No payment/payroll is
  auto-submitted.
- **Injection-safe.** The document reaches the model only as a vision
  document/image block (data), never in the system/instruction channel; the
  instruction is fixed. A malicious document's worst case is a bad suggestion
  the operator reviews — and the output schema nulls anything malformed and
  invents nothing. (`__tests__/imports/autofill-extract.test.ts`.)
- **Minimal retention.** Only the STRUCTURED proposed values are stored (needed
  for prefill) — never the document's raw OCR text. The original bytes live in
  the private bucket under a retention window; `purgeExpiredFormImports`
  (`AUTOFILL_RETENTION_DAYS = 7`) deletes expired/consumed documents and rows.
  The extraction event is audited (`recordAdminActivity`) WITHOUT its contents;
  the AI spend is in the governor ledger (a SHA-256 of the bytes, never bytes).
- **Cost/latency controls.** The governor refuses over the £100/org/month
  ceiling, dedupes a re-uploaded document, caps output tokens, and times out at
  20s. All degrade to an empty proposal.

## Tests

- Unit: `__tests__/imports/autofill-{schemas,extract,registry}.test.ts`
  (cleaners, parsing, injection/mass-assignment defence, confidence cap,
  registry ↔ DB ↔ schema alignment).
- Security: `__tests__/security/document-autofill-field-scoping.test.ts`
  (allowlist, staff pay/role exclusion, governed-feature registration).
- Integration (real Postgres): `__tests__/integration/rls/form-import-drafts-isolation.test.ts`
  (org isolation, self-scoping, WITH CHECK, form_type CHECK).
- E2E: `e2e/document-import.spec.ts` (customer import → review → prefilled form →
  save; dark-AI "Continue to form" path — the honest production default).

## Deploy & migration plan

1. **Migrations** (additive, forward-only; apply in order, human-approved):
   - `20261262000000_form_imports_bucket.sql` — private `form-imports` bucket +
     storage RLS (org folder + owner).
   - `20261264000000_form_import_drafts.sql` — `form_import_drafts` table + RLS
     (org + self) + explicit `authenticated` grant (30-Oct Data-API rule) +
     indexes + updated-at trigger.
   (Prefix `20261263000000` is the parallel notification-privacy session's;
   `20261261000000` is the customer-search session's — coordinated, no gap in
   correctness, just a reserved slot.)
2. **No new environment variable.** The pipeline uses the existing vision door,
   which is dark until a vision cost tier is bound. Shipping this changes nothing
   observable about spend until that binding exists.
3. **No code gate to flip.** The feature is live on merge+migrate in its dark
   form (uploads store, drafts record, extraction returns empty). It becomes
   generative the day the cheap tier is bound — see the external dependency.

### External dependency (AI credential) — stated explicitly

Live extraction requires the **cheap vision tier to be bound + credentialed**
(`TIER_MODEL.cheap` in `lib/ai/governor/registry.ts` + `ANTHROPIC_API_KEY`, per
the governor's activation rules). **This is a CEO/ops decision, not part of this
PR, and has NOT been done.** Until then every import honestly degrades to an
empty proposal and the operator fills the form by hand — which is exactly the
behaviour the e2e proves. **Live extraction has NOT been tested end-to-end
against a model; the extraction logic is unit-tested with mock responses and the
full pipeline is proven in its dark form.**

## Follow-ups (explicit)

- Full form coverage (`DOCUMENT-AUTOFILL-COVERAGE.md`): the remaining ⏳ targets.
- Reconcile `expense-drafts` receipt extraction onto the shared `<ImportButton>`.
- Office-document support (DOCX/XLSX) via server-side conversion or Migration OS.
- Wire `purgeExpiredFormImports` into the cron fleet.
- An "Import …" command-palette group.
