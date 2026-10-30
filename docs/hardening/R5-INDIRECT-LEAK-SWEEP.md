# R5 indirect-leak sweep — side channels that bypass base-table RLS

Date: 2026-10-30 · Scope: R5 staff-isolation (Phase 3 assigned-jobs, Phase 4
commercial tables → `is_org_admin` SELECT in migration `20261250`). Base-table
RLS is owned by the R5 program; this sweep hunts for places a **non-admin STAFF
member** could still read financial figures or another worker's data through a
**side channel that bypasses base-table RLS** (SECURITY DEFINER RPCs, signed-URL
issuers, exports, AI context, page tiles).

Method: static analysis only (grep/read + typecheck). No migrations changed, no
integration tier run. Every finding below is a **DB RPC-guard change** and is
therefore handed to the R5 coordinator to land in the same program as
`20261250` — do not merge the base-RLS narrowing without these, or the narrowing
is trivially defeated via `POST /rest/v1/rpc/...`.

## TL;DR

The app layer already treats **all** management reports as off-limits to staff:

- `lib/auth/capability-rules.ts` `canWith()` — owner always, admin only-if-granted,
  **every other role (staff) → `false`**. So `requireCapabilityApi("reports",
  "view"|"export")` denies staff.
- `app/(app)/reports/profit/page.tsx:65`, `.../utilisation/page.tsx:19`,
  `.../cashflow/page.tsx:58`, `.../ageing/page.tsx:183`, `.../retention/page.tsx:79`
  all redirect staff. `lib/reports/registry.ts` marks profit/cashflow/utilisation
  `managementOnly: true`.

But the SECURITY DEFINER RPCs that **back** those reports are `GRANT EXECUTE … TO
authenticated` and guard on **org membership only** (`current_org_ids()` + 42501),
not on `is_org_admin`. A staff member holding a normal session JWT can call them
directly through the PostgREST Data API, bypassing every Next.js page/capability
gate and (once R5 lands) the narrowed base-table RLS. SECURITY DEFINER **bypasses
RLS by definition**, so Phase 3/4's RLS narrowing does not touch these paths.

The correct pattern already exists in the same codebase:
`report_aged_payables` (`supabase/migrations/20261238000000_reports_aged_ledgers_rpc.sql:225`)
guards with **membership AND `is_org_admin`**:

```sql
if auth.role() is distinct from 'service_role'
   and (p_org_id not in (select public.current_org_ids())
        or not public.is_org_admin(p_org_id)) then
  raise exception 'payables are admin-only for this org' using errcode = '42501';
end if;
```

The fix for every finding is to adopt that exact two-clause guard. `service_role`
(the report-delivery cron render path, which holds no JWT) must keep bypassing, as
it already does.

## Findings (prioritised)

| # | Pri | RPC (file:line) | Reads | Leaks to staff via Data API? | Fix |
|---|-----|-----------------|-------|------------------------------|-----|
| 1 | P1 | `report_profit_labour_hours` — `supabase/migrations/20261239000000_report_profit_rollups.sql:82` (guard L96-99, `grant` L157) | `time_entries` (all jobs/all users) | **Yes** — returns `(job_id, user_id, hours)` for **every** job and **every** worker in the org. Reveals other workers' logged hours across jobs the caller is not assigned to. Backs the admin-only `/reports/profit`. | Add `is_org_admin` clause |
| 2 | P1 | `report_profit_stock_cogs` — `20261239000000_report_profit_rollups.sql:188` (guard L196-199, `grant` L240) | `stock_movements` | **Yes** — returns per-job material **COGS (£)** for all jobs. Commercial cost figure. Backs admin-only `/reports/profit`. | Add `is_org_admin` clause |
| 3 | P1 | `report_aged_receivables` — `20261238000000_reports_aged_ledgers_rpc.sql:100` (guard L118-121, `grant` L187) | `invoices` | **Yes** — per-customer **outstanding balances** org-wide (money owed to the firm, ageing buckets). Backs `/reports/ageing` (staff redirected) and `/reports/cashflow` (admin-only). Sibling `report_aged_payables` (same file, L202, guard L225-227) is already admin-gated — the asymmetry is almost certainly an oversight. | Add `is_org_admin` clause |
| 4 | P1 | `reports_revenue_per_month` — `20261240000000_reports_windowed_aggregates_rpc.sql:117` (guard L134-137, `grant` L170) | `invoices` | **Yes** — org **revenue per month** (paid invoices, ex-VAT). App denies staff `reports:view`. | Add `is_org_admin` clause |
| 5 | P1 | `reports_top_customers_by_revenue` — `20261237000000_reports_top_customers_rpc.sql:49` (guard L69-71, `grant` L107) | `invoices` + customer names | **Yes** — top customers ranked by **paid-invoice revenue** (commercial + customer-relationship intel). App denies staff. | Add `is_org_admin` clause |
| 6 | P2 | `reports_jobs_per_week` — `20261240000000_reports_windowed_aggregates_rpc.sql:55` (guard L77-80, `grant` L114) | `jobs` (counts) | **Yes** (counts only) — org-wide job + completion counts per week. Less sensitive than money, but still a management-only surface the app hides from staff, and it aggregates **all** jobs (bypassing Phase-3 assigned-job scope). | Add `is_org_admin` clause |

### Severity note (important for the coordinator)

At the **current** worktree snapshot (`20261250` not yet applied here), base-table
SELECT is still membership-based for `invoices` (`20260515190000_invoices.sql:77`),
`time_entries` (`20260525000000_field_operations.sql:61`, `is_org_member`) and so
on — so at this instant findings 2-5 do not expose more than a staff member could
read from the base tables directly. **Their severity is conditional on R5 landing:**
the moment Phase 3/4 narrows those base tables (which the brief states is done on
the coordinator's branch), these SECURITY-DEFINER RPCs become the live bypass that
re-opens exactly the data R5 just closed. Finding 1 (and the job-scope angle of
finding 6) is the most state-independent: `report_profit_labour_hours` returns
**other workers' hours on jobs the caller is not assigned to**, which Phase 3 is
specifically meant to prevent, and the app already forbids staff from this report.

Treat all six as must-fix in lockstep with `20261250`.

## Recommended DB change (for the coordinator — NOT applied here)

New additive, forward-only migration (e.g. `20261251…_report_rpcs_admin_guard.sql`)
that `create or replace`s findings 1-6 with the two-clause guard shown above
(membership **and** `is_org_admin`, `service_role` bypass preserved). No signature,
return-type, grant, or body-logic change otherwise — the arithmetic and the
`grant … to authenticated` stay (members-who-are-admins must still call them; the
guard does the gating). `report_aged_payables` is the reference implementation.

### Regression test to add alongside the fix (integration tier)

Extend `__tests__/integration/rls/secdef-org-rpc-guard.test.ts` (or a sibling) with
a case per RPC asserting that a **non-admin member** JWT receives `42501` and an
**admin** member succeeds — mirroring the existing `report_aged_payables` admin-only
assertion. (Not added in this PR: it is red until the DB guard lands, and the brief
bars running/altering the integration tier here. Land it in the fix PR.)

## Channels that are CLEAN (checked, no change needed)

- **Signed-URL issuers.** `app/api/jobs/[id]/photos/route.ts` (GET) loads the job
  under the **user JWT** (`createClient`), org-pins with `.eq("org_id", ctx.org.id)`
  and filters paths via `storagePathBelongsToOrg` before signing — so it inherits
  the base `jobs` SELECT RLS (Phase-3 assigned-job gating) and returns 404 for a
  non-visible job. `server/services/job-documents.ts`, `blueprints.ts`,
  `blueprint-pin-photos.ts`, `signature-capture.ts`, `company-logo.ts`,
  `compliance/actions.ts`, `invoices/[id]/proof-actions.ts` and the customer-portal
  issuers all sign under org/token-scoped reads with the same prefix guard. No
  issuer mints a URL without an org/assignment-gated read first.
- **Exports.** `/api/reports/export` → `requireCapabilityApi("reports","export")`
  (staff denied). `/api/payroll/[id]/csv` → owner/admin only (403 otherwise).
  `/api/payroll/lines/[id]/pdf` → self-or-admin (staff get only their own payslip).
  `/api/gdpr/erase` → owner/super-admin only; `gdpr_erase_org` is `grant … to
  service_role` only. CSV aggregates run under the caller's JWT, RLS-floored.
- **AI data access.** `lib/ai/quote-context.ts` **deliberately excludes** commercial
  figures — explicit exclusion list includes `{ field: "margins", why: "The firm's
  margin is its own business and is not an input to a scope of works." }` (L166) and
  past job totals/margins (L38). No staff-triggered AI context builder reads
  budgets/valuations/profit into a prompt.
- **Job detail / dashboard tiles.** `app/(app)/jobs/[id]/page.tsx` computes
  profitability server-side but only renders profit/margin/private-cost tiles under
  `isAdmin` (owner/admin) — `profit` is never serialised to the client for staff
  (L752, L879, L888-902). Underlying cost reads use the user JWT (RLS-floored).
  `/reports` pages are role/capability-gated as listed in the TL;DR.
- **Commercial write-RPCs** (`certify_valuation`, `generate_valuation_invoice`,
  `generate_stage_invoice`, `post_goods_received_note`, `next_po_number`, …) are all
  `is_org_admin`-guarded or membership-guarded returning only a number/uuid/state
  string — no commercial-figure read leak.

## One-line verdict

No pure app-code leak found (all app channels correctly gated, so nothing to fix in
app code here). The entire exposure is six SECURITY DEFINER report RPCs whose guard
checks membership but not admin; hand to the R5 coordinator to re-guard with
`is_org_admin` (template: `report_aged_payables`) in lockstep with `20261250`.
