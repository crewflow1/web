# CrewFlow Feature & Button Audit — 06 · Money / Finance

Scope: the **Money** nav area (owner/admin), `app/(app)/_nav/nav-model.ts` id `money` (roles = ADMIN_ROLES). Worktree `/Users/moetalibi/Code/web-main`, main `128dc5aa`. READ-ONLY audit; classified from code + known prod state. Browser verification NOT performed (see CONVENTIONS.md) — most features are therefore "IMPLEMENTED, NOT LIVE-VERIFIED" unless a migration/known-prod fact corroborates them.

Status legend per `docs/audit/CONVENTIONS.md`. Roles: owner, admin, staff only; ADMIN_ROLES = owner+admin.

**Money authz boundary (recurring):** the money *ledgers/ views* are owner/admin only; *cost ENTRY* (`/finances/new` → `POST /api/finances`) is deliberately **member-open** so field staff can log costs. Every other Money route is admin-gated — by a segment `layout.tsx` (invoices, payments, expenses, cis, reports) or a per-page `requireManagementRole` (cash, finances list, tax, insights).

---

### Page: Cash position — route `/cash`

- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Roles:** owner/admin only. `cash/page.tsx:144` redirects `staff` → `/me`. Money-out ledger (bills/CIS/VAT/draft payroll) is additionally gated by `cashOutVisibleToRole(role)` (`:154`) — withheld (not understated) for any future non-admin role.
- **Per-role diffs:** owner/admin see the full net position (collectable − owed). The money-OUT section, net-position card and supplier-bill queue only render when `showOutflows` is true (`:200,:313,:346`).
- **Purpose:** single read-only cash picture — what you can collect, what you owe now, the net, plus money-in outlook, payables, unscheduled contract value and recently-paid.
- **What the user sees:** Net-position card (collectable now / owed out now / net); money-in stat grid (collectable, overdue, due this week, expected this month, retention held, ready to invoice); money-in cash outlook rows by certainty; money-out "what you owe" rows (each flagged FACT/ESTIMATE); supplier bills queue; unscheduled-contract amber panel; overdue/due-soon/part-paid/ready-to-invoice queues; recently-paid list.
- **Features:**
  1. **Net cash position** — Problem: owner needs "can I cover what I owe". Steps: page composes `buildOrgCash` + `buildOrgCashOut` (`:155-163`) then `computeCashPosition` (`:168`). CRUD: read-only. Side-effects: none. Deps: `server/services/org-cash.ts`, `org-cash-out.ts`; explicitly NOT a bank balance (disclaimer `:247-255`). Estimate portion (VAT + draft payroll) flagged amber.
  2. **Money-in outlook** — read-only forecast rows, each labelled by certainty (invoiced vs planned vs unscheduled). No fake percentages.
  3. **Money-out "what you owe"** — unpaid bills + CIS due + VAT + draft payroll; committed POs and past-deadline CIS deliberately excluded (`:335-341`). Each row links to source records.
  4. **Queues & drill-downs** — overdue/due-soon/part-paid link to `/invoices/[id]`; ready-to-invoice links to `/jobs/[id]/billing`; unscheduled links to the job.
- **Load-failure behaviour:** `loadError || out.loadError` renders an amber alert telling the user NOT to trust a "nothing owed" reading (`:194`) — fail-loud money doctrine.
- **Prod availability:** live surface; all figures derived from existing authorities. No side-effects.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Queue row links | all queue lists | navigate to invoice/job | — | read-only nav | IMPLEMENTED, NOT LIVE-VERIFIED |
| Money-out row links | money-out section | navigate to source records | — | read-only nav | IMPLEMENTED, NOT LIVE-VERIFIED |

No create/export controls on this page.

---

### Page: Invoices (list) — route `/invoices`

- **Status:** LIVE & WORKING (invoice domain is core, prod-proven; void shipped mig 20261219).
- **Roles:** owner/admin only — enforced twice: segment guard `invoices/layout.tsx:17` (`requireManagementContext`) AND page `requireManagementRole(ctx)` (`invoices/page.tsx:70`). RLS last line.
- **Purpose:** org invoice ledger with status/customer filters, pagination, CSV/Xero/Sage export, and create.
- **What the user sees:** header with total count + export buttons + "New"; customer-filter banner (when `?customer=`); status filter form; `DataTable` (desktop columns + mobile cards, client-side sort over the loaded page, selectable rows with client CSV of selection); pagination.
- **Features:**
  1. **Filtered ledger** — Problem: find invoices by status/customer. Steps: server query org-pinned (`:124`), ordered `created_at,id` (F-1 deterministic paging, PAGE_SIZE 50). `overdue` and `outstanding` are canonical derived sets (`:131-150`) so drill-throughs match dashboard tiles. CRUD: read. Side-effects: none.
  2. **Export CSV / Xero / Sage** — links to `/api/invoices/export?format=simple|xero|sage&status=` (`:188-213`). simple = per-invoice; xero/sage = per-line-item mapped to each vendor import schema; management-gated (`export/route.ts:41`). Side-effect: file download (GET, new tab).
  3. **Bulk CSV of selection** — non-destructive client-side CSV of selected loaded rows (`:302`). No server call.
- **Prod availability:** live. Export is CSV only — no API push here (accounting push lives on /reports).

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| New (invoice) | header | → `/invoices/new` | — | create flow | LIVE & WORKING |
| Export CSV | header | GET `/api/invoices/export?format=simple` | — | CSV download | IMPLEMENTED, NOT LIVE-VERIFIED |
| Export Xero | header | GET …`format=xero` | — | Xero-schema CSV | IMPLEMENTED, NOT LIVE-VERIFIED |
| Export Sage | header | GET …`format=sage` | — | Sage-schema CSV | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status filter / Apply / Clear | filter form | GET requery | status | filtered list | LIVE & WORKING |
| Clear customer filter | banner | → `/invoices` | — | removes `?customer=` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Row sort / select / "Open →" | DataTable | client sort / select / open detail | — | nav / selection | IMPLEMENTED, NOT LIVE-VERIFIED |
| Prev / Next | pagination | page nav | — | page change | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: New invoice — route `/invoices/new`

- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (fallback path; invoices are normally auto-created on quote acceptance).
- **Roles:** owner/admin (layout guard). Page uses `requireOrgContext` only, but the layout gates it.
- **Purpose:** manual fallback to bill an **accepted** quote whose auto-invoice didn't fire.
- **What the user sees:** breadcrumb, a quote picker (accepted quotes only, F-1 fully paged `new/page.tsx:26`), due-date, notes; or an EmptyState when no accepted quote exists.
- **Features:**
  1. **Generate invoice from accepted quote** — Steps: client posts JSON → `POST /api/invoices` (`_form.tsx:38`). Server re-validates the quote is `accepted` (`route.ts:98`), rejects variations already captured in a non-cancelled interim valuation (double-bill fence `:102-145`), allocates number via `next_invoice_number` RPC, inserts `draft` invoice with denormalised `customer_id` + net-14 due default. CRUD: create `invoices`. After success: `router.push('/invoices/[id]')`. Side-effects: none (no email on create). Limits: only accepted quotes billable; valuation-linked variations excluded both in the picker and server-side.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Quote picker | form | select accepted quote | quote_id | enables submit | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generate/Submit | form | POST `/api/invoices` (201) | quote_id (+due/notes) | new draft invoice | IMPLEMENTED, NOT LIVE-VERIFIED |
| Go to quotes / Back | EmptyState | nav | — | nav | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Invoice detail — route `/invoices/[id]`

- **Status:** LIVE & WORKING (void flow + banners shipped mig 20261219).
- **Roles:** owner/admin (layout guard + per-action `requireManagementApi`/`requireManagementRole`).
- **Purpose:** one invoice — header/totals, immutable line-item snapshot, customer payment proofs, payments panel, audit, attachments, status/send/remind/link/void/delete controls.
- **What the user sees:** void/saved banner; PDF download; display-status pill (derived "overdue"); Net/VAT/Total; line items (own snapshot, F-1 paged, immune to later quote edits `:164`); PaymentProofsPanel; PaymentsPanel (totals + add/remove); audit (sent_at/paid_at/notes); AttachmentsPanel; Actions (`InvoiceControls`); Void form (only when not void/paid/partially_paid `:390`).
- **Features (numbered):**
  1. **Set status** (`_controls.tsx:42`) — PATCH `/api/invoices/[id]` with `{status}`; server stamps `sent_at`/`paid_at`; "overdue" no longer writable (derived). CRUD: update. Side-effects: none.
  2. **Link to job** (`:101`) — PATCH `{job_id}`; server `verifyJobInOrg` cross-org guard (`route.ts:67`). CRUD: update. Side-effect: recomputes job profitability rollup.
  3. **Email invoice PDF (Send)** (`:65`) — POST `/api/invoices/[id]/send`; renders PDF + emails via `sendInvoiceEmail` (Resend), stamps `sent_at`, flips draft→sent. CRUD: update + email row. **Side-effect: customer-facing EMAIL.** Active-org gate refuses foreign invoice before render (`send/route.ts:50`). **Dark unless `RESEND_API_KEY` set** → 503 `email_not_configured`.
  4. **Send reminder now** (`:126`) — POST `/api/invoices/[id]/remind`; stage "manual", stop-on-paid/void (409). CRUD: insert `invoice_reminders`. **Side-effect: EMAIL** (Resend). Dark without RESEND.
  5. **Download PDF** — GET `/api/invoices/[id]/pdf` (`:226`); org-pinned, renders org letterhead/bank details; management-gated. Side-effect: file download.
  6. **Delete invoice** (`:163`) — `confirm()` then DELETE `/api/invoices/[id]`; org-pinned destructive. CRUD: delete.
  7. **Void invoice** (`payment-actions.ts:215`) — server action; requires reason ≥3 chars; DB trigger `tg_invoices_void_guard` is the authority (refuses paid/partially-paid/has-payments, stamps `voided_at`, terminal). CRUD: update status→void. Side-effect: removes from receivables. Redirect banner on refusal.
  8. **Payment proofs** (`_payment-proofs-panel.tsx`) — reads customer-submitted proofs from `portal_uploads` via **admin client** (RLS has no policies; `org_id`+`target`+`kind` filters are the sole isolation). "Open" mints a 60s signed URL (`proof-actions.ts:30`, management-gated). CRUD: read-only.
  9. **Add payment** (`_payments-panel.tsx` → `addInvoicePayment`) — see Payments below; inserts `invoice_payments` with 10s dedupe window; status auto-derived by trigger; fires dark `payment.recorded` automation.
  10. **Remove payment** (`removeInvoicePayment`) — org-checked + org-pinned delete; redirects with `saved=payment_removed`.
- **Prod availability:** live; email paths dark without Resend; void live.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Download PDF | header | GET `/pdf` | — | PDF | IMPLEMENTED, NOT LIVE-VERIFIED |
| Set status (draft/sent/awaiting/partially/paid) | Actions | PATCH status | status | status+timestamp | LIVE & WORKING |
| Link to job (select) | Actions | PATCH job_id (onChange) | job_id | profitability relink | IMPLEMENTED, NOT LIVE-VERIFIED |
| Email invoice PDF → Send now | Actions | POST `/send` | recipient (customer or override) + note | **email sent**, draft→sent | FLAGGED OFF without RESEND_API_KEY |
| Send reminder now | Actions | POST `/remind` | recipient | **reminder email** + audit row | FLAGGED OFF without RESEND_API_KEY |
| Delete invoice | Actions | DELETE (confirm) | — | invoice deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Void invoice | Void form | server action | reason (≥3) | status→void | LIVE & WORKING |
| Add payment (Amount/Date/Ref/Notes → submit) | Payments | `addInvoicePayment` | amount, paid_at | payment recorded, status derived | LIVE & WORKING |
| Remove (payment) | Payments list | `removeInvoicePayment` | — | payment deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open (proof) | Proofs | signed URL (60s) → new tab | — | opens proof file | IMPLEMENTED, NOT LIVE-VERIFIED |
| Attachments (add/open/delete) | AttachmentsPanel | shared component | file | attach/view | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Payments / reconcile — route `/payments` (+ `/payments/new`, `/payments/reconcile/[id]`)

- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **Not a payment gateway** — "CrewFlow tracks payments, doesn't process them" (`payments/page.tsx:121`).
- **Roles:** owner/admin — segment guard `payments/layout.tsx:10`. The CSV-upload card additionally gates on `isAdmin` (`page.tsx:158`) though staff can't reach the segment at all.
- **Purpose:** record a real-world payment allocated across invoices; and bank-CSV upload → auto-match → reconcile.
- **What the user sees (`/payments`):** Outstanding headline (NETted via `computeReceivables`, F-1 paged `:54`/`:75`); "Record payment" button; CSV upload card; statement history (links to reconcile).
- **Features:**
  1. **Record allocated payment** (`/payments/new` → `recordAllocatedPayment`, `allocate-actions.ts:28`) — one `payments` receipt + one `invoice_payments` allocation per invoice, written atomically via `allocate_payment` RPC (over-allocation guard = DB authority). Pre-check `computePaymentAllocation`; 10s fail-closed idempotency probe. CRUD: insert payments + invoice_payments. **Side-effect: `payment.recorded` automation** (dark by default) + `recordAdminActivity`. Management-gated.
  2. **Upload bank CSV** (`uploadBankCsv`, `actions.ts:44`) — parse CSV (≤5MB), insert `bank_statements` + `bank_statement_lines`, score each incoming line vs unpaid invoices (≥70 → suggested). CRUD: insert. Navigates to reconcile. Side-effects: none external. Admin re-checked (`:54`).
  3. **Confirm bank match** (`confirmBankMatch`, `actions.ts:205`) — inserts `invoice_payments` for the matched line, updates line `match_status=matched`, bumps `bank_statements.matched_count`. CRUD: insert + update. **Side-effect: `payment.recorded` automation** (dark). Uses FormState+redirectTo (StateForm) to dodge the Next 15.5 stranded-commit race (`:18-31`).
  4. **Ignore bank line** (`ignoreBankLine`, `actions.ts:329`) — update `match_status=ignored`. CRUD: update.
  5. **Reconcile page** (`reconcile/[id]/page.tsx`) — statement + lines (F-1 paged) + full outstanding candidate ledger; per-line match/ignore forms.
- **Prod availability:** live (no external payment rail). Automations dark.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Record payment | `/payments` header | → `/payments/new` | — | allocate form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record (allocate submit) | `/payments/new` | `recordAllocatedPayment` (RPC) | amount, date, method, allocations | receipt + allocations | IMPLEMENTED, NOT LIVE-VERIFIED |
| Upload + match | `/payments` | `uploadBankCsv` | CSV file (≤5MB) | statement + suggestions | IMPLEMENTED, NOT LIVE-VERIFIED |
| Confirm match | reconcile | `confirmBankMatch` | — | invoice_payments + matched | IMPLEMENTED, NOT LIVE-VERIFIED |
| Ignore line | reconcile | `ignoreBankLine` | — | line ignored | IMPLEMENTED, NOT LIVE-VERIFIED |
| Statement row link | `/payments` | → reconcile | — | nav | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Expenses — route `/expenses` (+ `/new`, `/[id]`, `/budgets`)

- **Status:** PARTIALLY IMPLEMENTED — list/upload/approve/reject/budgets live; **AI receipt extraction is a governed AI call, DARK by default**.
- **Roles:** owner/admin — segment guard `expenses/layout.tsx` + page `requireManagementRole` (`page.tsx:49`); every action re-checks `requireManagementRole`.
- **Purpose:** receipt → AI-extracted draft → operator approval → posts a cost to `/finances`. Plus per-category budgets.
- **What the user sees:** three buckets (pending `extracted` / approved / rejected); draft list with AI confidence; detail page with editable extracted values + approve/reject; budgets page (budget-vs-actual bands + admin set/delete forms).
- **Features:**
  1. **Upload receipt** (`uploadExpenseReceipt`, `actions.ts:64`) — uploads to private `receipts` bucket (admin client), creates `expense_drafts` row, runs OCR in-band. CRUD: storage + insert. Side-effect: **governed AI vision extraction** — `createExpenseDraftFromUpload` → `maybeExtractReceipt` → `invokeWithGovernor("expense.receipt_extraction")` (`server/services/expense-drafts.ts:271`). **DARK:** no tier bound → `zeroExtraction` fallback, operator types values (registry `degradesTo`, `lib/ai/governor/registry.ts:360`). Confidence capped at 85% (review always required, `:381`). Writes `recordAdminActivity`.
  2. **Approve draft** (`approveExpenseDraftAction`, `actions.ts:134`) — `approveExpenseDraft` service posts a `finances` row and stamps `expense_drafts.finance_id` (admin client, since UPDATE RLS is `is_org_admin`). CRUD: insert finances + update draft. After success → `/expenses?saved=approved`, revalidates `/finances`.
  3. **Reject draft** (`rejectExpenseDraft`, `actions.ts:160`) — archive with reason; idempotent (already-approved guard). CRUD: update.
  4. **Set / delete budget** (`budgets/actions.ts:49,102`) — admin-gated (`isManager`); upsert/delete per-category standing budget via RPC. CRUD: upsert/delete. Read overlay only — never touches `finances` arithmetic.
- **Prod availability:** list/approve/reject/budgets live; AI OCR dark (needs vision provider + activated tier).

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Status tabs (pending/approved/rejected) | `/expenses` | filter | — | filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Upload receipt | `/expenses/new` | `uploadExpenseReceipt` + OCR | file (≤10MB, image/pdf) | draft (AI fields null when dark) | PARTIALLY IMPLEMENTED (AI dark) |
| Approve | `/expenses/[id]` | `approveExpenseDraftAction` | amount, vat, category | posts to Costs | IMPLEMENTED, NOT LIVE-VERIFIED |
| Reject | `/expenses/[id]` | `rejectExpenseDraft` | reason | draft archived | IMPLEMENTED, NOT LIVE-VERIFIED |
| Set budget | `/expenses/budgets` | `setExpenseBudget` (RPC) | category, amount, period | budget saved | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete budget | `/expenses/budgets` | `deleteExpenseBudget` | — | budget removed | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Costs (Finances) — route `/finances` (+ `/new`)

- **Status:** LIVE & WORKING (core cost ledger).
- **Roles:** **the Money authz boundary lives here.** `/finances` LIST is owner/admin (`page.tsx:49` `requireManagementRole`; no segment layout.tsx exists — per-page guard). `/finances/new` + `POST /api/finances` are **member-open** (any member logs a cost; `route.ts:93-98` uses `requireOrgContext` by design). `GET/PATCH/DELETE /api/finances` and export are management-gated (`requireManagementApi`).
- **Per-role diffs:** staff cannot view the cost ledger but CAN add a cost (e.g. from a job page "+ Add cost"). Read vs write intentionally split; RLS "members can insert" matches.
- **Purpose:** cost/expense log with category/VAT filters + monthly summary; add a cost with optional receipt.
- **Features:**
  1. **Cost ledger** (`page.tsx`) — org-pinned, F-1 deterministic paging (PAGE_SIZE 50), category/vat/date filters, monthly summary. CRUD: read. Management-gated.
  2. **New cost entry** (`new/_form.tsx` → `POST /api/finances`) — multipart (optional receipt → `receipts` bucket, admin client); `verifyJobInOrg` cross-org guard on `job_id`; VAT auto-computed; inserts `finances`. CRUD: create (+ storage). After success → `/jobs/[id]` (if job-scoped) or `/finances`. Side-effects: none external. **Member-open.**
  3. **Export CSV** — `/api/finances/export` (management-gated).
- **Prod availability:** live.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Filters (category/vat/date) | `/finances` | GET requery | — | filtered ledger | LIVE & WORKING |
| New cost | `/finances` / job page | → `/finances/new` | — | create flow | LIVE & WORKING |
| Save cost | `/finances/new` | POST `/api/finances` | amount, vat_rate (+cat/job/receipt) | cost recorded | LIVE & WORKING (member-open) |
| Export CSV | `/api/finances/export` | GET | — | CSV | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: CIS — route `/cis` (+ `/statements/[id]`)

- **Status:** LIVE & WORKING (M1–M4 live, prod tip ≥20261055). **CrewFlow never files to HMRC** — export/email only; M5 HMRC seam dark.
- **Roles:** owner/admin — segment guard `cis/layout.tsx` + in-page `isAdmin` refusal card (`page.tsx:99`) + every action re-checks `isManager` (`FORBIDDEN`). Tax identifiers never written to audit metadata.
- **Purpose:** per-tax-month (6th→5th) subcontractor payment & deduction statements and the CIS300-shape return dataset.
- **Features:**
  1. **Save contractor profile** (`saveContractorProfile`, `actions.ts:64`) — upsert PAYE ref/UTR. CRUD: upsert `cis_contractor_profiles`. Required before any statement.
  2. **Issue / reissue statement** (`issueCisStatement`, `:102`) — issues a new statement that supersedes the prior (never edits it). CRUD: insert. Audit row.
  3. **Withdraw statement** (`withdrawCisStatement`, `:138`) — on statement detail. CRUD: update.
  4. **Prepare monthly return** (`prepareCisReturn`, `:182`) — builds CIS300-shape figures; success message explicitly states CrewFlow does not file (`:207`). CRUD: insert `cis_monthly_returns`.
  5. **Mark as exported** (`exportCisReturn`, `:217`) — records the operator downloaded figures; "does not file" (`:245`). CRUD: update. State is `prepared|exported` only — filing is structurally unrepresentable.
  6. **Email statements to subcontractors** (`emailCisStatements`, `:268`) — queues statutory statements onto CrewFlow's outbound email queue; **sent via Resend by the shared drain** — **dark with no email provider** (nothing leaves the building). Idempotent (keyed on statement number); gross-paid + no-email skipped. **Side-effect: EMAIL to subcontractors** (NOT HMRC). CRUD: queue insert.
- **Prod availability:** live; emailing dark without Resend; no HMRC filing anywhere in this file.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Contractor profile (save) | `/cis` | `saveContractorProfile` | PAYE ref/UTR | profile saved | LIVE & WORKING |
| Issue / reissue statement | `/cis`, detail | `issueCisStatement` | supplier, tax month | statement issued | LIVE & WORKING |
| Withdraw statement | `/cis/statements/[id]` | `withdrawCisStatement` | — | statement withdrawn | IMPLEMENTED, NOT LIVE-VERIFIED |
| Prepare return | `/cis` | `prepareCisReturn` | tax month | return figures prepared (not filed) | LIVE & WORKING |
| Mark as exported | `/cis` | `exportCisReturn` | return_id | export recorded (not filed) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Email statements to subcontractors | `/cis` | `emailCisStatements` | tax month | statements queued | FLAGGED OFF without RESEND |

---

### Page: Tax — route `/tax`

- **Status:** PARTIALLY IMPLEMENTED — VAT/PAYE/CT **estimates** live; **HMRC MTD connect + submit is DARK** (`NEXT_PUBLIC_FEATURE_HMRC_CONNECT` + `HMRC_CLIENT_ID/SECRET`) plus a legal gate (HMRC vendor recognition).
- **Roles:** owner/admin — page `requireManagementRole` (`page.tsx:71`); every action checks owner/admin (`actions.ts:58,97,175`).
- **Purpose:** VAT (quarter, stagger-aware), PAYE/NI, Corporation Tax estimates derived from the org's own invoices/finances/payroll. Estimates only, "confirm with your accountant".
- **What the user sees:** estimate tiles + HMRC submissions list + prepare/submit affordances — the submit control renders **only when `isHmrcConnectable()`** (so it does not exist dark).
- **Features:**
  1. **VAT/PAYE/CT estimates** — F-1 paged, org-pinned SUMs (`:111`); cash-basis output VAT on `paid_at`. CRUD: read.
  2. **Prepare VAT return** (`prepareVatReturnAction`, `actions.ts:56`) — composes a prepared/held 9-box return via `submitVatReturn` orchestrator seam. Available DARK (pure composition; nothing reaches HMRC). CRUD: insert prepared return.
  3. **Prepare CIS300 return** (`prepareCis300ReturnAction`, `:94`) — same pattern.
  4. **Submit to HMRC** (`submitHmrcReturnAction`, `:163`) — **doubly dark-gated:** throws the honest "not recognised / not configured" reason BEFORE invoking the orchestrator when `!isHmrcConnectable()` (`:179`); orchestrator + adapters repeat the guard. No code path reaches HMRC's network. CRUD: would advance prepared→submitting (unreachable).
- **Prod availability:** estimates live; MTD submit dark (flag + creds + legal recognition all absent today).

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Prepare VAT return | `/tax` | `prepareVatReturnAction` | period | prepared return (held) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Prepare CIS300 | `/tax` | `prepareCis300ReturnAction` | tax month | prepared return | IMPLEMENTED, NOT LIVE-VERIFIED |
| Submit to HMRC | `/tax` (only when connectable) | `submitHmrcReturnAction` | kind, submission id | **blocked** — honest refusal | FLAGGED OFF (FEATURE_HMRC_CONNECT + creds + recognition) |

---

### Page: Reports — route `/reports` (+ profit, cashflow, ageing, pipeline, retention, utilisation)

- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (reports live; accounting API push DARK).
- **Roles:** owner/admin — segment guard `reports/layout.tsx`. Within, `managementOnly` reports (profit, cashflow, utilisation) are hidden from a non-admin in the library and 403 on export (`[report]/export/route.ts:53`) — a *correctness* gate (pay RLS makes labour/profit wrong under a non-admin JWT). ageing + retention pages redirect staff (`ageing/page.tsx:183`).
- **Purpose:** time-series aggregates (jobs/week, revenue/month, VAT/quarter, top customers) + composed report library + ledger listings + scheduled delivery + accounting push.
- **Features:**
  1. **Overview charts** — server-rendered SVG (no chart lib); org-scoped aggregates. CRUD: read.
  2. **Report library** (`lib/reports/registry.ts`: profit, cashflow, utilisation, pipeline) — each a dedicated page reusing a compute authority; shared PDF/CSV export via `/api/reports/[report]/export` (management-gated per `managementOnly`).
  3. **Ledger listings** — Retention register (`/reports/retention`) + Aged debtors & creditors (`/reports/ageing`). Reachable from the /reports cards; **NOT in the REPORTS registry** (no subscribe/PDF entry).
  4. **Export CSV** (overview) — `/api/reports/export` (management-gated).
  5. **Scheduled report subscriptions** (`ReportSubscriptionsPanel` + `subscribe/actions.ts`) — admin-only create/delete (`isAdminRole`); emails a report on a cadence. **DARK until email configured** (cron skips with no key). CRUD: insert/delete `report_subscriptions`. **Side-effect: scheduled EMAIL.**
  6. **Accounting connections** (`AccountingConnectionsPanel`) — Xero/QuickBooks/Sage OAuth. Connect control is a **DISABLED "Connect (configure credentials)" button while `connectable=false`** — never links to OAuth dark. `isXeroConnectable/…` require `FEATURE_ACCOUNTING_CONNECT` + client id/secret (`lib/integrations/accounting/oauth.ts:59,70`). Disconnect = admin action.
  7. **Accounting push / export** (`AccountingExportPanel` + `accounting/actions.ts`) — `requestAccountingPush` admin-gated, returns honest "not connected — use CSV" while dark (`actions.ts:81`); CSV export (`/api/accounting/export`) admin-gated, works today.
- **Prod availability:** reports + CSV live; subscriptions dark w/o email; accounting API push dark (FEATURE_ACCOUNTING_CONNECT off).

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Export CSV (overview) | `/reports` | GET `/api/reports/export` | — | CSV | IMPLEMENTED, NOT LIVE-VERIFIED |
| Report library cards | `/reports` | nav to report (admin-filtered) | — | report page | IMPLEMENTED, NOT LIVE-VERIFIED |
| Retention / Ageing cards | `/reports` | nav to ledger listing | — | report page | IMPLEMENTED, NOT LIVE-VERIFIED |
| Per-report PDF/CSV export | each report | GET `/api/reports/[report]/export` | — | PDF/CSV (403 if mgmt-only & non-admin) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Subscribe (schedule) | ReportSubscriptionsPanel | `createReportSubscription` | report, cadence, recipients | subscription (emails on cadence) | FLAGGED OFF without email |
| Delete subscription | panel | `deleteReportSubscription` | id | removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Connect (Xero/QB/Sage) | AccountingConnectionsPanel | disabled while dark | creds | — | FLAGGED OFF (FEATURE_ACCOUNTING_CONNECT) |
| Disconnect | panel | `disconnectAccountingConnection` | — | connection removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Push to accounting | AccountingExportPanel | `requestAccountingPush` | provider | honest "not connected" while dark | FLAGGED OFF (accounting connect) |
| Accounting CSV export | AccountingExportPanel | GET `/api/accounting/export` | — | CSV | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: AI Insights — route `/insights`

- **Status:** PARTIALLY IMPLEMENTED — deterministic signals/health/forecasts live; **LLM narrative + question box DARK** unless an inference tier is activated.
- **Roles:** owner/admin — page `requireManagementRole` (`page.tsx:47`). Forecasts section further gated by `cashOutVisibleToRole` (`:83`). API `/api/ai/question` management-gated (`route.ts:34`).
- **Purpose:** read-only analytical surface. "Nothing here changes a record, sends a message, or moves money."
- **Features:**
  1. **Deterministic signals / company health / forecasts** — composed from existing authorities; every card labelled FACT/DERIVED/HEURISTIC; no model. CRUD: read.
  2. **LLM activity narrative** (`resolveInsightNarrative`, `:63`) — overlays prose on the `summary` slot ONLY; cached + cost-recorded; null when no provider. **Governed AI** (shared `lib/ai/text` abstraction). Dark without activated tier.
  3. **Ask CrewFlow Insights (question box)** (`_question-box.tsx` → POST `/api/ai/question`) — returns `AiResponse` (answer + confidence + sources); read-only; rate-limited 20/IP/hour (`route.ts:42`). Badge reads `isInferenceTierActivated()` → shows "Deterministic only" when dark (`page.tsx:129`). **Governed AI call** via `askAi`. **Side-effect: governed AI inference** (cost-recorded); no data writes.
- **Prod availability:** deterministic layer live; AI prose + Q&A dark unless inference tier activated.

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Sample question chips | QuestionBox | prefill + submit | — | AI/deterministic answer | PARTIALLY IMPLEMENTED (AI dark) |
| Ask (submit) | QuestionBox | POST `/api/ai/question` | question (3–500 chars) | answer+confidence+sources | PARTIALLY IMPLEMENTED (AI dark) |

---

### Page: Payment landing pages — routes `app/payment/success`, `app/payment/cancelled`

- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **Not part of the Money nav area** — these are PUBLIC (no-auth) Stripe Checkout landing pages for the one-off **setup-fee** paid during HQ-driven customer onboarding (not tenant invoicing). Payment confirmation + provisioning happen in the Stripe webhook. Included here only because the prompt lists `app/payment/*`. Purely informational; no buttons beyond nav links.

---

## DOMAIN SUMMARY — Money / Finance

**Counts:** 9 nav routes (cash, invoices, payments, expenses, finances/Costs, cis, tax, reports, insights) + nested routes: invoices `[id]`/new, payments new/reconcile`[id]`, expenses `[id]`/new/budgets, finances new, cis statements`[id]`, reports {profit, cashflow, ageing, pipeline, retention, utilisation}/accounting. Plus 2 public `app/payment/*` landing pages. ~25 distinct pages/subpages. Server actions: ~22. API handlers: invoices (6), finances (3), reports (3), accounting (1), ai/question (1).

**Status tally (by page/major-feature):**
- LIVE & WORKING: invoices (list/detail incl. void), finances/Costs, CIS (statements/returns), invoice payments.
- IMPLEMENTED, NOT LIVE-VERIFIED: cash position, new invoice, payments/reconcile, reports (aggregates + CSV + ledger listings).
- PARTIALLY IMPLEMENTED: expenses (AI OCR dark), tax (estimates live, MTD submit dark), insights (deterministic live, LLM dark).
- FLAGGED OFF: invoice send/remind email (no RESEND), CIS statement email (no RESEND), report subscriptions email, HMRC submit, accounting API push/connect.

**Hard-to-discover / not in nav:** `/reports/ageing` and `/reports/retention` exist and are linked only as cards on `/reports` (NOT in the REPORTS registry, so no subscribe/PDF entry). `/expenses/budgets` is only reachable via a link on `/expenses`. `/finances/new` cost entry is primarily reached from the job page "+ Add cost", not the Money nav.

**Implemented but intentionally member-open (the Money authz boundary):** `/finances/new` + `POST /api/finances` are reachable by any org member (staff log costs); the `/finances` LIST and all mutation/export APIs are management-gated. `/finances` has **no `layout.tsx` segment guard** (unlike every other Money route) precisely so the new-page member-open exception can exist.

**Orphaned / dead:** none identified. All server actions and API handlers inspected have a UI caller. `app/payment/*` are live but belong to onboarding, not tenant Money.

**Server-actions / APIs worth noting:** `removeInvoicePayment`, `withdrawCisStatement`, `ignoreBankLine`, `deleteExpenseBudget`, `disconnectAccountingConnection`, `deleteReportSubscription` are all wired to UI controls (not orphaned). The `payment.recorded` automation event fires from both invoice and reconcile payment paths but ships `enabled:false` (dark).

**Dark / flagged FINANCIAL integrations (verify before trusting any "available" claim):**
1. **Invoice & CIS email** (Resend) — `RESEND_API_KEY` absent in prod → sends return 503 / nothing leaves the building.
2. **HMRC MTD (VAT/CIS300/FPS submit)** — `NEXT_PUBLIC_FEATURE_HMRC_CONNECT` (default false) + `HMRC_CLIENT_ID/SECRET` + legal vendor-recognition gate. Submit control only renders when connectable; triply dark-guarded. (`FEATURE_HMRC_CONNECT`.)
3. **Accounting push (Xero / QuickBooks / Sage OAuth)** — `FEATURE_ACCOUNTING_CONNECT` (default false) + per-provider client id/secret. Connect button disabled while dark; CSV export works today.
4. **Portal payments (Stripe Connect, customer pays invoice online)** — `NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS` (default false, `lib/env.ts:576`, `lib/payments/portal-stripe.ts:51`). Stripe-Connect connect route refuses while dark. **No UI surface in the Money nav** (the /payments page states CrewFlow is not a gateway) — it's a customer-portal/onboarding feature.
5. **Open-banking connect** — `NEXT_PUBLIC_FEATURE_BANKING_CONNECT` (default false, `lib/integrations/banking/oauth.ts:66`). API routes only; **no UI in the Money area** today (reconciliation is CSV-upload only).
6. **AI governed calls** — expense receipt OCR (`expense.receipt_extraction`), insights LLM narrative, and the `/insights` question box (`askAi`) all route through `invokeWithGovernor` / `lib/ai/text`; all DARK unless an inference tier is activated (cost governor). Expense OCR degrades to empty-draft; insights degrade to deterministic.
7. **Setup-fee Stripe Checkout** (`app/payment/*`) — real Stripe, but onboarding-only and webhook-driven (not tenant Money); included for completeness.
