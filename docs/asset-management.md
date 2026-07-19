# Asset Management — Stage One vertical

> Manage every physical asset a construction firm owns or hires — vans,
> excavators, generators, scaffolding, PPE — inside CrewFlow. Built on the exact
> proven Site Management pattern; additive, org-scoped, RLS-proven, reusing the
> universal attachment pipeline, the design system, and the RLS helpers. No
> parallel stores, no architecture forks.

## Coordinated delivery plan (milestone → PR)

A production platform, sequenced into coherent, independently-CI-green PRs. Each
reuses existing infrastructure; each is dark-safe and additive.

| # | Milestone | Core extension points | Status |
|---|---|---|---|
| **1** | **Asset register foundation** | `assets` table + RLS + `tenant_attachments` (images/manuals/certs) | ✅ **this PR** |
| 2 | Assignment engine | `asset_assignments` (asset → job/staff/vehicle/depot), conflict guard, audit | planned |
| 3 | QR platform | opaque asset id → existing routing; **needs a QR-gen dependency (decision)** | planned — see below |
| 4 | Inspections | `asset_inspections` + templates + schedules; reminders reuse the cron pattern | planned |
| 5 | Maintenance | `asset_maintenance` (preventive/corrective, parts, labour, cost, downtime) | planned |
| 6 | Document management | **reuses `tenant_attachments`** — no new store; category tagging | partial (attachments live now) |
| 7 | CX polish | skeletons/empty-states (live), bulk actions, mobile/tablet, cards | ongoing |
| 8 | Global search | extend the ⌘K palette + indexed serial/reg/tag search | planned |
| 9 | Security | tenant + assignment + attachment + QR isolation proofs | foundation proven; extends per milestone |
| 10 | Testing | unit + real-Postgres RLS + assignment-conflict + QR + E2E | foundation covered |
| 11 | Performance | indexes (live), query plans, N+1, search + QR-lookup speed | foundation indexed |
| 12 | Documentation | this file, kept current per milestone | ongoing |

### ⚠️ Architectural decision to surface (Milestone 3, QR)
There is **no QR/barcode library in the dependencies**. Generating printable QR
labels needs one (e.g. a server-side `qrcode` encoder → PNG/SVG data-URI, then the
existing PDF/print path). Adding it is a small but real **new external
dependency** — flagged for a quick CEO nod before Milestone 3, per the standing
rule that new dependencies / architecture changes are decision points. Camera
scanning uses the browser `BarcodeDetector` where available with a graceful
fallback. QR payloads carry an **opaque asset id only** — never tenant data.

## Milestone 1 — shipped (this PR)

The durable register:
- **`assets`** (`20260924000000_assets.sql`): name, category, manufacturer, model,
  serial, registration, your-reference; **ownership** (owned/hired) + **status**
  (active/retired/sold/lost/stolen/written_off) as separate concerns; supplier
  (**reuses `suppliers`**); purchase date/price, current value, warranty
  (depreciation-ready); hire window + rate; notes. Org-scoped RLS (member CRUD,
  admin-only hard delete — assets carry finance history), the shared
  `tg_set_updated_at()` trigger, and list/status/serial/registration/hire indexes.
- **Images, manuals, certificates** ride the existing `tenant_attachments`
  pipeline (CHECK widened to `assets`, preserving every prior target) — **no new
  store** (satisfies Milestone 6's "no duplicate storage").
- **Pure domain** (`lib/assets/schema.ts`): status/ownership constants + labels,
  `isDisposed`, category suggestions, the Zod create schema (money coercion, date
  validation) — unit-tested (8 cases).
- **UI**: list (status filter, active count, `EmptyState`, loading skeleton),
  create (finance + hire fieldsets, supplier picker, category datalist), detail
  (full spec, finance, hire, status controls, attachments, admin delete). Sidebar:
  **Assets**.
- **Security proof** (`__tests__/integration/rls/assets-isolation.test.ts`, real
  Postgres): tenant isolation (anon + non-member denied), attachment CHECK accepts
  `assets`, still accepts `site_reports`, rejects bogus.

## Reused (never duplicated)
`tenant_attachments` + storage RLS · `suppliers` · `recordAdminActivity` audit ·
`current_org_ids`/`is_org_admin`/`tg_set_updated_at` · `EmptyState` /
`Skeleton*` · the count-gated-mutation + admin-delete conventions.

## Known limitations (Milestone 1)
Full-field edit is via status controls only (a dedicated edit form is a fast
follow); import/export + bulk actions are Milestone 1b; assignment, QR,
inspections and maintenance are their own milestones above.
