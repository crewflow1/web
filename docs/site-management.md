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

## Fast-follow backlog (next Site Management increments)

- **"Log a snag" from a job** — a button on `jobs/[id]` deep-linking `/snags/new?job=…`
  (the create form already reads `?job`), plus a "Snags on this job" panel on the
  job detail (index `snags_job_idx` is already in place).
- **Customer-portal visibility** — surface verified/open snags on the portal so a
  client can see defects being closed before handover.
- **Snag-list "assigned to me"** filter for field staff; bulk status actions.
- **Next Stage One verticals**: Daily Diary, Toolbox Talks / RAMS, Site Reports
  (same job-linked + photo-attached shape), then the Blueprint Centre epic.
