# Blueprint Centre — foundation (Phase 2 WOW)

A **versioned drawing register** per job: upload a drawing (PDF/image), keep an
**immutable revision chain**, and view the current drawing + its full history — so
the site team always builds off the right revision. Migrations `20261015`.

This is **milestone 1** of the Blueprint Centre epic. The interactive canvas
(zoom/pan, coordinate-anchored pins, markup, revision compare) is **milestone 2**
— the only part that justifies a new client rendering dependency, deliberately
kept out of the foundation bundle.

Reuses the `job_documents` versioning **pattern** as a **sibling pair** (as certs
reused site_reports, POs reused quotes). It is **not** a `job_documents` type — a
drawing has no staff/private split, no completion lock, and carries its own sheet
number and revision label.

## Model (`blueprints` + `blueprint_versions`)

- **`blueprints`** — one row per drawing on a job. Identity = `unique(org_id,
  job_id, drawing_number)` (revisions go in the chain, never new rows). Carries
  `title`, `discipline`, `status` (preliminary / for-construction / as-built /
  superseded), and a trigger-maintained `current_version` pointer (no FK).
- **`blueprint_versions`** — immutable, one file per revision. `version` (integer
  chain, trigger-allocated) + a human **`revision` label** ("Rev C"/"P02") +
  `revision_date`, the storage pointer, `mime_type`, `size_bytes`, and a
  **`content_hash` (sha256)** for evidence.

### DB-enforced invariants (real-Postgres tested)

- **Version rows are immutable** — a before-UPDATE trigger rejects any change for
  **every role, service-role included** (closing the gap `job_document_versions`
  has, where immutability rests only on an absent UPDATE policy the service-role
  client bypasses).
- **org_id + version derived from the parent** on insert (client-sent values are
  ignored) — anti-spoof.
- `current_version` tracks the latest revision; `unique(blueprint_id, version)`.
- Tenant-scoped RLS; admins delete.

## Storage & security

- A dedicated **private `blueprints` bucket** (50 MB; PDF/JPEG/PNG/WebP — no HEIC,
  which doesn't render inline). Storage RLS mirrors the job-docs **staff** shape
  (members read/insert, admins delete); org-scoped path
  `${org_id}/${job_id}/${blueprint_id}/${fileId}.${ext}` (org_id first segment).
- **Signed-URL only:** the serve route (`/jobs/[id]/blueprints/f/[versionId]`)
  RLS-reads the row first, then mints a **60s** signed URL of the row's own path —
  a wrong/guessed id 404s (no enumeration). Bytes never have a durable link.
- **Hardened uploads:** the declared MIME is untrusted, so the service sniffs the
  real **magic bytes** and rejects a mismatch; it records the **sha256**; the
  storage key is built server-side (no user input, no traversal); every
  service-role path re-checks `org_id === ctx.org.id`.
- Uploads = any member; **delete = admin-only + count-gated** (a denied delete
  never removes bytes) + audited (`recordAdminActivity`).

## UX

- A compact **"Drawings" teaser** on the job page (own fetch, one mount line — not
  in the page's `Promise.all`) links to a dedicated **`/jobs/[id]/blueprints`**
  route (the house sub-route pattern, wide layout).
- The register lists each drawing with its current revision, discipline/status
  pills, an inline **native viewer** (`<img>` for images, `<iframe>` for PDFs)
  with a guaranteed **Open / download** link (the real affordance on mobile), and
  a `<details>` **revision history**. Admin: status control + delete.
- Accessibility: real `alt`/`aria-label` (number + title + revision), real links,
  text-labelled pills, native pinch-zoom, empty/loading/error states.

## Tests

- **Unit (11):** schema, size/MIME validation, magic-byte sniff (incl. spoof
  rejection), org-first storage key, current-version helper.
- **Integration (5, real Postgres):** org/version derivation, current pointer,
  version immutability (incl. service_role), one-per-drawing-number, tenant isolation.
- **Security (6):** signed-URL-after-RLS-read, org re-check, magic-byte+hash,
  count-gated delete, serve-route 404/no-enumeration, private-bucket upload.
- **E2E:** the register is behind auth; the file route never 302s an
  unauthenticated caller to a signed storage URL.

## Deferred → Blueprint milestone 2 (needs a client rendering dependency)

pdf.js in-app rasterisation (reliable mobile PDF), continuous zoom/pan + large-sheet
tiling, multi-sheet navigation, coordinate-anchored **pins**, freehand/box **markup**,
**revision compare** (side-by-side / onion-skin). Later: the hook where the
Blueprint AI reads the register.

## Known limitations
- The register loads all revision rows for a job's drawings in one batched query
  (no N+1). A single job carrying >1000 total revisions would need pagination —
  a long-project edge, mitigated by pointing the register at current-only + lazy
  history in a later pass.
- Deleting a job cascades the DB rows; storage bytes are cleaned by the delete
  service (admin `remove`) — inherited from the job-documents pattern.
