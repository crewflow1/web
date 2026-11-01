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

**Totals: 16 record types done; 11 pending (with reasons); the rest unsupported.**
Every button is functional — none is decorative. Extraction is governed and dark
by default (no vision tier bound), so today every import honestly degrades to an
empty proposal and the operator fills the form by hand; this was never faked as
live AI.

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
| Quote | `/quotes/new` | ⏳ pending | **Line-item builder** + controlled customer picker. Needs a line-items (array) extraction schema and the builder's `defaultLineItems` path; header-only prefill would be low-value. |
| Invoice | `/invoices/new` | 🚫 unsupported | Generated from jobs/quotes, not transcribed. |
| Review request | `/reviews/new` | 🚫 unsupported | No document source. |

## Projects / Jobs / Sites

| Record | Entry point | Status | Notes |
|---|---|---|---|
| Job | `/jobs/new` | ✅ done | Member. Site address + notes (no relational ids / schedule). |
| Site (address) | `/sites/new` | ✅ done | Org-admin (page redirect + RLS `is_org_admin`). Site brief → name/address. |
| Variation / VO | `/jobs/[id]/variations/new` | ⏳ pending | **Contextual** (`jobs/[id]`) + controlled cost/margin calculator. Title/description are route-prefillable (the page already prefills via `?fromRequest`); a follow-up mirrors that with `?import`. |
| Warranty | `/jobs/[id]/warranties` | ⏳ pending | **Contextual** (`jobs/[id]`), admin; clean route-prefill once a `defaults` prop is threaded into `WarrantyForm`. Strong fit (warranty certificate). |
| Job valuation | `/jobs/[id]/valuations` | 🚫 unsupported | Computed from the job's commercial state. |

## Site & Safety

| Record | Entry point | Status | Notes |
|---|---|---|---|
| Risk assessment (RAMS) | `/health-safety/new` | ✅ done | Member. Header only; hazards/scores/sign-off entered deliberately. |
| Permit to work | `/health-safety/permits/new` | ✅ done | Member. Permit doc → title/scope/location/responsible/isolation/emergency. |
| Toolbox talk | `/toolbox/new` | ✅ done | Member. Talk record → topic/date/points/presenter/PPE/attendees. |
| Snag / defect | `/snags/new` | ✅ done | Member. Defect report → title/description/location/trade/due. |
| Site diary | `/diary/new` | ✅ done | Member. Daily sheet → date/weather/labour/summary/delays/notes. |
| Compliance document | `/compliance/new` | ✅ done | Member. The uploaded doc → kind/title/expiry/notes (the file is re-attached on save). |
| Site report | `/site-reports/new` | ⏳ pending | Thin (title + period dates; job is a required relational field) — low document value. |
| Delay / EOT | `/delays/new` | ⏳ pending | Job is a required relational field; the extractable block (`DelayEventFields`) is a controlled fields component the create wrapper doesn't thread a `defaults` into yet. |

## Quality

| Record | Entry point | Status | Notes |
|---|---|---|---|
| Inspection & Test Plan | `/quality/new` | ✅ done | Member. ITP doc → work package/title/spec ref/location/date/notes (job picked manually). |
| NCR | `/quality/ncrs/new` | ⏳ pending | **Contextual** — raised against a specific inspection item via `?itemId`; not a standalone create. |

## People

| Record | Entry point | Status | Notes |
|---|---|---|---|
| Staff / team member (invite) | invite modal | ✅ done | Admin (`canManageStaff`). **Identity fields only** — pay/emergency-contact/role NEVER extracted (schema omits them; prompt forbids them). Event-target modal prefill. |
| Qualification | `/staff/[id]/_qualifications` | ⏳ pending | **Contextual** (`staff/[id]`), inline, admin. Strong fit (CSCS/cert); needs a `defaults` prop + the staff page to read `?import`. High-value follow-up. |
| Site induction | `/site-compliance/[siteId]` | ⏳ pending | **Contextual** (`siteId`) + signature capture; low document fit. |
| Customer contact | `/customers/[id]` | ⏳ pending | **Contextual** (`customer/[id]`), controlled-state inline; feasible by seeding state — follow-up. |

## Money / Procurement

| Record | Entry point | Status | Notes |
|---|---|---|---|
| Supplier | `/suppliers/new` | ✅ done | Member. Invoice header → contact + payment terms. |
| Expense / receipt | `/expenses/new` | ✅ done (existing) | **Already** an upload→OCR→draft→review flow (`server/services/expense-drafts.ts`, same vision door + governor). Phase 2 reconciles it onto the shared `<ImportButton>` for a consistent UX. |
| Cost entry (finances) | `/finances/new` | ⏳ pending | Controlled `useState` amount/VAT; posts via `fetch`. Needs state seeding; overlaps the expense receipt flow. |
| Payment | `/payments/new` | ⏳ pending | **Allocation builder** + money-invariant; settles existing invoices (low document fit). |
| Supplier payment | `/suppliers/[id]/payments` | ⏳ pending | **Controlled allocation builder**, DB-reconciled CIS/rate — values must reconcile against live bills, not be imported. |
| Purchase order | `/purchase-orders/new` | ⏳ pending | **Line-item builder** (already ingests `initial.line_items`); needs an array extraction schema. |
| VAT return | `/tax` | 🚫 unsupported | Computed from the ledger. |
| Price-book item | `/price-book` | ⏳ pending | Bulk supplier price list — better suited to Migration OS than per-record import. |

## Materials / Stock / Fleet / Assets

| Record | Entry point | Status | Notes |
|---|---|---|---|
| Stock item | `/stock/items/new` | ✅ done | Member. Product label / catalogue line → name/unit/sku/barcode/supplier ref/description. |
| Vehicle | `/fleet/vehicles/new` | ✅ done | Member. V5C / purchase invoice → reg/make/model/VIN/year/weight/purchase. |
| Asset / equipment | `/assets/new` | ✅ done | Member. Purchase invoice / spec / hire agreement → identity + purchase + warranty + hire. |
| Material request | `/materials/requests/new` | ⏳ pending | **Line-item builder**; needs an array extraction schema. |
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
