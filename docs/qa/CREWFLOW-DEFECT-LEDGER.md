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

## No P0 or P1 found in either programme.
Consistent with the two prior independent hardening/certification waves.
