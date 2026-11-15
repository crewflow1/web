# D-17 permission matrix (least-privilege rework, 2026-11-15)

Roles: **Owner** (always), **Admin** (only what the owner granted), **Staff** (field baseline only —
stray grant rows on a staff membership are ignored), **Other company** (any role in a different
organisation), **Held** (suspended / cancelled / pending / rejected company).

Enforcement is three-layer: **page** (segment layout / page guard) · **action** (`requireCapability`
family, `lib/auth/capability-rules.ts`) · **database** (RLS + trigger, migration `20261346`;
`public.has_org_capability` mirrors `canWith`). Proved with real GoTrue sessions in
`__tests__/integration/adversarial/staff-field-operations.test.ts` (11 allow/deny pairs) and the
existing adversarial suite.

Legend: ✅ allowed · 🔑 allowed with the named grant (admin) / owner · ⛔ refused · 👁 read only

## Field duties (baseline: owner, admin, staff all ✅; capability `*_field`, view/create/edit only)

| Duty | Staff | Admin | Owner | Other company | Held company | Database rule (20261346) |
|---|---|---|---|---|---|---|
| Scan an asset QR, open the asset | ✅ | ✅ | ✅ | ⛔ | 👁 | member read (unchanged) |
| Start / complete **own** inspection | ✅ draft→issued | ✅ | ✅ | ⛔ | ⛔ | insert: `created_by = me`, `status = draft`; update own only |
| Report a defect | ✅ as me, `reported` | ✅ | ✅ | ⛔ | ⛔ | insert: `reported_by = me`, `status = reported` (triage = `assets:edit`) |
| Take an asset into **own** custody / return it | ✅ self only | ✅ | ✅ | ⛔ | ⛔ | `assignee = assigned_by = me`; assigning others needs `assets:edit` |
| Log fuel | ✅ as me | ✅ | ✅ | ⛔ | ⛔ | insert `created_by = me`; edit/delete = `fleet` |
| Issue / transfer stock, manage assigned van stock | ✅ as me | ✅ | ✅ | ⛔ | ⛔ | stock-ledger trigger: `actor = me`, types issue / transfer / receipt |
| Count stock (record counts on a *counting* session) | ✅ | ✅ | ✅ | ⛔ | ⛔ | update `counted_by = me`, session `counting`, no variance fields |
| Record goods received (draft → posted) | ✅ own GRN | ✅ | ✅ | ⛔ | ⛔ | insert/update own draft; void = `purchase_orders` |
| Request materials | ✅ draft / submitted | ✅ | ✅ | ⛔ | ⛔ | member insert; **cannot** carry a decision |
| Submit a job cost (receipt) as **pending** | ✅ `extracted` only | ✅ | ✅ | ⛔ | ⛔ | insert status `extracted`; approve = `expenses:approve` |
| Draft a risk assessment / RAMS / permit; complete assigned procedures | ✅ draft | ✅ | ✅ | ⛔ | ⛔ | status must be `draft` (permit may also be `cancelled`) |
| Site reports, weather | ✅ | ✅ | ✅ | ⛔ | 👁 | member-level |

## Restricted (management capability required)

| Operation | Staff | Admin | Owner | Notes |
|---|---|---|---|---|
| Approve a purchase request / issue a PO / PO approvals | ⛔ | 🔑 `purchase_orders` | ✅ | decision columns refused for members (DB) |
| Approve / reject a cost entry | ⛔ | 🔑 `expenses:approve` | ✅ | |
| Issue / supersede / withdraw a risk assessment, issue / activate / close a permit | ⛔ | 🔑 `site_safety:approve` | ✅ | DB + action |
| Stock adjustments, corrections, item master, valuation, replenishment, stocktake open/post | ⛔ | 🔑 `stock` | ✅ | ledger trigger + page guards |
| Asset register, new asset, templates, calibration, holdings, prices | ⛔ | 🔑 `assets` | ✅ | purchase price column ACL (20261343) |
| Fleet register, vehicles, compliance | ⛔ | 🔑 `fleet` | ✅ | |
| Suppliers, PO list / new / matching | ⛔ | 🔑 | ✅ | |
| Financial reporting, cash, payroll, CIS, tax, bank / HMRC details | ⛔ | 🔑 | ✅ | unchanged (R4 modules) |
| Company settings, integrations, API keys, SSO, retention | ⛔ | 🔑 `settings:manage` | ✅ | unchanged |
| Compliance documents (insurance, contracts), document library | ⛔ | 🔑 `documents` | ✅ | **new gate** |
| Create a job / job templates | ⛔ | 🔑 `jobs:create` / `jobs:manage` | ✅ | **new gate** |
| Rota generate / conflicts | ⛔ | 🔑 `rota:edit` | ✅ | **new gate** |
| H&S worker links | ⛔ | 🔑 `site_safety:manage` | ✅ | **new gate** |
| Staff add / role / edit / remove, owner-record changes | ⛔ | per #1096 rules | ✅ | held company: refused |

## Company lifecycle (pending · suspended · rejected · cancelled) — final rule

| Company status | Owner | Admin / staff | Public links, forms, API keys, inbound channels |
|---|---|---|---|
| active / trial | full | per role + capability | work |
| suspended / cancelled | 👁 read-only app + billing, settings, export; **no operational write** | locked out (app `/access-pending`; database returns no company data) | operational writes ⛔ · paying an **existing** invoice ✅ · the customer's own consent / contact rights ✅ |
| pending / rejected | locked out; database returns no company data | same | everything ⛔ except consent rights |

Enforcement: `current_org_ids` / `is_org_member` / `is_org_admin` / compensation predicates (who may read),
RESTRICTIVE `org_is_writable` policies on 187 client-writable tables + the `held_org_write_guard` trigger on all
230 org tables (covers SECURITY DEFINER RPCs), capability guards + `assertOrgWritable` for service-role server
actions, and `server/services/org-lifecycle.ts` for public paths (fails closed). The server itself (Stripe
webhooks, crons, HQ, onboarding, reactivation) is never blocked; data is never auto-erased.
A member always keeps their own information: own company row (name, status), own membership, own profile, own
pay record.

## Deploy-together set
**Order: CODE FIRST, then migrations `20261340` → `20261346` in ascending order** (all above the production
tip `20261327`). Proved locally: the new build against a database at `20261327` passes the full browser suite
except staff goods-receiving (staff cannot read a purchase order until `20261346` — today's behaviour, a
read-only 404, nothing written); applying `40`–`46` live to the running server then passes the key journeys.
The reverse order is NOT safe (and a rollback therefore goes DATABASE first, then application — see ROLLBACK.md): `20261341`–`43` remove columns from the Data API that the OLD code still
selects as a client. During the code-first window the database still has today's (pre-existing) holes; the
new code adds only stricter application gates, so there is no new exposure.
