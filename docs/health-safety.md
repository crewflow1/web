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

## Notes / limitations (M1)
- Method statement is free-form prose in M1; structured, numbered method steps are a later increment.
- Permits-to-work, operative distribution + sign-off (the work-blocking safety gate),
  PDF export and portal/site visibility are milestones M2–M4.
- `e2e/global-setup.ts` is the same authenticated harness the blueprint stack (#409)
  introduces; when both land it merges to the superset — a trivial resolution.
