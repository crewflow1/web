# Document-to-form autofill — coverage inventory

**Feature 2.** Every record-creation entry point in the authenticated product, with
the status of its "Import" affordance. This is the complete audit the mandate
asked for.

Legend:

- **✅ done** — a shared `<ImportButton>` sits beside the create button, gated by
  the same permission the create action enforces, wired end-to-end (upload →
  governed extraction → review → prefill the existing form → save).
- **⏳ pending** — applicable but not yet wired; a precise structural reason is
  given. These are the documented follow-up.
- **🚫 unsupported** — not a sensible autofill target; reason given.

**Totals: 23 record types done; a small number deliberately unsupported or
deferred, each with a reason below.** Every button is functional — none is
decorative.

**Header-only vs line-item adapters.** 20 forms are header-field adapters (flat
string fields prefilled into the create form). 3 (material request, purchase
order, and — header-only — variation) use the **line-item adapter**: a
schema-validated array of rows the review dialog renders as a table and the
create form's builder seeds its rows from (`form_import_drafts.line_items`).

**What needs a vision provider (the honest cred boundary).** Extraction is
governed and **dark by default (no vision tier bound)**, so today every import —
header fields AND line items — degrades to an **empty proposal** and the operator
fills the form by hand. The buttons, upload, storage, review and form-seeding all
work now; the *automatic field/line extraction* is what a vision provider
activates. This was never faked as live AI. The builder-seeding is verifiable
today with a seeded draft; see `__tests__/imports/autofill-registry.test.ts`.

**Verified in staging (2026-11-01):** buttons present + permission-gated across
all 23, desktop + mobile; the review→prefill→save path for the new forms proven
via seeded drafts; tenant isolation and the staff field-scoping (pay/role/
emergency never extractable) unchanged.

Shared pieces every target reuses: `components/import/import-button.tsx`,
`lib/imports/autofill/*`, `server/services/document-autofill.ts`. Adding a pending
target = a registry entry + a strict schema + a one-line button placement +
(route form) passing `defaults` from `loadImportDraftDefaults`.

---

## Sales
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Customer | `/customers/new` | ✅ done | Capability `customers:create`. e2e covered. |
| Lead | `/leads/new` | ✅ done | Capability `leads:create`. Enquiry → contact/service/value/postcode/notes. |
| Quote | `/quotes/new` | 🚫 unsupported | Has a **dedicated AI quote-writer** (`_quote-writer-panel.tsx`) plus a complex controlled builder (customer/property/lead pickers, per-line `needs_pricing`). A generic document import would duplicate and conflict with that purpose-built path, so quote creation stays with the quote-writer. |
| Invoice | `/invoices/new` | 🚫 unsupported | Generated from jobs/quotes, not transcribed. |
| Review request | `/reviews/new` | 🚫 unsupported | No document source. |

## Projects / Jobs / Sites
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Job | `/jobs/new` | ✅ done | Member. Site address + notes (no relational ids / schedule). |
| Site (address) | `/sites/new` | ✅ done | Org-admin (page redirect + RLS `is_org_admin`). Site brief → name/address. |
| Variation / VO | `/jobs/[id]/variations/new` | ✅ done | Capability `quotes:create`, job-nested (newPathOverride). Instruction/VO-request → title/description; prices & margin stay in the calculator, never extracted. |
| Warranty | `/jobs/[id]/warranties` | ✅ done | Owner/admin, job-nested (newPathOverride). Certificate → title/provider/kind/period/reference/cover/exclusions; dates stay derived from the completion certificate. |
| Job valuation | `/jobs/[id]/valuations` | 🚫 unsupported | Computed from the job's commercial state. |

## Site & Safety
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Risk assessment (RAMS) | `/health-safety/new` | ✅ done | Member. Header only; hazards/scores/sign-off entered deliberately. |
| Delay / EOT | `/delays/new` | ✅ done | Member. Delay notice → category/startedOn/endedOn/description; working-days-lost stays a manual claim. |
| Site report | `/site-reports/new` | ✅ done | Member. Report → title + reporting period; progress % & photos added on the report. |
| Permit to work | `/health-safety/permits/new` | ✅ done | Member. Permit doc → title/scope/location/responsible/isolation/emergency. |
| Toolbox talk | `/toolbox/new` | ✅ done | Member. Talk record → topic/date/points/presenter/PPE/attendees. |
| Snag / defect | `/snags/new` | ✅ done | Member. Defect report → title/description/location/trade/due. |
| Site diary | `/diary/new` | ✅ done | Member. Daily sheet → date/weather/labour/summary/delays/notes. |
| Compliance document | `/compliance/new` | ✅ done | Member. The uploaded doc → kind/title/expiry/notes (the file is re-attached on save). |



## Quality
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Inspection & Test Plan | `/quality/new` | ✅ done | Member. ITP doc → work package/title/spec ref/location/date/notes (job picked manually). |
| NCR | `/quality/ncrs/new` | 🚫 unsupported | Strictly contextual — requires `?itemId` (raised against a failed inspection item). Its details come from the inspection you are viewing, not an uploaded document; low document fit. |

## People
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Staff / team member (invite) | invite modal | ✅ done | Admin (`canManageStaff`). **Identity fields only** — pay/emergency-contact/role NEVER extracted (schema omits them; prompt forbids them). Event-target modal prefill. |
| Qualification | `/staff/[id]` | ✅ done | Owner/admin, staff-nested (newPathOverride). CSCS/certificate → type/title/reference/issue+expiry/notes; never pay, role, or data beyond the certificate. |
| Site induction | `/site-compliance/[siteId]` | ⏳ pending | **Contextual** (`siteId`) + signature capture; low document fit. |
| Customer contact | `/customers/[id]` | ⏳ pending | **Contextual** (`customer/[id]`), controlled-state inline; feasible by seeding state — follow-up. |

## Money / Procurement
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Supplier | `/suppliers/new` | ✅ done | Member. Invoice header → contact + payment terms. |
| Purchase order | `/purchase-orders/new` | ✅ done | Member. Supplier quote/proforma → reference/expected-date/notes + priced order lines (line-item adapter). Supplier/job operator-picked. |
| Material request | `/materials/requests/new` | ✅ done | Member. Take-off/materials list → needed-by/notes + materials rows (line-item adapter, NO money). |
| Expense / receipt | `/expenses/new` | ✅ done (existing) | **Already** an upload→OCR→draft→review flow (`server/services/expense-drafts.ts`, same vision door + governor). Phase 2 reconciles it onto the shared `<ImportButton>` for a consistent UX. |
| Cost entry (finances) | `/finances/new` | 🚫 covered | The **expense/receipt** upload→OCR→review flow already covers importing a cost document (`server/services/expense-drafts.ts`); a second cost-entry importer would duplicate it. |
| Payment | `/payments/new` | 🚫 unsupported | **Financial execution.** Settles existing invoices via an allocation builder; importing amounts/allocations would automate a money movement. Approval is preserved — the operator enters and confirms payments by hand. |
| Supplier payment | `/suppliers/[id]/payments` | 🚫 unsupported | **Financial execution.** DB-reconciled CIS/rate allocation against live bills — values MUST reconcile against live data, never be imported. Approval preserved. |
| VAT return | `/tax` | 🚫 unsupported | Computed from the ledger. |
| Price-book item | `/price-book` | 🚫 Migration OS | A price **list** is a bulk import; Migration OS (the dedicated bulk importer) handles supplier price lists, not a per-record document import. |

## Materials / Stock / Fleet / Assets
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Stock item | `/stock/items/new` | ✅ done | Member. Product label / catalogue line → name/unit/sku/barcode/supplier ref/description. |
| Vehicle | `/fleet/vehicles/new` | ✅ done | Member. V5C / purchase invoice → reg/make/model/VIN/year/weight/purchase. |
| Asset / equipment | `/assets/new` | ✅ done | Member. Purchase invoice / spec / hire agreement → identity + purchase + warranty + hire. |
| Stocktake | `/stock/stocktake/new` | 🚫 unsupported | A counting session, not a document. |

## Inbox / Comms / Settings / Templates
| Record | Entry point | Status | Notes |
|---|---|---|---|
| Conversation / support ticket | `/inbox`, `/support/new` | 🚫 unsupported | Composed, not imported. |
| API key / webhook / marketplace | settings | 🚫 unsupported | Configuration; no document source. |
| Job template / quality template | `/jobs/templates/new`, `/quality/templates` | 🚫 unsupported | Templates, not records. |

---

## The two deferred classes (why they're a second wave, not decorative buttons)

1. **Line-item / allocation builders** (quote, purchase order, material request,
   payment, supplier payment). These serialize repeatable rows to a hidden JSON
   field via controlled React state. Correct autofill needs an *array* extraction
   schema (`{description, qty, unit, unit_price, vat_rate}` …) and the builder's
   own `initial`/`defaultLineItems` path — a distinct schema shape and a
   per-builder integration. Wiring a header-only button would be the kind of
   half-working affordance the mandate forbids, so these wait for the line-item
   schema work.
2. **Contextual `[id]`-nested forms** (variation, warranty, qualification, site
   induction, customer contact, NCR). These create a child record under a parent
   in the URL (`jobs/[id]`, `staff/[id]`, …), so the Import button must live on
   the parent page and carry its id. Several (qualification, warranty) are
   high-value certificate imports and are the first follow-up; the `<ImportButton>`
   already supports a `newPathOverride` for exactly this.

## Office documents (DOCX/XLSX)

The button accepts **PDF + images** (the vision door's document-block formats).
Office formats would store bytes nothing can extract; Phase 2 adds server-side
conversion or routes spreadsheets to Migration OS.
