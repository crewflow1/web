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
