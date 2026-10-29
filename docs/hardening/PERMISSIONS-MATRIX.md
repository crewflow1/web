# CrewFlow — Permissions Matrix

**Date:** 2026-10-28 · prod `aedb9279`. Authoritative role/route/action/RLS map. Full route-level evidence: `docs/hardening/findings/01-route-authorization.md`; staff-role detail: `docs/audit/PART-2-STAFF.md`.

## Roles (the only ones that exist)
| Role | Set | Lands on | Reach |
|---|---|---|---|
| **owner** | `ADMIN_ROLES` | `/dashboard` | full product + money + settings |
| **admin** | `ADMIN_ROLES` | `/dashboard` | same product surface as owner |
| **staff** | — | `/me` | assigned work + field tools |
| **super-admin (HQ)** | env allowlist `CREWFLOW_SUPERADMIN_EMAILS` | `/admin` | platform; **separate from company roles**, cannot be gained by a company user |

`ADMIN_ROLES = [owner, admin]`. There is **no** manager/supervisor/accountant/viewer role.

## Enforcement layers (defence in depth)
1. **Nav** (`app/(app)/_nav/nav-model.ts`) — presentation only; hides surfaces from staff. **Never** the security boundary.
2. **Member floor** — root `(app)/layout.tsx` → `requireOrgContext()`; anonymous → `/login`.
3. **Management gate** — `requireManagementRole`/`requireManagementContext` (page: redirect `/dashboard?error=forbidden`) / `requireManagementApi` (403). Owner+admin only.
4. **HQ gate** — `requireHqPage` (anon→`/login`, else 404) / `requireHqApi` (404). Env allowlist.
5. **RLS** — last line; every tenant table org-scoped via `current_org_ids()`. Always on even when an upper layer is permissive.
6. **Per-mutation re-checks** — destructive/financial actions re-assert role in the action body.

## Role × capability
| Capability | owner | admin | staff | super-admin | Enforcement |
|---|:--:|:--:|:--:|:--:|---|
| `/me`, field tools (toolbox/diary/snags/quality/drawings/site-compliance), leave request | ✅ | ✅ | ✅ | — | member floor / all-roles |
| View/open any job | ✅ | ✅ | ✅ | — | **RLS org-wide** (not assigned-only) |
| Job commercial/billing/valuations/profit tabs | ✅ | ✅ | ❌ | — | server fail-closed (`requireManagementRole`) |
| Log a cost (`/finances/new`) | ✅ | ✅ | ✅ | — | member-open **by design** |
| Quotes (list/CRUD/send/approve) **+ AI quote-writer** | ✅ | ✅ | ❌ | — | layout + **every action re-checks** (quote-writer fixed PR #947) |
| Money (invoices/payments/expenses/CIS/tax/reports/cash) | ✅ | ✅ | ❌ | — | segment layout + `requireManagementApi` |
| Settings → Billing | ✅ | ✅ | ❌ | — | **`requireManagementContext` (PR #947)** |
| Settings → api-keys/webhooks/imports | ✅ | ✅ | ❌ | — | page `isAdmin` deny panel/redirect |
| Staff / Rota / Payroll | ✅ | ✅ | ❌ (→`/me`) | — | page-gated hard redirect |
| See other staff pay / NI | owner/admin | ✅ | ❌ | — | **DB RLS** (`staff_compensation`, `staff_secrets`) |
| Operations (assets/fleet/stock/suppliers/PO/sites/materials) | ✅ | ✅ | ⚠️ **URL-readable** | — | member floor + RLS — **POLICY-01 (CEO)** |
| Site & Safety admin registers | ✅ | ✅ | ⚠️ URL-readable | — | member floor + RLS — **POLICY-02 (CEO)** |
| Inbox customer-comms reads | ✅ | ✅ | ⚠️ URL-readable | — | member floor + RLS; sending guarded — **POLICY-03 (CEO)** |
| `recordSupplierBill`, inspection-template publish/archive | ✅ | ✅ | ⚠️ **URL-writable** | — | RLS member-write **by design** — **POLICY-04 (CEO)** |
| CrewFlow HQ (`/admin/*`, `/api/hq/*`) | ❌ | ❌ | ❌ | ✅ | env allowlist (`requireHqPage/Api`), re-checked in 32 action files |
| Impersonate a customer org | ❌ | ❌ | ❌ | ✅ | HQ-gated, audited, 24h-capped, RLS-bounded, banner-enforced |

Legend: ✅ allowed · ❌ denied · ⚠️ nav-hidden but enforced only at the member floor (RLS still scopes rows) — a **policy decision**, not a confirmed breach.

## API / RPC / RLS summary
- **148 API routes:** ~15 management, ~35 member, 10 HQ/superadmin, ~45 cron (secret), ~15 webhooks (signature), 15 v1 public (API-key, flag-dark), 4 SSO, 1 telephony.
- **~190 SECURITY DEFINER functions:** client-executable uuid-arg class all guarded with `current_org_ids()` + `42501`.
- **RLS:** every tenant table org-scoped; service-role-only tables RLS-on + zero-policy; no blanket client grants.
