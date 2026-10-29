# CrewFlow Feature & Button Encyclopaedia — Master Index

**Audit date:** 2026-10-28 · **Commit:** `128dc5aa` (main) · **Prod:** crewflow.uk, migration tip `20261236000000`
**Method:** read-only static audit of the actual codebase (routes, page components, server actions, API handlers, DB permissions, feature flags), executed by 11 parallel domain auditors and reconciled against a raw route/API/action inventory.
**Not performed:** authenticated multi-role browser click-through (out of scope). Most controls are therefore classified **IMPLEMENTED, NOT LIVE-VERIFIED** from code evidence — see each file and Part 7 for the honest verification boundary. We do **not** claim 100% live coverage.

## How this encyclopaedia is organised

The user-requested 8 parts map to these files. The three audiences are kept separate.

| Part | Title | File(s) |
|---|---|---|
| **1** | **Construction Company Owner** | `01`–`08` (every owner-facing domain, in navigation order) |
| **2** | **Construction Company Staff** | `PART-2-STAFF.md` (roles, permission matrix, staff-only surfaces) — derived from `01`–`08` |
| **3** | **CrewFlow HQ** (platform super-admin) | `09`–`11` |
| **4** | Master Feature Inventory | `PARTS-4-8.md` §4 |
| **5** | Complete Button & Action Inventory | `PARTS-4-8.md` §5 + the per-domain button tables in `01`–`11` |
| **6** | Feature Flags, Hidden & Incomplete Functionality | `PARTS-4-8.md` §6 |
| **7** | Coverage & Verification Report | `PARTS-4-8.md` §7 |
| **8** | Executive Summary | `PARTS-4-8.md` §8 |

### Part 1 & 3 detail files (navigation order)

**Owner / Staff product (Part 1 — the owner sees all of these; staff see a role-filtered subset):**
1. `01-owner-home-inbox-mobile.md` — Home dashboard · Staff "My day" (`/me`) · Notifications · Inbox & conversations · Activity log · worker-portal/offline/access-pending
2. `02-sales-and-portal.md` — Leads · Quotes · Customers · Price book · Reviews · the customer-facing portal (`/q`, `/customer-portal/*`)
3. `03-projects-jobs.md` — Jobs list/calendar/templates and the full `/jobs/[id]` workspace (8 tabs)
4. `04-site-and-safety.md` — Health & safety/RAMS · Permits · Toolbox talks · Site diary · Snagging · Works quality · Delays & EOT · Site reports · Drawings · Documents · Site compliance · Compliance library · Weather
5. `05-people-payroll.md` — Staff · Rota · Leave · Payroll
6. `06-money-finance.md` — Cash position · Invoices · Payments · Expenses · Costs · CIS · Tax · Reports · AI insights
7. `07-operations.md` — Operations overview · Assets · Fleet · Stock · Materials · Sites · Suppliers · Purchase orders
8. `08-settings-onboarding-account.md` — Settings (billing/security/SSO/integrations/API keys/webhooks/automations/data-retention) · Marketplace · Imports · Onboarding · Help · Support · Auth

**CrewFlow HQ (Part 3):**
9. `09-hq-core.md` — Overview/command-centre · CEO board · Pulse · Approvals · Decisions · Tasks · Workflow sagas · Executive-assistant · Launch checklist · Notifications · Notes · Cadence · Alerts · Automations · Settings
10. `10-hq-growth-ai-employees.md` — Sales AI · Sales orchestrator · Research · Qualification · Outreach · Marketing/Product/Design/Docs/Ops/QA/Customer-success/Support AI · AI Boardroom · Executor shadow · Shared memory · AI Receptionist
11. `11-hq-customers-billing-ops.md` — Organizations/signups · Customers · Onboarding & migration · Billing (Stripe) · Finance · Analytics · AI costs · Ops/health · Support · Impersonation · Switch-to-customer

### Working files (not deliverable prose)
- `CONVENTIONS.md` — status legend + roles + evidence rules used by every auditor.
- `_coverage-raw.md` — the authoritative raw inventory (every route, every API handler) used to reconcile coverage.
- `_reconciliation-ledger.md` — orchestrator's cross-cutting findings ledger feeding Parts 6–8.

## Headline scale (documented)

- **197** page/route sections documented (147 owner/staff + 50 HQ), covering **264** route files (185 `app/(app)` + 79 `app/admin`) + 19 customer-portal + auth/onboarding/portal surfaces — detail sub-routes/tabs are documented within their parent page section.
- **~985** tabulated control & feature rows across the 11 domain files.
- **147** API route handlers and **~571** server actions form the coverage spine (these are **not** counted as buttons — see Part 5).
- **3** roles: **owner**, **admin**, **staff** (`ADMIN_ROLES` = owner+admin). No manager/supervisor role exists.
- **~30** feature flags; prod ON/OFF mapped in Part 6.

## Global verification caveat

Status values are assigned from **code + known production state** (deployed migrations, the `/api/health` capability probe, `lib/env.ts` defaults, the activation matrix). Where a flow could only be confirmed by clicking it as a signed-in user of a given role, it is marked **IMPLEMENTED, NOT LIVE-VERIFIED**. Nothing here is asserted "working" solely because a button exists.
