# Site Management — milestone

> Stage One capability build. First vertical: **Snagging** (defect tracking) — the
> operational spine of on-site quality management. Additive, dark-safe, and built
> entirely on existing platform primitives (the `compliance` CRUD vertical, the
> universal `tenant_attachments` pipeline, the shared RLS helpers). No new
> architecture, no external dependency, no irreversible migration.

## Why snagging first

A "snag" is a construction defect found on site — a cracked tile, a missing seal,
a socket wired wrong. UK firms track them from first-spotted through to signed-off
so nothing slips before handover, and today they do it on paper, WhatsApp, and
spreadsheets. It is the highest-value **completable** Site Management vertical:
self-contained, maps cleanly onto patterns the codebase already has, and needs no
telephony/LLM/rendering infrastructure. (Blueprint Centre — markups, drawing
comparison, measurements, mobile viewer — is a canvas/PDF-rendering epic that
needs a new client dependency and its own multi-milestone plan; it is sequenced
next, not bundled here.)

## What shipped

A complete `/snags` vertical:

- **Log** a snag — title, priority, target-fix date, job/site, assignee, location,
  trade, details. Cursor lands in the title field; job + assignee come from the
  org's real data (reusing `listStaffForOrg`).
- **List** — one org-scoped read, status **and** priority filters, an open-count,
  overdue emphasis, `EmptyState` on zero. Job + assignee names resolve in two
  **batched** lookups (never per-row) so a site with hundreds of open snags stays
  a constant three queries.
- **Detail + workflow** — the lifecycle `open → in_progress → fixed → verified`
  (plus `wont_fix`), one-click status buttons, quick reassign + priority controls,
  a linked job, an audit block, and **photos** via the universal `AttachmentsPanel`.
- **Delete** — owner/admin only, count-gated, and it cleans up the snag's photos
  first (reusing `deleteTenantAttachment`, not duplicating storage code).

## Architecture — extend, don't duplicate

- **Table + RLS** (`20260919000000_snags.sql`) mirrors `jobs` / `compliance_documents`
  exactly: `org_id` tenant scoping, four policies (`current_org_ids()` for member
  CRUD, `is_org_admin()` for hard delete), the shared `tg_set_updated_at()` trigger,
  and indexes for the list + per-job queries. `job_id`/`assigned_to`/`reported_by`
  are `on delete set null` — a deleted job never erases the defect history.
- **Photos ride the existing pipeline.** Rather than a new bucket, snags become a
  target of the universal `tenant_attachments` system: one line added to
  `ATTACHMENT_TARGET_TABLES` and a widened `target_table` CHECK. The bucket's
  storage RLS keys on the org-id **path prefix**, not the table, so no storage
  policy changes — snag photos flow through the same audited, signed-URL,
  admin-delete pipeline as every other entity's files.
- **Pure domain logic** (`lib/snags/schema.ts`) — statuses, priorities, labels,
  `resolvedAtForTransition`, and the Zod input schemas — is separated from I/O and
  unit-tested directly.

## Security

No new attack surface. All reads/writes go through the tenant (user-JWT) client so
RLS scopes them; the service-role client is never used in the snag actions. Every
mutation is count-gated (an RLS no-op returns "not found", never a false success).
Hard delete is re-checked in code (owner/admin) as defence-in-depth over the RLS
policy, matching the compliance/attachments gate.

## Tests

- **Unit** (`__tests__/snags/schema.test.ts`, 13 cases) — the transition/resolved-at
  logic across every status pairing, and the input schema (blank→undefined coercion,
  bad uuid/date rejection, priority default).
- **Integration / RLS** (`__tests__/integration/rls/snags-isolation.test.ts`, real
  Postgres) — service-role positive control, anon denial, and an **authenticated
  non-member** denial (proving the gate is org membership via `current_org_ids()`,
  not mere authentication).

## Increment 2 — Daily Site Diary (`/diary`)

The second vertical, built on the exact snagging template. A dated per-site log —
**date, job, weather, headcount, work done, delays, notes**, with site **photos**
via the same universal `tenant_attachments` pipeline (allowlist + CHECK widened to
`site_diary_entries`, proven by the same positive/negative assertions).

- **Table** `site_diary_entries` (`20260920000000_site_diary.sql`): org-scoped RLS
  (member CRUD, admin-only delete — a diary is handover/dispute evidence), a
  `labour_count >= 0` CHECK, `entry_date default current_date`, the shared
  `tg_set_updated_at()` trigger, and `(org_id, entry_date desc)` + per-job indexes.
- **Full CRUD**: list (most-recent-day first, batched job-name resolution, delay
  badge), a shared create/edit form (`_form.tsx`, so the two can't drift), detail
  with photos, and admin delete (count-gated, photo-cleanup first).
- **Pure logic** (`lib/site-diary/schema.ts`): a deterministic `formatDiaryDate`
  (no locale/timezone dependency) + the Zod schemas incl. `labour_count`
  coercion — unit-tested (`__tests__/site-diary/schema.test.ts`, 8 cases).
- **RLS proof** (`__tests__/integration/rls/site-diary-isolation.test.ts`, 5 cases):
  service positive control, anon + non-member denial, CHECK accepts/rejects.

## Increment 3 — Toolbox Talks / RAMS (`/toolbox`)

Recorded on-site safety briefings — the evidence a UK site must keep that a talk
happened and who attended. Same template again.

- **Table** `toolbox_talks` (`20260921000000_toolbox_talks.sql`): topic +
  talk_date (required), presenter, attendees (free-text sign-in) + optional
  `attendee_count` (>= 0 CHECK), job, notes. Org-scoped RLS (member CRUD,
  admin-only delete — H&S evidence), shared trigger, `(org_id, talk_date desc)` +
  per-job indexes. The signed attendance sheet is a **photo** via the universal
  pipeline (allowlist + CHECK widened to `toolbox_talks` — third stacked widening,
  preserving `snags` + `site_diary_entries`).
- **CRUD**: list (most-recent first, batched job names), create form, detail with
  photos, admin delete. Point-in-time record — no edit surface in v1.
- **Pure logic** (`lib/toolbox-talks/schema.ts`): Zod schema incl. `attendee_count`
  coercion — unit-tested (6 cases). Date display reuses the diary's
  `formatDiaryDate`.
- **RLS proof** (`__tests__/integration/rls/toolbox-talks-isolation.test.ts`, 5
  cases): service positive control, anon + non-member denial, CHECK accepts/rejects.

## Increment 4 — Site Reports (`/site-reports`) — formal progress reporting

The largest Site Management vertical: formal, client-ready progress reports that
**aggregate** existing site information (diary, snags, toolbox talks) into a
structured, auditable deliverable — distinct from the internal Daily Diary. Built
to the full production bar as a **phased feature**; this is **increment 1 — the
durable, security-critical core**, shipped complete and verified. PDF, portal, the
rich per-section editor, notifications and the AI writer layer on this proven
foundation (they do not change the model).

**Shipped (increment 1):**
- **Immutable-snapshot data model** (`20260922000000_site_reports.sql`). A report
  separates its **editable draft** (`content` jsonb — selected source refs +
  commentary) from the **frozen customer-visible snapshot** (`snapshot` jsonb,
  materialised at issue). A DB trigger (`tg_site_reports_immutable`) makes the
  snapshot **write-once** and freezes `content` after issue — enforced even against
  the service-role writer, so a historical report can never silently change when
  its source records are later edited. Revisions supersede rather than mutate.
- **Server-validated state machine** (`lib/site-reports/state.ts`): draft →
  ready_for_review → approved → issued → superseded → archived; every transition
  is `assertTransition`-guarded in the actions. Unit-tested.
- **Deterministic aggregation** (`lib/site-reports/aggregate.ts`, pure): gathers a
  job+period's diary/snags/toolbox, proposes a default selection, summarises
  counts, and materialises the frozen snapshot from the author's curated selection
  + commentary. *Deterministic, not AI* — the AI writer (a later increment) will
  feed this same pipeline through the existing draft/approval/capability/audit
  engines, never a parallel path.
- **Full lifecycle actions + UI**: list (status filter), create (pick job +
  period → gather → draft), review (edit commentary, run the workflow, issue).
  Report-level attachments via the universal pipeline (CHECK widened to
  `site_reports`, preserving all prior Site Management targets).
- **Security proof** (`__tests__/integration/rls/site-reports-isolation.test.ts`,
  real Postgres): tenant isolation (anon + non-member denied), **snapshot
  write-once + content-freeze-after-issue** (trigger blocks even service_role),
  and the attachment CHECK accepts `site_reports`, still accepts `snags`, rejects
  bogus. Plus 12 unit cases (state machine, schema, aggregation).

**Reuse points identified for later increments (discovery):**
- **PDF** — reuse `@react-pdf/renderer` + the `lib/pdf/*.tsx` component pattern
  (invoice/quote/payslip PDFs) + a `/api/site-reports/[id]/pdf/route.ts`. No new
  PDF system.
- **Portal** — issued-only visibility through the existing customer-portal token
  model (a dedicated issued-only read path, not a blanket policy). `customer_id` +
  `status='issued'` are already the scoping keys + index.
- **Notifications / approval / AI** — the existing notification, draft, approval
  and capability-registry engines; no parallel pathways.

**Shipped (increment 2 — the client deliverable):** a branded, professional
**PDF** at `GET /api/site-reports/[id]/pdf` (RLS-authed, `runtime=nodejs`),
reusing `@react-pdf/renderer` + the invoice/quote PDF architecture — org
letterhead + logo, report identity block, executive summary, aggregated
site-activity stats, a snags table, all commentary sections, an approval block,
and a fixed footer with page numbers. It renders the **frozen snapshot** for an
issued report and a live **preview** for a draft; a Download/Preview button sits
on the detail page. Proven by a real PDF-generation unit test (renders a
well-formed `%PDF-` buffer, incl. an empty-content draft) — enabled by switching
the unit tier to the automatic JSX runtime (`vitest.config.ts`).

**Shipped (increment 3 — the customer value loop):** issued reports can now be
**published to the customer portal** and viewed/downloaded by the client.
- **Publication model** (`20260923000000_site_reports_portal.sql`): additive
  `portal_published_at` / `portal_published_by` / `portal_withdrawn_at` /
  `customer_notified_at` + a partial index over the visible set. Publishing is a
  **deliberate step separate from issuing** (issue internally, publish later).
  The frozen snapshot is untouched (publication columns are separate operational
  state). Visibility rule (`lib/site-reports/portal.ts` `isPortalVisible`, pure +
  unit-tested): `status IN (issued,superseded) AND published AND NOT withdrawn`.
- **Access model**: the portal has **no customer JWT** — the URL token resolves
  to a customer (`loadCustomerByPortalToken`), and every report read
  (`_reports.ts`) filters by that `customer_id` + `org_id` + `isPortalVisible` on
  the admin client, exactly like quotes/invoices. Guessing an id, a draft, an
  unpublished or withdrawn report, another customer's or another org's report all
  return nothing identically.
- **Customer surface**: `/customer-portal/[token]/reports` (list, latest vs.
  superseded) + `/[id]` (frozen snapshot, client-decisions surfaced, supersession
  notice) + `/[id]/pdf` (token-gated download, `safeReportFilename`, private
  cache). Renders **only** the frozen snapshot — never live source records.
- **Operator controls**: Publish / Withdraw on the internal detail page
  (owner/admin, issued-only, count-gated, audited). Portal-visibility status shown.
- **Security proof** (`__tests__/integration/rls/site-reports-portal.test.ts`,
  real Postgres): customer isolation (A1 ≠ A2, id-guessing fails), tenant
  isolation (org A ↛ org B), status enforcement (draft/approved/unpublished/
  withdrawn invisible; issued-published + superseded-published visible), frozen
  snapshot exposure. Plus 9 unit cases (visibility predicate + safe filename).

**Deferred to increments 4+ (honestly not yet built):** customer notifications on
publish (through the existing draft/approval/comms-readiness engine — the
`customer_notified_at` field + audit distinction are already in place), a
Playwright E2E of the full internal→customer loop, structured risk/decision/
photo-gallery editors, and the AI Site Report Writer.

## Fast-follow backlog (next Site Management increments)

- **"Log a snag" from a job** — a button on `jobs/[id]` deep-linking `/snags/new?job=…`
  (the create form already reads `?job`), plus a "Snags on this job" panel on the
  job detail (index `snags_job_idx` is already in place).
- **Customer-portal visibility** — surface verified/open snags on the portal so a
  client can see defects being closed before handover.
- **Snag-list "assigned to me"** filter for field staff; bulk status actions.
- **Next Stage One verticals**: Site Reports (same job-linked + photo-attached
  shape) completes the Site Management cluster, then the Blueprint Centre epic.
  (Snagging, Daily Diary, Toolbox Talks shipped — increments 1–3 above.)
