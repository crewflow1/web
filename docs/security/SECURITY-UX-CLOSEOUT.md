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
