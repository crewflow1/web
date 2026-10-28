# 01 — Route Authorization Matrix

**Scope:** every `app/(app)/**/page.tsx` + `layout.tsx` and every `app/api/**/route.ts`.
**Code audited:** `/Users/moetalibi/Code/web-main` @ `origin/main` tip `aedb9279` (live production).
**Method:** READ-ONLY. Each route's loader was traced together with its layout chain; nav
intent (`app/(app)/_nav/nav-model.ts`) was cross-referenced against the server guard actually
enforced; every candidate gap was checked against the governing RLS policy before a severity
was assigned. No application code was modified.

---

## Summary

The authorization architecture is sound. **No P0 (cross-tenant) and no CLEAR P1 (privilege-
escalation) findings.** The root shell `app/(app)/layout.tsx` funnels every `(app)` route
through `getRequestI18n()` → `requireOrgContext()` (`server/i18n/request.ts:54`), so every
product route has a hard **member-of-active-org floor** — nothing under `(app)` is anonymous-
reachable, and every data loader examined is active-org–pinned (`.eq("org_id", ctx.org.id)`)
on top of RLS that keys on `current_org_ids()`. Management-only money/sales/CIS **mutations**
self-guard inline (`requireManagementApi`, or `requireOrgContext` + `isManagementRole`/`isManager`
re-check) rather than trusting the layout — which is the correct pattern, since layout guards do
**not** protect server-action POSTs. The HQ/superadmin surface is correctly gated everywhere
(`requireHqApi`/`requireHqPage`, or `requireUser` + inline `isSuperAdminEmail` → 404).

What remains is a **consistent class of P2/P3 defence-in-depth gaps**: a number of surfaces the
nav model advertises to `owner/admin` only (`ADMIN_ROLES`) are enforced at the server merely to the
member floor, so a `staff` member can reach them by typing the URL. In every confirmed case the
data is **already member-readable under RLS**, so the exposure is "staff sees a screen the sidebar
would have hidden", not a tenant-isolation or privilege break. Whether each *should* be management-
only is frequently a genuine product decision (field workers plausibly need Operations / Site &
Safety reads), so most are marked **AMBIGUOUS-NEEDS-CEO**. Two mutation surfaces
(`recordSupplierBill`, asset-inspection-template `publish`/`archive`) run at the member floor, but
their governing RLS **deliberately permits member writes**, so they are consistent-with-policy
rather than bypasses.

### Counts

| Metric | Count |
|---|---|
| Total `(app)` pages (`page.tsx`) | 185 |
| Total `(app)` segment layouts (`layout.tsx`) | 11 |
| Total API route handlers (`route.ts`) | 148 |
| **Pages — effective enforcement floor** | all 185 = member (via root layout) |
| Pages management-effective (layout / inline `requireManagementRole` / `if(!isAdmin)` block / staff-redirect) | 51 |
| Pages at member floor only | 134 |
| Pages genuinely unguarded of data (static form, member floor still applies) | 1 (`support/new`) |
| HQ/superadmin pages under `(app)` | 0 (HQ lives in `app/admin/*`, a separate group) |
| API — HQ/superadmin-gated (`requireHqApi` or `requireUser`+`isSuperAdminEmail`→404) | 10 |
| API — management-gated (`requireManagementApi`) | ~15 |
| API — member-gated (`requireOrgContext`) | ~35 |
| API — cron (shared-secret `isCronAuthorised`→401) | ~45 |
| API — webhooks (HMAC/signature-verified) | ~15 |
| API — public v1 (API-key `resolveApiKey`, flag-dark) | 15 |
| API — SSO (SAML signature + replay / OIDC protocol) | 4 |
| API — telephony inbound (channel shared-secret) | 1 |

### Confirmed gaps by severity

| Severity | Count | Nature |
|---|---|---|
| P0 (cross-tenant / priv-esc) | **0** | — |
| P1 (staff gains a management mutation RLS would otherwise deny) | **0** | — |
| P2 (missing defence-in-depth page gate; RLS still holds) | **6 groups** | GAP-1..GAP-4, GAP-6(billing), GAP-7(templates) |
| P3 (minor / read-only / consistent-with-RLS) | **3** | GAP-5 (rota reads), GAP-6 (other settings), GAP-7 (supplier bill) |

> CLEAR P0/P1 findings: **0.** The audit surfaced defence-in-depth hardening and a handful of
> product-policy decisions, not an exploitable isolation or escalation hole.

---

## Guard contract (as verified in code)

| Guard | File | Semantics |
|---|---|---|
| `requireOrgContext()` | `server/auth/session.ts:282` | any signed-in member of active org; anon→/login, no-org→/onboarding, inactive→/access-pending |
| `requireManagementRole(ctx)` / `requireManagementContext()` | `session.ts:466,473` | owner/admin; else `redirect("/dashboard?error=forbidden")` |
| `requireManagementApi()` | `session.ts:491` | owner/admin; else 403 JSON |
| `requireHqPage()` / `requireHqApi()` | `server/auth/hq.ts:30,43` | env superadmin allowlist; anon→/login (page) / 404, else 404 |
| root `(app)/layout.tsx` | `app/(app)/layout.tsx` + `server/i18n/request.ts:54` | **implicit `requireOrgContext()` for the whole subtree** |

Roles are exactly `owner,admin,staff`; `ADMIN_ROLES = [owner,admin]`. Nav gating in
`nav-model.ts` is presentation only.

---

## Matrix (grouped by nav area / route prefix)

Legend: **NAV** = who the sidebar shows it to · **LOADER** = server enforcement actually applied
· **RLS** = row-level write/read posture · **Δ** = gap vs nav intent.

### Home / Projects / People

| Route(s) | NAV | LOADER | Δ |
|---|---|---|---|
| `/dashboard` | admin | member + staff→`/me` redirect (`dashboard/page.tsx:145`) | OK (effectively admin) |
| `/me` | staff | member | OK |
| `/jobs`, `/jobs/[id]/**` (most) | all | member (`jobs/[id]/layout.tsx` = `requireOrgContext`) | OK |
| `/jobs/[id]/billing`, `/jobs/[id]/valuations` | all | **management** (inline `requireManagementRole`) | OK |
| `/jobs/templates/**` | admin | member | Δ P3 (template config; member-readable) |
| `/staff`, `/staff/rota` | admin | member + inline `isAdmin` read-only render | Δ P3 (GAP-5) |
| `/staff/rota/generate`, `/staff/rota/conflicts` | admin | member, **no** inline gate | Δ P3 (GAP-5, read-only proposal) |
| `/staff/leave`, `/staff/[id]`, `/staff/[id]/timesheet` | all/mixed | member | OK (pay in `staff_compensation`, own RLS) |
| `/payroll`, `/payroll/[id]` | admin | **management** (`if(!isAdmin) redirect`) | OK |

### Sales (layout `requireManagementContext`)

| Route(s) | NAV | LOADER | Δ |
|---|---|---|---|
| `/leads/**`, `/quotes/**`, `/customers/**`, `/price-book/**` | admin | **management** (segment layout + inline `requireManagementRole`) | OK |
| `/reviews`, `/reviews/new` | admin | **member** (no layout, no inline gate) | **Δ P2 (GAP-4)** |

### Money

| Route(s) | NAV | LOADER | Δ |
|---|---|---|---|
| `/cash` | admin | member + staff→`/me` redirect (`cash/page.tsx:144`) | OK (effectively admin) |
| `/invoices/**` | admin | **management** (`invoices/layout.tsx` + page `requireManagementRole`) | OK |
| `/payments/**` | admin | **management** (`payments/layout.tsx`) | OK |
| `/expenses/**` | admin | **management** (`expenses/layout.tsx` + page) | OK |
| `/finances/**` | admin | **management** (`requireManagementRole`) | OK |
| `/cis/**` | admin | **management** (`cis/layout.tsx`; actions re-check `isManager`) | OK |
| `/tax` | admin | **management** (`requireManagementRole`) | OK |
| `/reports/**` | admin | **management** (`reports/layout.tsx`) | OK |
| `/insights` | admin | **management** (`requireManagementRole`) | OK |

### Site & Safety (area = all roles; several children = admin)

| Route(s) | NAV | LOADER | Δ |
|---|---|---|---|
| `/toolbox/**`, `/diary/**`, `/snags/**`, `/quality/**`, `/delays/**`, `/blueprints`, `/site-compliance/**` | all | member | OK (area is all-roles) |
| `/health-safety`, `/health-safety/permits/**` | admin | **member** | **Δ P2 (GAP-2)** |
| `/site-reports/**` | admin | **member** | **Δ P2 (GAP-2)** |
| `/documents` | admin | **member** | **Δ P2 (GAP-2)** |
| `/compliance/**` | admin | **member** | **Δ P2 (GAP-2)** |
| `/weather` | admin | **member** | **Δ P2 (GAP-2)** |

### Operations (area = admin; all children = admin)

| Route(s) | NAV | LOADER | Δ |
|---|---|---|---|
| `/operations` | admin | **member** | **Δ P2 (GAP-1)** |
| `/assets/**` | admin | **member** | **Δ P2 (GAP-1)** |
| `/fleet/**` | admin | **member** | **Δ P2 (GAP-1)** |
| `/stock/**` | admin | **member** | **Δ P2 (GAP-1)** |
| `/materials/requests/**` | admin | **member** | **Δ P2 (GAP-1)** |
| `/sites/**` | admin | **member** | **Δ P2 (GAP-1)** |
| `/suppliers/**` | admin | **member** (but `/suppliers/[id]` CIS/financial sub-view has inline `isAdmin`, `suppliers/[id]/page.tsx:103`) | **Δ P2 (GAP-1)** |
| `/purchase-orders/**` | admin | **member**; `recordSupplierBill` action = member (RLS-permitted, see GAP-7) | **Δ P2 (GAP-1)** |

### Inbox (area = all; customer-comms children = admin)

| Route(s) | NAV | LOADER | Δ |
|---|---|---|---|
| `/notifications` | all | member | OK |
| `/inbox` (enquiries) | admin | **member** | **Δ P2 (GAP-3)** |
| `/inbox/conversations/**` | admin | **member** | **Δ P2 (GAP-3)** |
| `/inbox/review` | admin | **member** | **Δ P2 (GAP-3)** |
| `/inbox/audit` | admin | **member** | **Δ P2 (GAP-3)** |

### Settings / utility

| Route(s) | NAV | LOADER | Δ |
|---|---|---|---|
| `/settings` (home) | all | member + inline `isAdmin` conditional | OK |
| `/settings/integrations`, `/settings/api-keys`, `/settings/webhooks`, `/imports` | admin | **management** (`if(!isAdmin) redirect/return`) | OK |
| `/settings/billing` | admin | member + inline `isAdmin` **read-only render** (exposes subscription + SaaS invoices) | **Δ P2 (GAP-6)** |
| `/settings/sso` | admin | member + inline `isAdmin` hides config | Δ P3 (GAP-6; honest dark state) |
| `/settings/automations`, `/settings/data-retention` | admin | member + inline `isAdmin` read-only render | Δ P3 (GAP-6) |
| `/settings/security` | admin | `requireUser` (per-user MFA enrol — **by design**, must stay aal1-reachable) | OK (self-serve) |
| `/settings/ai-receptionist`, `/settings/marketplace`, `/marketplace` | admin/flag | member | Δ P3 |
| `/help/**` | all | `requireUser` | OK |
| `/support/**`, `/support/new` | all | member floor (static form; `createSupportTicket` action gates write) | OK |

### API — notable classes (full list verified; exceptions below)

| Route class | Guard | Verdict |
|---|---|---|
| `/api/admin/stripe/*`, `/api/admin/qualification/*`, `/api/admin/research/*`, `/api/admin/analytics/*` | `requireUser` + inline `isSuperAdminEmail`→404 | OK (superadmin) |
| `/api/admin/monitoring/selftest`, `/api/hq/pulse/**` | `requireHqApi` | OK |
| `/api/dev/test-login` | env fail-closed (`VERCEL_ENV`!=preview/dev → 404) | OK |
| `/api/finances/**`, `/api/invoices/**`, `/api/quotes/[id]/{send,pdf}`, `/api/customers/[id]/statement/pdf`, `/api/reports/{route,export}`, `/api/tax/quarterly-pdf`, `/api/ai/question` | `requireManagementApi` (403) | OK |
| `/api/cron/**` | `isCronAuthorised` shared secret → 401 (incl. the eight that don't literally name `CRON_SECRET`: invoice-reminders, overdue-invoices, review-requests, lead-followups, quote-followup, report-delivery, retention-purge, compliance-expiry) | OK |
| `/api/webhooks/**` (stripe, twilio, vapi, whatsapp, resend, email) | provider signature / HMAC, fail-closed | OK |
| `/api/integrations/calendar/[provider]/webhook` | constant-time channel-token verify | OK |
| `/api/sso/{saml,oidc}/[orgId]/**` | SAML signature + replay-consume / OIDC protocol | OK |
| `/api/v1/**` (public API) | `resolveApiKey` via `lib/public-api/guard.ts`, scope-checked, flag-dark (404 off) | OK |
| `/api/receptionist/inbound` | `x-crewflow-channel-secret` constant-time | OK (coarse by design) |
| member-gated PDF/export/integration/schedule/search/gdpr routes | `requireOrgContext` + org pin | OK (member-readable data) |

---

## Detailed findings

### GAP-1 — Operations area reachable by any member (P2, AMBIGUOUS-NEEDS-CEO)

- **Evidence:** `nav-model.ts:197-214` marks the whole Operations area and every child
  `roles: ADMIN_ROLES`. Loaders enforce only the member floor, e.g.
  `app/(app)/operations/page.tsx`, `assets/page.tsx`, `fleet/page.tsx`, `stock/page.tsx`,
  `materials/requests/page.tsx`, `sites/page.tsx`, `suppliers/page.tsx`,
  `purchase-orders/page.tsx` — each `const { ctx } = await requireOrgContext();` with no role
  check.
- **Who/how:** a `staff` member, by typing the URL or Cmd+K. The sidebar hides these for staff
  but that is presentation only.
- **What protects the data today:** RLS (reads keyed on `current_org_ids()`) **plus** explicit
  active-org pins in every loader. Cross-tenant is not possible; `/suppliers/[id]` additionally
  gates its CIS/financial sub-view behind an inline `isAdmin` (`suppliers/[id]/page.tsx:103`).
  So the exposure is intra-org: staff can *read* plant/vehicle/stock/supplier/PO registers.
- **Intended policy:** **AMBIGUOUS.** Assets, stock, materials and sites are plausibly legitimate
  field-worker reads; suppliers and purchase-order *costs* lean management. Needs CEO call per
  sub-domain.
- **Severity:** P2 (defence-in-depth; RLS holds).
- **Smallest fix:** add `requireManagementRole(ctx)` to each page loader that CEO rules
  management-only, or (cleaner) an `operations/layout.tsx` with `requireManagementContext()` for
  the sub-domains that should be admin — leaving the field-worker ones at the member floor.

### GAP-2 — Site & Safety admin registers reachable by any member (P2, AMBIGUOUS-NEEDS-CEO)

- **Evidence:** `nav-model.ts:145,146,152,154,156,157` mark Health & safety, Permits, Site
  reports, Documents, Compliance library and Weather `roles: ADMIN_ROLES`. Loaders
  (`health-safety/page.tsx`, `health-safety/permits/page.tsx`, `site-reports/page.tsx`,
  `documents/page.tsx`, `compliance/page.tsx`, `weather/page.tsx`) are `requireOrgContext` only.
- **Who/how:** `staff` via direct URL.
- **What protects it:** RLS + active-org pin; member-readable compliance data. No cross-tenant.
- **Intended policy:** **AMBIGUOUS** — the Site & Safety *area* is deliberately `ALL_ROLES`
  (`nav-model.ts:143`), and RAMS/permits are exactly what site crews need to read; only specific
  children were marked admin. Leans "staff read is acceptable".
- **Severity:** P2.
- **Smallest fix:** `requireManagementRole(ctx)` in the specific loaders CEO deems admin-only
  (most likely Documents + Compliance library); leave H&S/Permits/Weather member-readable.

### GAP-3 — Inbox customer-comms surfaces reachable by any member (P2, AMBIGUOUS-NEEDS-CEO)

- **Evidence:** `nav-model.ts:228,229,234,235` mark Enquiries, Conversations, Review queue and
  Delivery audit `roles: ADMIN_ROLES`. Loaders (`inbox/page.tsx:75`, `inbox/conversations/**`,
  `inbox/review/page.tsx`, `inbox/audit/page.tsx`) are member-only, org-pinned
  (`inbox/page.tsx:100` `.eq("org_id", ctx.org.id)`).
- **Who/how:** `staff` via URL — can read inbound enquiries and customer conversation threads.
- **What protects it:** RLS + active-org pin; **outbound** customer comms (reply/send) go through
  separately-guarded actions/routes, not these read pages.
- **Intended policy:** **AMBIGUOUS**, leaning management for customer-comms reads.
- **Severity:** P2.
- **Smallest fix:** add `requireManagementRole(ctx)` to the four loaders (or an `inbox` layout that
  gates everything except `/notifications`, which must remain `ALL_ROLES`).

### GAP-4 — `/reviews` reachable by any member (P2, AMBIGUOUS-NEEDS-CEO)

- **Evidence:** `nav-model.ts:117` marks Reviews under Sales (`ADMIN_ROLES`).
  `reviews/page.tsx:72` and `reviews/new/page.tsx` use `requireOrgContext` only (no Sales layout
  over `/reviews`). Loader is org-pinned (`reviews/page.tsx:101`).
- **Who/how:** `staff` via URL — read the reputation/review queue.
- **What protects it:** RLS + active-org pin.
- **Intended policy:** AMBIGUOUS (reputation management is a Sales/management function, but a read
  is low-sensitivity).
- **Severity:** P2.
- **Smallest fix:** `requireManagementRole(ctx)` in both `/reviews` loaders.

### GAP-5 — People rota read surfaces ungated (P3)

- **Evidence:** `/staff` (`staff/page.tsx:52`) and `/staff/rota` (`staff/rota/page.tsx:107`)
  render a read-only view to staff via inline `isAdmin` conditionals (they do not block).
  `/staff/rota/generate` (`staff/rota/generate/page.tsx:166`) and `/staff/rota/conflicts` have
  **no** inline gate — but `generate` is explicitly a non-persisting proposal ("nothing here is
  saved", page copy) and `conflicts` is a read-only schedule check.
- **Who/how:** `staff` via URL.
- **What protects it:** read-only; pay data lives in `staff_compensation` with its own RLS and is
  not surfaced here. No mutation.
- **Intended policy:** AMBIGUOUS/low — crews seeing the roster/availability is reasonable.
- **Severity:** P3.
- **Smallest fix:** if CEO wants the roster management-only, add `requireManagementRole(ctx)` to
  `staff/rota/{page,generate,conflicts}` and the `staff` page.

### GAP-6 — Settings config pages render a read-only view to non-admins (P2 billing / P3 rest)

- **Evidence:** `/settings/billing` (`settings/billing/page.tsx:54`) computes `isAdmin` but does
  **not** block — it loads and renders `subscription` + `listOrgSaasInvoices(...)` for any member
  (lines 63-70), hiding only the change buttons. `/settings/sso`, `/settings/automations`,
  `/settings/data-retention` similarly render read-only to non-admins (e.g.
  `data-retention/page.tsx:156`, `automations/page.tsx:122`).
- **Who/how:** `staff` via URL.
- **What protects mutations:** the respective server actions gate writes; this is a *read*
  exposure. For billing the read includes the org's SaaS subscription state and invoice list.
- **Intended policy:** billing read leans **CLEAR** management-only (financial account data); the
  others are low-sensitivity config views.
- **Severity:** P2 (billing), P3 (sso/automations/data-retention).
- **Smallest fix:** `if (!isAdmin) redirect("/dashboard?error=forbidden")` in
  `settings/billing/page.tsx` *before* the Stripe reads (match the `api-keys`/`webhooks` pattern).

### GAP-7 — Member-floor mutations permitted by RLS: `recordSupplierBill`, template `publish`/`archive` (P3 / P2, AMBIGUOUS-NEEDS-CEO)

- **Evidence:**
  - `recordSupplierBill` (`app/(app)/purchase-orders/actions.ts:446`) guards with
    `requireOrgContext()` only, then inserts into `finances`. RLS **deliberately** allows member
    inserts: `"finances: members can insert ... with check (org_id in (select
    public.current_org_ids()))"` (`supabase/migrations/20260515180000_finances_and_receipts.sql:60`);
    only DELETE is admin-only (line 68-69). The action is otherwise hardened (active-org pin on the
    PO read at `actions.ts:446+`, job-org re-check, idempotency guard).
  - `publishTemplate`/`archiveTemplate` (`app/(app)/assets/template-actions.ts:407,443`) guard with
    `requireOrgContext()` only and write `asset_inspection_templates`, whose RLS is
    member-writable for insert/update (`...templates_insert ... with check (org_id in (select
    current_org_ids()))`, `...templates_update ...`); only delete is `is_org_admin`.
- **Who/how:** a `staff` member reaching the PO detail / asset-template pages (member floor) and
  submitting the form.
- **What protects it:** RLS — and critically, **RLS is written to permit exactly these member
  writes**, so this is consistent-with-policy, not a bypass. `recordSupplierBill` matches the
  documented "cost-entry stays member-open" money-authz boundary.
- **Intended policy:** `recordSupplierBill` = **AMBIGUOUS→P3** (already an accepted member-open
  cost-entry decision; changing it means changing RLS *and* the action together). Template
  `publish`/`archive` = **AMBIGUOUS→P2** (org-wide inspection-standard lifecycle by a non-manager;
  if it should be admin-only, both the action guard and the `asset_inspection_templates` write RLS
  need tightening to `is_org_admin`).
- **Severity:** P3 (supplier bill), P2 (template lifecycle).
- **Smallest fix:** if CEO rules either management-only, add an inline
  `if (!isManagementRole(ctx.membership.role)) return formError(...)` to the action **and** tighten
  the corresponding RLS write policy to `is_org_admin(org_id)` so the boundary is enforced at both
  layers.

---

## Residual to verify (medium confidence, not a confirmed finding)

- **Quotes mutation actions** (`app/(app)/quotes/actions.ts`): the Sales layout gates *rendering*
  for owner/admin, but server actions are not layout-protected. Several quote actions read
  `ctx.membership.role` inline (e.g. `sendQuote` at :771, variation/EOT actions at :1920,:1977),
  which is the correct pattern; however `createQuote` (:207), `updateQuote` (:532) and
  `deleteQuote` (:966) were not individually confirmed to re-check management role, and the quotes
  write RLS was not read. If any of those rely solely on the layout + member-level RLS, that would
  be a P2 (staff could mutate quotes by invoking the action directly). Recommend a focused pass:
  confirm each quote CRUD action either calls a management guard or that `quotes` write RLS is
  `is_org_admin`.

## Architectural notes (strengths worth preserving)

1. Root `(app)/layout.tsx` → `requireOrgContext()` gives every product route an authenticated
   member floor; there is no anonymous-reachable `(app)` page.
2. Management **mutations** self-guard inline instead of trusting layouts — correct, because
   Next.js layout guards do not run on server-action POSTs. CIS actions
   (`cis/actions.ts`, all 7 re-check `isManager`) and the money API routes
   (`requireManagementApi`) are good exemplars.
3. Every loader examined is active-org–pinned on top of `current_org_ids()` RLS, so the
   impersonation/dual-org edge cannot leak across tenants.
4. HQ, cron, webhook, SSO and public-API boundaries are all correctly and distinctly enforced;
   the "no guard import" appearance in a flat grep was in every checked case a differently-named
   but present guard (`isCronAuthorised`, signature verifiers, `resolveApiKey`, inline
   `isSuperAdminEmail`).
