# 05 — Permission-enforcement surface (code-level)

**Repo:** `/Users/moetalibi/Code/web-main` · origin/main tip `aedb9279` (HEAD commit `0830a7b9`)
**Date:** 2026-10-28 · **Scope:** READ-ONLY inventory. No code changed.

Purpose: map every place the **current binary `owner|admin == management`** gate is
applied, so we can plan the move to **OWNER (full + sole member-admin) / ADMIN
(granular per-module/per-action, default NONE) / STAFF (own rota/clock/holiday +
assigned jobs)**.

---

## 0. The gate today (`server/auth/session.ts`)

```
isManagementRole(role)         => role === "owner" || role === "admin"   (session.ts:457)
requireManagementRole(ctx)     => redirect /dashboard?error=forbidden if not mgmt  (:466) — PAGE/action guard
requireManagementContext()     => requireOrgContext() + requireManagementRole      (:473) — layout/action
requireManagementApi()         => requireOrgContext() + 403 JSON if not mgmt        (:491) — API routes
```

`ctx.membership.role` is the caller's OWN row in the active org (resolved by
`requireOrgContext` with a `user_id` filter). There is **no capability table** — the
gate is a hard-coded two-value set. The nav model mirrors it:
`app/(app)/_nav/nav-model.ts:35` → `ADMIN_ROLES = ["owner","admin"]` (presentation only,
not enforcement).

**Two equivalent encodings of the SAME binary gate exist in the codebase:**
1. The four `session.ts` helpers above — **83 call sites**.
2. Inline `role === "owner" || role === "admin"` (and local `requireAdmin` / `isAdmin` /
   `isManager` / `isAdminRole` copies) — **~126 matches across ~120 files**.

A capability model must replace **both** encodings. Total distinct enforcement files: **163**.

---

## 1. Management-gate call sites — module → capabilities

Each row is a `(module, action)` capability the ADMIN model must be able to express.
Gate kinds: **L** = segment layout, **P** = page/server-component loader, **A** = server
action, **R** = API route. Gate source: **H** = `session.ts` helper, **I** = inline
`owner||admin` (or local admin helper).

| Module | Representative gate sites (file:line) | Kind | Src | Capability axis |
|---|---|---|---|---|
| **Jobs — billing/valuations** | `jobs/[id]/billing/page.tsx:42`, `billing/actions.ts`*, `jobs/[id]/valuations/page.tsx:30`, `jobs/[id]/variation-request-actions.ts:125` | P/A | H+I | jobs.billing View/Edit/Approve |
| **Jobs — commercial/margin** | `jobs/[id]/commercial/page.tsx`, `commercial/actions.ts`, `jobs/[id]/certificate/{page,actions}`, `warranties/{page,actions}`, `blueprints/{page,actions}`, `jobs/[id]/_job-programme.tsx`, `jobs/[id]/layout.tsx:96` (isAdmin prop), `jobs/templates/*` | P/A | I | jobs.commercial View/Edit; jobs.templates Manage |
| **Quotes** | `quotes/layout.tsx:17`, `quotes/page.tsx:48`, `quotes/actions.ts` ×12 (208,384,533,676,779,825,967,1044,1270,1610,1915,1974), `quotes/[id]/page.tsx:168` (inline), `quotes/new/page.tsx:97` (canSeeBlockers) | L/P/A | H+I | quotes View/Create/Edit/Send/Approve |
| **Quotes — API** | `api/quotes/[id]/pdf/route.ts:25`, `api/quotes/[id]/send/route.ts:24` | R | H | quotes.export / quotes.send |
| **Sales — customers** | `customers/layout.tsx:17`, `customers/page.tsx:66`, `customers/actions.ts` ×5 (93,153,220,269,303) | L/P/A | H | customers View/Create/Edit/Delete |
| **Sales — leads** | `leads/layout.tsx:17`, `leads/page.tsx:55`, `leads/actions.ts` ×7 (54,125,189,231,309,366,448) | L/P/A | H | leads View/Create/Edit/Delete |
| **Sales — price book** | `price-book/layout.tsx:10`, `price-book/page.tsx:39`, `price-book/actions.ts` ×7 (85,118,163,193,239,325,354) | L/P/A | H | price_book View/Edit |
| **Sales — customers API** | `api/customers/[id]/statement/pdf/route.ts:23` | R | H | customers.export |
| **Money — invoices** | `invoices/layout.tsx:17`, `invoices/page.tsx:71`, `invoices/[id]/payment-actions.ts` ×3 (35,181,227), `invoices/[id]/proof-actions.ts:34` | L/P/A | H | invoices View/Create/Edit/Approve/Delete |
| **Money — invoices API** | `api/invoices/route.ts:26,64`, `api/invoices/[id]/route.ts:27,98`, `.../remind:28`, `.../send:26`, `.../pdf:29`, `api/invoices/export/route.ts:86` | R | H | invoices.send / invoices.export |
| **Money — payments** | `payments/layout.tsx:10`, `payments/page.tsx:36` (inline), `payments/actions.ts` ×3 (46,211,335), `payments/allocate-actions.ts:33` | L/P/A | H+I | payments View/Create/Allocate |
| **Money — expenses/budgets** | `expenses/layout.tsx:17`, `expenses/page.tsx:50`, `expenses/actions.ts` ×3 (66,136,162), `expenses/budgets/page.tsx:80` + `budgets/actions.ts:27` (inline) | L/P/A | H+I | expenses View/Create/Edit; budgets Manage |
| **Money — finances/insights** | `finances/page.tsx:52`, `insights/page.tsx:47` | P | H | finances.view (dashboard money tiles) |
| **Money — finances API** | `api/finances/route.ts:36`, `api/finances/export/route.ts:22`, `api/finances/[id]/route.ts:27,88` | R | H | finances View/Edit/Export |
| **Money — CIS** | `cis/layout.tsx:10`, `cis/page.tsx` (inline), `cis/actions.ts` (inline), `suppliers/[id]/cis/{page,actions}.ts` (local `isManager`), `api/cis/returns/[id]/export.csv`, `api/cis/statements/export.csv` | L/P/A/R | H+I | cis View/Prepare/Export |
| **Money — tax** | `tax/page.tsx:73` + `:250` (inline), `tax/actions.ts` (inline), `api/tax/quarterly-pdf/route.ts:43` | P/A/R | H+I | tax View/Export |
| **Money — reports** | `reports/layout.tsx:10`, `reports/page.tsx` (inline), `reports/accounting/actions.ts`, `reports/subscribe/actions.ts`, `reports/cashflow/page.tsx`, `api/reports/route.ts:23`, `api/reports/export/route.ts:41`, `api/reports/[report]/export/route.ts`, `api/accounting/export/route.ts`, `api/payroll/lines/[id]/pdf/route.ts` | L/P/A/R | H+I | reports View/Export/Subscribe |
| **Settings — billing** | `settings/billing/page.tsx:55` + `billing/actions.ts:30` | P/A | I | settings.billing Manage |
| **Settings — security/SSO/MFA** | `settings/sso/page.tsx:30` + `sso/actions.ts:29`; security enrol surface is MFA-allow-listed in `session.ts:344` | P/A | I | settings.security Manage |
| **Settings — api-keys** | `settings/api-keys/page.tsx:69` + `api-keys/actions.ts:77` | P/A | I | settings.api_keys Manage |
| **Settings — webhooks** | `settings/webhooks/page.tsx:69` + `webhooks/actions.ts:62` | P/A | I | settings.webhooks Manage |
| **Settings — integrations** | `settings/integrations/page.tsx:44` + `integrations/actions.ts:55`; `api/integrations/{accounting,banking,calendar,hmrc,stripe-connect,telematics}/*/{connect,callback,refresh}` | P/A/R | I | settings.integrations Connect/Manage |
| **Settings — automations** | `settings/automations/page.tsx:64` + `automations/actions.ts:43`, `automations/workflow/page.tsx:43` | P/A | I | settings.automations Manage |
| **Settings — data retention / GDPR** | `settings/data-retention/page.tsx:35` (admin) **+ `:112` `isOwner` OWNER-ONLY**, `data-retention/actions.ts:43`; `api/gdpr/erase/route.ts:63` **OWNER-ONLY**; `api/gdpr/export/route.ts:52` (owner/admin) | P/A/R | I | settings.data_retention Manage (erase = OWNER) |
| **Settings — marketplace** | `settings/marketplace/page.tsx:55` + `marketplace/actions.ts:39`, `marketplace/page.tsx:68` + `marketplace/actions.ts:40` | P/A | I | marketplace Install/Manage |
| **Settings — org config** | `settings/page.tsx:36`, `settings/org-config-actions.ts:42`, `settings/_flat-rate.tsx:17`, `_working-hours.tsx:18`, `_tax-defaults.tsx:18`, `settings/logo-actions.ts`, `settings/ai-receptionist/page.tsx:50` + `ai-receptionist/actions.ts` | P/A | I | settings.org Manage |
| **Settings — imports** | `imports/page.tsx:22` + `imports/actions.ts:1372` | P/A | I | data.import Manage |
| **Operations — assets/fleet** | `operations/page.tsx:61`, `assets/[id]/page.tsx` + `assets/{calibration,depreciation,maintenance,override,schedule,service-schedule}-actions.ts`, `fleet/page.tsx`, `fleet/fuel/page.tsx` | P/A | I | assets/fleet View/Edit/Manage |
| **Operations — stock** | `stock/actions.ts`, `stock/reorder-actions.ts`, `stock/stocktake-actions.ts`, `stock/van-actions.ts`, `stock/items/[id]/page.tsx`, `stock/replenishment/page.tsx`, `stock/stocktake/[id]/page.tsx`, `stock/vans/page.tsx` | P/A | I | stock View/Adjust/Manage |
| **Operations — suppliers/PO** | `suppliers/[id]/page.tsx:102`, `suppliers/[id]/performance/page.tsx:73`, `suppliers/[id]/payments/{page,actions}` (local `isManager`), `suppliers/actions.ts`, `purchase-orders/[id]/page.tsx:121`, `purchase-orders/actions.ts`, `purchase-orders/receiving-actions.ts` | P/A | I | suppliers/po View/Create/Receive/Pay |
| **Operations — sites/materials** | `sites/{page,new,[id]}`, `materials/requests/actions.ts:80`, `materials/requests/[id]/page.tsx:68` | P/A | I | sites/materials View/Request/Approve |
| **Staff** | `staff/page.tsx`, `staff/[id]/page.tsx`, `staff/[id]/timesheet/page.tsx` (inline); `staff/actions.ts` local `requireAdmin` (:60) on invite/role/remove/rota/leave-review/holiday/pension/payroll-profile/qualifications | P/A | I | staff View/Edit + **member-admin (see §2)** |
| **Staff — rota/leave** | `staff/rota/page.tsx`, `staff/leave/page.tsx`; `createRotaEntry`/`deleteRotaEntry`/`reviewLeaveRequest` admin-gated; `createLeaveRequest`/`cancelLeaveRequest` **self-service (no admin gate)** | P/A | I | rota Manage; leave Review (self submit = STAFF) |
| **Payroll** | `payroll/page.tsx`, `payroll/actions.ts` (inline) | P/A | I | payroll View/Run |
| **Inbox / comms** | nav `ADMIN_ROLES` only (`nav-model.ts:228-235`); `inbox/actions.ts:31`, `inbox/conversations/actions.ts:95,164,237`, `inbox/review/actions.ts` use **`requireOrgContext` only — NOT management-gated in the action layer** (no inbox layout.tsx exists) | A | — | **GAP: comms relies on nav-hiding + RLS, not a server gate** |
| **Site & safety** | `site-reports/[id]/page.tsx:120,123`, `site-reports/actions.ts`, `toolbox/[id]/page.tsx` + `toolbox/actions.ts`, `diary/[id]/page.tsx`, `snags/[id]/page.tsx`, `qa/page.tsx:90`, `quality/*`; health-safety/permits/compliance/weather nav = `ADMIN_ROLES` | P/A | I | hs/toolbox/quality View/Sign/Manage |
| **Documents** | nav `ADMIN_ROLES` (`nav-model.ts:154`) | — | — | documents View/Manage |
| **AI tools** | `api/ai/question/route.ts:35` (`requireManagementApi`); quote writer draft in `quotes/actions.ts` (`requireManagementRole`); `settings/ai-receptionist/*` admin-gated | R/A | H+I | ai.ask / ai.quote_writer / ai.receptionist Manage |
| **Search / Cmd+K** | `api/search/route.ts:265` `isManagementRole` → `canSeeMoney` (hides money results from staff) | R | H | cross-cutting: money read visibility |

\* `jobs/[id]/billing/actions.ts` uses inline check; billing/page uses the helper.

### Call-site totals
- `requireManagementRole`: **54** call sites (pages + server actions).
- `requireManagementApi`: **19** call sites (API routes).
- `requireManagementContext`: **9** call sites (segment layouts: customers, payments,
  invoices, quotes, expenses, leads, price-book, cis, reports).
- `isManagementRole`: **1** feature call site (`api/search/route.ts:265`) + 2 internal in `session.ts`.
- **Total via the four helpers: 83 call sites.**
- **Plus ~126 inline `owner||admin` equivalence checks across ~120 files** (same binary
  gate, bypassing the helper — notably ALL of settings/*, operations/*, staff/*,
  site-safety/*, and several money/jobs surfaces).

---

## 2. Owner-vs-admin today + member management

### Member-management surface — `app/(app)/staff/actions.ts`
All member admin runs through a **local `requireAdmin(ctx)` (owner||admin)** gate
(`staff/actions.ts:60`) — i.e. **any admin can manage members, including other admins.**

| Operation | Function:line | Who can do it today | Owner protections |
|---|---|---|---|
| **Invite / add member** | `inviteStaff` :92 (gate :94) | owner **or admin** | owner role refused (:115 — "assigned during onboarding only") |
| **Resend invite** | `resendStaffInvite` :263 (gate :265) | owner **or admin** | — |
| **Change role** | `updateStaffRole` :332 (gate :334) | owner **or admin** | can't assign `owner` (:340); can't demote last owner (:362) |
| **Remove member** | `removeStaff` :462 (gate :464) | owner **or admin** | can't remove an `owner` (:477) |

Membership INSERT (`:196`), role UPDATE (`:366`), DELETE (`:481`) all run on the
**user-JWT client** → the real boundary is the `memberships` RLS `is_org_admin` policy,
which is **also owner||admin** (baseline/`20260515170000_org_member_visibility.sql`).
UI: `staff/_invite-modal.tsx:157` disables the owner option; `staff/[id]/page.tsx:465-485`
hides owner from the role selector and blocks owner edits.

**First owner** is set at org creation: `server/services/bootstrap-account.ts:132`
(`role:"owner"`). Demo seeds: `demo-lifecycle.ts:736,752`.

### Existing owner-only distinctions
Only **two** true owner-exclusive gates exist today (both destructive data ops):
1. `api/gdpr/erase/route.ts:63` — `isOwner` + super-admin only (org data erasure).
2. `settings/data-retention/page.tsx:112` — `isOwner` controls the erase affordance
   (the retention-purge admin gate at `:35` is owner||admin).

Everything else treats owner and admin **identically**.

### Ownership-transfer flow
**NONE exists.** No `transferOwnership` / `promoteToOwner` / `changeOwner`. The owner role
can only be set during onboarding (`bootstrap-account.ts`); the UI explicitly refuses
promoting anyone to owner (`updateStaffRole:340`, invite modal). The only "transfer
ownership" code is HQ-side AI-receptionist worklist reassignment (`app/admin/ai-receptionist/.../reassign/*`) — unrelated to org membership.

**Implication for the new model:** OWNER-sole member-admin + ownership-transfer are both
NET-NEW. Today the gate cannot distinguish "manage members" from "manage money" — one bit.

---

## 3. Member / permission audit infrastructure

| Log | Table | Populated by | Covers membership/role changes? |
|---|---|---|---|
| **HQ-side** | `admin_activity_log` (migration 20260605) | `recordAdminActivity()` (`server/services/hq-audit.ts:46`), service-role, super-admin callers only | No — HQ ops only (ai-receptionist, automations, inbox) |
| **Org-side** | `activity_log` (migration 20260516200000) | **DB triggers** on customers, leads, jobs, quotes, invoices, finances, rota_entries, leave_requests, invoice_payments, time_entries, payroll_runs, imports, material_requests, goods_received_notes, purchase_orders, stock_movements | **No trigger on `memberships`** |

**Finding: there is NO audit log for membership / role / permission changes.**
`staff/actions.ts` writes NO `activity_log` row and calls NO `recordAdminActivity` on
invite / role-change / remove. The org-side `activity_log` has append-only + no-truncate
protection (`activity_log_append_only_*`) but `memberships` is simply not wired to it. A
granular ADMIN-capability model will need a **new org-scoped audit trail** for
appoint/remove/permission-set/ownership-transfer events (currently invisible).

---

## 4. AI tools / comms that are management-gated

| Surface | Gate | File:line |
|---|---|---|
| AI question/assistant API | `requireManagementApi` | `api/ai/question/route.ts:35` |
| AI quote writer (draft) | `requireManagementRole` inside quote actions | `quotes/actions.ts` (writer draft path) |
| AI receptionist settings | inline owner||admin | `settings/ai-receptionist/page.tsx:50`, `ai-receptionist/actions.ts` |
| Inbox / conversations / review queue / delivery audit | **nav `ADMIN_ROLES` + RLS only — action layer uses `requireOrgContext` (no mgmt gate)** | `inbox/actions.ts:31`, `inbox/conversations/actions.ts`, `inbox/review/actions.ts`, nav-model.ts:228-235 |

Comms is the weakest server-side link: no `requireManagement*` in the action layer and no
inbox `layout.tsx`. Capability enforcement here is currently presentation (nav) + RLS.

---

## 5. Settings surfaces — how each is gated

All settings gates are **inline owner||admin** (none route through the `session.ts`
helper). Each has a `page.tsx` loader check AND an `actions.ts` write check.

| Setting | Page gate | Action gate |
|---|---|---|
| Plan & billing | `billing/page.tsx:55` | `billing/actions.ts:30` |
| Security / SSO | `sso/page.tsx:30` | `sso/actions.ts:29` |
| API keys | `api-keys/page.tsx:69` | `api-keys/actions.ts:77` |
| Webhooks | `webhooks/page.tsx:69` | `webhooks/actions.ts:62` |
| Integrations | `integrations/page.tsx:44` | `integrations/actions.ts:55` + all `api/integrations/*` connect/callback routes |
| Automations | `automations/page.tsx:64`, `automations/workflow/page.tsx:43` | `automations/actions.ts:43` |
| Data retention | `data-retention/page.tsx:35` (admin) / **`:112` owner-only erase** | `data-retention/actions.ts:43`; `api/gdpr/erase:63` **OWNER** |
| Marketplace | `marketplace/page.tsx:55` | `marketplace/actions.ts:39` |
| Org config / flat-rate / hours / tax-defaults / logo / AI receptionist | `settings/page.tsx:36`, `_flat-rate.tsx:17`, `_working-hours.tsx:18`, `_tax-defaults.tsx:18` | `org-config-actions.ts:42`, `logo-actions.ts` |
| Import data | `imports/page.tsx:22` | `imports/actions.ts:1372` |

---

## 6. Planning implications (for the capability model)

1. **Two encodings to migrate**: 83 helper call sites + ~126 inline checks (~120 files).
   Recommend collapsing inline checks onto a single capability-aware helper first.
2. **Capability axes observed**: View / Create / Edit / Approve(+Send) / Delete / Export /
   Manage, per module — matches the founder's requested verb set. Modules enumerated in §1.
3. **OWNER-sole powers are NET-NEW**: today admin == owner for member management. Need
   (a) owner-only appoint/remove admin, (b) owner-only set-admin-permissions,
   (c) owner-only ownership-transfer (no flow exists), (d) default-NONE for new admins.
4. **STAFF already partially modelled**: self-service leave (`createLeaveRequest`/`cancel`),
   `/me` + `["staff"]` nav, `canSeeMoney=false` in search. "Assigned jobs only" is an
   RLS/data-scope concern, not yet a capability bit.
5. **Audit gap**: add an org-scoped audit trail for membership/permission/ownership events
   (§3) — none exists today.
6. **Comms gap**: inbox action layer must gain a server gate (§4) — currently nav + RLS only.
7. RLS `is_org_admin` is also binary owner||admin — the DB layer will need the same
   granular treatment or the app gate becomes the only enforcement for sub-admin
   capabilities.
