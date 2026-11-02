# CrewFlow — Defect Ledger (pre-launch mission, Programmes A + B)

> Severity: **P0** break-launch · **P1** fix-before-scale · **P2** fix-soon ·
> **P3** debt/cosmetic. "Found by": A = real-browser QA, B = code/backend.
> **Date:** 2026-11-02. Status reflects apply-held PRs (nothing merged/deployed).

| ID | Sev | Found by | Finding | Root cause | Fix / status | Retest |
|---|---|---|---|---|---|---|
| **D-1** | **P2** | B | **Push/SMS drain double-send** — overlapping cron ticks read + send the same queued rows (no claim step) → duplicate push/SMS. | select-then-send with no atomic claim. | Claim RPC (`FOR UPDATE … SKIP LOCKED`, `queued→sending`, lease reclaim) + migration `20261274000000`; drains claim-then-send. **PR #1030, apply-held.** | real-Postgres concurrency test (disjoint claims) — **green** |
| **D-2** | **P3** | A | **Hydration mismatch** on relative timestamps — dashboard activity feed renders "10 min ago" (server) vs "11 min ago" (client) when crossing a minute tick. React self-heals; console error only. | relative time from `new Date()` differs SSR vs hydration. | `suppressHydrationWarning` on the 3 client components that SSR a relative time. **PR #1033, apply-held.** | dashboard reloads with **zero console errors** in Chrome |
| D-3 | P3 | B | `escapeHtml` duplicated across ~9 files. | copy-paste drift risk. | consolidated to `lib/html.ts` + test. **PR #1029.** | security + unit tiers green |
| D-4 | P3 | B | 3 flaky/brittle unit tests. | timing / shared state. | fixed. **PR #1028.** | unit tier green |
| D-5 | Ops | B | Cron auth non-constant-time compare. | `===` on secret. | constant-time + 7 tests. **PR #1027.** | security tier green |
| D-6 | — | B | #1029 escapeHtml removal staled 2 line-keyed F-1 allowlist entries. | line-keyed allowlist. | re-keyed. | both F-1 guards green |
| D-7 | P3 | B/A | intermittent `asset-inspections` e2e (deep-swap nav race). | server work commits, URL may not at depth ≥4. | flagged for Wave 2 (confirm FormState + `location.assign`). | 190/191 e2e pass |
| **OBS-1** | P3 | A | staff viewing another member renders empty, edit-disabled **Hourly pay / Emergency contact** fields rather than hiding them. **No data leaks** (verified: seeded owner pay £45.50 + emergency contact → both stay empty for staff; `staff_compensation` RLS strips them). | form renders all fields for non-admins. | cosmetic — hide fields for non-admins. **Not a security issue.** | seeded-data leak test — **no leak** |
| OBS-2 | P3 | A | one trivial asset 404 (favicon/avatar class) on HQ pages. | missing static asset. | non-blocking; all functional requests 200. | — |
| **D-8** | **P2** | **A** | **Job-Overview leaked commercial figures to assigned staff.** A staff member opening their assigned job's Overview saw the cash strip (contract £21,675 / £10,000 received / outstanding £11,675) + the "Get paid — billing plan" link. The `/commercial`, `/billing`, `/valuations` sub-pages redirect non-admins, but the Overview (staff-reachable) rendered the same figures ungated. | the Overview's commercial strip + billing link were gated only on `billed>0`, not on role; the R5 financial boundary is a route/UI gate (invoices RLS is org-member-wide by design across all 4 financial tables). | **FIXED** — gated both behind `canViewPrivate` (owner/admin) in the server component (figures not rendered into staff's payload). **PR #1036, apply-held.** | Chrome: staff Overview strip+link gone, owner unaffected; **3 new source-contract tests** (13 pass) |
| OBS-3 | P3 | A | A transient "Something went wrong" error boundary appeared once during a staff sign-out while on `/me` at mobile width (click likely interrupted mid-redirect). Not reliably reproduced; sign-out via desktop header works. | possibly an aborted in-flight RSC during sign-out redirect. | **Observation — re-check**; not a confirmed defect. | — |

## What was tested and found clean (no defects)

- **Owner revenue journey** (lead → customer → quote+mixed-VAT → approve →
  customer-portal accept → auto invoice+job → partial payment): every step
  Chrome-tested and DB-verified; all figures arithmetically correct.
- **Staff R5 isolation**: nav scoping, direct-URL denial of
  invoices/quotes/reports/finances, unassigned-job 404, and a **seeded-data
  leak test** confirming pay/emergency contact are stripped. No leak.
- **HQ console**: home, Customers OS (51 orgs), customer profile, system status.
- **Customer portal**: quote view + e-signature accept, draft-quote guard.
- **Product-truth**: AI quote drafting correctly shown "Off / not connected".
- **Console/network**: dashboard, leads, customers, quotes, invoices, H&S, HQ
  pages loaded with no functional errors.

| **D-9** | **P1** | **A/B** | **Staff could read AND write the org's post-sale billing records via direct authenticated PostgREST (no UI).** Direct staff-JWT probe: `invoices` → INV-0001 total £21,675, plus `invoice_payments` + `payments` readable, and `invoice_payments` INSERT allowed. The SELECT/INSERT/UPDATE policies were org-member-wide; route/UI gates (and #1036) only hid it in the browser. | the R5 financial boundary was enforced only at the route/UI/capability layer; the DB RLS on these billing tables was org-member-wide. | **FIXED** — migration `20261275000000` scopes SELECT/INSERT/UPDATE on invoices/invoice_payments/payments to `is_org_admin(org_id)`. Quotes/quote_line_items deliberately preserved (tested staff-drafting flow). **PR #1037, apply-held (migration NOT applied).** | staff read→0 / write→42501; owner+admin OK; cross-org+revoked denied; new 17-case test; full security (8,598) + integration RLS (1,761) tiers green |

| **D-10** | **P2** | A/B | **Staff read the whole org CRM** (`customers`: names/emails/phones/addresses/VAT) via direct API. | `customers` SELECT org-member-wide. | **FIXED** — migration 20261276000000: staff SELECT scoped to assigned-job customers (`my_assigned_customer_ids()`), admin writes. **PR #1038.** | 6-case test; full RLS tier green |
| **D-11** | **P2** | A/B | **Staff read the full price-book** (rate library / margins) via direct API. | `price_book_items` SELECT org-member-wide. | **FIXED** — migration 20261277000000: admin-only. **PR #1039.** | 4-case test; tiers green |
| **D-12** | **P2** | A/B | **Staff read the whole sales pipeline** (`leads`: contact PII, estimated values) via direct API. | `leads` SELECT org-member-wide. | **FIXED** — migration 20261277000000: admin OR assignee. **PR #1039.** | 4-case test; tiers green |
| **D-13** | **P2** | A/B | `quotes`/`quote_line_items` member-wide (staff read every quote + line price via API). | member-wide SELECT/INSERT/UPDATE. | **FIXED** — founder decided owner/admin-only; migration 20261278000000 scopes to `is_org_admin`; portal/automation/owner lifecycle preserved. **PR #1040.** | rewritten quote-approval-authz (admin-only) + new quotes-admin-only-scope (6); full RLS (1,745) + security (8,598) + quote unit (81) tiers green; owner `/quotes` verified in Chrome |

## P1 found + fixed (D-9). P2s D-8/10/11/12/13 all fixed. No P0 found.
See `docs/qa/CREWFLOW-FINANCIAL-DATA-SECURITY-AUDIT.md` for the full direct-API
audit, census, and coordinated release pack (#1036/#1037/#1038/#1039).
D-9 is a within-org staff-over-privilege on financial data (not cross-tenant, so
not P0), confirmed by direct-API probe and remediated at the DB layer (apply-held
**#1037**). Recommend treating as a release blocker alongside #1036. The earlier
"no P0/P1" statement applied before the direct-API financial audit; the UI-only
passes had not probed PostgREST directly.
