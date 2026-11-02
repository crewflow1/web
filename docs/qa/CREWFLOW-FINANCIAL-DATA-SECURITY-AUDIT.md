# CrewFlow — Financial & Customer Data Access Security Audit

> **Method:** direct authenticated **PostgREST** requests with real synthetic
> JWTs (owner / admin / staff / cross-org), bypassing the app UI — the only way
> to prove the *database* access boundary. Plus a full `pg_policies` census of
> every commercially-sensitive table. **Date:** 2026-11-02. All fixes **apply-held**.

## 1. The core finding (why UI/route gates were not enough)

CrewFlow enforces its financial boundary at the **route + UI + capability**
layers (e.g. `/invoices`, `/quotes`, `/cash`, `/reports` are staff-forbidden;
`requireCapabilityFor` gates money actions). But the **RLS on the underlying
tables was org-member-wide**, so a restricted `staff` JWT calling PostgREST
directly could read (and sometimes write) data the UI hides. **A hidden UI
control or route redirect does not fix a database access vulnerability.**

## 2. Policy census — every commercially-sensitive table

| Table | Before | After (this hardening) |
|---|---|---|
| invoices, invoice_payments, payments | MEMBER-WIDE r/w | **admin-only** (#1037) |
| customers | MEMBER-WIDE r/w | **assigned-job SELECT; admin write** (#1038) |
| price_book_items | MEMBER-WIDE r/w | **admin-only** (#1039) |
| leads | MEMBER-WIDE r/w | **admin OR assignee SELECT** (#1039) |
| quotes, quote_line_items | MEMBER-WIDE r/w | **unchanged — product decision pending** (§5) |
| suppliers | MEMBER-WIDE r | unchanged — low-sensitivity (§5) |
| finances/costs | member insert (by design), admin read | unchanged — intentional (staff log site costs) |
| jobs, job_documents, job_valuations, purchase_orders | already admin / assigned-job | unchanged |
| staff_compensation, payroll_lines | already denied to staff | unchanged |

## 3. Confirmed exposures + fixes (empirical, before → after)

| # | Table(s) | Direct staff-JWT BEFORE | AFTER | Fix |
|---|---|---|---|---|
| D-9 (P1) | invoices / invoice_payments / payments | reads INV-0001 £21,675, all payments; **INSERT allowed** | read→0, write→42501; owner/admin OK | **#1037** |
| D-10 (P2) | customers | reads the **whole org CRM** (names/emails/phones/addresses/VAT) | staff sees only assigned-job customers; owner all | **#1038** |
| D-11 (P2) | price_book_items | reads the full rate library | staff→0; owner/admin only | **#1039** |
| D-12 (P2) | leads | reads the **whole sales pipeline** (contact PII, est. values) | staff sees only leads assigned to them | **#1039** |
| D-8 (P2) | (job Overview UI) | commercial strip shown to assigned staff | gated behind `canViewPrivate` | **#1036** |

Each fix uses `is_org_admin(org_id)` (the predicate the existing `admins can
delete` policies already use — it honours HQ impersonation) or a SECURITY DEFINER
assigned-scope helper (`my_assigned_customer_ids()`). Every member-client
reader/writer was dependency-audited first: all portal/cron/api-v1/automation
paths use the **service-role** client (bypass RLS); all remaining member-client
paths sit behind owner/admin route/capability gates (their INSERT…RETURNING still
works). **No legitimate workflow is broken** — confirmed by the full tiers below.

## 4. Verification (data layer, not UI)

- Per-fix positive/negative tests (owner/admin read; staff/cross-org/revoked
  denied; staff write denied; owner write OK): `financial-tables-admin-scope`
  (17), `customers-assigned-job-scope` (6), `price-book-leads-scope` (4).
- **Full security tier — 8,598 tests green.**
- **Full integration RLS tier — 137 files / 1,748 tests green** with all four
  migrations (275/276/277 + #1037's) applied.
- #1036 (UI), #1037/#1038/#1039 (DB) **agree**: the UI hides it, the route
  forbids it, and the DB now denies it — defence-in-depth at all three layers.

## 5. Remaining — product decisions (not yet changed)

- **quotes / quote_line_items** — still member-wide, so a staff JWT can read
  every quote + line price. Staff have **no Sales UI** (no quote drafting in the
  app today), but `quote-approval-authz.test.ts` documents staff quote
  draft/edit/send as an intended **RLS-layer** capability (only the *approval*
  transition is trigger-gated). **Decision needed:** is there an active/intended
  staff quotation workflow?
  - If **no** → scope quotes to `is_org_admin` (and update that test).
  - If **yes** → scope to `created_by = auth.uid() OR job_id IN
    my_assigned_job_ids()` (staff see only their own drafts + assigned-job
    quotes), set `created_by` on the quote-create action, and reseed the test's
    quote with `created_by = staff`. Columns exist (`created_by`, `job_id`).
  I recommend the second (narrowest that preserves a future staff-draft flow).
  Ready to implement on your call.
- **suppliers** — member-readable (vendor names/contacts; lower sensitivity) and
  used by staff global search + fleet (owner). Recommend leaving member-level
  unless supplier commercial terms are considered sensitive, in which case scope
  SELECT to `is_org_admin`.

## 6. Release pack (dependency-safe, apply-held)

All migrations are additive, independent (distinct tables), reversible, and
rewrite no data. Apply in prefix order after founder approval:
`20261275000000` (billing) → `20261276000000` (customers) → `20261277000000`
(price_book/leads). #1036 is code-only (no migration). Per-migration apply/
rollback detail: `docs/release/FINANCIAL-RLS-FIX-APPLY-PLAN.md`.

**Recommend treating #1036/#1037/#1038/#1039 as a coordinated security release
and a launch blocker.** Nothing is applied to production.
