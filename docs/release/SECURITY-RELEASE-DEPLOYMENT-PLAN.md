# CrewFlow — Coordinated Security Release Deployment Plan

> **Apply-held.** No merge/apply/deploy without explicit founder approval. This
> plan covers the financial/customer/quote data-access hardening validated in the
> `integration/security-combined` environment.

## 1. Scope — PRs + exact head SHAs

| PR | SHA | Migration | Tables / surface |
|---|---|---|---|
| #1036 | `8325e55c` | — (code only) | job-Overview commercial strip gate (UI) |
| #1037 | `d96b751e` | `20261275000000` | invoices, invoice_payments, payments → admin |
| #1038 | `2bedd6e1` | `20261276000000` | customers → assigned-job (+ `my_assigned_customer_ids()`) |
| #1039 | `32978b5a` | `20261277000000` | price_book_items → admin; leads → admin/assignee |
| #1040 | `f0859fd3` | `20261278000000` | quotes, quote_line_items → admin |

Independent (NOT part of this security release, but reserves the adjacent prefix):
**#1030** `043adf9e` — push/SMS claim, migration `20261274000000` (tables
push_deliveries/sms_deliveries; unrelated to the financial tables).

## 2. Migration ordering / dependency audit (finding #8)

- Prod tip today: `20261273000000`. New migrations are strictly-increasing,
  prefix-unique: `274` (#1030, reserved), `275`→`278` (this release). **No
  collision.**
- The migrations are **mutually independent** (distinct tables/policies), additive,
  and rewrite no data. `274` touches a different domain, so it may be applied
  before or after `275–278` without functional effect.
- Dependency: all four security migrations use `is_org_admin(org_id)` (already
  LIVE) and `current_org_ids()` (LIVE); `276` adds a new SECURITY DEFINER helper
  `my_assigned_customer_ids()` that depends only on the LIVE `my_assigned_job_ids()`.
- **Verified clean apply in sequence** via `supabase db reset` on
  `integration/security-combined` (273 → 275 → 276 → 277 → 278 applied with no
  error), then the full test suite green (§4).
- **Recommended apply order:** if #1030 is approved in the same window, apply in
  strict prefix order `274 → 275 → 276 → 277 → 278`. If #1030 is deferred, apply
  `275 → 276 → 277 → 278` (the `274` gap is harmless — additive, distinct domain —
  and `274` slots in later without reordering).

## 3. Pre-apply gates
1. All five PRs merged to `main` with green CI (mandatory checks).
2. Founder approval (security release).
3. Fresh **off-platform prod backup** + integrity/restore proof
   (`~/CrewFlow-backups`, per the DR runbook).
4. `supabase migration list --linked` shows tip `20261273000000`, no drift.

## 4. Verification evidence (from the combined environment)
- Full **security tier (8,598)**, full **integration RLS tier (1,745)**, quote/
  variation **unit tests (81)** — green with all four migrations applied.
- Per-table positive/negative tests (owner/admin read+write; staff/cross-org/
  revoked denied) for billing, customers, price_book, leads, quotes.
- Direct staff-JWT PostgREST probe: every restricted table → 0 rows / 42501.
- Owner end-to-end lifecycle verified in Chrome; legitimate staff workflows
  (assigned-job customer, site costs, assigned leads) intact.

## 5. Apply (migrations-first, one at a time, from `~/Code/web`)
For each of `20261275000000 … 20261278000000` (and `274` if #1030 approved), in
prefix order:
```
supabase db query --linked -f supabase/migrations/<file>.sql    # txn-wrapped
supabase migration repair --status applied <version> --linked   # file staged in linked dir
```
Then merge the PRs to `main` (Vercel deploys the #1036 UI gate + the code that
already reads through RLS; behaviour is unchanged for owner/admin, so deploy
order vs apply does not matter — applying first is safe).

## 6. Post-apply verification (read-only on prod)
```sql
select tablename, policyname, qual from pg_policies
 where cmd='SELECT'
   and tablename in ('invoices','invoice_payments','payments','customers',
                     'price_book_items','leads','quotes','quote_line_items')
 order by tablename;              -- expect admin/assigned-scoped, none member-wide
select proname from pg_proc where proname='my_assigned_customer_ids';  -- expect 1
```
- A non-admin member JWT (or the launch staff account) direct SELECT on each
  table → **0 rows** (customers/leads → assigned-scope only).
- Owner smoke: `/quotes`, `/invoices`, `/cash`, `/reports` load with data.
- `/api/health` OK; customer-portal quote link still accepts.

## 7. Rollback
Each migration is reversible via a forward migration recreating the prior member
policy (`for select/insert/update … using/with check (org_id in (select
current_org_ids()))`), and dropping `my_assigned_customer_ids()` for `276`. No
data is written, so **no data-restore path** is involved. Roll back the UI (#1036)
by reverting its commit. Roll back individual tables independently if needed.

## 8. Post-deployment monitoring (first 24–48h)
- Sentry: watch for 42501 / "row-level security" errors on owner/admin financial
  routes (would indicate a legitimate admin path we missed — none expected).
- `/admin/ops` health + cron success rows.
- Confirm no support reports of missing invoices/quotes/customers for owner/admin.
- Confirm the first customer-portal quote acceptance still generates an invoice.
