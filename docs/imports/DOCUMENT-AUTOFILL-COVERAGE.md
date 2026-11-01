# Document-to-form autofill — coverage inventory

**Feature 2, Phase 1.** This lists every record-creation entry point in the
authenticated product and the status of its "Import" affordance. It is the
explicit audit the mandate asked for, and the backlog for full coverage.

Legend:

- **✅ done** — a shared `<ImportButton>` is placed next to the create button,
  gated by the same permission the create action enforces, and wired end-to-end
  (upload → governed extraction → review → prefill the existing form → save).
- **⏳ pending** — a real, intended target with no Import yet. Needs a strict
  extraction schema (`lib/imports/autofill/schemas.ts`), a registry entry, the
  button, and prefill wiring. This is the Phase-2 backlog.
- **🚫 unsupported** — not a sensible autofill target; the reason is given.

Phase 1 ships **one representative per domain** (Sales, Money, Projects, Site &
Safety, People) wired end-to-end, plus the shared pipeline every pending target
will reuse. **Full coverage across all forms is an explicit follow-up.**

The shared button is `components/import/import-button.tsx`; the pipeline is
`lib/imports/autofill/*` + `server/services/document-autofill.ts`. Adding a
pending target is a registry entry + a schema + a one-line button placement +
(for a `/new` route) passing `defaults` from `loadImportDraftDefaults`.

---

## Sales

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| Customer | `app/(app)/customers/page.tsx` → `/customers/new` | ✅ done | **Representative.** Capability-gated (`customers:create`). e2e: `e2e/document-import.spec.ts`. |
| Quote | `app/(app)/quotes/page.tsx` → `/quotes/new` | ⏳ pending | Quote builder is line-item heavy; a document import would map header + line items. Larger schema. |
| Lead | `app/(app)/leads/page.tsx` → `/leads/new` | ⏳ pending | Good fit (enquiry email/letter → lead). |
| Invoice | `app/(app)/invoices/page.tsx` → `/invoices/new` | 🚫 unsupported | Invoices are GENERATED from jobs/quotes inside CrewFlow, not transcribed from a document. |
| Review request | `app/(app)/reviews/new` | 🚫 unsupported | No document source. |

## Projects / Jobs

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| Job | `app/(app)/jobs/page.tsx` → `/jobs/new` | ✅ done | **Representative.** Member-open. Extracts SITE address + notes only (no relational ids / schedule — a document cannot name a CrewFlow UUID). |
| Site (address) | `app/(app)/sites/new` | ⏳ pending | Admin-gated. Overlaps the job site-address schema. |
| Variation / VO | `/jobs/[id]/variations/new` | ⏳ pending | Client variation instruction → VO. |
| Job valuation | `/jobs/[id]/valuations` (inline) | ⏳ pending | Inline form; needs the event-target integration pattern. |
| Warranty | `/jobs/[id]/warranties` (inline) | ⏳ pending | Warranty certificate → record. Strong fit. |

## Site & Safety

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| Risk assessment (RAMS) | `app/(app)/health-safety/page.tsx` → `/health-safety/new` | ✅ done | **Representative.** Member-open. Header fields only — hazards/scores/sign-off are entered deliberately, never auto-extracted. |
| Permit to work | `/health-safety/permits/new` | ⏳ pending | Permit document → record. |
| Toolbox talk | `/toolbox/new` | ⏳ pending | Talk record/attendance sheet → record. |
| Site report | `/site-reports/new` | ⏳ pending | |
| Snag / defect | `/snags/new` | ⏳ pending | Photo-driven; the image pipeline already fits. |
| Delay / EOT event | `/delays/new` | ⏳ pending | |
| Site diary entry | `/diary/new` | ⏳ pending | |
| Compliance document | `/compliance/new` | ⏳ pending | The document IS the record; extract its metadata (expiry, type). |

## Quality

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| ITP | `/quality/new` | ⏳ pending | |
| NCR | `/quality/ncrs/new` | ⏳ pending | |

## People

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| Staff / team member (invite) | `app/(app)/staff/page.tsx` → invite modal | ✅ done | **Representative.** Admin-only (`canManageStaff`). **Extracts IDENTITY fields only** — name, email, phone, employment type. Pay and emergency contacts are column-ACL-restricted and are NEVER extracted (schema omits them; prompt forbids them). Uses the event-target modal-prefill pattern. |
| Qualification | `/staff/[id]/_qualifications` (inline) | ⏳ pending | Certificate/CSCS card → qualification + expiry. Strong fit; inline (event-target). |
| Subcontractor | via Suppliers | — | Covered by the Supplier target. |
| Site induction | `/site-compliance` (inline) | ⏳ pending | |

## Money

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| Supplier | `app/(app)/suppliers/page.tsx` → `/suppliers/new` | ✅ done | **Representative.** Member-open. Extracts contact + payment terms from an invoice header / letterhead. |
| Expense / receipt | `/expenses/new` | ⏳ pending (prior art) | `server/services/expense-drafts.ts` ALREADY does governed receipt → expense extraction via the same vision door. Phase 2 reconciles it onto this shared `<ImportButton>` so the UX is consistent. |
| Cost entry (finances) | `/finances/new` | ⏳ pending | Receipt → cost line. Overlaps expense extraction. |
| Payment | `/payments/new` | ⏳ pending | Admin-gated. |
| Purchase order | `/purchase-orders/new` | ⏳ pending | |
| VAT return | `/tax` (inline) | 🚫 unsupported | Computed from the ledger, not transcribed. |
| Price-book item | `/price-book` (inline) | ⏳ pending | Supplier price list → items (bulk; may suit Migration OS instead). |

## Materials / Stock / Fleet / Assets

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| Material request | `/materials/requests/new` | ⏳ pending | |
| Stock item | `/stock/items/new` | ⏳ pending | |
| Stocktake | `/stock/stocktake/new` | 🚫 unsupported | A counting session, not a document. |
| Vehicle | `/fleet/vehicles/new` | ⏳ pending | V5C / insurance doc → vehicle. Strong fit. |
| Asset / equipment | `/assets/new` | ⏳ pending | Purchase/warranty doc → asset. |

## Inbox / Comms / Settings

| Record | Create entry point | Status | Notes |
|---|---|---|---|
| Conversation / message | `/inbox/conversations/new` | 🚫 unsupported | Composed, not imported. |
| Support ticket | `/support/new` | 🚫 unsupported | Composed. |
| Contact (on customer) | inline | ⏳ pending | Business card → contact. |
| API key / webhook / marketplace | settings (inline) | 🚫 unsupported | Configuration, no document source. |

---

## Office documents (DOCX/XLSX/…)

The `<ImportButton>` accepts **PDF and images (JPG, PNG, WEBP, HEIC)** — exactly
what the vision door reads as a document block. Office formats are **not**
accepted in Phase 1: the vision model takes PDF/image blocks only, so storing a
`.docx`/`.xlsx` would leave bytes nothing could extract. Phase-2 options:
server-side conversion to PDF before extraction, or routing spreadsheets to the
existing Migration OS bulk importer. Tracked as a follow-up.

## Command palette

`app/(app)/_nav/commands.ts` has a role-gated "Create" command group. A matching
"Import …" command group is a small, consistent Phase-2 addition.
