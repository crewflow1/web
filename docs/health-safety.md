# Health & Safety — RAMS (Milestone 1)

Every UK construction task legally needs a **risk assessment** and a **safe method
of work** before it starts (CDM 2015). A "RAMS" is the document the site team writes:
the activity, the hazards, how likely and how severe each is, the control measures
that bring the risk down, and the step-by-step safe method. Once **issued** it is a
legal record — it must be immutable, and any change means a new revision.

Milestone 1 delivers the **RAMS record + its hazards** as a first-class, DB-enforced,
tenant-isolated vertical. Permits-to-work and operative sign-off follow in later
milestones. **Deterministic — no external service, no credential, no AI, $0 idle cost.**

## Why this vertical
The reconciliation of the master roadmap found the platform's remaining unbuilt scope
is dominated by capabilities blocked on external credentials (AI generation, comms
activation, telephony, payments) or founder product decisions (autonomy, CIS). Health &
Safety is the clean exception: construction-critical, immediately usable, provable end
to end, non-duplicative (compliance-document expiry tracking is a different thing), and
buildable with the database alone. It reuses the platform's existing spine — jobs,
staff/memberships, RLS, audit, PDF (later milestone), portal (later) — rather than
forking anything.

## Data model (`20261018000000_health_safety_rams.sql`)
Two tenant tables, every convention mirroring the existing ones (snags `20260919`,
purchase_orders `20261006`, the hq_* immutability triggers):

- **`risk_assessments`** — the RAMS header: `title`, `activity`, `location`, optional
  `job_id`, `assessor_id`, `assessment_date`, `review_date`, `ppe text[]`,
  `method_statement`, `status`, `reference` (RA-NNNN), issue stamps, `supersedes_id`.
- **`risk_assessment_hazards`** — the assessed hazards (the heart of the document):
  `hazard`, `who_at_risk`, `likelihood`/`severity` (1–5) with a **generated**
  `risk_rating = likelihood × severity`, `control_measures`, and an optional residual
  `residual_likelihood`/`residual_severity` with a generated `residual_rating`.

## Invariants — enforced in Postgres, not the app
Proven against real Postgres in `__tests__/integration/health-safety` +
`__tests__/integration/rls/health-safety-isolation`:

- **Tenant isolation (RLS).** Both tables are RLS-on; every policy is scoped to
  `org_id in (select current_org_ids())`; the header's hard delete is `is_org_admin()`
  only. An anonymous client and an authenticated **non-member** both read zero rows and
  cannot write.
- **Composite-FK tenant integrity.** A hazard references its parent by `(id, org_id)`
  (blueprint_pins doctrine), and its `org_id` is **derived from the parent by a
  trigger** — a client that supplies a foreign `org_id` has it overwritten, so a hazard
  can never be anchored into another tenant.
- **Same-org job link.** The optional `job_id` is validated same-org by a trigger
  (a set-null composite FK would null `org_id`, so a trigger is the correct tool for a
  nullable tenant link).
- **Immutability-on-issue.** A `draft` is freely editable. On **issue** it is frozen: a
  trigger refuses any content change and permits only the forward lifecycle
  `issued → superseded | withdrawn`; hazards of an issued RA can be neither added,
  edited, nor deleted. Two CHECK constraints make the lifecycle airtight — a reference
  exists **iff** the record has left draft, and a non-draft record must carry its issue
  stamp — so a draft can never skip straight to a terminal state.
- **Per-org numbering.** `next_ra_number(org)` allocates `RA-0001, RA-0002, …` on issue;
  a `unique (org_id, reference)` backstops the read-max-then-increment race so a
  collision fails loudly instead of duplicating.
- **Search-path-pinned SECURITY DEFINER.** Every definer function pins
  `search_path = public` (no mutable-path escalation).

## The 5×5 risk matrix (`lib/health-safety/rams.ts`)
Pure, deterministic, unit-tested — the same rules the DB enforces, expressed once for
the UI, the actions and the tests. `riskRating = L×S`; `riskBand` follows the HSE
construction convention (1–4 low · 5–9 medium · 10–15 high · 16–25 critical);
`canTransition` mirrors the DB lifecycle; `canIssue` gates issue on a complete document
(title, activity, a named assessor, ≥1 hazard); `overallRiskBand` surfaces the worst
residual risk across a RAMS. Risk is always conveyed in **text**, never colour alone.

## Server actions (`app/(app)/health-safety/actions.ts`)
Create / edit / add-hazard / delete-hazard / **issue** / supersede / withdraw. Every
write runs on the **tenant (user-JWT) client** so RLS scopes it — the service-role
client is never used here. Mutations are `requireOrgContext`-gated, `org_id`-filtered,
and **count-checked** (an RLS/immutability no-op returns count 0 and surfaces
"not found / not editable", never a false success). Issue re-checks `canIssue`, then
allocates the reference and stamps the record; the issuance is audited via
`recordAdminActivity`.

## UI
`/health-safety` (register), `/health-safety/new` (create), `/health-safety/[id]`
(detail: header, the hazards table with per-hazard risk bands and the overall band, the
edit + add-hazard forms and the Issue button while draft; a frozen read-only view with
Supersede/Withdraw once issued). Responsive, ≥44px targets, `aria-live` errors, meaning
carried in text.

## Testing
- **Unit (16, `__tests__/health-safety/rams.test.ts`):** the matrix + bands at every
  boundary, the lifecycle transitions, hazard/header validation, issue-readiness, worst-band.
- **Integration — DB invariants (5) + RLS isolation (6), real Postgres:** generated
  ratings, hazard org-derivation (spoof overwritten), cross-org job rejection, the
  immutability-on-issue freeze + lifecycle CHECKs, and tenant isolation for RA + hazards
  incl. a non-member write refusal.
- **Security source-contracts (10, `__tests__/security/health-safety.test.ts`):** RLS
  enabled, membership-scoped policies, composite-FK integrity, org-derive + job-org
  triggers, immutability + lifecycle CHECKs, definer search_path pinning, and that the
  actions are tenant-client-only + count-gated.
- **Authenticated E2E (`e2e/health-safety.spec.ts`):** logged-out boundary + a real
  authenticated journey (create → add hazard → issue → the record is frozen), via the
  seeded `storageState` harness (`e2e/global-setup.ts`).

## Milestone 2 — Permits-to-Work (`20261019_health_safety_permits.sql`)

High-risk tasks (hot works, working at height, confined space, excavation,
electrical isolation/LOTO, roof work, temporary works, lifting, demolition,
asbestos, general) need a **permit**: a controlled, time-bound authorisation that
the work is safe to start *now*. A permit is an operational record referencing the
relevant RAMS, **not** legal advice.

- **`permits_to_work`** — header (`permit_type`, `title`, `scope`, `location`,
  optional `job_id` + `risk_assessment_id`, `responsible_person`, `isolation_details`,
  `emergency_arrangements`, a `valid_from`/`valid_until` window, `status`, `PTW-NNNN`,
  closeout + lifecycle stamps).
- **`permit_conditions`** — the control checks that gate issue (fire watch, isolation
  confirmed, gas test, edge protection, rescue plan…): `label`, `required`, `confirmed` + who/when.

**Lifecycle (DB state machine):** `draft → issued → active → (suspended ⇄ active) →
closed`; cancel from any live state; terminal states. **Expiry is DERIVED at read**
(`valid_until < now`) — no stored expiry, **no cron, $0**.

**Invariants — enforced in Postgres, proven on real Postgres (14 integration):** RLS
tenant isolation; a permit can't bind another org's job/RAMS, nor a job-scoped permit a
different job's RAMS; condition `org_id` trigger-derived (anti-spoof) + composite-FK.
**Issue gate** — only a draft with a full window, every required condition confirmed,
and (if linked) an **issued** RAMS. **Immutability (evidence-grade)** — issued
contractual/safety fields + provenance frozen (the check runs whenever the permit has
left draft, so an edit can't ride in on a transition); a **direct INSERT can't mint a
born-issued permit**; a confirmed control can't be un-confirmed / its who-when rewritten;
conditions can't be deleted or reparented off a live permit. **Numbering** `PTW-NNNN`
gates the caller to their own org (no cross-org count leak).

These were shaped by an **adversarial DB review** that found + closed two issue-gate /
immutability bypasses and a condition-tamper cluster before ship; each fix has a named
regression test (`[P0-1]…[P2-7]`). `lib/health-safety/permits.ts` mirrors the rules
(11 unit); actions are tenant-client-only + count-checked (10 security, 4 RLS). UI at
`/health-safety/permits`.

## Milestone 3 — Operative Sign-off / Acknowledgement (`20261020_health_safety_acknowledgements.sql`)

A worker confirms *"I have read and understood this RAMS / permit"* — evidence that
answers **who, which issued version, when**, and is immutable. **One generic
subject-based table** (`safety_acknowledgements`, subject_type ∈ {risk_assessment,
permit_to_work}, extensible to toolbox) serves every H&S document — not one signature
table per type.

**Signature model (deliberate):** authenticated user + immutable server-pinned
timestamp + version anchor + a **typed-name attestation**. No drawn-signature image —
an authenticated identity bound to a specific issued snapshot is stronger,
privacy-lighter structured evidence than an unauthenticated scribble. **No IP, device
or geolocation is collected.**

**Version-anchored (§17):** the acknowledgement binds to the subject's issued reference
(`RA-NNNN` / `PTW-NNNN`) at sign time; superseding/revising the document leaves this
record historical and requires a fresh acknowledgement of the new version. **Append-only.**

**Invariants — enforced in Postgres, proven on real Postgres (9 integration + 4 RLS):**
- **Sign as yourself only** — RLS `user_id = auth.uid()` + a trigger session-bind; a
  worker (or a service key) can't record a signature on another operative's behalf.
- **Live document only** — a RAMS must be `issued`; a permit must be `issued`/`active`
  **and inside its validity window** (no signing an expired permit).
- **Version anchor** — the signed version must equal the subject's current issued reference.
- **Membership** — the signer must be a current member of the subject's org; `org_id` is
  trigger-derived from the subject (anti cross-tenant); membership is checked **before**
  any status/reference is revealed (no cross-tenant probe via error text).
- **Tamper-proof evidence** — the signing timestamp is **pinned server-side** (no
  backdating); the row is **append-only** (no UPDATE, even for the service role) and
  **non-erasable** (no DELETE policy — not even an org admin can destroy it; GDPR erasure
  is a future controlled, audited `signed_name` redaction, never a hard delete).
- **No duplicates** — unique per (org, subject, version, operative).

These were shaped by an **adversarial DB review** that found + closed a backdating hole,
an evidence-erasing admin-delete, a service-key impersonation path and an expired-permit
sign gap before ship; each fix has a regression test.

**UI:** a shared `SignoffPanel` on the issued RAMS + issued/active permit detail — the
sign-off register (who signed, their attestation, when) and, if the current worker hasn't
signed this version, an explicit non-dark-pattern acknowledge form (the statement + a
typed-name field). Mobile-first, ≥44px, `aria-live`. `lib/health-safety/acknowledgements.ts`
owns the wording + progress (5 unit); the action is tenant-client-only, signs as the auth
user (5 security source-contracts). Toolbox-talks attendance can adopt the same model later
(the subject_type is extensible) — not refactored here.

**Work-blocking gate (§21) — founder decision surfaced, not invented:** M3 makes
outstanding acknowledgements **visible** (the "N of M signed" register) — a **WARN**
posture. Whether to **HARD-BLOCK** a worker from being assigned / clocking into
high-risk work until the required RAMS/permit is acknowledged is an operational **policy
decision** (it touches assignment/clock-in) that needs your call before it's built.

## Milestone 4 — Evidence-grade PDF

RAMS and permits produce **evidence-grade PDFs** — the artefact a firm hands to the HSE,
a principal contractor, or its own records. Built on the **existing** `@react-pdf`
architecture (`lib/pdf/*`, `renderToBuffer`) — no new engine.

- **`lib/pdf/rams-pdf.tsx`** — header (company, `RA-NNNN`, status), activity, meta
  (location, assessor, dates, PPE), the **hazards & controls table** (initial `L×S`
  rating + band, controls, residual band), the method statement, and the **operative
  sign-off register**. Footer: generated-at + "not a substitute for a competent H&S
  professional".
- **`lib/pdf/permit-pdf.tsx`** — header (`PTW-NNNN`, type, status), scope, validity
  window, RAMS reference, the **control-conditions checklist** (✓/✗ + confirmed-at),
  isolation/emergency detail, sign-off register, and close-out. Footer: "operational
  record — not legal advice".
- **Routes** `GET /api/health-safety/[id]/pdf` and `/api/health-safety/permits/[id]/pdf`
  — `requireOrgContext` + tenant (RLS) client (never service-role); a **draft returns
  409** (no evidence to produce); `Cache-Control: private, no-store`. Wired as a
  "⤓ Download PDF" control on the issued document's sign-off panel.

**Document-delivery decision (§24, made deliberately):** RAMS and permits are **INTERNAL
/ principal-contractor** evidence, **not end-customer (homeowner) documents**. CrewFlow's
portal serves the homeowner, who neither needs nor should see RAMS/permits, so these are
**not** auto-exposed to the customer portal (§24: *"do not automatically expose internal
H&S documents to customers"*). A dedicated **principal-contractor sharing** surface (with
an explicit publish + customer-safe snapshot) is a **product decision surfaced for the
founder**, not built here. The PDF input types already carry **H&S content only** (no
cost/margin/price fields — asserted in tests), so a customer-safe snapshot is trivial if
that surface is later approved.

**Tests:** 6 PDF unit (well-formed `%PDF-` buffers for RAMS + permit incl. empty/closed
states; the input carries no cost/margin field) · 4 PDF security source-contracts
(auth-gated, tenant-client, issued-only, private-cache, no-cost-leak) · **2 authenticated
E2E** — a real owner GET of the RAMS PDF returns `application/pdf` starting `%PDF-`; a
draft returns 409.

## Notes / limitations
- Method statement is free-form prose (M1); structured numbered steps are a later increment.
- A per-transition audit trail (`permit_events` — suspension reason, re-activation
  authoriser) is a tracked enhancement; issuance is audited via `recordAdminActivity`.
- Operative distribution + sign-off (the work-blocking safety gate), PDF export and
  portal/site visibility are milestones **M3–M6**.
- `e2e/global-setup.ts` is the same authenticated harness the blueprint stack (#409)
  introduces; when both land it merges to the superset — a trivial resolution.
- The app middleware's `getUser()` bounces authenticated **write-POSTs** to `/login` in
  the LOCAL harness (not our code — an existing action reproduces it; not reproducible in
  CI, where authenticated writes pass); write journeys are validated in CI.
