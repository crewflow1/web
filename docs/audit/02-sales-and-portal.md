# CrewFlow Feature & Button Audit — 02 · Sales & Customer Portal

Domain: Sales (Leads · Quotes · Customers · Price book · Reviews) + the public
customer-facing surfaces (the `/q/<token>` quote short-link and the 19-page
`/customer-portal/<token>`). Read-only audit; classified from code + known prod
state. **Browser verification was NOT performed** (authenticated multi-role prod
access out of scope). Status legend + roles per `docs/audit/CONVENTIONS.md`.

Cross-cutting facts established up-front:
- **Sales segment authz.** `/leads`, `/quotes`, `/customers`, `/price-book` each
  carry a `layout.tsx` calling `requireManagementContext()` (owner/admin only;
  redirects staff to `/dashboard?error=forbidden`) — e.g.
  `app/(app)/leads/layout.tsx:15`. **`/reviews` has NO layout guard** and its
  pages use only `requireOrgContext()` (`app/(app)/reviews/page.tsx:72`,
  `reviews/new/page.tsx:29`) — nav hides it under ADMIN_ROLES but there is no
  server-side role gate (see Domain Summary).
- **Portal auth.** Every `/customer-portal/*` + `/q/*` route is anonymous; the
  URL token IS the credential. All DB access uses the service-role admin client
  (RLS bypassed), so every query is explicitly pinned on `org_id` + `customer_id`
  in code (`loadCustomerByPortalToken`). Bad/expired token →
  `InvalidLinkPage`.
- **Portal online payments are DARK** (two-switch gate + per-org Stripe Connect
  account); see the Invoices portal page. `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS`
  is the flag (`lib/payments/portal-stripe.ts:50`), comment: "NEVER, today".
- **AI Quote Writer** pipeline is built and model-bound but `available` requires
  the vendor credential → renders a dark "Off" notice in prod (see New quote /
  Quote detail).

---

## SALES

### Page: Leads (pipeline) — route `/leads` (`app/(app)/leads/page.tsx`)

- **Status:** LIVE & WORKING (kanban render + GET filters). Lead-score banding is live-computed.
- **Roles:** owner/admin only. Server-enforced twice: `requireManagementRole(ctx)` at `page.tsx:55` AND the segment `layout.tsx`. No per-role display diffs.
- **Purpose:** The sales pipeline — a horizontally-scrolling kanban, one column per `LEAD_STAGES`, with a per-column count + value and a forecast headline.
- **What the user sees:** Header with lead count + GBP forecast + "New lead" CTA; a filter bar (search / source / score band / urgency / assigned); stage columns of `LeadCard`s. Empty state (`🎯`) when the org has zero leads and no active filter.

**Features**
1. **Pipeline board + forecast**
   - Problem: see every live enquiry and its forecast value at a glance.
   - Steps: page reads `leads` (org-pinned `.eq("org_id", ctx.org.id)`, `.neq("status","archived")`, `page.tsx:70-81`), paged via `fetchAllRows` (F-1, no 500 cap), merges a second string-selected read for `contact_*` columns (`:120-145`), buckets by stage + tallies `totalValue` via `bucketPipelineLeads` (`:167`).
   - Data CRUD: READ only (leads + merged contact fields).
   - After success: columns render; archived rows excluded from columns AND forecast.
   - Side-effects: none.
   - Connected: LeadCard → `/leads/[id]`; "New lead" → `/leads/new`.
   - Prod availability: LIVE.
   - Deps/limits: lead score computed live (`@/lib/leads/score`); search sanitised via `sanitizeSearchTerm` + `ilikeOrFilter` to prevent PostgREST `.or()` injection (`:104-108`).
2. **Filters (search / source / band / urgency / assigned)** — GET form (`method="GET"`, `:236`). Source/urgency/band validated against enums; `assigned` is a raw eq; band filter applied in-memory (`:159-170`). Assigned options built from visible data. READ only. No side-effects. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| New lead | header + empty state | link | — | → `/leads/new` | LIVE |
| Search / Source / Score / Urgency / Assigned | filter bar | GET query params | — | filtered board | LIVE |
| Apply | filter bar | submits GET | — | reload with filters | LIVE |
| Clear | filter bar | link to `/leads` | — | reset filters | LIVE |
| Lead card (whole) | columns | link | — | → `/leads/[id]` | LIVE |
| Stage `<select>` + Move | each card | `moveLeadStage` server action | status | re-stages, bumps activity, rescored, redirect `/leads` | LIVE |

---

### Page: Lead detail — route `/leads/[id]` (`app/(app)/leads/[id]/page.tsx`)

- **Status:** LIVE & WORKING. The "AI summary" feature is FLAGGED OFF / provider-gated (see feature 5).
- **Roles:** owner/admin only (segment layout). No per-role diffs.
- **Purpose:** One lead's record — score breakdown, convert-to-customer, follow-up acknowledgement, AI summary, linked quote/calls, edit form, delete.
- **What the user sees:** breadcrumb, contact header (name/email/phone as `mailto:`/`tel:` links), stage badge + quick-move, score card, Customer/Convert card, Follow-up card, AI summary card, linked quote + calls sections, edit form (`LeadForm`), AttachmentsPanel, red Delete card. `?error`/`?saved` banners mapped via ERROR_MAP/SAVED_MAP.

**Features**
1. **Lead score breakdown** — deterministic rubric (`scoreLead`, `:181`), per-factor bars + confidence %. READ/compute only. No side-effects. LIVE.
2. **Quick stage move** — `moveLeadStage.bind(id)` (`:258`); UPDATE `leads.status` + `last_activity_at`, rescore, redirect `/leads`. LIVE.
3. **Convert to customer** — `convertLeadToCustomer` (`actions.ts:355`). Idempotent: reads lead org-pinned, no-ops if `customer_id` already set, else INSERT `customers` from contact fields + backfill `leads.customer_id WHERE null` (concurrency guard, orphan rollback `:410-428`). CRUD: creates a customer row. Side-effects: none external. Connected: → `/customers/[id]`. LIVE.
4. **Follow-up acknowledge (Mark called / Mark messaged / Archive)** — `acknowledgeLead` (`actions.ts:220`). Resolves lead org-pinned on tenant client BEFORE a service-role write to `lead_followup_state` (markLeadActed), pauses the 72h/7d reminder cron; Archive also sets `status='archived'`. CRUD: writes followup-state + (archive) lead status. Side-effect: suppresses background reminder emails. LIVE.
5. **AI summary (Generate / Regenerate)** — `regenerateLeadSummary` (`actions.ts:298`) → `summariseLead(id, orgId)` then persists `leads.ai_summary`. Side-effect: **AI call (metered by governor; provider dark by default)**. Classify: FLAGGED OFF / provider-gated — succeeds only where an AI provider is live; redirects `?error=summary_failed` otherwise. Connected: feeds the score's nothing; display only.
6. **Linked quote / "Create a quote"** — reads `quotes.lead_id` (`:141`); links to `/quotes/new?lead_id=&customer_id=`. READ. LIVE.
7. **Linked calls / AI transcripts** — reads `calls.lead_id` (`:132`); shows direction/status/duration + `ai_summary`/transcript `<details>`. READ. (Telephony substrate largely dark in prod — these rows are populated only where call capture exists.) LIVE-render.
8. **Edit lead** — `updateLead.bind(id)` via `LeadForm` (`:611`); see New lead form. UPDATE org-pinned, rescore. LIVE.
9. **Delete lead** — `deleteLead` (`actions.ts:437`); DELETE org-pinned `{count:"exact"}`. Irreversible. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Move (quick) | header | `moveLeadStage` | status | re-stage → `/leads` | LIVE |
| Convert to customer | Customer card | `convertLeadToCustomer` | — | creates customer → `/customers/[id]` | LIVE |
| View customer | Customer card | link (when converted) | — | → `/customers/[id]` | LIVE |
| Mark called / Mark messaged | Follow-up | `acknowledgeLead` kind=call/message | — | pauses reminders | LIVE |
| Archive | Follow-up | `acknowledgeLead` kind=archive | — | status=archived, drops from pipeline | LIVE |
| Generate / Regenerate | AI summary | `regenerateLeadSummary` | — | AI write (dark-gated) | FLAGGED OFF |
| Create a quote / + Add another quote | linked-quote | link | — | → `/quotes/new?lead_id=&customer_id=` | LIVE |
| Save changes | edit form | `updateLead` | name + (email or phone) | updates lead | LIVE |
| Cancel | edit form | link `/leads` | — | back | LIVE |
| Delete lead | red card | `deleteLead` | — | hard delete → `/leads` | LIVE |
| Show transcript | call row | `<details>` | — | expand | LIVE |

---

### Page: New lead — route `/leads/new` (`app/(app)/leads/new/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** owner/admin (segment layout). **Purpose:** capture a new enquiry. **What the user sees:** breadcrumb + `LeadForm` (shared with edit).
- **Feature — Create lead** (`createLead`, `actions.ts:48`): validates `createLeadSchema`, cross-tenant ref integrity via `verifyCrmReferences` (customer/assignee must be in-org, `:63`), INSERT `leads` (org-derived, status "new"), `recomputeLeadScore`, redirect `/leads/[id]`. CRUD: creates lead. Side-effects: none external. Deps: email-or-phone required; customer/staff pickers paged complete (`_form-helpers.ts`) with `withPreservedOption` defence so an edit can't NULL an out-of-list link.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save lead | form | `createLead` | name + (email or phone) + source | creates lead → detail | LIVE |
| Cancel | form | link `/leads` | — | back | LIVE |
| Customer / Assigned / Source / Urgency `<select>`s | form | field inputs | — | — | LIVE |

**Connected API (not a page): public lead intake** — `app/api/v1/leads/route.ts` (API-key lead ingest) and `app/api/demo/route.ts` (marketing demo-request intake) both write `leads`; surfaced here in `/leads`. No UI control on these sales pages submits to them. (Out of this domain's page scope — noted for completeness.)

---

### Page: Quotes (register) — route `/quotes` (`app/(app)/quotes/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** owner/admin (`requireManagementRole` `:44` + layout). **Purpose:** paginated quote register with status + customer filter. **What the user sees:** header + count + "New quote"; optional customer-filter banner; status filter form; desktop table / mobile cards; prev/next pagination (50/page).

**Features**
1. **Quote register** — org-pinned read (`:64`) with exact count, 50/page, stable `created_at`+`id` order; status filter validated against `QUOTE_STATUSES`; `?customer=` UUID-validated (`:52`). READ. LIVE.
2. **Customer-scoped view** — `?customer=<uuid>` banner + "Back to customer"/"Clear" (driven from customer detail). LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| New quote | header | link | — | → `/quotes/new` | LIVE |
| Status `<select>` + Apply | filter | GET | — | filtered list | LIVE |
| Clear | filter | link `/quotes` | — | reset | LIVE |
| Help with quotes | header | HelpLink → article | — | help | LIVE |
| Open → / card | rows | link | — | → `/quotes/[id]` | LIVE |
| ← Previous / Next → | pager | link | — | page nav | LIVE |
| Back to customer / Clear customer filter | banner | link | — | nav | LIVE |

---

### Page: Quote detail (edit + lifecycle) — route `/quotes/[id]` (`app/(app)/quotes/[id]/page.tsx`)

- **Status:** LIVE & WORKING. Approval workflow + separation-of-duties live; "Email quote PDF" is DARK-safe (needs RESEND). AI-writer panel dark.
- **Roles:** owner/admin (segment layout). Per-role: `isAdmin` (owner/admin) sees Approve/Reject/Request-changes; a non-admin management member sees a read-only approval note (moot given layout is admin-only, but coded `:649`). Separation-of-duties: the quote's creator is blocked from self-approval when another owner/admin exists (`:339-348`).
- **Purpose:** edit a quote via the builder + run its lifecycle (approval → send → accept/decline), manage variations/EOT, version history, signatures, templates, delete.
- **What the user sees:** breadcrumb/header with total+status badge; (variation only) `VariationPanel`; Share+lifecycle panel (public link via `ShareLinkPanel`, sent/viewed/accepted/declined stamps, linked-job link, action buttons, Download PDF, Email-quote widget); Approval panel (pending/approved/rejected); locked-state duplicate card OR the `QuoteBuilder`; Save-as-template panel; signatures list (typed + drawn image via signed URL); `VersionHistoryPanel`; AttachmentsPanel; red delete `ConfirmForm`.

**Features**
1. **Edit via builder** — `updateQuote.bind(id)` (`actions.ts:518`). Replaces line items wholesale; reads ALL existing lines paged (F-1, `:183`) so a save can't truncate. CRUD: updates quote + replaces `quote_line_items`. LIVE.
2. **Request approval** — `requestQuoteApproval` (`actions.ts:763`), draft/rejected → `pending_approval`; revalidates dashboard. LIVE.
3. **Review (Approve / Request changes / Reject)** — `reviewQuote` (`actions.ts:809`); separation-of-duties gate; comment required for reject/request-changes. CRUD: status + approver/approved_at/comment. LIVE.
4. **Mark as sent** — `sendQuote` (`actions.ts:665`), approved → sent (status only, no email). LIVE.
5. **Accept on customer's behalf** — `acceptQuoteAsOwner` (`actions.ts:1028`); records a signature, accepts, **auto-creates a draft invoice** and **auto-emails the invoice PDF** (best-effort via `sendInvoiceEmail`; `?warn=invoice_skipped` on failure). Side-effects: **invoice creation + customer email**. LIVE (email dark-safe without RESEND).
6. **Mark declined** — `declineQuoteAsOwner` (`actions.ts:1243`). LIVE.
7. **Email quote PDF** — `SendQuote` client widget (`_send-quote.tsx`) → `POST /api/quotes/[id]/send` (renders PDF + emails portal link, optional recipient override + note). Side-effect: **customer email**. Classify: LIVE but dark-safe (fails with configuration error when RESEND absent). Explicit-permission class (sends on the user's behalf).
8. **Download PDF** — `GET /api/quotes/[id]/pdf` new tab (`:531`). LIVE.
9. **Duplicate as new draft** (locked quotes) — `duplicateQuoteAsDraft` via `StateForm` (location.assign, deep-swap-race-safe). LIVE.
10. **Save as template** — `SaveAsTemplatePanel` → `saveQuoteAsTemplate` (price-book action); writes `quote_templates`+lines. LIVE.
11. **Signatures display** — reads `signatures` for target quote; mints short-lived signed URLs for drawn images (`signatureImageUrl`, org-scoped). READ. LIVE.
12. **Version history + diff** — `quote_versions` org-pinned (`:209`) vs current snapshot. READ. LIVE.
13. **Variation panel / EOT** — for `variation_number` quotes: cost basis + extension-of-time (`recordVariationEotAgreement`, `actions.ts:1874`). LIVE.
14. **AI quote drafting panel** — mounted in builder; dark notice in prod (see New quote feature 2). FLAGGED OFF.
15. **Delete quote** — `deleteQuote` (`actions.ts:951`); blocked when invoices depend on it (`has_invoices`), else cascades line items. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Request approval | lifecycle | `requestQuoteApproval` | draft/rejected | → pending_approval | LIVE |
| Approve / Request changes / Reject | approval panel | `reviewQuote` (name=action) | comment (for reject/changes) | status change | LIVE |
| Mark as sent | lifecycle | `sendQuote` | approved | status=sent | LIVE |
| Accept on customer's behalf | lifecycle | `acceptQuoteAsOwner` | — | accept + draft invoice + email | LIVE |
| Mark declined | lifecycle | `declineQuoteAsOwner` | — | status=declined | LIVE |
| Email quote PDF / Send quote | Send widget | `POST /api/quotes/[id]/send` | (optional) email + note | emails PDF+link | LIVE (dark-safe) |
| Download PDF | lifecycle | `/api/quotes/[id]/pdf` | — | PDF tab | LIVE |
| Copy/share link | ShareLinkPanel | copy `/q/<token>` | — | share | LIVE |
| Duplicate as new draft | locked card | `duplicateQuoteAsDraft` | — | new draft copy | LIVE |
| Save as template | template panel | `saveQuoteAsTemplate` | name | writes template | LIVE |
| Save changes | builder | `updateQuote` | customer + ≥1 line | updates quote | LIVE |
| + Add line / ✕ remove / price-book pick / apply template | builder | client state | — | edits line items | LIVE |
| Agreed EOT controls | variation panel | `recordVariationEotAgreement` | date | records EOT | LIVE |
| Delete quote | red card | `deleteQuote` (ConfirmForm) | confirm | delete (blocked if invoiced) | LIVE |

---

### Page: New quote — route `/quotes/new` (`app/(app)/quotes/new/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** owner/admin (layout). **Purpose:** build a new quote. Pre-fills from `?lead_id`/`?customer_id` (validated against org-visible lists) and the org's `default_terms`.
- **What the user sees:** breadcrumb + `QuoteBuilder` (customer/site/lead selects, AI panel, line-items table with live totals, notes/terms).

**Features**
1. **Create quote** — `createQuote` (`actions.ts:202`); validates, INSERT quote + line items, links lead; redirect `/quotes/[id]`. CRUD: creates quote + lines. LIVE.
2. **AI quote drafting (Draft a scope of works)** — `QuoteWriterPanel` (`_quote-writer-panel.tsx`). Renders a dark "Off" notice unless `getQuoteWriterReadiness().available` — which requires pipeline+registry+**model binding**+**vendor credential**. Model is bound (sonnet-5 since 2026-09-10) but the credential gates it, so **dark in prod**. When live: Draft → `draftQuoteAction` (governed AI call; budget/duplicate/rejected outcomes), Apply hands line items into the builder (no quote created, no send path). Side-effect: **AI call, governor-metered, event-driven (button only)**. Classify: FLAGGED OFF (built, awaiting credential).
3. **Price-book picker / Apply template** — client-side populate line items from `priceBookItems` / `templates`. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save quote | builder | `createQuote` | customer + ≥1 line | creates quote | LIVE |
| Draft a scope of works | AI panel | `draftQuoteAction` | lead/quote anchor | AI draft (dark) | FLAGGED OFF |
| Apply / Discard (AI draft) | AI panel | apply→builder / discard | — | populate lines | FLAGGED OFF |
| + Add customer | builder (no-customers alert) | link new tab | — | → `/customers/new` | LIVE |
| price-book pick / apply template / +Add line / ✕ | builder | client state | — | edit lines | LIVE |
| Cancel | builder | link `/quotes` | — | back | LIVE |

---

### Page: Customers (list) — route `/customers` (`app/(app)/customers/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** owner/admin (`requireManagementRole` `:66` + layout). **Purpose:** the address book — searchable, type-filterable, paginated (200/page, exact count). **What the user sees:** header + count; search (name/address/postcode/email/phone) + type filter; `DataTable` (cards below `sm`); "Showing A–B of N" pager.

**Features**
1. **Customer list + server-side search** — org-pinned (`:87`), server search across whole table via `customerSearchOr`, type filter (individual/business), stable `created_at`+`id` order. READ. LIVE. (Note: list read error is logged but NOT loud-thrown, `:112` — degrades to empty on failure.)

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| New customer | header | link | — | → `/customers/new` | LIVE |
| Search box + Search | filter | GET | — | server search | LIVE |
| Type `<select>` | filter | GET | — | filter individual/business | LIVE |
| Clear | filter | link `/customers` | — | reset | LIVE |
| Row / Edit → / card | table | link | — | → `/customers/[id]` | LIVE |
| ← Previous / Next → | pager | link | — | page nav | LIVE |

---

### Page: Customer detail — route `/customers/[id]` (`app/(app)/customers/[id]/page.tsx`)

- **Status:** LIVE & WORKING. Statement email + portal-link rotate + delete are dark-safe/guarded.
- **Roles:** owner/admin (layout). Delete is admin/owner (RLS; friendly gate). **Purpose:** 360° customer record — financial rollups, B2B hierarchy, quotes/jobs/invoices/payments summaries, contacts, statement, comms timeline, edit, portal link, inbound files, delete.
- **What the user sees:** breadcrumb; type badge + "customer since"; 4 rollup tiles (lifetime revenue / invoiced / paid / outstanding); business-details + rolled-up sites; SummaryCards (Quotes/Jobs/Invoices/Payments with "All … →" links); `CustomerContactsSection`; StatementPanel; Timeline (merged, newest first, incl. comms); Address + MapActions; CustomerForm; portal-link panel; inbound files list; AttachmentsPanel; red delete ConfirmForm.

**Features**
1. **Financial rollups** — `loadCustomerFinancials` anchored on durable `invoices.customer_id` (not quote join), paged + loud (`:146`). READ. LIVE.
2. **B2B hierarchy** — parent/child customers (`loadBusinessOptions`/`loadChildCustomers`). READ. LIVE.
3. **Per-entity summaries + "All …" deep-links** — quotes/jobs/leads/invoices/payments paged reads (`:89-153`); links scope `/quotes?customer=`, `/jobs?customer=`, `/invoices?customer=`. READ. LIVE.
4. **Comms timeline** — `loadCustomerCommsTimeline` (email/SMS/WhatsApp/voice/chat, by contact identity) merged with quotes/invoices/jobs/payments/leads; deep-links `/inbox/conversations/[id]`. READ. LIVE (populated only where comms channels active).
5. **Named contacts CRUD** — `CustomerContactsSection` → `_contacts-client.tsx` (add/edit/delete/set-primary) via `_contact-actions.ts` (org-pinned; members write, admins delete; never mints portal access). CRUD on `customer_contacts`. LIVE.
6. **Statement of account** — `StatementPanel`: Download PDF (`GET /api/customers/[id]/statement/pdf`) + Email to customer (`sendCustomerStatement`, `actions.ts:262`). Side-effect: **customer email** (dark-safe: `statement_email_unconfigured` without RESEND; disabled when no email on file). LIVE (dark-safe).
7. **Edit customer** — `updateCustomer.bind(id)` via `CustomerForm`; parent-business validated (`resolveParentCustomer`); org-pinned update. LIVE.
8. **Portal link generate/rotate** — `rotateCustomerPortalToken` (`actions.ts:213`) mints/rotates `portal_token`, clears expiry+last-used; rotation immediately invalidates the prior link. `ShareLinkPanel` shows the `/customer-portal/<token>` URL. CRUD: writes `portal_token`. LIVE.
9. **Files from this customer** — `listStaffCustomerFiles` (service-role read of `portal_uploads`, signed URLs). READ. LIVE.
10. **Delete customer** — `deleteCustomer` (`actions.ts:296`); admin/owner only; blocked by FK (`customer_has_records`). LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| All quotes/jobs/invoices/payments → | SummaryCards | links | — | scoped list | LIVE |
| Create a quote / Add a job (empty CTAs) | SummaryCards | links | — | new scoped | LIVE |
| Add contact / Edit / Remove / Set primary | contacts | `_contact-actions` | name 2+ | contact CRUD | LIVE |
| Download PDF | statement | GET pdf route | (date range) | PDF tab | LIVE |
| Email to customer | statement | `sendCustomerStatement` | customer email | emails statement | LIVE (dark-safe) |
| Save changes | edit form | `updateCustomer` | name | updates customer | LIVE |
| Generate portal link / Regenerate | portal panel | `rotateCustomerPortalToken` | — | mint/rotate token | LIVE |
| Copy/share link | ShareLinkPanel | copy URL | — | share | LIVE |
| Open (customer file) | files | signed URL | — | open file | LIVE |
| Map actions | address | MapActions (directions etc.) | — | external map | LIVE |
| Delete customer | red card | `deleteCustomer` (ConfirmForm) | confirm | delete (FK-guarded) | LIVE |

---

### Page: New customer — route `/customers/new` (`app/(app)/customers/new/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** owner/admin (layout). **Purpose:** add a customer. **What the user sees:** `CustomerForm` (name/email/phone, business fieldset incl. company/VAT number + parent business, address fieldset, notes).
- **Feature — Create customer** (`createCustomer`, `actions.ts:87`): validates `customerFormSchema`, resolves optional parent (`resolveParentCustomer`), INSERT org-derived, redirect `/customers/[id]`. CRUD: creates customer. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save | form | `createCustomer` | name | creates customer → detail | LIVE |
| Cancel | form | link `/customers` | — | back | LIVE |
| Customer type / Parent business `<select>` | form | field | — | — | LIVE |

---

### Page: Price book — route `/price-book` (`app/(app)/price-book/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** owner/admin — `requireManagementRole` `:39` + layout + explicit "MONEY BOUNDARY: staff must never see prices" note. Hard delete is owner/admin-only within management (`isAdmin`, `:40`). **Purpose:** the estimating rate library + saved quote templates. `dynamic = "force-dynamic"`. **What the user sees:** add-item form; active rate-library table (edit/archive); archived table (restore/delete); saved-templates list (rename/delete).

**Features**
1. **Add price-book item** — `createPriceBookItem` (`actions.ts:80`); pounds→pence; INSERT `price_book_items` org-pinned. CRUD. LIVE.
2. **Archive/Restore** — `setPriceBookItemActive` toggles `active`. LIVE.
3. **Delete item (admin)** — `deletePriceBookItem` (`actions.ts:188`); role-checked + confirm. LIVE.
4. **Templates rename/delete** — `renameQuoteTemplate` / `deleteQuoteTemplate` (cascade lines). LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Add item | add form | `createPriceBookItem` | description/unit/price | creates item | LIVE |
| Edit | active row | link | — | → `/price-book/[id]` | LIVE |
| Archive / Restore | rows | `setPriceBookItemActive` | — | toggle active | LIVE |
| Delete (item) | archived row | `deletePriceBookItem` | confirm | hard delete (admin) | LIVE |
| Rename template (name/job type + save) | template | `renameQuoteTemplate` | name | updates template | LIVE |
| Delete (template) | template | `deleteQuoteTemplate` | confirm | delete + cascade lines | LIVE |

---

### Page: Price-book item edit — route `/price-book/[id]` (`app/(app)/price-book/[id]/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** owner/admin (layout). `dynamic = "force-dynamic"`. **Purpose:** edit one rate (`getPriceBookItem` org-pinned; pence shown as pounds).
- **Feature — Update item** (`updatePriceBookItem`, `actions.ts:112`): validates, UPDATE org-pinned, redirect `/price-book`. CRUD. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes | form | `updatePriceBookItem` | description/unit/price | updates item | LIVE |

---

### Page: Reviews — route `/reviews` (`app/(app)/reviews/page.tsx`)

- **Status:** LIVE & WORKING, but **authz gap** (see note). **Roles intended:** owner/admin (nav only). **Actual server gate:** `requireOrgContext()` only — NO `requireManagementRole`, NO segment `layout.tsx`. A staff member who knows the URL can view the list, open `/reviews/new`, and run the lifecycle/email actions (the actions also use only `requireOrgContext`, `actions.ts:69/137/165/197`). Record as a **real authz gap vs the rest of Sales**.
- **Purpose:** schedule + track post-job review requests; send/resend/cancel/complete. **What the user sees:** header + "+ Request review"; status filter pills; per-request cards (platform/status/customer/email/notes + job link) with contextual action buttons.

**Features**
1. **Review request list** — reads `review_requests` org-pinned (`:101`), joined customer+job, `.limit(200)`, status filter. READ. LIVE.
2. **Send email now / Resend** — `emailReviewRequestNow` (`actions.ts:196`): org-pinned read (prevents cross-org wrong-letterhead send), composes platform-specific review-link email, `sendEmail`, stamps `sent`. Side-effect: **customer email** (dark-safe: `email_no_key` without RESEND). LIVE (dark-safe). Only when customer has an email.
3. **Cancel** (scheduled) — `cancelReviewRequestAction`. LIVE.
4. **Mark completed** (sent) — `markReviewCompletedAction`. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Request review | header | link | — | → `/reviews/new` | LIVE |
| All/Scheduled/Sent/Completed/Cancelled | filter pills | links | — | status filter | LIVE |
| Send email now / Resend email | card (scheduled/sent, has email) | `emailReviewRequestNow` | — | emails customer | LIVE (dark-safe) |
| Cancel | card (scheduled) | `cancelReviewRequestAction` | — | status=cancelled | LIVE |
| Mark completed | card (sent) | `markReviewCompletedAction` | — | status=completed | LIVE |
| View job → | card (has job) | link | — | → `/jobs/[id]` | LIVE |
| Customer name | card | link | — | → `/customers/[id]` | LIVE |

---

### Page: New review request — route `/reviews/new` (`app/(app)/reviews/new/page.tsx`)

- **Status:** LIVE & WORKING (same authz gap — no role gate). **Purpose:** schedule a review request. **What the user sees:** customer picker (paged complete), optional completed-job picker (preserve-injected `?job_id`), platform, when-to-send (0/3/7 days), notes.
- **Feature — Create request** (`createReviewRequestAction`, `actions.ts:68`): validates, computes `send_at`, INSERT `review_requests` status "scheduled", `recordAdminActivity`, redirect `/reviews?saved=created`. CRUD. Side-effect: HQ audit-log entry. The cron (`/api/cron/lead-followups`-style review cron) sends at the delay. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Schedule review request | form | `createReviewRequestAction` | customer + platform + delay | schedules request | LIVE |
| Customer / Job / Platform / When `<select>`s | form | fields | — | — | LIVE |
| Cancel | form | link `/reviews` | — | back | LIVE |

---

## CUSTOMER-FACING

### Page: Public quote short-link — route `/q/[token]` (`app/q/[token]/page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** anonymous (token = credential; allow-listed in middleware). **Purpose:** the single source of truth for a customer viewing + accepting/declining a quote or variation online. **What the user sees:** branded header (org logo via signed URL, VAT, address, Download PDF); quote/variation meta (For/Valid until/Completion date/Status/Total); accepted/declined/error banners; `VariationSummary` (variations); line-items table + totals; notes/terms; bank details (only after acceptance); accept form (typed-name e-signature + optional drawn `SignaturePad` + comment) with a "Decline/Reject instead" `<details>`.

**Features**
1. **View quote** — service-role read by `public_token` (`:42`); only `approved/sent/viewed/accepted/declined/expired` visible else `InvalidLinkPage`; best-effort stamps `viewed_at` on first open (`:94`). Line items + (variations) sibling-quote context paged in full; **no `cost_*` columns** read on this customer surface (pinned by a security test). READ + viewed stamp. LIVE.
2. **Accept & sign** — `publicAcceptQuote` (`actions.ts:22`) → rate-limit (`quote_action`) + IP hash + `acceptQuoteByToken`. Side-effects: records signature, accepts quote, **auto-creates + emails invoice** (service-role path), owner notification. LIVE.
3. **Decline/Reject** — `publicDeclineQuote` → `declineQuoteByToken`; optional reason/comment. LIVE.
4. **Download PDF** — `/q/[token]/pdf`. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Download PDF | header | `/q/[token]/pdf` | — | PDF tab | LIVE |
| Accept & sign / Approve & sign | accept form | `publicAcceptQuote` | full name (signature) | accept + invoice + email | LIVE |
| Draw signature | accept form | SignaturePad (optional) | — | signature image | LIVE |
| Decline/Reject instead | `<details>` | reveals form | — | expand | LIVE |
| Decline quote / Reject variation | decline form | `publicDeclineQuote` | (optional reason) | status=declined | LIVE |

---

### Portal shell (`app/customer-portal/[token]/_shell.tsx`)
Shared chrome for all portal pages: org branding + "Hello, <first name>" + "Call <org>"; 17-tab horizontal strip ≥sm; phone bottom-nav with 4 primary tabs (Overview/Jobs/Invoices/Messages) + a JS-free `<details>` "More" sheet. Not a route itself. LIVE.

### Page: Portal Overview — route `/customer-portal/[token]` (`.../page.tsx`)

- **Status:** LIVE & WORKING. **Roles:** anonymous (token). **Purpose:** the portal home — action centre + KPIs + most-recent quote/invoice. **What the user sees:** "Needs your attention" action rows (overdue/quote/due/report decisions); 3 KPI cards (open quotes / accepted / outstanding); recent-quote card (View & respond → `/q/<token>`, Download PDF, All quotes); recent-invoice card; empty state.

**Features**
1. **Action centre** — `buildPortalActionItems` from quotes+invoices (net paid)+report-decisions; deep-links to `/q/<token>` and portal pages. READ. LIVE.
2. **KPIs + balance** — all quotes/invoices/payments paged (F-1) + `computePortalPayments` (single balance authority shared with Invoices tab). READ, loud-throw on failure. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Action row (Review / View invoice / Open report) | action centre | links | — | nav to `/q/` or portal page | LIVE |
| View & respond | recent quote | link `/q/<token>` (new tab) | — | quote page | LIVE |
| Download PDF | recent quote | `/q/<token>/pdf` | — | PDF | LIVE |
| All quotes → / All invoices → | cards | links | — | portal tabs | LIVE |

### Page: Portal Activity — route `.../activity` (`activity/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** reverse-chron timeline (quotes sent/accepted, invoices, payments, reports). READ only; `buildPortalTimeline` is customer-safe (no notes/staff/cost). **Controls:** timeline entries link to `/q/<token>` or portal pages. No writes.

### Page: Portal Quotes — route `.../quotes` (`quotes/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** the customer's own quotes (only `approved/sent/viewed/accepted/declined/expired`; **no cost columns**). Variations labelled distinctly. **Controls:** status filter (GET); per-card View & respond/Review & approve → `/q/<token>`, PDF → `/q/<token>/pdf`. No writes here (decisions happen on `/q/<token>`).

### Page: Portal Invoices — route `.../invoices` (`invoices/page.tsx`)
- **Status:** LIVE & WORKING; **"Pay now" is DARK**. **Purpose:** the customer's invoices + payment summary + payment schedule + statement + proof upload + (dark) online pay.
- **What the user sees:** paid/due/overdue tiles; Download-statement; payment-schedule (deposit/stages/retention); per-invoice cards (status/total/paid/outstanding, bank-transfer note, Download PDF, dark Pay-now, submitted-proofs read-back, "Upload payment proof" `<details>`).

**Features**
1. **Invoice list + money summary** — invoices (void-excluded) + payments paged (F-1); `computePortalPayments`; display-status via `invoiceDisplayStatus`. READ. LIVE.
2. **Download statement** — `/customer-portal/<token>/statement/pdf`. LIVE.
3. **Upload payment proof** — `uploadPaymentProof` (`_upload-action.ts:54`): rate-limited, validates file (PDF/JPG/PNG/HEIC/WebP, 10MB), writes `portal_uploads`, `recordAdminActivity` + `emitNotifications` to org. CRUD: file upload. Side-effect: **org notification**. LIVE.
4. **Pay now (online payment)** — `startInvoicePayment` (`_pay-action.ts:49`). Renders ONLY when `isPortalPaymentsConfigured()` (flag `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` + `STRIPE_CONNECT_SECRET_KEY`) AND the org has a `connected` Stripe account (`:252-265`). Both are off in prod → **button never renders**. When live: mints a Stripe Checkout Session on the tenant's connected account, redirects to Stripe; webhook `/api/webhooks/stripe-invoice` records payment. Side-effect: **real payment** (Explicit-permission class). Classify: **FLAGGED OFF** (`NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS`; comment "NEVER, today").

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Download statement | top | statement PDF route | — | PDF | LIVE |
| Download invoice PDF | card | invoice pdf route | — | PDF | LIVE |
| Pay now · £… | card | `startInvoicePayment` → Stripe | — | hosted checkout | FLAGGED OFF |
| Upload payment proof / Send proof | `<details>` | `uploadPaymentProof` | file | stores proof + notifies org | LIVE |

### Page: Portal Valuations — route `.../valuations` (`valuations/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** read-only interim valuations (applications for payment) — submitted/certified/invoiced only; drafts hidden; built via `buildPortalValuationView` (named scalars, no cost/notes). READ. No writes/buttons.

### Page: Portal Jobs — route `.../jobs` (`jobs/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** read-only job progress (status/date/assigned name, % progress, customer-visible programme milestones). Security: `jobs.notes` + staff email deliberately NOT selected; progress/milestones narrowed via `toPortalProgress`/`toPortalMilestones`. READ. No writes/buttons.

### Page: Portal Photos — route `.../photos` (`photos/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** site photos published to the customer via report snapshots (`listPortalphotos`); signed URLs. READ. **Controls:** image links (open full), "View the report these photos came from →". No writes.

### Page: Portal Reports — route `.../reports` (`reports/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** list issued/published progress reports (latest/superseded badges). **Controls:** View → `/reports/[id]`, PDF → `/reports/[id]/pdf`. READ only.

### Page: Portal Report detail — route `.../reports/[id]` (`reports/[id]/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** render one frozen report snapshot (status/phase/progress, "Decisions we need from you", summary sections, snags). **Controls:** Download PDF; "See the latest report" (superseded). **Note:** the "Decisions we need from you" block is **display-only** — there is no decision-response control on this page (customers respond via Messages), while the Overview action centre nudges "Open report" for pending decisions (minor dead-end).

### Page: Portal Warranties — route `.../warranties` (`warranties/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** warranty cover + servicing schedule (dates DERIVED from completion certificates; **no reminder emails** unless `maintenanceRemindersSending()`), plus customer-initiated warranty claims.
- **Feature — Submit claim** (`submitWarrantyClaim`, `_warranty-claim-action.ts:45`): on active warranties with a certificate; opens an internal `support_tickets` row (category `warranty_claim`) + `support_messages` + HQ audit. CRUD: support ticket. Side-effect: internal ticket (followed on Messages). LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Report an issue with this cover / Submit claim | `<details>` (active warranty) | `submitWarrantyClaim` | summary + details | opens support ticket | LIVE |

### Page: Portal Servicing (book a service) — route `.../servicing` (`servicing/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** book a concrete operator-published maintenance slot (optionally against a serviceable warranty).
- **Feature — Request booking** (`bookServiceSlot`, `_booking-action.ts:35`): rate-limited; validates slot availability/ownership/capacity server-side; INSERT booking; HQ audit. CRUD: booking row. LIVE. (Shows an empty state + points to Messages when no slots are open.)

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Request booking | slot form | `bookServiceSlot` | slot | books slot (status pending confirm) | LIVE |
| Slot / Warranty `<select>`s | form | fields | — | — | LIVE |

### Page: Portal Documents — route `.../documents` (`documents/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** unified document library (quotes/invoices/reports/certificates/attachments), each via its own scoped read; type filter; bulk ZIP.
- **Controls:** filter pills; per-doc View (+ PDF); "Download all (zip)" → `/documents/download-all` (per-filter). READ + ZIP download. No writes.

### Page: Portal Messages (list + compose) — route `.../messages` (`messages/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** support threads (`support_tickets` scoped org+customer) + new-message compose + unread badge.
- **Feature — Send message** (`sendPortalMessage`, `_message-action.ts:38`): creates a `support_tickets` row + first `support_messages` + HQ audit + org notification. CRUD: ticket+message. Side-effect: **org notification**. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send message | compose form | `sendPortalMessage` | subject + body | opens ticket | LIVE |
| Thread row | list | link | — | → `/messages/[ticketId]` | LIVE |

### Page: Portal thread (view + reply) — route `.../messages/[ticketId]` (`messages/[ticketId]/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** one support thread, internal/HQ notes filtered out (query + JS). Reply hidden on resolved/closed tickets.
- **Feature — Reply** (`replyToPortalThread`, `_thread-reply-action.ts:53`): appends `support_messages`, re-opens a `waiting_on_customer` ticket via trigger, org notification + HQ audit. CRUD: message. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send reply | reply form | `replyToPortalThread` | body | appends reply | LIVE |
| ← Back to messages / Start a new message | header/closed | links | — | nav | LIVE |

### Page: Portal Chat — route `.../chat` (`chat/page.tsx`)
- **Status:** LIVE & WORKING (in-app, no external transport). **Purpose:** live chat into the org's unified inbox; replies tailed by polling `./poll`.
- **Feature — Send chat** (`sendPortalChatMessage`, `_chat-action.ts:79`): rate-limited; upserts a `conversations` thread (channel `chat`) + inbound `messages` row; posts a **deterministic auto-acknowledgement** (AI seam dark); org notification + HQ audit. CRUD: conversation+message. Side-effects: org notification, auto-ack. LIVE (AI auto-reply dark).

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send (ChatPanel) | chat | `sendPortalChatMessage` | body | posts message + auto-ack | LIVE |

### Page: Portal Requests — route `.../requests` (`requests/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** two intakes — future-work request (creates a lead) and change-request (variation intake) for in-progress jobs.
- **Features:** (1) **Future-work** — `submitFutureWorkRequest` (`_future-work-action.ts:48`): INSERT `leads` `source:"portal"`, contact copied from the customer record, HQ audit, revalidates `/leads`. CRUD: lead. LIVE. (2) **Change request** — `submitChangeRequest` (`requests/variation-request-action.ts:50`): re-verifies the job belongs to the customer, INSERT `variation_requests`, HQ audit. CRUD: variation_request. LIVE. Read-backs show coarse stage words only.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send request | future-work form | `submitFutureWorkRequest` | title + details + timing | creates lead | LIVE |
| Send change request | change form (when open jobs) | `submitChangeRequest` | job + title + urgency | creates variation_request | LIVE |

### Page: Portal Files — route `.../files` (`files/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** "Send us a file" (general upload, not tied to an invoice) + read-back of sent files.
- **Feature — Upload file** (`uploadCustomerFile`, `_customer-file-action.ts:59`): validates (PDF/JPG/PNG/WebP/HEIC, 10MB), writes `portal_uploads` (kind customer file), HQ audit + org notification. CRUD: file. Side-effect: **org notification**. LIVE. (Read-back via signed URLs.)

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send file | upload form | `uploadCustomerFile` | file | stores + notifies org | LIVE |
| View (sent file) | list | signed URL | — | open file | LIVE |

### Page: Portal Contacts — route `.../contacts` (`contacts/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** customer adds reachable contacts (never mints portal access — that's a staff action; "Portal access" badge shown read-only).
- **Feature — Add contact** (`addCustomerContact`, `_contact-action.ts:37`): validates, INSERT `customer_contacts` org+customer pinned, HQ audit. CRUD: contact. LIVE.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Add contact | form | `addCustomerContact` | name + (email or phone) | adds contact | LIVE |

### Page: Portal Profile — route `.../profile` (`profile/page.tsx`)
- **Status:** LIVE & WORKING. **Purpose:** read-only "on file" details + editable comms preferences + profile-change *requests*.
- **Features:** (1) **Save preferences** — `savePortalPreferences` (`_preferences-action.ts:44`): writes customer-owned preferred-channel + notes directly; HQ audit. CRUD: preferences. LIVE. (2) **Request a change** — `requestProfileUpdate` (`_preferences-action.ts:115`): does NOT write `customers`; opens a `support_tickets` row (category account) for staff to apply; org notification. CRUD: support ticket. LIVE. (Name/email/phone deliberately read-only.)

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save preferences | prefs form | `savePortalPreferences` | channel | saves prefs | LIVE |
| Request the change | profile form | `requestProfileUpdate` | ≥1 field | opens change ticket | LIVE |

---

## DOMAIN SUMMARY

**Counts**
- Pages audited: **28** — 13 Sales (`/leads`, `/leads/[id]`, `/leads/new`, `/quotes`, `/quotes/[id]`, `/quotes/new`, `/customers`, `/customers/[id]`, `/customers/new`, `/price-book`, `/price-book/[id]`, `/reviews`, `/reviews/new`) + `/q/[token]` + **14 portal routes** (overview, activity, quotes, invoices, valuations, jobs, photos, reports, reports/[id], warranties, servicing, documents, messages, messages/[ticketId], chat, requests, files, contacts, profile = 19 portal pages incl. shell). Portal page files = 19 as specced.
- Named server actions / API handlers across the domain: ~45 (leads 7, quotes ~12 incl. public token + variation + EOT, customers 5 + contacts 4, price-book 6, reviews 4, portal ~12, quote-writer 3).
- Buttons/controls tabulated: ~120.

**Status tallies**
- LIVE & WORKING: the overwhelming majority of pages + controls.
- FLAGGED OFF (built-dark): **Portal "Pay now"** (`NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` + Stripe Connect key + per-org connection); **AI Quote Writer** (model bound, awaits vendor credential — dark "Off" notice); lead **AI summary** generate/regenerate (provider-gated, governor-metered); portal chat **AI auto-reply** seam (deterministic ack only today).
- Dark-safe (LIVE but no-op without config): quote "Email PDF", customer "Email statement", "Send review email now" — all degrade to a configuration error without `RESEND_API_KEY`.
- BROKEN: none found.
- PLACEHOLDER: none (dark features render honest "off" copy).

**Notable findings**
1. **`/reviews` is the one Sales surface with no server-side role gate.** It has no `layout.tsx`; `page.tsx:72`, `new/page.tsx:29` and every action in `reviews/actions.ts` use only `requireOrgContext()` (no `requireManagementRole`). Nav hides it under ADMIN_ROLES, but a `staff` member can reach the list/new page and run create/send-email/cancel/complete by URL — unlike leads/quotes/customers/price-book, which each have a `requireManagementContext()` layout guard. Only a real authz gap in this domain.
2. **Portal online payments are fully dark in prod.** Two-switch gate (`lib/payments/portal-stripe.ts:50-66`, comment "NEVER, today") + a third per-org Stripe-Connect-account check (`invoices/page.tsx:252-265`) mean the "Pay now" button never renders; bank-transfer + proof-upload is the only live path. Webhook (`/api/webhooks/stripe-invoice`) + checkout service exist behind it.
3. **AI Quote Writer is built-and-bound but credential-gated** → shows a well-engineered dark notice (`_quote-writer-panel.tsx` `DarkNotice`); owners/admins see an activation checklist. It never calls a model on render (event-driven only). Classify FLAGGED OFF.
4. **Report "decisions we need from you" is a dead-end on the report page** (`reports/[id]/page.tsx:95`): it's display-only, yet the Overview action centre nudges "Open report" for pending decisions. The customer can only respond via Messages — no decision-capture control exists.
5. **Quote acceptance (owner-side and public token) auto-creates and emails an invoice** (`quotes/actions.ts:1189-1200`, `:1436-1442`) — a notable cross-domain side-effect chain (quote → draft invoice → customer email) worth knowing when auditing Money.
6. **Customer-facing reads strip cost/margin columns by construction**: `/q/[token]`, portal quotes, portal valuations, portal jobs all explicitly avoid `cost_*`/`jobs.notes`/staff email, enforced by security tests (noted in code). Strong tenant/PII discipline on the service-role (RLS-bypassing) portal.
7. **Customers list read is not loud** (`customers/page.tsx:112` logs + degrades to empty) — the lone read on these pages that doesn't `throw readFailure`; every other Sales/portal read fails loud. Minor reliability inconsistency.
8. **Hard-to-discover / cross-nav controls:** price-book "Save as template" is reachable only from a quote's detail page (`SaveAsTemplatePanel`), not from `/price-book`; the quotes customer-filter view is only linked from customer detail; `?lead_id`/`?customer_id` quote pre-fill is only reachable via the lead detail CTA.
9. **Implemented, not in customer nav (intentional):** public lead intake API handlers (`/api/v1/leads`, `/api/demo`) feed `/leads` but have no page control. The `chat/poll` route backs the chat panel's polling with no UI of its own.
10. **Orphaned/dead controls:** none found — every server action in the domain has a reachable UI trigger; variation-request change intake is conditionally shown (only when the customer has open jobs).
