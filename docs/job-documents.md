# Job Documents (P4)

Per-job document storage with a **staff / company-private split** — the office
can keep documents on a job that site staff can add to but must never read.
Shipped and in production (RC3); migrations `20260704010000` (core),
`20260704010100` (buckets), `20260704010200` (activity filter). This doc was
added by the Programme E reconciliation — the subsystem previously had none.

> **Not the same as** the customer-portal document library (`#390`, quote/invoice/
> report PDFs) or the polymorphic `tenant_attachments`. Job Documents is a
> **staff-internal** store with its own tables + buckets; it has **no customer /
> portal exposure**.

## The two areas

`job_documents.visibility` discriminates one job into two document areas:

| Area | Who can read | Who can write | Purpose |
|---|---|---|---|
| `staff` | owner / admin / **staff** | owner / admin / staff | shared working documents |
| `private` | owner / admin **only** | owner / admin / staff (**write-only**) | company-private; staff drop-box |

The `private` area is the security-sensitive part: a staff member can **upload**
a document (e.g. drop off a supplier invoice) but can **never** list or download
anything in it. Only owner/admin can read it back.

## Enforced at three layers (defence in depth)

1. **Table RLS** (`20260704010000`) — SELECT on a `private` row requires
   owner/admin; INSERT is allowed for any member; the staff role is excluded
   from private reads.
2. **Storage RLS** (`20260704010100`) — two physically separate buckets so the
   boundary is on the bytes, not just the metadata row:
   - `job-docs` (staff area) — any org member may read/write.
   - `job-docs-private` — owner/admin READ, members INSERT (write-only drop
     box), admin delete. Staff can never SELECT, so a private signed URL only
     succeeds via the **service-role client after a server-side admin check**.
3. **Service layer** (`server/services/job-documents.ts`) — re-checks the caller's
   role before minting any private signed URL; the page passes a computed
   `canViewPrivate` (`app/(app)/jobs/[id]/page.tsx`) so private rows never enter
   a staff member's RSC payload in the first place.

## Audit privacy

Private-document events are logged with an action prefixed
`job_document.private.`; `20260704010200` amends the org-wide `activity_log`
SELECT policy so **only owner/admin** see those rows — otherwise a private
filename would leak to staff through the activity feed.

## UI

`app/(app)/jobs/[id]/_job-documents.tsx` + `_job-documents-client.tsx` render the
two areas on the job page, gated by `canViewPrivate`; uploads/deletes go through
`job-documents-actions.ts`.

## Versioning

`job_documents` carries a version chain (one row per logical document, newest
version resolved by a trigger) so replacing a document keeps history rather than
overwriting — see the core migration.
