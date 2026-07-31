# Loud read failures — the silent-empty-state audit

## The incident

PR #476's axe-canary work uncovered that `/assets/holdings` and the job hub's
assets panel had rendered their EMPTY states in production for weeks:
`asset_assignments` carries two foreign keys to `assets` (`asset_id`,
`vehicle_asset_id` — custody vs "loaded on vehicle"), so the bare
`assets(...)` PostgREST embed had two candidate relationships and PostgREST
rejected the WHOLE query (PGRST201). Both pages destructured
`const { data } = await query; const rows = data ?? []` — so a hard failure
on every request rendered as "Nothing is checked out".

Two independent defects compounded:

1. **The embed was ambiguous** — fixed with explicit FK hints
   (`assets!asset_assignments_asset_id_fkey(...)`).
2. **The error member was discarded** — so the failure was invisible. A page
   that renders its empty state on query error is indistinguishable from
   healthy (the e2e axe canary's candidacy-floor argument, `e2e/_axe-canary.ts`).

This audit swept the whole app for defect 2 (the systemic pattern) and built a
schema-derived tripwire for defect 1.

## The sweep

Every `const { data } = await …` / `const { data: x } = await …` read in
`app/`, `server/`, `lib/`, `components/` was read and classified (285 grep
hits + adjacent same-class sites found while reading: `Promise.all`
destructures, `(await …).data ?? []`, `{ count }` destructures,
`if (error || !data) return []` conflations):

- **A — the bug class**: an org-scoped page/panel primary read (or guard, or
  snapshot builder) whose failure rendered an empty/healthy state, a fake-zero
  KPI, a fake-nil tax dataset, a silently skipped notification, or a fail-open
  guard. Converted to loud-fail.
- **B — error → "not found" lies**: `.single()/.maybeSingle()` reads where a
  query failure became `notFound()`, an `?error=…_not_found` redirect, or an
  invalid-link page for a REAL record. Converted: throw on error first;
  not-found strictly for genuinely-null rows (`.single()` treats `PGRST116`
  as the no-row path).
- **C — deliberate best-effort**: enrichment joins (names/labels), storage
  cleanup pre-reads, documented `fetchAllRows` partial-aggregate posture
  (dashboard/briefing/fleet/operations/org-cash), post-write side-channel
  notifications with independent backstops. **Left as designed** — ledger
  below.
- **D — already loud** in practice (error surfaces via a sibling check, DB
  constraint, or recorded failure path). Untouched.

## The doctrine (how loud-fail surfaces)

| Surface | Treatment |
|---|---|
| Full-page primary read (server component / `_data` helper / service feeding one page) | `if (error) throw readFailure(context, error)` → route-group error boundary renders + Sentry captures via `onRequestError` |
| Panel/section inside a still-useful page | `reportReadFailure(context, error)` (explicit Sentry+console capture) + an explicit inline error block — never the empty state |
| Detail reads & action guards | throw on error BEFORE the `notFound()` / not-found redirect |
| Read-modify-write actions | throw BEFORE the write — a failed read must never clobber state or stamp false success |
| API/cron routes | 500 / error JSON, matching each file's existing loud sibling |
| Fail-open guards (suppression gate, SMS dedup, rota overlap, owner-lockout) | throw — a failed read blocks the guarded operation |

`lib/supabase/read-failure.ts` carries both paths and the message shape
(`<context> read failed: [<code>] <message>` — the PostgREST code makes
PGRST201-class rejections identifiable from the Sentry title). Hand-rolled
query casts that typed the promise as `Promise<{ data: T | null }>` (reads
were systematically typed error-blind while sibling write chains carried
`error`) were widened with `SupabaseReadError`.

## Severity model

Two tiers inside class A, and the distinction matters (credit: the
blueprint-pins session's review relay):

- **(a) error → empty/missing content** — a list renders empty, a section
  vanishes. Misleading by omission; an operator may still get suspicious.
- **(b) error → wrong-but-plausible claim** — the page asserts a false fact:
  "Nothing is checked out", "No hazards yet" on a RAMS that HAS hazards, £0
  outstanding, a NIL CIS return, "no conflicts" from a degraded detector,
  "0 open snags". Nothing looks broken, so nothing gets questioned. Every
  (b) site was treated as must-fix regardless of surface size.

## Highest-severity fixes (why this class matters)

- **Fail-open guards**: `hq-comms.addressIsSuppressed` (bounced/complained
  addresses could be emailed), `receptionist.findSentTransport` (duplicate
  SMS/WhatsApp dispatch), `rota.listUserShiftsOnDay` (double-booked shifts),
  staff last-owner-lockout guards (org lockout), payroll open-entry guard.
- **False success on failed reads**: imports commit/rollback stamped
  `committed`/`rolled_back` having done nothing; payroll runs saved with zero
  lines; `receptionist.processInboundEnquiry` marked enquiries processed with
  no lead created (its try/catch was dead code — PostgREST errors return, not
  throw).
- **State clobbers**: settings profile/org forms rendered EMPTY on failed
  reads (a re-save would blank real bank details); `onboarding_state`
  read-merge-writes wiped dismissed/celebrated keys.
- **Tax/statutory**: CIS month snapshots building a NIL return from a failed
  read; voided-payment filter failing open into statements; statement PDFs
  without provenance lines; invoice/quote emails + public PDFs with totals
  but zero line items; payslips silently missing NI numbers.
- **Blast radius**: `lib/jobs/load.ts` (every job page 404'd on transient
  error), portal payment schedule (all six reads), HQ boards (billing,
  onboarding, customers, snapshot MRR) rendering fake-zero.

## The C ledger (reviewed, deliberately soft)

Kept as designed, with the reviewed reason:

- `fetchAllRows` callers — `lib/supabase/paginate.ts` documents the
  best-effort partial-aggregate posture: `briefing.ts`, `job-site-hub.ts`,
  `fleet-snapshot.ts`, `operations-snapshot.ts`, `schedule-integrity.ts`
  (caveat noted: for a conflict DETECTOR the posture inverts safety — a
  degraded read reports "no conflicts"; candidate for a degraded flag),
  `org-cash.ts` (its pre-existing `loadError` flag now also reflects partial
  reads).
- Name/owner enrichment joins where the primary read is separately checked:
  `hq-sales` company-name joins, HQ snapshot `memberships → users` owner
  columns, `hq-task-queue.loadEmployees`, `blueprint-pins` snag join,
  site/snag/toolbox "Job" label lookups, filter-chip name lookups.
- Storage-cleanup pre-reads where the row delete is loud and the cost is an
  orphaned blob: `job-documents`, `blueprints.deleteBlueprint`,
  `company-logo`, snags/assets/diary attachment id reads.
- Documented degrade-to-null snapshot resolvers: toolbox issue-time
  site/user/RAMS/permit label freezing ("failures degrade to null, never
  block the issue"), PDF letterhead/branding lookups.
- Idempotency heuristics whose primary write is loud and DB-backstopped:
  quotes accepted/invoice-reuse pre-checks (partial unique index), staff
  already-member check, purchase-orders 10s dedupe window.

  **Correction (review pass).** The earlier wording here had it backwards: it
  filed the payments dedupe window with the DB-backstopped guards and flagged
  only supplier-payments as the exception. NEITHER has a DB natural-key
  backstop. `payments`/`supplier_payments` carry no unique index over
  (org, amount, paid_at, method, reference, created_by), so the 10-second probe
  is the ONLY duplicate check that exists, and `data: null` from a rejected
  query is indistinguishable from "no recent duplicate". Both now FAIL CLOSED —
  a failed probe refuses the write and tells the operator to retry, rather than
  recording a customer's payment twice (`payments/allocate-actions.ts`) or
  paying a subcontractor twice and filing the CIS deduction with it
  (`suppliers/[id]/payments/actions.ts`, both the M2 and M3 probes). A refused
  save costs a retry; a duplicated one inverts the ledger silently.
- Post-write side-channel notifications with fallbacks (support ticket reply
  notification subject, admin owner-email lookup) — the write succeeds and
  the notification degrades.
- `retention-milestones.ensureMilestoneNotifications` — now fails safe
  (emit nothing) instead of re-firing milestones from an empty read.

## Out-of-scope observations recorded during the sweep

- RLS-only reads with no active-org pin spotted at: `payroll/actions.ts`
  (hours window), `site-reports/actions.ts` (job resolve on create),
  `payments/actions.ts` (unpaid-invoice match scoring), `toolbox/[id]`,
  `snags/[id]`, `purchase-orders/[id]` + two PO action gates,
  `lib/ai/aggregates.ts` (activity summary). The read-side active-org
  programme is closed; these look like stragglers of the same class.
- `demo-lifecycle` invite recovery uses unpaginated `auth.admin.listUsers()`
  (first page only) — idempotent recovery misses existing users beyond ~50.
- e2e detection precedent: the axe canary's candidacy floor proves a page
  rendering its empty state on error is invisible without a floor or an
  error assertion. Key list surfaces could grow seeded floors later; the
  source-tier tests below are the cheap, hermetic guard this PR ships.

## Enforcement

- `__tests__/security/postgrest-embed-ambiguity.test.ts` — parses
  `supabase/migrations/*.sql` into the FK graph; asserts the set of ≥2-FK
  (source → target) pairs equals a REVIEWED allowlist (a new migration that
  creates a second FK to an embedded table fails CI at birth); sweeps every
  `.from(...).select(...)` for embeds crossing an ambiguous pair without an
  explicit FK-name hint (`!inner`/`!left` are join modifiers, not
  disambiguation); pins the two incident pages.
- `__tests__/security/loud-read-failures.test.ts` — pins the marquee
  conversions (fail-open guards, RMW aborts, tax-critical reads, incident
  pages) and holds a per-directory RATCHET on `const { data } = await` sites:
  the count may only go DOWN. A new swallowed read fails the tier until it
  handles `error` or a reviewed exception bumps the baseline.

## Inherited debt — 2026-07-29 baseline adjustment

Trains 24–26 (#482 PO receiving, #483 sites, #484 AI governor) were authored
concurrently with this ratchet and merged after it froze. Their reads add
+4 discard (app), +3 discard / +2 soft-data (server+lib) to the ledger.
Each lane carried its own loud-error discipline on its critical paths (GRN
posting, RPCs); the counted shapes are secondary reads. They are queued for
the next loud-reads slice — the `===` baselines were raised once, here, and
any further movement fails the build.

## Conversion — 2026-07-31: the job hub's H&S panel (SEV-A)

`app/(app)/jobs/[id]/_job-safety.tsx` held three reads — the job's RAMS, its
permits, its toolbox talks — on the `data ?? []` shape, with `error` bound
nowhere. Found while auditing a different lane; left unfixed there as
out-of-remit.

This is the worst variant of severity (b) in the model above, for one reason:
**the panel hides itself when the job has no records** (`return null`). So a
rejected query did not render a suspicious empty list — the entire Health &
safety section *vanished*, taking with it the "No issued RAMS is current for
this job. Issue one before work starts." warning and every unsigned toolbox
talk. The page then read as "this job has no H&S obligations", which is the
strongest all-clear the product can give, asserted precisely when the database
is unhealthy. A safety control must fail CLOSED.

Treatment — panel doctrine (the page stays useful), matching `_job-assets.tsx`
on the same route:

- The hand-rolled cast typed the promise `Promise<{ data: unknown[] | null }>`
  — error-blind by construction, the root cause. Widened with
  `SupabaseReadError`, as the sweep did elsewhere.
- All three errors are reported individually (`job safety: RAMS on job`,
  `… permits on job`, `… toolbox talks on job`) so each is its own Sentry
  signal.
- **ANY** failure blocks the whole render. A partial safety picture is itself a
  false all-clear: permits loading while RAMS is rejected would silently assert
  the job has no risk assessment.
- The failure state is explicit red markup that names the trap — "This is NOT
  an all-clear; do not treat it as 'no RAMS required'".

Ledger movement: `app/(app)` softData **52 → 49** (−3, the three reads now sit
behind a real `.error` check). `discard` and `countOnly` unchanged; the other
two scopes unchanged. Baseline lowered in the same commit, per the DOWN rule.

Pinned by the `SEV-A: the job safety panel fails CLOSED` block in
`__tests__/security/loud-read-failures.test.ts`: the three named reports, the
visible error block, the three-way `failed` latch, the non-error-blind cast,
and a structural sweep asserting no `<res>.data ??` in the file lacks a
matching `<res>.error`. Reverting any single read to the bare shape turns it
red.

### Correction to the referring report

The lane that found this named `lib/health-safety/toolbox-talks.ts` as the
second offender. It is not: that module is pure domain logic (lifecycle,
labels, reference parsing) with no DB access at all. The toolbox-talks read
that was failing open is the third read *inside* `_job-safety.tsx`, fixed here.
The other H&S read layers were checked and are already loud —
`server/services/health-safety-snapshot.ts` (every read throws; its header
states the reasoning) and `app/(app)/health-safety/_signoff-data.ts`
(`listAcknowledgements`, `countOrgMembers`, `requiredOperatives`).

Still soft, noted not fixed: `priorRevisionSignoff` in `_signoff-data.ts`
discards `error` on both of its reads. Its failure mode is a *missed prompt* to
re-acknowledge a superseded revision rather than a false compliance claim, and
it is counted in the frozen `discard` baseline — a candidate for the next
slice.
