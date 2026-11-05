# Financial-table RLS admin-scoping — production apply plan (migration 20261275000000)

> **Apply-held.** No merge/apply without explicit founder approval. Security fix
> for a **confirmed P1** data exposure (staff could read + write the org's billing
> records via direct authenticated PostgREST, bypassing route/UI gates).

## What it changes
Scopes **SELECT / INSERT / UPDATE** on `invoices`, `invoice_payments`, `payments`
from org-member-wide (`org_id IN current_org_ids()`) to **owner/admin only**
(`is_org_admin(org_id)`) — the predicate the existing `… admins can delete`
policies on these same tables already use. DELETE policies unchanged. Quotes /
quote_line_items are **deliberately not** touched (staff quote-drafting is a
tested legitimate flow — see the SCOPE note in the migration).

## Why it is safe (verified before writing)
- Capability model (`server/auth/capabilities.ts`): financial capabilities are
  owner/admin only (`staff` → no capabilities). No legitimate staff workflow
  reads/writes these tables (authorised site expenses live in the separate
  member-open `finances`/costs table).
- Every member-client (RLS) reader/writer sits behind a route or capability gate
  only owner/admin pass; their INSERT…RETURNING still works (admin caller).
- Customer-portal / cron / api-v1 / automation use the **service-role** client
  (bypasses RLS) — unaffected.

## Verification already performed (local)
- Direct staff-JWT probe: before = staff reads INV total £21,675 + writes; after =
  **0 rows / 42501 on write**. Owner still reads + writes.
- New test `__tests__/integration/rls/financial-tables-admin-scope.test.ts`
  (17 cases: owner/admin read, staff + cross-org + revoked denied, staff write
  denied, owner write OK, quotes still member-readable) — green.
- Full **security tier** (8,598) + full **integration RLS tier** (1,761) green.

## Pre-apply gates
1. CI green on the PR.
2. Founder approval (this is a security release blocker — confirm priority).
3. Fresh off-platform backup + `supabase migration list --linked` shows the
   expected tip with no drift.

## Apply (migrations-first, from `~/Code/web`, the linked checkout)
Independent of the push/SMS migration `20261274000000`; if both are approved,
apply in prefix order (`…274`, then `…275`). For this one:
```
supabase db query --linked -f supabase/migrations/20261275000000_financial_tables_admin_select_rls.sql
supabase migration repair --status applied 20261275000000 --linked
```

## Post-apply verification (read-only on prod)
- `pg_policies`: invoices/invoice_payments/payments each have `… admins can
  select/insert/update` carrying `is_org_admin(org_id)`; no `members can select`.
- A staff-JWT (or a real non-admin member) direct SELECT on these tables → 0 rows.
- Owner/admin app flows (invoices, cash, reports, tax, record-payment) unaffected.
- `/api/health` OK.

## Rollback
Forward migration recreating the member policies
(`for select/insert/update … using/with check (org_id in (select current_org_ids()))`).
No data is written, so no data-restore path is involved.
