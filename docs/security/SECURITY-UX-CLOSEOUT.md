# Security + UX Closeout — evidence log

Branch `security/ux-closeout` off `main` `3867417d`. Baseline verified: prod
`3867417` healthy, db:ok, 377/377 migrations, dark providers dark.

---

## Phase 1 — hourly_pay access — **CONFIRMED (MAJOR)**

### The finding
An ordinary staff member can read a **co-worker's `hourly_pay`** (and
`emergency_contact`, `employment_type`, `start_date`) directly from
`public.users`.

### Root cause
`public.users` carries the sensitive employment-profile columns
(`hourly_pay`, `emergency_contact`, added in `20260521000000`), and the RLS
policy **"users: members can read profiles of co-workers"**
(`20260515170000_org_member_visibility.sql`) grants **row-level** SELECT on
`public.users` to any authenticated user who shares an org:

```sql
create policy "users: members can read profiles of co-workers"
on public.users for select to authenticated
using ( id in ( select user_id from public.memberships
                where org_id in (select public.current_org_ids()) ) );
```

RLS is row-level, so a co-worker who may legitimately read the row (for names /
emails in assignment dropdowns) also reads **every column on it**, including pay.
`20260529000000_security_hardening.sql` moved `ni_number` to an admin-only
`staff_secrets` table for exactly this reason — but **left `hourly_pay` and
`emergency_contact` on the co-worker-readable row**.

### Reproduction (real Postgres, staff JWT — not the UI)
Local Supabase, Brightwork org. Owner `11451eb9…` pay set to £45.50; staff
`1f5a00c2…`. Executed as the staff JWT (`auth.uid()=1f5a00c2`, role
`authenticated`):

```
select … from public.users where id = '<owner>';
→ auth.uid()=1f5a00c2-…
→ OWNER ROW READABLE BY STAFF → hourly_pay=45.50 | emergency_contact={"name":"Jane Doe","phone":"07700900000"}
→ rows_returned=1
```

Staff reads the owner's pay + emergency contact. **Confirmed at the RLS layer.**

### Every reader / writer (all on the user-JWT `authenticated` client — admins use
the same role, so a blanket column REVOKE would break admins too):
- READ (cost/payroll — admin/owner context): `lib/profitability/labour-rates.ts`
  (loadOrgHourlyPay, job costing), `lib/reports/report-data.ts`,
  `server/services/company-health.ts`, `server/services/intelligence.ts` (×2),
  `app/(app)/dashboard/page.tsx` (payroll tile), `app/(app)/payroll/actions.ts`.
- READ (UI): `app/(app)/staff/page.tsx` (roster — NOT role-gated on the data
  rows), `app/(app)/staff/[id]/page.tsx`, `app/(app)/me/page.tsx` (OWN pay).
- WRITE: `app/(app)/staff/actions.ts` (admin edit), `app/onboarding/join/actions.ts`
  (invitee seeds own).

### Intended model (per the CEO directive — NOT invented here)
`hourly_pay` readable by **the user themselves** + **org owners/admins**
(payroll, roster, job costing); **not** arbitrary co-workers. Mirrors the
`staff_secrets`/NI precedent, adjusted to allow SELF read (pay needs it for the
`/me` earnings surface; NI did not).

### Fix (DB-enforced, lowest boundary)
RLS is row-level and admins share the `authenticated` role, so the column must be
separated. Move `hourly_pay` + `emergency_contact` to a sibling table with RLS
`self OR is_org_admin(shared org)`. **Global per-user semantics preserved** (one
pay value per user, as today) so job-costing/payroll figures stay byte-equivalent
for admin/owner context. Centralise the read; update all sites; prove financial
fixtures unchanged; real-Postgres RLS regression tests; adversarial review.

### AS IMPLEMENTED
- **Migration `20261218000000_protect_staff_compensation.sql`**: new `public.staff_compensation`
  (user_id PK — global, matching the dropped column; `hourly_pay`, `emergency_contact`,
  `updated_by`, `updated_at`). RLS: `can_read_compensation(user)` = self OR owner/admin of a
  shared org; `can_write_compensation(user)` = owner/admin of a shared org (NO self-write).
  Both SECURITY DEFINER + empty search_path. Backfill from users, then DROP `users.hourly_pay`
  + `users.emergency_contact`.
- **Reads rewired** to staff_compensation (admin/owner context ⇒ identical pay map, financials
  byte-equivalent): labour-rates (job costing), reports, company-health, intelligence (×2),
  dashboard payroll tile (via loadOrgHourlyPay), payroll run, staff roster, staff detail, `/me`.
- **Writes rewired**: staff edit (admin, RLS-gated), staff invite pre-fill + onboarding self-seed
  (service-role — a member can never self-set pay), all error-aware.
- **types.ts**: surgical edit (add staff_compensation + 2 functions, drop 2 users columns) — NOT
  a full regen (regen also pulled unrelated hq_events partition rotation — the documented trap).
- **Regression test** `__tests__/integration/staff/compensation-rls.test.ts` — real Postgres,
  6/6 PASS: staff→co-worker BLOCKED, staff→self OK, admin→member OK, staff self-write BLOCKED,
  cross-org BLOCKED, anon BLOCKED.
- **Gates**: typecheck clean; unit 10,906/10,906 (payroll/costing/profitability fixtures
  unchanged = financial equivalence); security 308 files green (F-1 allowlists updated for
  shifted lines; staff_compensation in COVERAGE_REVIEWED as id-batch-bounded; embed-ambiguity
  pair reviewed; loud-read baseline +1 ledgered for the /me best-effort own-pay estimate).

**VERDICT: hourly_pay finding CONFIRMED and FIXED at the DB boundary.**

---

## Phase 2 — job Commercial / Valuations / Billing access

### Trace + verdict
- `_job-tabs.tsx` renders Commercial/Valuations/Billing to EVERY member (no role
  gate). `commercial/page.tsx` had only `requireOrgContext()`; role (`canSetBudget`
  = owner/admin) gated only the budget WRITE — figures (margin/cost/profit) rendered
  to any member. Job overview showed Profit + Margin ungated. This is the
  pre-existing "any member VIEWS, role gates WRITES" design.
- **Verdict: mixed — a correctness-forced gate + a genuinely-ambiguous product
  decision.** Not a single A/B/C.

### Correctness-forced (FIXED — a direct corollary of Phase 1)
Profit/margin/cost are **labour-cost-derived**. Since staff_compensation makes
co-worker pay admin-only, only an owner/admin can compute a COMPLETE labour cost;
a non-admin would see an UNDERSTATED cost / overstated margin — a wrong money
figure. So the pay-dependent figures are now owner/admin only:
- job overview Profit + Margin tiles → `isAdmin` gated;
- `/commercial` page → redirects non-admins to the job overview (server gate);
- Commercial tab hidden for staff; the Cmd+K "commercial (margin & cost)" +
  "add cost" commands are owner/admin only.
This is not an invented permission — it is the unavoidable consequence of the pay
fix, and it is consistent with the CEO-approved "Money area is admin-only" IA.

### Genuinely ambiguous (SURFACED — authorization UNCHANGED, per the directive)
`/valuations` (applications for payment) and `/billing` (customer invoicing) are
**pay-independent** (no correctness issue) and their staff-visibility is a real
product decision the code makes explicitly (view-all). I did NOT change their
authorization.

**Field-level verification (why this is safe to leave, not an unclosed hole):**
I read both pages + their loud-read services to confirm they expose NO Phase-1
data. `/valuations` (`buildJobValuationsView`) renders only revenue-side figures —
`gross_valuation`, `variations_total`, `previous_certified_gross`,
`net_certified_this`, `retention_percent` and the derived retention position; its
`isAdmin` prop gates only the submit/certify **actions**, not the figures.
`/billing` (`loadJobBilling`) renders only accounts-receivable — contract,
billed-to-date, received, collectable, outstanding, overdue, retention-held, cash
outlook. **Neither surface reads `staff_compensation`, `hourly_pay`, labour cost,
profit or margin.** So the labour-cost boundary from Phase 1 is fully closed on
these routes; what remains is purely "should field staff see customer revenue?" —
a policy question, correctly left to the CEO rather than guessed.

**CEO decision needed:** should field staff see a job's valuations
/ customer-billing / commercial-cash strip, or are those management-only like the
Money area? If management-only, gate `/valuations` + `/billing` + the overview cash
strip to owner/admin the same way (a small, mechanical follow-up).

No server access boundary was weakened; the leak-relevant surface (labour cost via
pay) is closed.

---

## Phase 3 — adjacent sensitive-field sweep (same co-worker-`users` pattern) — CLEAN

After Phase 1, `public.users` (the co-worker-readable row) holds only: id, email,
full_name, phone, avatar_url, employment_type, start_date, created_at, updated_at.
The sensitive financial/identity fields are all OFF it — ni_number → staff_secrets
(20260529), hourly_pay + emergency_contact → staff_compensation (20261218).
Remaining fields are contact/identity (intended co-worker visibility) + low-
sensitivity HR (employment_type, start_date).

The other staff-PII tables carry their OWN self-or-admin RLS (verified, real
Postgres): `payroll_tax_profiles` + `pension_enrolments` SELECT =
`(user_id = auth.uid() AND org_id IN current_org_ids()) OR is_org_admin(org_id)` —
a co-worker CANNOT read another's tax code or pension. staff_secrets (NI) is admin-
only; staff_compensation is self-or-admin. **No further BLOCKER/MAJOR exposure via
this pattern.** (employment_type/start_date co-worker visibility = MINOR/accepted.)

---

## Phase 4 — UX closeout

### 4A — Finances → "Costs" (SHIPPED, complete atomic sweep)
`/finances` is a cost/spend log (not a ledger); "Costs" is accurate. Renamed EVERY
user-visible occurrence tied to that surface, in one pass: nav label + i18n
`nav.finances`, the `/finances` page h1 + subtitle, `/finances/new` breadcrumb + h1
("New cost entry"), the approve-receipt flow ("posted to Costs" toast + "post to
Costs" copy + the "Costs" link), the Tax page "Costs" link, the activity-log filter
label + phrasing ("added a cost"), the dashboard "Add cost" CTA, and the i18n
snapshot test. "Expenses" is UNCHANGED (the reviewed decision — "Receipts" was
rejected). Old term "finances" kept as a ⌘K search keyword. Route path stays
`/finances` (URL≠label; renaming the route is out of scope). No calc/RLS/logic
touched; typecheck + i18n/nav/activity green.

### 4B — thin area landings (People `/staff`, Site & safety `/health-safety`) — DEFERRED, documented
A genuinely useful "what needs me here" hub needs NEW data composition (pending-
leave count, rota-conflict detection, payroll-due, expiring certifications). The
data exists (`/staff/rota/conflicts`, `/staff/leave`, `/payroll`, the H&S snapshot),
but composing it is feature-build work, not the "cheap + safe" bar this closeout
sets — and rule #8 forbids a cosmetic redesign programme here. RECOMMEND as its own
small UX slice with CEO sign-off; left unchanged for now.

### 4C — design-system drift — DEFERRED, documented
The prior audit found the feared decorative excess ABSENT; the real drift is low-
severity (raw `<button>` vs Button, hand-rolled pills vs Badge, 0/184 PageHeader,
breadcrumbs on 16/184). Fixing it well is a broad, multi-file sweep — exactly the
"churn for its own sake" rule #8 excludes from a security closeout. RECOMMEND a
targeted PageHeader+Breadcrumb wayfinding slice (object `[id]` routes) as separate
UX work; not churned in here.

---

## Phase 5 — performance regression check — PASS

Prior programme's perf work must not regress (auth-read dedup, dashboard
single-wave concurrency, DailyBriefing Suspense, no new client bundle). Measured
against a fresh production build + `next start` on the closeout branch:

- **/dashboard REST query count = 85** (Kong access log, owner session). Prior
  baseline was ~84; the +1 is the payroll tile now reading `staff_compensation`
  via `loadOrgHourlyPay` instead of an embedded `user:users(hourly_pay)` join —
  same number of round-trips, no fan-out. No runaway (guard: <110).
- Dashboard still renders as one concurrent `Promise.all` wave with the
  `DailyBriefing` Suspense boundary intact (unchanged by this branch).
- No `"use client"` added to any server component; the pay reads all moved
  server-side (page/service), so no client bundle growth.

Verdict: **no performance regression.**

## Phase 6 — role + mobile + direct-URL QA — PASS (1 pre-existing item documented)

Automated (Playwright, production build) — 8/8 role + label checks pass:

| Check | Result |
|---|---|
| owner `/finances` h1 = "Costs" (4A) | ✓ |
| owner reaches `/commercial` (unaffected) | ✓ |
| owner `/dashboard` query count 85 (no regression) | ✓ |
| staff `/dashboard` → `/me` (existing gate preserved) | ✓ |
| staff `/commercial` → redirected to job overview (2) | ✓ |
| staff job overview hides "Margin" (2) | ✓ |
| staff job tab bar hides "Commercial" (2) | ✓ |
| staff `/me` (own pay) renders | ✓ |

The DB-level proof (staff cannot read a co-worker's pay; self/admin can; cross-org
+ anon blocked) is the 6/6 real-Postgres suite
`__tests__/integration/staff/compensation-rls.test.ts` — the authoritative Phase-1
gate; the UI checks above are corroboration, not the boundary.

Mobile overflow sweep at 320 / 375 / 390 / 430 / 768 (owner: `/finances`, job
overview, `/commercial`; staff: `/me`, job overview) — **24/25 clean**.

### Pre-existing item (NOT caused by this closeout; documented, not fixed)
Owner job-overview `/jobs/[id]` horizontally overflows at **768px** (scrollWidth
934 vs 768). Root cause is a wide element in `_job-programme.tsx` (a component this
PR does NOT touch) — its container lacks an `overflow-x-auto`/`min-w-0` bound.
Proof it is pre-existing: `_job-programme.tsx` is byte-identical to main, and on
main the overview rendered the same content to owners, so an owner's 768px view is
unchanged from main. This branch actually *removes* it for staff (24/25 clean,
staff 768px clean) by gating the extra Profit/Margin tiles + Commercial tab.
Fixing a pre-existing cosmetic overflow in an untouched component is exactly the
"no cosmetic redesign programme" this closeout excludes (rule #8). RECOMMEND a
one-line `overflow-x-auto` wrap on the programme grid as a separate small UX fix.

---

## Phase 7 — three adversarial reviews (independent, read-only) + remediation

All three were told to FALSIFY the change and end with an explicit deploy verdict.

### Security / RLS — **SAFE TO DEPLOY**
Real-Postgres falsification with a live staff JWT (inside an explicit
`BEGIN…ROLLBACK`, `rolbypassrls=f`): staff→co-worker pay = 0 rows; staff→self = own
row; staff self-write = 0 rows (blocked); admin→member = 1 row; cross-org admin +
stranger = 0 rows; anon denied. Helpers `SECURITY DEFINER`, owned by postgres,
`search_path=""`, no recursion. Every app read runs on the user-JWT client (RLS is
the gate); service-role paths are write-only or self-scoped; cron report-delivery
is admin-subscription-gated (verified INSERT RLS). `users.hourly_pay/emergency_contact`
dropped; zero code reads them. Nothing weakened. One MINOR: add an
`emergency_contact` assertion — **DONE** (seeded both cols; negative on staff→admin,
positive on admin→member).

### Domain / financial — DO NOT DEPLOY → remediated
Confirmed payroll/job-costing/dashboard/VAT/CIS byte-equivalent for owner/admin;
migration lossless; RLS proven. Found **one BLOCKER** (below) + MINORs (timesheet
silent pay-discard; one relaxed exact-count) — **all fixed**. Also a MAJOR:
`/reports/profit` had no page-level role guard.

### UX / IA / role — DO NOT DEPLOY → remediated
Grepped the app rather than trusting the doc; caught the SAME blocker independently,
plus the rename was still half-applied (M2) and two role MINORs.

### BLOCKER (caught by BOTH non-security reviewers) — job "Profitability" section leaked to staff — FIXED
`app/(app)/jobs/[id]/page.tsx:861-949`. Phase 2 gated the Job-value Profit/Margin
tiles + margin pill but MISSED the sibling "Profitability" section (gated only by
`!profit`), which rendered Revenue/Costs/**Gross profit**/**Costs-by-category
(Labour…)** to every member. Doubly wrong: under a staff JWT `loadOrgHourlyPay`
returns only the viewer's own rate → understated cost / overstated profit. **Fix:**
the whole profitability READ is now `isAdmin`-gated (staff see a slim "Costs" section
with only the "+ Add cost" action). Cost ENTRY is deliberately preserved for all
roles (see CEO decision below).

### MAJOR — `/reports/profit` (and `/reports/utilisation`) wrong for direct-URL staff — FIXED
Both reports are labour-cost-derived (P&L; utilisation carries a per-member rate
column + labour cost) via the rewired `report-data.ts` / `intelligence.ts` pay read.
The Reports nav area is admin-only, but the PAGES had no guard, so a direct URL
showed a non-admin an overstated P&L / broken labour figures. **Fix:** page-level
owner/admin redirect on both, and `registry.managementOnly` flipped to `true` for
both so the export route's 403 and the /reports index filter agree. (overview +
pipeline read no pay — left staff-visible.)

### MINORs — FIXED
- Roster `/staff` "Hourly" column hidden for non-admins (was self-populated + "—"
  for everyone else = looks broken); "Edit →" → "View →" for non-admins.
- ⌘K "Add cost to this job" **un-gated** — cost entry is a member action (button +
  `finances` INSERT RLS admit members); gating only the shortcut was inconsistent.
- Timesheet pay read now LOUD (was a silent £0 on read failure).
- `source-assertions` exact read-count restored (`users` ×1, `staff_compensation`
  ×2) instead of the relaxed `>=1`.
- CI-only: `active-org-write-slice.test.ts` seeded `hourly_pay` on `public.users`
  (now dropped) → moved to a `staff_compensation` seed.

### Not fixed here (documented) 
- `/staff/[id]` "View timesheet" → co-worker "Forbidden" page — pre-existing, has a
  `/me` link (graceful). Out of this closeout's scope.

### NEW CEO decisions surfaced (not guessed)
1. **Should field staff be able to LOG job costs at all?** Today the `finances`
   INSERT RLS admits any member and the job "+ Add cost" button is shown to all —
   so cost entry is member-accessible by design. This closeout PRESERVES that
   (tightening it would break a field workflow and is a product call, not a
   security fix). If costs should be admin-only, gate the button + `/finances/new`
   + the INSERT RLS together.
2. **Profit & utilisation reports are now management-only.** They were
   `managementOnly:false` (staff-visible), but the pay fix makes them wrong+pay-
   adjacent for staff, so they are now owner/admin-only — a correctness-forced
   corollary, consistent with the job Profitability gate. If the CEO wants a
   staff-facing profit/utilisation view it needs a pay-free projection (a build).

**Re-review disposition:** every BLOCKER/MAJOR fixed; typecheck clean; unit +
security 10,906/10,906 green after the fixes; the RLS integration suite strengthened.

### Re-review round 2 (UX) — M2 sweep finished
The UX re-review confirmed M1, the reports guards, and every MINOR CLOSED and safe
("nothing here is unsafe and nothing leaks pay-derived data"), but rightly
FALSIFIED the "complete sweep" claim a second time: my straggler grep had filtered
out any line containing `/finances`, which hid label+href-on-one-line cases. Six
more user-visible strings tied to the Costs area were then fixed:
`lib/health/company-health.ts` ("Finances" drill-through → "Costs"),
`lib/intelligence/cvr-rollup.ts` ("Costs (finances)" → "Costs"),
`lib/pdf/tax-quarter-pdf.tsx` (section heading "Finance / expense rows" → "Cost /
expense rows" — it had contradicted the empty-state renamed one line below), and
the user-surfaced `/api/finances` messages ("Failed to load finances"/"Failed to
create finance"/"Finance saved…" → cost). A corrected sweep (grep NOT filtering
`/finances`, then classifying every hit) now shows only different-meaning uses
remain: fleet/asset "Finance" (vehicle/asset financing), HQ "Finance AI" (dept),
cash "rent, finance, PAYE/NI" (loan outflow), and the route/table/API resource
name `finances` (URL≠label, deliberately unchanged). typecheck clean; unit +
security 10,906/10,906.
