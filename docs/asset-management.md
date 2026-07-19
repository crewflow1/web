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
| **1** | **Asset register foundation** | `assets` table + RLS + `tenant_attachments` (images/manuals/certs) | ✅ #373 |
| **2** | **Assignment & custody engine** | `asset_assignments` + partial-unique-index invariant + guard trigger + transfer RPC | ✅ **this PR** |
| **3** | **QR platform** | `asset_qr_identities` (opaque token, one-active invariant, atomic rotate, revoke) | ◑ **M3a identity core — this PR**; M3b (labels+scan) next |
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

## Milestone 2 — shipped (this PR): assignment, custody & transfer

Custody history for every asset — who has it, on which job/vehicle, at which
depot, in what condition, due back when — with the **defining risk (conflicting
custody) enforced at the database, never the frontend**.

- **Five concerns kept separate** (per the approved model): asset **lifecycle**
  (`assets.status`), **custody + history** (`asset_assignments`), and the seams for
  operational availability / location / compliance that M4–M5 will fill. Custody is
  NOT overloaded onto the lifecycle status.
- **The invariant** (`20260925000000_asset_assignments.sql`): a **partial unique
  index `UNIQUE(asset_id) WHERE status='open'`** → at most one open assignment per
  asset; two concurrent check-outs → exactly one winner (the loser gets a 23505 the
  action translates to "already checked out"). A **guard trigger** enforces same-org
  references (job/vehicle/assignee) + eligibility (only an `active` asset may be
  issued) at the DB. **Transfer** is an atomic `SECURITY INVOKER` RPC
  (`transfer_asset_assignment`) — close-old + open-new in one transaction, rolls
  back fully on a bad destination.
- **Actions** (`assignment-actions.ts`): check-out (insert; DB invariant is the
  gate — no check-then-insert), return (close the open row; a repeat is a no-op),
  transfer (RPC). All translate DB violations into construction-language errors.
- **Pure domain** (`lib/assets/assignment.ts`, 9 unit cases): types/conditions,
  destination-per-type, eligibility, overdue, error translation, Zod schemas.
- **UX**: a custody section on the asset detail — current holder/job/location,
  since, due-back, overdue; check-out / return / transfer forms.
- **Security proof** (`__tests__/integration/rls/asset-assignments.test.ts`, real
  Postgres, 7 cases incl. a genuine **concurrency** proof): single-open invariant,
  concurrent-winner, eligibility, cross-org guard, transfer atomicity + rollback,
  return idempotency, attachment CHECK (+ prior targets), anon denial.

**Known limitations (M2):** reservations deferred (documented — better handled by
future scheduling); lost/stolen is via the asset lifecycle status (M1) not a custody
action yet; staff-held / job-asset cross-domain lists + a dedicated Playwright E2E
are the immediate follow-ups; per-field operational-vs-financial permission split is
a later hardening pass.

## Milestone 3a — shipped (this PR): QR identity core

The security foundation of the QR platform — **dependency-free** (the `qrcode`
library only renders the *image*; that's M3b). A permanent, revocable, tenant-safe
identity per asset.

- **`asset_qr_identities`** (`20260926000000`): opaque high-entropy token (raw,
  like `customers.portal_token` — revocable + enumeration-resistant, encodes no
  business data), `active`, revocation (`revoked_at/by/reason`), lineage
  (`regenerated_from`). **Invariant: one ACTIVE identity per asset** (partial
  unique index) + unique token + a same-org guard trigger. RLS (member CRUD,
  admin delete).
- **Atomic rotate RPC** (`rotate_asset_qr_identity`, SECURITY INVOKER): revoke-old
  + insert-new in one txn → old printed labels die immediately; concurrent
  rotations can't leave two active.
- **Pure module** (`lib/assets/qr.ts`, 5 unit cases): crypto-random token gen,
  edge token-format validation, the `isResolvable` (active-only) scan predicate,
  `scanPath`, safe label filename.
- **Actions**: generate/regenerate (rotate RPC), revoke (count-gated). QR card on
  the asset detail.
- **Security proof** (`__tests__/integration/rls/asset-qr.test.ts`, real Postgres,
  6 cases): one-active invariant, concurrent-generation → exactly one active,
  atomic rotate revokes-old, revoked/cross-tenant/unknown token **do not resolve**,
  same-org guard, anon denial.

## Milestone 3b (scan) — shipped: authenticated scan resolver

The security-critical half of M3b — **dependency-free** (the token comes from the
scanned URL; `qrcode` renders the *image*, added in the labels slice).

- **`/a/[token]`** (`app/(app)/a/[token]/page.tsx`) — under the `(app)` auth group,
  so an unauthenticated scan follows the app's normal sign-in and returns to this
  internal route (**no open-redirect surface**). Renders a thin scan landing
  (asset + status + custody) → **View asset & custody**, handing off to the detail
  page's existing **M2 custody actions** — no QR-specific custody logic.
- **`resolveScannedAsset`** (`_scan.ts`, server-only, **tenant-scoped** via the
  user-JWT client so RLS gates both the identity and the asset): edge token-shape
  gate → active identity by token → the asset. **Identical `null` (→ notFound)** for
  malformed / unknown / revoked / cross-tenant / inaccessible — no disclosure, no
  enumeration signal.
- **Security proof** (`__tests__/integration/rls/asset-qr-scan.test.ts`, real
  Postgres, 4 cases): active same-org token → the correct asset; revoked → null;
  cross-tenant → null (owning org still resolves); unknown → null.

**M3b-labels (next slice):** final `qrcode` `npm audit` + install → SVG →
react-pdf **labels** (single + sheets, org branding, no financial fields) → camera
scanner UX + manual entry → dedicated Playwright QR E2E. The scan *security* is
proven here; labels are rendering + camera UI.

## Reused (never duplicated)
`tenant_attachments` + storage RLS · `suppliers` · `recordAdminActivity` audit ·
`current_org_ids`/`is_org_admin`/`tg_set_updated_at` · `EmptyState` /
`Skeleton*` · the count-gated-mutation + admin-delete conventions.

## Known limitations (Milestone 1)
Full-field edit is via status controls only (a dedicated edit form is a fast
follow); import/export + bulk actions are Milestone 1b; assignment, QR,
inspections and maintenance are their own milestones above.
