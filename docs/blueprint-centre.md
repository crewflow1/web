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

## Programme B — Blueprint Pins (shipped)

Pins make drawings **operational**: open a drawing, tap the exact location of a
problem, and create a snag that is now anchored to that spot on that revision —
connecting the drawing, the snag, its job, its photos, and the audit trail.

### One generic model — `blueprint_pins` (migration `20261016`)
A single table, not one system per domain. A pin carries an anchor
(`blueprint_version_id` + 1-based `page_number` + normalized `u,v ∈ [0,1]`), a
`kind`, and exactly one payload:
- **`kind='snag'`** → links a snag (create-a-new-snag is the hero flow; link an
  existing open snag is also supported). Status is **read from the snag** — never
  duplicated on the pin.
- **`kind='note'`** → a free text note pinned to the spot (no external entity).

New link targets (site report / diary / toolbox / document, and *task* once that
domain exists) are a **3-line additive migration** — a nullable `<entity>_id`
column + a composite FK + one `check` clause — never a redesign.

### DB-enforced integrity (real-Postgres tested — 9 invariants)
- **Anchored to the immutable revision.** A pin belongs to `blueprint_version_id`,
  never the drawing + "current version" — re-issuing a drawing does not relocate
  pins (a construction-safety property; also what lets revision-compare show
  A's pins on A and B's on B). No carry-forward: "copy my pins to the new
  revision" would insert new rows, never re-point old ones.
- **Cross-tenant is impossible, declaratively.** Composite FKs
  `(blueprint_version_id, org_id) → blueprint_versions(id, org_id)` and
  `(snag_id, org_id) → snags(id, org_id)` (each needing the additive
  `unique(id, org_id)` candidate key) mean a pin **cannot** reference another
  org's version or snag — enforced by Postgres for **every** role incl.
  service_role, because RLS guards only the row written, never the row it points
  at (the `invoice_payments` doctrine).
- **Cross-job is rejected by a trigger** (a static FK can't express it — 4 of the
  linkable targets have a nullable `job_id`): a pin can't link a snag from a
  different job.
- **Anti-spoof.** `org_id`/`job_id` are derived from the parent version in a
  `SECURITY DEFINER` before-write trigger; client-sent tenancy is ignored.
- **Coordinates constrained** to `[0,1]`, `page_number ≥ 1`; **kind ↔ payload**
  consistency (a note needs text; a snag pin carries no free note).
- **No dangling rows.** Deleting the snag (or version/job/org) cascades the pin
  away. Creating a snag + its pin is one **atomic** `SECURITY INVOKER` RPC.

### RLS, audit, cost
- Members **place / move / read** pins; **hard delete is admin-only** (members
  re-place rather than delete). Tenant-isolated via `current_org_ids()`.
- Audited via `recordAdminActivity` (the working path — avoids the dead
  `job_documents` tenant-`_record_activity` gap) on **create / link / delete
  only** — never per-move (position drift is high-volume, low-signal).
- No realtime, no polling, no cron: bounded reads (one batched query per
  version+sheet, no N+1) and ordinary mutations. Storage cost is **zero** — pins
  are coordinates, not files.

### Viewer integration (no M2 rework)
The pins layer rides the existing `data-blueprint-overlay` (kept a single
element). A pin at `(u,v)` renders at `left:u*100% / top:v*100%` inside the page
box, so the M2 pan/zoom transform positions it for free — no per-pin math. A
click→`(u,v)` uses the live page-box rect (identical for PDF and image;
`normalizePoint` is NOT used — it is PDF-user-space, y-up, undefined for images).
An explicit `mode: 'view' | 'place'` + a tap-vs-drag threshold means placing a
pin never fights pan/zoom, and the seam is ready for a markup tool layer. 44px
touch targets, keyboard/`Esc`, focus-safe, status by icon+shape+colour (not
colour alone).

### Tests
- **Unit (22):** coordinate model (pointer→normalized, %-anchor, tap-vs-drag),
  0-based↔1-based page convention, status derivation (snag is authority),
  filtering, all input schemas.
- **Integration (9, real Postgres):** the invariants above.
- **Security (12):** source contracts locking the composite FKs, the derive
  trigger, RLS admin-delete, the SECURITY INVOKER RPC, and the service's
  tenant-client + `recordAdminActivity` + no-audit-on-move boundaries.
- **E2E:** the pin surface never leaks to a logged-out visitor; the authenticated
  place→snag journey is `test.fixme` pending the auth-E2E harness (not stubbed).

## Programme C — Blueprint Markup (shipped)

Redlines on a drawing: pick a tool (**freehand / line / arrow / rectangle /
ellipse / text**), a colour and a width, and draw directly on the sheet. A
sibling of pins — same immutable-revision anchor, same normalized `{page,u,v}`
model, same composite-FK tenant integrity — with a few deliberate divergences.

### Model — `blueprint_markup` (migration `20261017`)
- A shape = `(shape, geom {points:[{u,v}...]}, page_number, blueprint_version_id)`
  + style (`color`, `stroke_width`) + optional `text_content`.
- **Server-derived `bbox_*`** (the before-write trigger recomputes it from the
  points — a client-sent bbox is ignored, so it can never poison spatial queries).
- **Soft-delete lifecycle** (`status` active/removed + `deleted_at`): a **member**
  retracts their own redline via UPDATE; hard DELETE stays admin-only.
- No external entity link → one composite FK (the version anchor), no cross-job rule.

### DB-enforced integrity (real-Postgres tested — 8 invariants)
- **org_id/job_id + bbox derived server-side** in a `SECURITY DEFINER` before-write
  trigger; client tenancy/bbox ignored.
- **geom validated in the trigger**: point-count per shape (2 for line/arrow/rect/
  ellipse, 1 for text, ≥2 for freehand), every point in `[0,1]`, plus a declarative
  `1..2000`-point DoS cap.
- **Anchor (version/page) frozen after insert** — a redline never migrates revisions.
- **Attribution stamped from `auth.uid()`** (unspoofable) — net-new hardening beyond
  the pins sibling.
- Composite FK `(blueprint_version_id, org_id) → blueprint_versions(id, org_id)`
  (cross-tenant defence-in-depth + `ON DELETE CASCADE`); colour/stroke/text-payload/
  soft-delete-consistency CHECKs; RLS members select/insert/update, admin hard-delete.

### Geometry + rendering
- **`lib/blueprints/markup.ts`** is the pure core (20 unit tests): `bbox`, an
  **iterative** RDP `simplify` (no recursion overflow) + hard point cap,
  `quantize` (so client-preview and the DB-derived bbox agree bit-for-bit),
  arity/range validation, all reusing the pins/M2 `{u,v}` model.
- Rendered as an SVG `viewBox="0 0 1 1" preserveAspectRatio="none"` layer **beneath**
  the pins overlay — so a stored `(u,v)` is used verbatim as `x,y` (zero paint-time
  JS) and inherits the M2 pan/zoom transform for free. `vector-effect="non-scaling-
  stroke"` keeps line weight constant at every zoom. **Text renders as an HTML
  sibling** (React child — auto-escaped, no HTML/SVG injection) to dodge the
  non-uniform-viewBox skew.
- The viewer's `mode` is now `'view' | 'pin' | 'markup'` (pins untouched — `placeMode`
  is a derived alias). In markup mode a capture layer owns the pointer for drawing
  tools (stage pan early-returns, **wheel-zoom stays live**); **select** keeps pan +
  lets you tap a shape (pins win z-order ties natively) to Remove/Delete. The
  in-progress stroke is **one imperatively-mutated node via `requestAnimationFrame`**
  (one `getBoundingClientRect`/frame) so freehand never thrashes React; committed
  shapes are a memoized set filtered to the current sheet.

### Tests
- **Unit (20):** geometry (bbox, RDP + caps, quantise, arity/range, schemas).
- **Integration (8, real Postgres):** the invariants above.
- **Security (14):** source contracts on the trigger derivation, geom validation,
  anchor immutability, attribution stamping, RLS, and the service's tenant-client
  + `recordAdminActivity` + no-audit-on-reshape + quantise boundaries.
- **E2E:** markup never leaks to a logged-out visitor; the authenticated draw
  journey is `test.fixme` pending the auth-E2E harness (not stubbed).

### Deliberately deferred (additive, documented)
Post-hoc **geometry editing** (drag handles to reshape a committed shape) — the
draw → view → remove flow is complete; reshape is an additive follow. Also
per-author edit restriction (currently any member edits any redline, matching the
pins model).

## Deferred → Blueprint milestone D+ (forward-designed)

Built so these need **no** coordinate/DB redesign:
- **Programme D — Revision compare** (side-by-side + onion-skin): two RenderSurfaces
  in one dialog, each per-`versionId`; each surface shows only its own version's
  pins — free, because pins are version-scoped. Deterministic only (no pixel-diff/AI).
- Large-sheet **tiling** for very high-DPI drawings, an **offline** foundation
  (the pin model is already client-id/idempotency-compatible), and the hook where
  the Blueprint AI reads the register + pins.

## Authenticated E2E harness (cross-cutting)

The blueprint viewer/pins/markup authenticated journeys are no longer `test.fixme`
— they run as **real authenticated E2E** every CI pass. A Playwright `globalSetup`
(`e2e/global-setup.ts`) seeds a deterministic org/user/membership/job/blueprint +
a real 1-page PDF into the **local** Supabase (service-role, exactly as the
integration tier does), signs the user in, and mints a `storageState` whose
Supabase auth cookie is encoded by **`@supabase/ssr`'s own encoder** (correct
name/base64url/chunking) so the middleware accepts it. Specs opt in with
`test.use({ storageState: "e2e/.auth/owner.json" })`; the logged-out boundary
specs stay anonymous. **CI-safe:** Node-only, the service-role key is already in
the e2e job env, **no app/middleware/auth code changes, no production-reachable
login route**, and the state file is gitignored (holds a live JWT). This unblocks
authenticated E2E for the whole blueprint stack (and any future feature).

## Programme D — Revision Comparison (shipped)

Compare two revisions of a drawing to answer "what changed?" A **Compare
revisions** button (shown only when a drawing has ≥2 versions) opens a
full-screen, **view-only** comparison.

### Modes
- **Side-by-side** — Rev A left, Rev B right, each an independent render surface
  with its revision badge; the default on tablet/desktop.
- **Overlay / onion-skin** — both stacked, an **opacity slider** cross-fading B
  over A, plus **swap A/B**.
- **Difference** — the B layer gets CSS `mix-blend-mode:difference` (deterministic,
  same-origin, **no pixel read-back** → no extra memory, no taint) so identical
  areas composite to black and changes glow. Offered only when overlay is valid.

### Rendering — `DrawingRenderSurface`
A reusable render **core** (`_drawing-render-surface.tsx`) owns the fetch-once
byte flow + the **hardened pdf.js** path (`isEvalSupported:false`,
`enableXfa:false`, `disableAutoFetch:true`, worker, cancellable `RenderTask`,
DPR + max-side caps, destroy-on-unmount). Compare mounts **two**, driven by one
shared `fit/zoom/pan` when synced. It is a deliberate sibling of the M2 viewer's
inline core — Programme D does **not** refactor the green tri-feature viewer
(protecting the shipped M2/pins/markup); a later pass may consolidate the viewer
onto this surface (tracked debt). Dual-canvas **memory tiers**: `compare-sxs`
DPR≤1.5, `compare-overlay` DPR≤1 + 3072 px cap — compare's peak stays ≤ 1× the
single viewer.

### Selection, pairing, sync, dimensions
- Pickers default **current-vs-previous**; A==B is unselectable.
- **Page pairing** — same-index seed, per-side sheet stepping; the active pair
  (`A n/m · B n/m`) is always shown; a non-blocking notice flags count mismatch.
- **Sync** ("Link views") default on — one shared normalized `fit/zoom/pan`.
- **Overlay/difference gated to ≤1% aspect drift** (`overlayAllowed`): different
  sheet sizes ⇒ the modes disable with "Overlay unavailable — different
  dimensions. Showing side by side." **Never stretches** one drawing onto another.

### Annotations, state, security
- Version-scoped **A/B pin + markup toggles** (default off); each surface renders
  only its own `versionId`'s annotations (DB invariant — never merged), A/B badged.
- State in the **URL** (`?compare&a&b&mode&pageA&pageB&op&sync&fg&ann`) — **UUIDs
  only**, no signed URLs/paths/tokens; tampered pairs fall back to the safe default.
- **Zero migration, no new endpoint** — both revisions fetch the existing RLS-gated
  `/f/[versionId]` route, **each independently tenant-gated**; a cross-tenant B
  404s while A is unaffected. CSP + pdf.js hardening unchanged.

### Mobile / a11y
Phone (<768px) → single surface + **A|B toggle** (overlay-friendly); ≥44px
controls; `role="dialog"` + focus trap; `aria-live` "Comparing Rev A with Rev B";
real `<input type=range>` opacity; keyboard **S**ide/**O**verlay/**X** swap /
arrows page / `+`/`-`/`0` zoom / `Esc` (inert while a picker is focused).

### Tests
- **Unit (16):** revision-pair defaults, page pairing, aspect compatibility,
  opacity clamp, URL-state parse/serialize (tamper fallback), a11y summary.
- **Security (7):** no compare endpoint, hardened pdf.js unchanged, fetch-once,
  view-only (no mutation wired), URL carries no secrets.
- **E2E:** logged-out boundary + a **real authenticated journey** (open → both
  revisions paint side-by-side → overlay + opacity → swap → close) with a
  **zero-console-error** assertion — via the #409 harness, not fixme.

### Deferred (additive)
Manual A↔B page-pair persistence (kept transient — no speculative table); a
per-revision manual pan-nudge for content registration; consolidating the M2
viewer onto `DrawingRenderSurface`.

## Known limitations
- The register loads all revision rows for a job's drawings in one batched query
  (no N+1). A single job carrying >1000 total revisions would need pagination —
  a long-project edge, mitigated by pointing the register at current-only + lazy
  history in a later pass.
- Deleting a job cascades the DB rows; storage bytes are cleaned by the delete
  service (admin `remove`) — inherited from the job-documents pattern.
