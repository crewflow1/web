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
| quotes, quote_line_items | MEMBER-WIDE r/w | **admin-only** (#1040, D-13 decided) |
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

## 5. D-13 resolved + remaining low-sensitivity item

- **quotes / quote_line_items — DECIDED + FIXED (#1040).** Founder decision
  (2026-11-02): quotes are **owner/admin only**; ordinary staff may not read/
  create/edit/delete quotes via UI/PostgREST/APIs/RPCs (a dedicated estimating
  permission may come later). Migration `20261278000000` scopes SELECT/INSERT/
  UPDATE to `is_org_admin`. Customer-portal accept/decline (service-role), the
  owner/admin lifecycle, and quote→invoice/job automation are preserved. The
  `quote-approval-authz` test was rewritten to the approved model and a dedicated
  staff/cross-org/revoked negative test added.
- **suppliers** — member-readable (vendor names/contacts; lower sensitivity),
  used by staff global search + fleet. **Left member-level** (documented); scope
  SELECT to `is_org_admin` if supplier commercial terms are later deemed
  sensitive.

## 6. Legitimate staff workflows — confirmed still functional (finding §8)

- **Site expenses / costs** — the `finances`/costs table stays member-open
  (staff log authorised site costs) — untouched by this hardening.
- **Assigned-job access** — staff still see their assigned jobs + that job's
  customer (customers scoped to `my_assigned_customer_ids()`), site docs, toolbox,
  material requests, timesheets. Verified by the full integration RLS tier.
- **Leads assigned to a staff member** remain visible to that assignee (#1039).
- Owner/admin quote lifecycle verified in Chrome (`/quotes` reachable, create
  flow intact) + the quote unit tests + quote-approval-authz admin cases.

## 7. Coordinated security release pack (dependency-safe, apply-held)

Migrations are additive, independent (distinct tables/policies), reversible, and
rewrite **no data**. One code-only PR (#1036) + four migration PRs.

**Apply order (after approval), from `~/Code/web` (linked checkout):**
| Step | Migration | PR | Tables |
|---|---|---|---|
| 1 | `20261275000000` | #1037 | invoices, invoice_payments, payments |
| 2 | `20261276000000` | #1038 | customers (+ `my_assigned_customer_ids()`) |
| 3 | `20261277000000` | #1039 | price_book_items, leads |
| 4 | `20261278000000` | #1040 | quotes, quote_line_items |

(#1030's `20261274000000` push/SMS claim is independent; apply in prefix order if
also approved. #1036 is code-only.)

Per step: `supabase db query --linked -f <file>` then `supabase migration repair
--status applied <version> --linked`.

**Backup (pre-apply):** fresh off-platform prod backup + integrity/restore proof
(per `docs/release/FINANCIAL-RLS-FIX-APPLY-PLAN.md`); `supabase migration list
--linked` shows no drift.

**Post-apply verification (read-only on prod):**
```sql
-- every target table's SELECT policy is admin/assigned-scoped, none member-wide:
select tablename, policyname, qual from pg_policies
 where cmd='SELECT'
   and tablename in ('invoices','invoice_payments','payments','customers',
                     'price_book_items','leads','quotes','quote_line_items')
 order by tablename;
-- helper present:
select proname from pg_proc where proname='my_assigned_customer_ids';
```
Plus a direct non-admin-member JWT SELECT on each table → expect 0 rows (or
assigned-scope only). `/api/health` OK.

**Rollback:** each is reversible via a forward migration recreating the prior
member policy (`using (org_id in (select current_org_ids()))`). No data path.

**Recommend treating #1036/#1037/#1038/#1039/#1040 as one coordinated security
release and a launch blocker.** Nothing is applied to production.
