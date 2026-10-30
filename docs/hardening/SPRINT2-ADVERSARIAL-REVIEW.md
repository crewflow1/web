# Sprint-2 R5 — Independent Adversarial Review

**Reviewer:** independent (read-only on code), adversarial posture — goal was to _falsify_, not approve.
**Date:** 2026-10-30
**Scope:** branches `feat/jobs-assignment-reconciliation` (F1/F2 + mig 20261246) and
`feat/r5-phase3-operational-rls` (migs 20261250 / 20261252 / 20261253 + service-role paths).
**Method:** `git show <ref>:<path>` static analysis; verbatim byte-diff of the six report-RPC
bodies against their originals (20261237–240); policy-name reconciliation of every dropped SELECT
policy; manual authz tracing of the named `createAdminClient()` call sites. No DB mutation, no
integration tier, no `supabase db` lifecycle commands.

---

## VERDICT: 1 BLOCKER, 1 HIGH, 1 MEDIUM. Do **not** merge `20261252` as-is.

> **BLOCKER (loud):** Migration **20261252** (finances SELECT → `is_org_admin`) **breaks the
> member-open staff cost-entry workflow**. `POST /api/finances` is *deliberately member-open*
> (field staff "+ Add cost") and performs `insert().select("id").single()` on the **tenant**
> (user-JWT) client. Once the finances SELECT policy is admin-only, a non-admin's
> `INSERT … RETURNING` can no longer read the row back, so the call fails and the cost is not
> saved. The migration's own header claims *"COST ENTRY IS PRESERVED"* — that claim is **false**
> for the primary staff cost-entry path, because the author only considered the `expense_drafts`
> flow and `approveExpenseDraft` (admin-gated), not this member-open API.

---

## Findings

### BLOCKER-1 — Migration 20261252 breaks member-open staff cost entry
**File:** `supabase/migrations/20261252000000_r5_phase4_finances_denial.sql`
interacting with `app/api/finances/route.ts:95` (POST) / `:160` (`insert().select("id").single()`).

**What changed:** the only finances SELECT policy (`"finances: members can select"`, org-wide) is
narrowed to `org_id in current_org_ids() AND is_org_admin(org_id)`. INSERT/UPDATE/DELETE policies
are unchanged (still member-open).

**Exploit / break scenario:** a non-admin staff member logs a cost from the job page
(`+ Add cost → /finances/new → POST /api/finances`). The route runs under the **tenant** client:

```ts
const { data: inserted, error } = await supabase
  .from("finances")
  .insert({ org_id: ctx.org.id, amount, ... })
  .select("id")           // ← RETURNING, now subject to the admin-only SELECT policy
  .single();
if (error || !inserted) return respond.error(500, "Failed to create cost");
```

In PostgREST/PostgreSQL, `INSERT … RETURNING` (and `.insert().select()`) requires the returned row
to pass the table's SELECT policy. For a non-admin, `is_org_admin(org_id)` is false, so the row is
not returnable → `.single()` yields no row / an RLS error → `!inserted` → **HTTP 500 "Failed to
create cost"**. The documented, member-open staff workflow is broken. (Secondary: depending on how
PostgREST handles the blocked representation, this can also leave the user retrying and is at best
a hard failure of a core field-staff action.)

**Why the migration's reasoning missed it:** the header asserts the only finances read-back is
`approveExpenseDraft` (owner/admin, so the RETURNING passes) and that *"staff cost capture is the
expense_drafts submission flow (a separate table)"*. But `POST /api/finances` is member-open by
explicit design (its own comment: *"Cost ENTRY is deliberately member-open — field staff log costs
from the job page"*) and writes **directly** to `finances` with a RETURNING read on the tenant
client.

**Fix (any one):**
1. For the member-open insert path, perform the `finances` insert via the **service-role admin
   client** (org-pinned, `org_id = ctx.org.id`) so the RETURNING is not subject to the member's
   SELECT policy — mirrors the self-scoped service-role idiom already used in
   `material-request-writes.ts`; **or**
2. Add a narrow SELECT policy letting a member read finances rows **they created**
   (`created_by = auth.uid()`), so insert-with-returning works without re-opening the ledger; **or**
3. Drop the `.select("id")` RETURNING on the member path and obtain the id another way
   (e.g. a service-role follow-up read pinned to `created_by`).

**Pre-merge confirmation (coordinator, ~1 min, owns the DB):** on a narrowed-SELECT `finances`,
as a non-admin member JWT run `insert into finances(...) returning id` via PostgREST and confirm it
errors / returns no row. This is apply-held, so the finding is a pre-merge blocker, not a live
incident.

---

### HIGH-1 — Commercial denial (20261250) locks PO header but leaves `purchase_order_line_items` staff-readable
**File:** `supabase/migrations/20261250000000_r5_phase4_commercial_denial.sql` (purchase_orders)
vs `supabase/migrations/20261006000000_purchase_orders.sql:100`.

`20261250` narrows `purchase_orders` SELECT to `is_org_admin`, but the child table
`purchase_order_line_items` keeps its original policy:

```sql
create policy "po_line_items: members can select" on public.purchase_order_line_items
  for select to authenticated using (org_id in (select public.current_org_ids()));
```

No admin predicate. The line items carry the commercially-sensitive data the slice is meant to bar
from staff — **unit costs, quantities, line totals, supplier line references**. RLS on the child is
independent of the parent, so a staff JWT can `GET /rest/v1/purchase_order_line_items?select=*`
directly and read every PO's lines, even though the header is now admin-only. The slice's own
"deferred" note lists only `finances` and `stock_movements`; this child table is simply overlooked,
and the header comment claims `purchase_orders` is covered without caveating the lines.

**Impact:** defeats the purchase-orders portion of the stated threat model (bar commercial figures
from staff); staff isolation is a hard security requirement for R5.

**Fix:** add `purchase_order_line_items` (and audit the other commercial children — valuation /
variation / billing line tables — for the same gap) to the admin-only SELECT narrowing in this
slice, or explicitly document it as deferred with a tracked follow-up. The eight header tables
themselves are correctly handled (see verified items).

---

### MEDIUM-1 — Divergent "who may assign" authority: granular `hasCapability` vs coarse `is_org_admin`
**Files:** `app/(app)/jobs/actions.ts:98` (createJob), `app/(app)/jobs/[id]/assignment-actions.ts:90,169`
(crew add/remove) vs `app/(app)/jobs/actions.ts` updateJob (relies on the jobs UPDATE RLS =
`is_org_admin`) and the three RPCs in `20261246` (`is_org_admin`).

The **create** gate and the **crew-panel add/remove** gate use the granular capability model
`hasCapability(ctx, user, "jobs", "manage")` (owner always; admin only with the `jobs:manage`
grant; others never). The **updateJob primary reassignment** path has no such app gate — it relies
on the jobs UPDATE RLS (`is_org_admin`, i.e. any owner/admin regardless of granular grants) and the
RPC's own `is_org_admin`.

**Consequence:** an admin **without** the `jobs:manage` grant is **blocked** from create-with-assignee
and from crew add/remove, but **allowed** to reassign the primary via updateJob. Same logical action,
two different authority definitions. It **fails closed** (no privilege escalation) and is **not
currently exploitable** — `20261241` backfills every existing admin to a wildcard grant and prod has
0 admins — so severity is MEDIUM (consistency / potential wrong-block of a future granular admin),
not a security hole. The user-facing message *"Only owners or admins can assign…"* is also
misleading for an admin who *is* an admin but lacks the specific grant.

**Fix:** pick one authority for "assign a worker" across all three paths. Either gate updateJob's
reassignment on `hasCapability("jobs","manage")` too (consistent granular model), or gate
create/crew-add on `is_org_admin`-equivalent (coarse) — and align the DB RPC (`is_org_admin`) with
the chosen app gate so a gate pass can never be followed by an RPC 42501 (which today would silently
log-and-continue in createJob, leaving a job unassigned under "Job created.").

---

## Verified correct (adversarial checks that did NOT falsify)

### F1 — `add_job_worker` (mig 20261246) — SOUND
- **Lock before any write:** the three mutators (`set_job_primary_assignment`, `remove_job_worker`,
  `add_job_worker`) each take `pg_advisory_xact_lock(hashtext('job_assignment'), hashtext(p_job_id::text))`
  **after** the read-only org/admin guards and **before** the first row read/write. Confirmed in all
  three bodies.
- **Guards & error codes:** org guard → `42501`; admin guard (`is_org_admin`) → `42501`; job-not-in-org
  → `P0002`; worker-not-a-member → `23514`. Correct and present in `add_job_worker`.
- **Add-vs-remove resurrection:** the lock closes the real F1 race — `set_job_primary_assignment`'s
  RULE-1 re-insert of the *outgoing primary* can no longer interleave with a concurrent
  `remove_job_worker` to resurrect an explicitly-removed worker (both orders now end with the worker
  removed). Two *deliberate* concurrent admin ops (remove W ‖ add W) resolve last-writer-wins, which
  is correct concurrent intent, not a defect.
- **Deadlock-free:** every function acquires exactly ONE advisory lock, same key namespace, before
  any row lock; none acquires a second advisory lock or an advisory lock after a row lock → no lock
  ordering inversion. Different jobs use different keys; `hashtext` collisions can only cause benign
  extra serialization, never deadlock or incorrectness.

### F2 — createJob pre-insert gate — CORRECT (modulo MEDIUM-1 divergence)
- `if (result.data.assigned_to && !(await hasCapability(ctx, user, "jobs", "manage")))` runs **before**
  the insert; the insert never sets `assigned_to` (assignment is RPC-only), and the RPC re-checks
  `is_org_admin` — double layer. A non-admin cannot get an assignee set. An owner passes; a
  wildcard-backfilled admin passes (`grantAllows` matches `*`). No bypass found.

### Mig 20261250 / 20261252 — one SELECT policy each, drops match real names
- For all 8 commercial tables **and** `finances`, the `drop policy if exists "<name>"` string matches
  the **exact** (and only) existing SELECT policy name in the source migration — verified against
  20261072 / 20261192 / 20261039 / 20261221 / 20261005 / 20261006 / 20260623 / 20260515180000. No
  leftover permissive SELECT policy survives; no table had a second SELECT or a `FOR ALL` policy.
- `is_org_admin` (current def, 20260701) resolves to owner/admin membership (or impersonated-org
  admin) — truly blocks non-admin staff, and owners/admins keep full read. No legitimate owner/admin
  read is broken by the narrowings themselves.

### Mig 20261253 — six report RPC bodies reproduced VERBATIM
- Byte-diff of each RPC body (between the dollar-quote tags) against its original, after removing only
  the added admin-guard block, is **IDENTICAL** for all six:
  `report_profit_labour_hours`, `report_profit_stock_cogs` (← 20261239);
  `report_aged_receivables` (← 20261238); `reports_revenue_per_month`, `reports_jobs_per_week`
  (← 20261240); `reports_top_customers_by_revenue` (← 20261237). No accidental logic change.
- The only change is the inserted `if auth.role() is distinct from 'service_role' and not
  public.is_org_admin(<org>) then raise … 42501;` guard, placed after the existing membership guard —
  identical shape to the already-correct sibling `report_aged_payables` (which already had it). The
  originals had **zero** `is_org_admin` references, confirming all six were genuinely member-only and
  are now closed. `service_role` (delivery cron) still bypasses both guards.

### Service-role (`createAdminClient()`) paths — no authz gap found
- `app/(app)/jobs/[id]/assignment-actions.ts` — `hasCapability("jobs","manage")` is checked **before**
  the admin client is constructed; every statement pins `org_id = ctx.org.id`; writes route through
  the locked RPCs which re-check org/admin/member. `job_assignments` is service-role-only, so staff
  have no direct write path. Clean.
- `server/services/expense-drafts.ts` — `approveExpenseDraft` is owner/admin-gated (explicit
  `role !== 'owner' && role !== 'admin'` refusal) before the finances insert; the tenant-client
  RETURNING passes because the caller is always an admin. OK under 20261252.
- `server/services/material-request-writes.ts` — the admin client is used **only** for self-scoped
  idempotency reads, each pinned to `org_id` **and** `client_write_key` **and** `created_by = userId`
  (`findOwnRequestId`), so it can never surface another member's row. Writes are org-pinned. Clean.

---

## Residual / breadth caveats (not blockers)
- **Indirect-leak breadth beyond the 8 tables:** views, other SECURITY DEFINER RPCs granted to
  `authenticated` that echo commercial figures, and signed URLs are out of this slice's base-table
  scope. Recommend a census of all `security definer` RPCs with `grant execute … to authenticated`
  that read commercial tables (the report-RPC slice closed 6; confirm none remain).
- **finances INSERT/UPDATE stay member-open** (unchanged, by product decision) — staff can still
  insert/update ledger rows directly; this is pre-existing and out of scope for a read-denial slice,
  noted for awareness.
- Typecheck / unit tiers not run here (branches are far ahead of `main`; CI reported green on the
  source PRs). Findings above are static-analysis based.
