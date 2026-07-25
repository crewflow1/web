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

## Milestone 5 — Security hardening (final adversarial review)

A final adversarial review of the **whole** H&S surface (RAMS, permits, sign-off, PDF) was
run before calling the operational chain done. Its driving fact: the browser ships the anon
key, so a server action is **not** a trust boundary — any authenticated member can hit
PostgREST directly with their JWT, and only **RLS + triggers + CHECKs** enforce anything.
Judged by that standard the review found the RAMS *issue path* was permissive where the
permit path (M2) had already been hardened. All P0/P1 findings, plus the P2 correctness
leaks, are closed in **`20261021_health_safety_evidence_hardening.sql`** and the two PDF
routes. Findings and fixes:

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | **P0** | A RAMS could be `INSERT`ed already-`issued` — forged reference/issuer, back-dated, **zero hazards** — because `risk_assessments` had no born-a-draft guard (the permit table did). | `tg_ra_lifecycle` (BEFORE INSERT OR UPDATE): a RAMS is always born a draft; issue is only reachable via the gated UPDATE. |
| 2 | **P0** | The `canIssue` readiness gate (assessor + ≥1 hazard) lived **only** in the server action, so a direct draft→issued PATCH could mint a hazard-less/assessor-less issued record. | The gate is re-enforced in `tg_ra_lifecycle` for every real (JWT) caller. |
| 3 | **P1** | On draft→issued, `issued_by` / `issued_at` were **client-supplied** on both tables (the immutability freeze only bites *after* issue) → forge the issuer, back-date the issuance. | Pinned server-side to `auth.uid()` / `now()` on the issue transition — RAMS in `tg_ra_lifecycle`, permits in `tg_permit_pin_provenance` (which also pins the lifecycle stamps). |
| 4 | **P1** | The issued-record delete-guard was an **RLS policy** → bypassed by the `service_role`, unlike every other evidence invariant here (which are triggers). | Re-expressed as BEFORE DELETE **triggers** (`tg_ra_block_delete_when_issued`, `tg_permit_block_delete_when_issued`) — role-independent; org teardown still cascades (the org row is gone by then). The draft-only DELETE *policies* stay as JWT-path defence-in-depth. |
| 5 | **P2** | `next_ra_number` was SECURITY DEFINER with no membership check → a cross-org issued-RAMS **count oracle**. | Gated to the caller's own org (`current_org_ids()`), mirroring `next_ptw_number`. |
| 6 | **P2** | The permit evidence PDF printed the stored status, so an `active` permit past `valid_until` read "active". | The route computes `effectiveStatus(...)`; the PDF renders **EXPIRED** when the window has passed. |
| 7 | **P2** | Both PDF routes labelled the header with the caller's *active* org, so a multi-org member could see one org's document under another's letterhead. | The header now uses the **subject's own** `org_id`. |

**Trusted-role asymmetry.** Pinning and the DB issue-gate fire when `auth.uid()` is present
(every browser caller). The `service_role` — trusted server-side code that is never shipped
to the browser (fixtures, migrations) — keeps its explicit values, the same asymmetry the
acknowledgements validate-trigger already uses (M3). The born-a-draft and delete-guard
triggers are unconditional (they hold for the service role too).

**Proof (real Postgres).** `__tests__/integration/health-safety/issue-hardening.test.ts` (6)
proves, as a real **staff** member (JWT): a born-issued INSERT is refused; issuing with no
hazard / no assessor is refused; `issued_by`/`issued_at` are pinned (a forged issuer +
back-dated instant are ignored) on **RAMS and permit**; and `next_ra_number` refuses another
org's number but allows the caller's own. `health-safety-delete-guard.test.ts` (8) proves an
issued RAMS/permit survives an admin **and** a service-role delete (the trigger, not just the
policy), a draft deletes, an issued record cannot be flipped back to draft, and org teardown
still cascades through issued evidence. Source-contracts are locked in
`__tests__/security/health-safety.test.ts`.

Combined with the per-milestone adversarial reviews (M2 permits: issue-gate + immutability
bypasses; M3 sign-off: backdating, admin-delete, service-key impersonation, expired-permit
sign), the epic's evidence chain — RAMS → hazards → permit → conditions → operative
acknowledgement → PDF — is DB-enforced, tenant-isolated, append-only where it must be,
provenance-pinned at issue, and non-erasable once issued for **every** role.

## Milestone 6a — RAMS revisioning (`20261022_health_safety_rams_revisioning.sql`)

An issued RAMS is a frozen legal record and is **never edited in place**. When the
assessment changes you raise a **revision**: a new draft is created from the issued
snapshot (header + hazards copied), edited, then issued — at which point the previous
issued revision becomes `superseded` and the new one is the single current record. This
mirrors the versioned-publish house pattern proven for asset inspection templates
(`20260929`).

**Lineage (smallest clear shape).** Two new columns on `risk_assessments`:
`root_risk_assessment_id` (the series identity — equals `id` for revision 1, copied
forward; defaulted by a trigger so the client never sets it) and `revision_number`. The
already-present `supersedes_id` (backward pointer) is finally used. No forward
`superseded_by_id` — it is derived. A single `tg_ra_revision_integrity` trigger blocks
self-supersede, cross-series and cross-org lineage.

**DB-enforced invariants (proven on real Postgres — `revisioning.test.ts`, 8 tests):**
- `unique (root, revision_number)` — no duplicate revision numbers.
- `unique (root) where status = 'issued'` — **exactly one current revision per series** (the load-bearing guarantee).
- `unique (root) where status = 'draft'` — at most one revision-in-progress; a concurrent second draft is rejected (proven with a real race — exactly one of two wins).
- Lineage fields are added to the `tg_ra_immutable_when_issued` frozen list, so they can't be rewritten post-issue.

**Atomic issue.** `issue_rams_revision(p_id)` (SECURITY INVOKER, so RLS + the M5 issue-gate
+ provenance pin still apply) locks the draft `FOR UPDATE`, supersedes the series'
currently-issued revision, and promotes the draft — in one transaction, so there is never
a window with two current revisions or an old-retired/new-failed split. A race rolls back
on the one-issued partial index. The revision keeps the series number and appends its
revision (`RA-0001` → `RA-0001-R02`); revisions don't consume a new RA-NNNN.

**Re-acknowledgement falls out for free.** Each revision is its own subject row, so a new
revision starts with **zero** acknowledgements and the superseded revision can no longer
be signed (the M3 ack trigger only permits signing an *issued* document). No
acknowledgement is ever copied or mutated; old signatures stay attached to the old
revision. "Who must re-acknowledge" is surfaced against the current revision (M6b).

**PDF evidence.** The RAMS PDF header now carries `Revision N · Current (issued)` /
`Superseded`, so a downloaded historical PDF is unambiguous years later.

The operator flow: an issued RAMS shows **Create revision** (a draft copied from the
snapshot) → edit hazards/controls/method → **Issue revision N** (supersedes the previous
in one step) → the previous revision stays immutable in the **Revision history** rail.

## Milestone 6b — Operational surfaces (register, signals, hub, required-operative, search)

The RAMS + permits verticals become a coherent safety-management system.

**Required-operative sign-off model.** Sign-off is now measured against the operatives
**required** to acknowledge a document — the distinct crew rota'd to its job
(`rota_entries`, the platform's canonical job-workforce; H&S reuses it rather than keeping
a second list). The detail panels show `signedRequired / required`, an explicit **Awaiting
sign-off** list (the WARN signal), and — honestly — **Not tracked** when a document has no
job link, because we never invent a requirement (directive §10-11). The status is a pure,
unit-tested function (`summariseSignoff`); a real member (JWT) can read the rota to derive
the crew, per job, org-scoped (proven in `required-operatives.test.ts`). The whole-org
`countOrgMembers()` denominator is gone.

**Work-block seam (WARN, not block).** The infrastructure to *detect and signal* "RAMS
acknowledgement required before work" is in place (the outstanding-operative list + the
dashboard signals). Hard-blocking a paid operative from clocking in is a product-policy
decision and is **not** built — the detection/signal is the safe default; the hard-block
seam is architected on top of the required-operative set.

**Dashboard action signals** (`lib/health-safety/signals.ts` + `server/services/
health-safety-snapshot.ts`). Deterministic, bounded, RLS-scoped — mirrors the retention
snapshot pattern, not the per-user notifications engine. Signals (danger → warn → info):
permits expired-but-open, active jobs with no current RAMS, permits expiring within 24h,
RAMS past review date, critical (16-25) residual risk, drafts awaiting issue. Surfaced as a
"Needs attention" panel on the H&S register; hidden entirely when all-clear.

**Register filters.** The H&S register filters by status (All / Draft / Issued /
Superseded-withdrawn) with live counts, bounded reads.

**Job Safety hub** (`app/(app)/jobs/[id]/_job-safety.tsx`). A per-job H&S section (mirrors
the job-assets pattern): the job's RAMS (current issued highlighted, a "no current RAMS"
warning when work is in progress) and its permits with the **derived** status (an expired
permit reads EXPIRED, never a stale "active").

**Search.** RA and permit numbers + titles are in the ⌘K palette (RLS-scoped, sanitised).

**Observability.** `risk_assessment.revised` (and the existing `.issued`) are audited via
`recordAdminActivity` with ids/reference/status only — never method statements, close-out
notes or signatures.

## Notes / limitations
- Method statement is free-form prose (M1); structured numbered steps are a later increment.
- A per-transition audit trail (`permit_events` — suspension reason, re-activation
  authoriser) is a tracked enhancement; issuance is audited via `recordAdminActivity`.
- Operative sign-off (M3) and evidence PDFs (M4) have shipped. RAMS revisioning /
  re-acknowledgement, the global H&S register + dashboard signals, the required-operative
  work-block **signal** (WARN, not hard-block), and mobile/a11y are milestone **M6**.
- `e2e/global-setup.ts` is the same authenticated harness the blueprint stack (#409)
  introduces; when both land it merges to the superset — a trivial resolution.
- The app middleware's `getUser()` bounces authenticated **write-POSTs** to `/login` in
  the LOCAL harness (not our code — an existing action reproduces it; not reproducible in
  CI, where authenticated writes pass); write journeys are validated in CI.
