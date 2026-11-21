# COMPLETE-CODE-TEST-REPORT — Programme B (code / backend / DB / security)

> Independent engineering verification, run locally this mission (not relying on
> CI alone). **Date:** 2026-11-02. Local Supabase (real Postgres).

## Test tiers (all green)

| Tier | Command | Result |
|---|---|---|
| Unit | `vitest run` | **712 files / 11,812 tests ✓** |
| Integration (real Postgres) | `vitest run --config vitest.integration.config.ts` | **285 files / 2,820 tests ✓** (requires `NEXT_PUBLIC_APP_URL` + local Supabase env) |
| Security / trust-boundary | `vitest run --config vitest.security.config.ts` | **343 files / 8,598 tests ✓** |
| Typecheck | `tsc --noEmit` | clean against app code (one pre-existing `.next/types` route-type artifact for `app/admin/layout` `HQ_NAV`, present on main + CI-green, is a dev-server generated-types quirk, not a regression) |
| Lint | `eslint` | 0 errors |

New tests added this mission:
- `__tests__/integration/notifications/delivery-claim-concurrency.test.ts` —
  real-Postgres proof that concurrent push/SMS claims return disjoint rows
  (the D-1 double-send fix), plus lease-reclaim and `p_limit`.

## Database / RLS verification (direct Postgres inspection)

Every browser action in Programme A was cross-checked in Postgres:
- **leads / customers / quotes / quote_line_items / invoices / invoice_payments
  / jobs** rows were read back and matched the UI exactly (contact fields,
  `customer_type=business`, company/VAT, `Q-0001` subtotal 18500 / vat_total 3175
  / total 21675, `INV-0001` total 21675, payment 10000).
- **Mixed per-line VAT** (20% + 5%) computed correctly in both UI and DB.
- **Accept automation**: quote→accepted + auto invoice (draft) + auto job, all
  linked by FK, confirmed in DB.
- **staff_compensation RLS**: seeded the owner's `hourly_pay`=45.50 +
  `emergency_contact`; confirmed a staff viewer cannot read either (stripped).

## Security model (R5 + boundaries)

- `secdef-org-rpc-guard` (15) + `migration-data-api-grant-guard` (7) green,
  including the two new claim RPCs (service-role only, p_limit — no org-id arg).
- F-1 volume-safety guards green after re-keying for the drain→RPC change.
- Staff isolation proven at the DB layer by the security/integration tiers and
  at the UI layer in Programme A (see `CHROME-STAFF-QA.md`).

## Financial correctness
Quote/VAT/invoice/payment arithmetic verified both by the dedicated financial
test tiers (cis-deduction, job-budgets, active-org-finance-scoping, etc.) and by
the Programme-A hand calculation (mixed-VAT = £3,175 on an £18,500 base).

## Honest gaps
- Full `npm run build` production-bundle check and the Playwright e2e tier were
  not re-run end-to-end in this pass (the e2e tier's status is tracked separately;
  190/191 pass with one intermittent — D-7).
- Dependency/supply-chain scan (gitleaks/CI) not re-run locally this pass.
