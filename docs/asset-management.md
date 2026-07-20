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
| **3** | **QR platform** | `asset_qr_identities` (opaque token, one-active invariant, atomic rotate, revoke) + vector labels + authed scan resolver + in-app scanner | ✅ M3a #376 · scan #377 · labels #378 · scanner (this PR) |
| **4** | **Inspections** | immutable records + safety-blocking + templates + scheduling + **overrides/lineage/hardening/pre-use (this PR)**; UX/E2E completion next | ◑ M4a #380 · M4c #381 · M4b-1 #382 · M4b-2 #383 · **M4d — this PR**; M4 UX/E2E next |
| **5** | **Maintenance** | cases + DB-gated state machine + admin-only costs satellite **(M5a — this PR)**; schedules/generator (M5b) + RTS loop UX (M5c) next | ◑ **M5a — this PR** |
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

## Milestone 3b (labels) — shipped: printable QR labels

- **Supply-chain review (documented):** `qrcode@1.5.4` (MIT, maintained) installed
  + `@types/qrcode` (dev). Its subtree adds **no flagged advisories** (the repo's
  pre-existing Next.js/PrismJS audit findings are unrelated). Server-only; used at
  render time. No second QR/PDF library.
- **`lib/pdf/asset-label-pdf.tsx`** — reuses the **existing react-pdf** architecture
  (no new engine). The QR is **true vector**: `QRCode.create()` → each dark module
  a react-pdf `<Rect>` inside an `<Svg>` (crisp at any print size). Labels carry
  **only safe/public fields** (name, ref, category, optional serial/registration,
  QR, "Scan to view asset", org branding) — **never** price/value/supplier pricing/
  notes (the input type doesn't accept them).
- **`GET /api/assets/[id]/label/pdf?copies=N`** — RLS-authed; resolves the asset's
  **active** QR token → encodes the absolute `/a/[token]` scan URL (so a phone
  camera opens the authenticated route); single label or an N-up print sheet;
  `safeLabelFilename`, private cache; 404 (no leak) if not the caller's / no active
  identity. **Print label** + **Print sheet** on the asset QR card.
- **PDF test** (`label-pdf.test.ts`, 4 cases): renders a real `%PDF-` buffer for a
  single label + a 12-up sheet + a bare label; asserts the input exposes no
  financial fields.

## Milestone 3b (scanner) — shipped: in-app camera scanner entry + QR E2E

The last M3b slice — **completes the QR platform**. No new resolver, no new
dependency.

- **`/assets/scan`** (`app/(app)/assets/scan/page.tsx` + `_scanner.tsx`) — a thin
  authed server shell rendering a client scanner. **Camera path** uses the native
  `BarcodeDetector` where the browser exposes it (Chrome/Android); everywhere else
  (notably iOS Safari) it **degrades gracefully** to the always-present **manual
  code entry** (paste the label URL or type the code under the QR). The camera is
  released on stop/unmount. A **Scan** action sits on the assets list header.
- **`tokenFromScan`** (`lib/assets/qr.ts`, pure + unit-tested) is the security
  gate: it accepts a full label URL, a bare `/a/<token>` path, or the raw token,
  and returns a valid token or `null`. **The scanned host is deliberately ignored**
  — only the token is extracted and we navigate **internally** via `scanPath`, so a
  spoofed QR (`https://evil.example/a/<token>`) can never become an open redirect,
  and a non-`/a/` payload resolves to nothing. The token is still resolved behind
  auth + RLS by the existing `/a/[token]` route.
- **QR E2E** (`e2e/asset-qr.spec.ts`, real app + real Postgres): proves the
  request-boundary property that is the whole point of a scannable label — **a
  logged-out scan of `/a/<token>` and a logged-out visit to `/assets/scan` both hit
  the auth wall** (307 → `/login`, destination preserved) and **never paint** asset
  or custody data. A well-formed-but-fake token redirects identically to junk (no
  oracle). This matches the tier's deterministic anonymous-visitor pattern.

### QR lifecycle coverage — where each invariant is proven
The full **create → generate → label → scan → custody → regenerate** lifecycle is
proven **deterministically at the integration tier against real Postgres**, where
those data invariants belong: `asset-qr.test.ts` (one-active, atomic rotate,
resolve/deny), `asset-qr-scan.test.ts` (per-tenant + per-state resolution),
`label-pdf.test.ts` (label + sheet render). An **authenticated browser lifecycle
E2E** would need a logged-in session; this app is passwordless (magic-link/OTP) and
the E2E tier has **no auth harness yet**. That harness is a discrete,
independently-reviewed infrastructure increment (it becomes the first authenticated
spec and every later feature E2E depends on it) — **not** folded silently into a
feature PR. Tracked as the next E2E-infra task.

## Milestone 4a — shipped: inspections (immutable records + pass/fail outcome)

A durable, tamper-evident record of every inspection on an asset — pre-use, LOLER,
PUWER, PAT, servicing — with a pass/fail **outcome** that becomes the safety
signal M4c reads through the M2 custody eligibility seam. **Reuses the Site
Reports immutable-snapshot pattern exactly — no new framework.**

- **`asset_inspections`** (`20260927000000`): `content` (mutable working answers)
  vs `snapshot` (frozen at issue, **write-once**); `status`
  (draft/issued/superseded/archived); `outcome` (pass/pass_with_defects/fail);
  `safety_critical`; re-inspection lineage (`revision`/`supersedes_id`). Indexes
  incl. a partial one for the M4c safety lookup (current issued safety-critical
  fails). Evidence photos ride `tenant_attachments` (CHECK widened, all 13 prior
  targets preserved) — no new store.
- **Immutability + issue-integrity trigger** (`tg_asset_inspections_immutable`):
  snapshot is write-once; an **issued** inspection **must** carry an outcome + a
  snapshot; and `content`/`outcome`/`safety_critical` are **frozen** once issued
  (the safety record can't be quietly re-scored). A same-org guard
  (`tg_asset_inspections_guard`) rejects a cross-tenant `asset_id`. RLS: member
  CRUD, admin delete.
- **Pure domain** (`lib/assets/inspection.ts`, 12 unit cases): the state machine
  (`assertTransition`), outcome/kind constants + labels, `materializeInspection
  Snapshot` (pure, caller-passed `issuedAt`), and **`isSafetyBlocking`** — the
  predicate the M4c DB guard will mirror, unit-tested so the two can't drift.
- **Actions** (`inspection-actions.ts`): create draft; **issue** (state-machine
  check → materialise snapshot → status+outcome+snapshot+content in **one atomic
  update**; the trigger is the hard gate); discard-draft. All tenant-scoped +
  audited.
- **UX**: an Inspections section on the asset detail — list (status/outcome/
  safety badges), a **blocking banner** on a current safety-critical fail, a
  record-inspection form, and per-draft issue/discard.
- **Security proof** (`__tests__/integration/rls/asset-inspections.test.ts`, real
  Postgres, 8 cases): the legit issue; issued-requires-outcome **and**
  -snapshot; snapshot write-once + content/outcome/safety_critical frozen;
  same-org guard; status/outcome CHECKs; anon + non-member denial; attachment
  CHECK (asset_inspections + prior 'assets' + bogus rejected).

## Milestone 4c — shipped: safety-blocking custody

Closes the loop between inspections and custody, **at the database**.

- **`20260928000000_asset_inspection_safety_block.sql`** — **extends** the M2
  custody guard (`tg_asset_assignments_guard`, CREATE OR REPLACE, every prior
  check reproduced verbatim) so a **new open assignment is refused** while the
  asset has an **issued safety-critical `fail`** that a **later issued
  safety-critical pass has not cleared** (`inspected_at >`). Because the guard
  fires `before insert or update` and the transfer RPC is SECURITY INVOKER, this
  applies to **check-out AND transfer-in** with no action-layer change — the
  frontend can't bypass it. **Reinspection / return-to-service falls out for
  free**: issue a passing safety-critical inspection and the asset is issuable
  again (no separate state to flip). Partial index keeps the lookup cheap.
- **Friendly error** (`lib/assets/assignment.ts`, `friendlyAssignmentError`): the
  new `check_violation` is surfaced as "record a passing re-inspection before
  issuing it" (unit-tested); the M4a asset-detail banner already flags the block.
- **Security proof** (`__tests__/integration/rls/asset-inspection-safety.test.ts`,
  real Postgres, 5 cases): an issued safety-critical fail **blocks** check-out; a
  **later pass clears** it; a **non-safety-critical** fail and a **draft** fail do
  **not** block; **transfer-in is blocked** too (RPC rolls back, the original open
  assignment survives).

**Permissioned override** is a deliberate follow-up — a safety block should not be
trivially overridable, so it needs an explicit authorised-override path (role +
recorded reason), not a quiet flag.

## Milestone 4b (part 1) — shipped: versioned inspection templates

Reusable, versioned checklists seed inspections — grounded in a UK-construction
domain review (PUWER pre-use checks, WAH-Regs 7-day scaffold inspections,
INDG367 harness checks, LOLER boundaries). **Not a generic form builder**: a
bounded jsonb definition (sections → typed items), app-validated, DB-frozen.

- **`asset_inspection_templates`** (`20260929000000`): one row per version;
  `family_id` groups versions; **(family, version) unique**; **at most ONE
  PUBLISHED version per family** (partial unique index); `check_level`
  (pre_use_check / recorded_inspection / thorough_examination — the
  compliance-honesty boundary: CrewFlow is the record for the first two and
  stores the external examiner's report for the third, never synthesising a
  certificate); `categories` applicability; supersedes lineage; RLS (member
  CRUD, admin delete).
- **DB-frozen substance** (`tg_asset_inspection_templates_immutable`): once a
  version leaves draft its definition/name/categories can never change — a
  checklist someone inspected against can't be silently rewritten. Publishing an
  empty definition is refused at the DB. **Atomic publish**
  (`publish_inspection_template` RPC, SECURITY INVOKER): supersede-old +
  publish-new in one transaction.
- **Item model** (pure, `lib/assets/inspection-template.ts`, 17 unit cases):
  response types pass_fail · yes_no · text · number · meter_reading · choice ·
  date · acknowledgement; per-type fail rules (`fail_on`, `failing_choices`,
  min/max range); `safety_critical` (block-use), `severity` minor/major,
  `allow_na` ("not applicable" counts as answered, never fails); evidence flags
  (photo-always vs photo-on-fail, comment-on-fail, signature). State machine
  draft → published → superseded → archived; only published versions start
  inspections.
- **Outcome derivation** (`deriveOutcome`, the safety bridge to M4c): a failed
  safety-critical item → `fail` + `safety_critical=true` (the custody block
  engages unchanged); only non-critical failures → `pass_with_defects` (defect
  ≠ unsafe); else `pass`. Required-unanswered blocks issue (validation), never
  auto-fails; mandatory fail-comments enforced.
- **Inspections keep the exact version they used**: `template_id` /
  `template_version` / **`template_snapshot`** on `asset_inspections`,
  **write-once at the DB from the moment of start** (separate
  `tg_asset_inspections_template_guard`; the proven M4a immutability function
  is untouched). An in-progress inspection keeps its checklist through later
  publishes; deleting a template never destroys evidence (`on delete set null`
  — the snapshot carries the full definition).
- **UX**: template library (`/assets/templates`, one row per family, search +
  status filters) · create + draft editor (sections, typed items, fail rules,
  evidence flags, move/remove, publish with validation problems listed, clear
  locked-version messaging) · version history · clone / next-version /
  archive · **Start from template** on the asset detail · a **run page**
  (`/assets/[id]/inspections/[id]`) with glove-friendly tap targets, per-item
  comments, **Save progress** (interrupted-draft recovery) and **Complete**
  (derives the outcome and locks the record) · compliance-safe wording
  throughout ("record of…", never "certified safe") · evidence photos via the
  existing attachments pipeline on the inspection.
- **TS attachment allowlist aligned with the DB CHECK** (added
  `asset_assignments` + `asset_inspections`, which the DB has accepted since
  20260925/20260927 — the app-side list had lagged).
- **Security proof** (`asset-inspection-templates.test.ts`, real Postgres, 11
  cases): version uniqueness; one-published-per-family; published frozen vs
  draft editable; empty-publish refused; atomic RPC supersede+publish; RPC
  refuses non-draft; inspection linkage write-once; cross-org template + 
  supersedes refs rejected; **new version never alters an existing inspection's
  snapshot**; anon denied.

**Known limitations (M4b-1):** per-item photo/signature *capture* lands with the
M4 UX slice (flags are authored + frozen now; photos attach at inspection
level); draft answers are plain-text in `content` until issue (as site reports);
publish is member-level pending the M4d capability model; template pickers list
all published templates (category filtering is soft guidance).

## Milestone 4b (part 2) — shipped: schedules + idempotent due-work generation

Standing rules that generate due inspections — "pre-use check daily", "PAT
quarterly", "7-day scaffold inspection". **The due record IS a draft
inspection** carrying the frozen snapshot of the template family's **current
published version** — no parallel "due" store; the existing run page executes
it.

- **`asset_inspection_schedules`** (`20260930000000`): template-family
  reference (generation resolves the live published version each cycle);
  cadence = exactly-one of `interval_days`/`interval_months`, **both null =
  one-off** (generates once, then deactivates); `next_due`, `lead_time_days`,
  `active`, and **`required_for_assignment`** (the pre-use seam — captured +
  surfaced now, **enforced at the custody guard in M4d** so the guard changes
  exactly once). Same-org guard; **admin-only writes** at RLS (standing rules
  generate work automatically; `ai_receptionist_setups` precedent), member
  read.
- **THE IDEMPOTENCY INVARIANT**: `(schedule_id, cycle_key)` **total** unique
  index on `asset_inspections` (`cycle_key` = the cycle's due date; total not
  partial — PostgREST's ON CONFLICT arbiter can't use a partial index; manual
  inspections carry `(null,null)` and never collide). The generator's
  `INSERT … ON CONFLICT DO NOTHING` **is the claim** (automation_runs 20260912
  doctrine); advancement is a **count-gated CAS** on `next_due` run on win AND
  conflict-loss (unstick), one cycle per run (bounded catch-up). Cron timing is
  never load-bearing. **Deliberately no pair CHECK** tying schedule_id to
  cycle_key — schedule deletion is `on delete set null` on schedule_id only,
  which a pair CHECK would turn into an un-deletable schedule.
- **Generator** (`server/services/asset-inspection-generator.ts`, service
  client — cron norm): bounded batch (50) of active schedules in their lead
  window; resolves the family's published version (an unpublished/archived
  family generates nothing **and does not advance** — resumes, truthfully
  overdue, on republish); builds the frozen snapshot; claims; advances.
- **Cron**: `GET /api/cron/inspections-due` (Bearer `CRON_SECRET`,
  `withCronTelemetry`, `maxDuration 60`) — registered in `vercel.json` daily
  at 05:00 (18th cron).
- **Pure domain** (`lib/assets/inspection-schedule.ts`, 10 unit cases):
  date-only arithmetic (month-end clamping, leap years), cadence presets incl.
  **6-weekly** (O-licence PMI) and 3-/6-monthly (PAT convention / LOLER
  accessory cycles), `cycleKey`, generation-window + overdue predicates,
  schedule schema.
- **UX**: a Schedules section on the asset detail (cadence, next-due with
  overdue highlight, paused badge, "Required before issue" badge, admin
  add/pause/resume/remove) · **Due / Overdue badges** on draft inspections ·
  completing a generated inspection writes `last_completed_at` back to its
  schedule (informational — advancement is fixed-cadence at generation).
- **Security proof** (`asset-inspection-generator.test.ts`, real Postgres, 7
  cases **running the real generator service**): exactly-one correctly-shaped
  due inspection + idempotent re-run + exactly-one advance; **concurrent runs
  → one row, one advance**; paused generates nothing; unpublished family
  generates nothing and does not advance; one-off deactivates after one;
  cross-org schedule/asset/template + provenance refs rejected; anon denied.

**Known limitations (M4b-2):** `required_for_assignment` is not yet enforced
(M4d, with the override path — a hard gate without an override path would strand
assets); notification events (due-soon/overdue) land with the M4 UX slice via
`emitNotifications` (the notifications table has no DB dedup, so emission keys
off the generator's claim win); org-wide due/overdue dashboards land with the M4
UX slice (the per-asset views ship now).

## Milestone 4d — shipped: permissioned overrides, reinspection lineage, hardening, pre-use enforcement

**One custody-guard replacement carries every M4d arm** (the guard is the
highest-risk shared object; it changed once). `20261001000000`:

- **Overrides** (`asset_inspection_overrides`): an admin can record a formal,
  audited operational override that bypasses **exactly one** blocking fail —
  mandatory ≥10-char reason (DB CHECK), optional expiry that **re-blocks purely
  by time predicate** (no cron, no state flip), **write-once revocation**, and a
  record that is **immutable except revocation** (no quiet extension — extend =
  revoke + re-issue, two audit events). **One LIVE override per fail** (partial
  unique index — concurrent creates get exactly one winner). Targets are
  validated at the DB (same-org, same-asset, issued safety-critical fail). An
  override **never alters the inspection it bypasses**, and the UI wording is
  honest: *"operational override recorded"* — never "cleared", never "certified
  safe". RLS: **member SELECT is load-bearing** (the SECURITY INVOKER custody
  guard runs under the issuing member's RLS — if members couldn't read
  overrides, the bypass would never engage; it's also the abuse deterrent);
  create/revoke admin-only at RLS **and** in the action.
- **Explicit reinspection lineage**: `reinspection_of` on `asset_inspections`
  links a clearing pass to the exact fail it clears — timestamp-independent (a
  legitimately **backdated** pass still clears *its* fail, which the M4c
  timestamp fallback could not), scoped to exactly one fail, same-org/same-asset/
  non-draft guarded, **frozen after issue**. The M4c later-pass rule remains as
  the documented fallback — existing behaviour and its suites stay green.
- **THE shared clearing predicate** (`asset_inspection_fail_is_cleared`,
  SECURITY INVOKER, stable): linked-pass | later-pass | active-override — used
  by the custody guard now and by M5's return-to-service gate later, so the two
  can never drift. The guard's raise message is **byte-identical** to M4c.
- **A4.9 hardening** (found by the M4d threat model): previously a member could
  UPDATE a blocking fail to `superseded`, silently escaping the guard's
  `status='issued'` universe. Now a safety-critical fail can leave `issued`
  **only when an issued successor exists** (a revision or linked
  re-inspection).
- **Pre-use enforcement** (the M4b-2 `required_for_assignment` seam): a due,
  uncompleted draft inspection generated by an **active required** schedule
  blocks issue — *"complete the required pre-use check before issuing"*. Pure
  row-state predicate (no clock windows): completing the check unblocks;
  pausing the schedule / unticking the flag (admin) is the escape valve.
- **UX**: a **Safety blocks** panel on the asset detail — one row per current
  blocking fail with its honest override state, **Record re-inspection** (all
  members; templated fails re-run the family's live published version, ad-hoc
  fails get a safety-critical ad-hoc draft), and the admin override/revoke
  forms. The inspections banner is now lineage+override-aware
  (`currentSafetyBlocks`, the unit-tested UI mirror of the DB predicate).
- **Security proof** (`asset-inspection-overrides.test.ts`, real Postgres, 13
  cases): active-override bypass with subject untouched; deterministic expiry;
  revocation + no-un-revoke; one-live concurrency; wrong-target rejections
  (passed/non-critical/draft/cross-org/cross-asset); per-fail scoping +
  immutability; **backdated linked pass clears (arm 2 would not)**; lineage
  guards + freeze; **A4.9 retire-without-successor refused**; transfer honours
  overrides + rolls back after revoke; pre-use blocks then unblocks on
  completion; paused/non-required escape valves; anon denied. The M2/M4c
  custody suites regression-prove the guard replacement in the same run.

## Milestone 4 (UX/E2E) — shipped: the completion slice

- **Org-wide attention** (`/assets/inspections`, linked from the assets
  header): what's overdue, what's due, and **which assets are blocked and
  why** — with the honest override state — computed by the same unit-tested
  mirror of the DB clearing predicate the asset detail uses. Bounded reads on
  the partial indexes.
- **Notifications** (existing `emitNotifications` bus, in-app first): an
  `inspection.due` note per **won generator claim** (the claim IS the dedup —
  the notifications table has none, so retried/concurrent runs emit nothing)
  and an urgent `inspection.failed_safety` note exactly-once on the
  count-gated issue transition.
- **Evidence capture on the run page**: typed-name **signature attestation**
  per `requires_signature` item (server-validated at completion via
  `missingSignatures`; frozen into `content.signatures` and the issued
  snapshot; drawn signatures are a later enhancement), photo-requirement
  badges per item (binding photos to items is still inspection-level via the
  attachments panel — documented limitation).
- **Dedicated M4 boundary E2E** (`e2e/asset-inspections.spec.ts`, real app +
  real Postgres, 4 specs): the template library/editor, the org-wide overview
  and an inspection run URL all hit the auth wall and never paint. The full
  lifecycle stays proven at the integration tier (11 + 7 + 13 real-Postgres
  cases); the authenticated browser lifecycle E2E awaits the passwordless
  login harness (its own tracked infra increment).

**M4 status: COMPLETE** under the honest scope above. Remaining M4-adjacent
work rides later slices: per-item photo binding + drawn signatures (with the
auth-harness E2E), org-wide notification preferences.

## Milestone 5a — shipped: maintenance cases, state machine, costs privacy

One shared repair flow for every entry point (breakdown, failed inspection,
planned work). `20261002000000`:

- **`asset_maintenance_cases`**: type (breakdown/corrective/preventive/service/
  calibration/warranty), priority (snags precedent), the 10-state machine,
  provenance FKs (source inspection/assignment, supplier, assignee),
  `out_of_service` + downtime stamps, `reinspection_required`, lifecycle stamps.
  A case born from a failed inspection is reinspection-required by construction.
- **DB-hard gates**: G1 completed-requires-work-evidence · **G2
  return-to-service refused while the LINKED safety fail is uncleared — via the
  SHARED `asset_inspection_fail_is_cleared` predicate (same three arms as the
  custody guard: linked pass | later pass | active override), so the two sites
  can never drift** · G3 cancel-requires-reason · G4 completed-is-frozen (even
  service role) · G0 same-org refs. App owns transition LEGALITY
  (`lib/assets/maintenance.ts`, documented matrix + ctx edges: a
  reinspection-required case can never skip its gate; `cancelled → reported` is
  the only resurrection).
- **Costs privacy at the DB**: `asset_maintenance_case_costs` satellite with
  **admin-only RLS on all four verbs** (row-level security can't hide columns —
  the P4 split-by-table discipline); dual-gated in the action; editable after
  completion (invoices arrive late) — which is also why costs live off the
  frozen case.
- **B3 decision (documented)**: `out_of_service` is a member-visible operational
  flag + banner — NOT a custody-guard block (moving a broken asset to the
  fitter IS an open `sent_for_repair` assignment; a dangerous asset is recorded
  as a failed safety inspection, engaging the full M4 machinery). The custody
  guard is untouched by M5a.
- **UX**: a Maintenance section on the asset detail — open/closed cases, legal
  next-step select from the unit-tested matrix, out-of-service banner, report
  form, admin costs drawer. In-app `maintenance.reported` notification.
- **Proof**: unit 10 (matrix incl. ctx edges, downtime, schemas, errors) +
  real-Postgres 8 (G1/G3/G4 incl. service-role freeze; **G2 blocked → cleared
  by LINKED pass AND by ACTIVE override**; cross-org matrix incl. the costs
  smuggle; anon denial on cases AND costs; attachment CHECK 15 targets + prior
  + bogus).

**M5 remainder:** M5b service schedules + idempotent generator (clone of the
proven M4b-2 claim model; the design's pair-CHECK bug fixed the same way) and
M5c the full repair → re-inspection → return-to-service loop UX + E2E.

## Reused (never duplicated)
`tenant_attachments` + storage RLS · `suppliers` · `recordAdminActivity` audit ·
`current_org_ids`/`is_org_admin`/`tg_set_updated_at` · `EmptyState` /
`Skeleton*` · the count-gated-mutation + admin-delete conventions.

## Known limitations (Milestone 1)
Full-field edit is via status controls only (a dedicated edit form is a fast
follow); import/export + bulk actions are Milestone 1b; assignment, QR,
inspections and maintenance are their own milestones above.
