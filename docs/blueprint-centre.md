# Blueprint Centre — foundation (Phase 2 WOW)

A **versioned drawing register** per job: upload a drawing (PDF/image), keep an
**immutable revision chain**, and view the current drawing + its full history — so
the site team always builds off the right revision. Migrations `20261015`.

**Milestone 1** (above) is the versioned register. **Milestone 2** (shipped —
see [§ Milestone 2](#milestone-2--interactive-canvas-viewer) below) adds the
**interactive canvas viewer**: in-app pdf.js rasterisation with continuous
zoom/pan, keyboard control, multi-sheet navigation, and a normalized overlay
that later milestones anchor pins/markup to. Coordinate-anchored **pins**,
freehand **markup**, and **revision compare** remain deferred to M3+.

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
  pills, a **"View"** button that opens the M2 interactive canvas viewer (below),
  a guaranteed **Open** link per revision (new tab → the 60s signed URL), and
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
  unauthenticated caller to a signed storage URL. (M2 viewer E2E — worker
  asset + auth-wall + fixme canvas journey — is in the M2 section below.)

## Milestone 2 — interactive canvas viewer

The full-screen viewer (`_pdf-viewer.tsx`, opened by `_viewer-launcher.tsx`)
rasterises the current drawing in-app so the site team can zoom into a detail
without leaving CrewFlow or fighting a mobile browser's PDF plugin.

### Rendering architecture (why it is safe)

- **Client-only, code-split.** The viewer is loaded via
  `next/dynamic(… , { ssr: false })`, so pdf.js never runs on the server and
  never lands in the register route's bundle — the route stays **3.16 kB**;
  pdf.js resolves as a separate lazy chunk only when a user clicks **View**.
  The production build proves the SSR boundary holds.
- **One fetch, no durable link.** The viewer fetches the same-origin serve
  route (`/jobs/[id]/blueprints/f/[versionId]`) **once** as an `ArrayBuffer`
  (reusing M1's RLS-read → 60s signed-URL path), then hands the bytes to pdf.js.
  Images render via a `Blob` `<img>`; PDFs via pdf.js.
- **Hardened `getDocument`:** `isEvalSupported: false` (no string→JS eval — pdf.js
  never needs full `'unsafe-eval'`), `enableXfa: false`, `disableAutoFetch: true`,
  no scripting, no annotation layer. Render caps at **DPR ≤ 2** and a **4096 px**
  max side so a huge sheet can't allocate an unbounded canvas; each
  `RenderTask` is **cancellable** (page changes/zoom abort the prior raster).
- **Worker:** `scripts/copy-pdf-worker.mjs` copies `pdf.worker.min.mjs` into
  `public/` on `predev`/`prebuild` (the file is a gitignored build artifact).
  It is served same-origin and **excluded from the auth middleware matcher** —
  it carries no tenant data, and a 307-to-`/login` on an expired cookie would
  otherwise hand pdf.js an HTML page as its worker source.
- **CSP:** the only delta is `'wasm-unsafe-eval'` in `script-src` (permits
  `WebAssembly.compile/instantiate` for pdf.js's image codecs — strictly
  narrower than the `'unsafe-inline'` already shipped, and **not** `'unsafe-eval'`;
  the negative test still guards against full eval). `worker-src 'self' blob:`,
  `img-src blob:`, and the Supabase `connect-src` were already present. CSP stays
  **Report-Only** — no enforcing flip.

### Interaction & accessibility

- Continuous **zoom** (wheel anchored to cursor + buttons, clamped 0.1–8×),
  **pan** (pointer drag, `touch-action:none`), **fit width / fit page / reset**,
  and multi-sheet **page nav** (only when >1 page).
- Full **keyboard** map (`+`/`−`/`0`/`f`, arrows, PageUp/Down, Home/End, `Esc`),
  `role="dialog"` + `aria-modal`, an `aria-live` status line, canvas
  `role="img"` with a per-sheet label, focus returned to the launcher on close,
  and a graceful **error → Open/download** fallback.
- A normalized **0..1 overlay** (`data-blueprint-overlay`) is mounted over the
  canvas now, so Programme B pins drop onto a coordinate model that is already
  correct under any zoom/pan — no viewer rework later.

### Pure core + tests

- **`lib/blueprints/viewer.ts`** holds all the coordinate math as pure functions
  (`normalizePoint`/`denormalizePoint` round-trip, `fitScale`, `clampZoom`,
  `zoomStep`, `bitmapScale` DPR cap, `clampPage`) — **10 unit tests**
  (`__tests__/blueprints/viewer.test.ts`), the layer a `node`-env vitest can
  cover without a DOM/canvas.
- **E2E (`e2e/blueprint-viewer.spec.ts`):** two real assertions run every CI
  pass — the worker asset is served same-origin as JavaScript (guards the
  copy-worker pipeline), and the viewer chrome never leaks to a logged-out
  visitor. The authenticated **open → canvas paints → zoom → Esc** journey is
  `test.fixme` pending the authenticated-E2E harness; the real pdf.js canvas
  paint is proven in a live browser via the M2 render self-test (not stubbed).

## Deferred → Blueprint milestone 3+

Coordinate-anchored **pins** (Programme B — a generic pin model with
DB-enforced composite-FK tenant integrity, dropping onto the M2 overlay),
freehand/box **markup**, **revision compare** (side-by-side / onion-skin),
large-sheet **tiling** for very high-DPI drawings, an **offline** foundation,
and the hook where the Blueprint AI reads the register.

## Known limitations
- The register loads all revision rows for a job's drawings in one batched query
  (no N+1). A single job carrying >1000 total revisions would need pagination —
  a long-project edge, mitigated by pointing the register at current-only + lazy
  history in a later pass.
- Deleting a job cascades the DB rows; storage bytes are cleaned by the delete
  service (admin `remove`) — inherited from the job-documents pattern.
