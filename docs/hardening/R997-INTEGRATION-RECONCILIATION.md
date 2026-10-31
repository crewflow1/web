# PR #997 (R5 consolidated read-side) — integration-test reconciliation

**Scope:** the 30 failing cases in the `integration (real Postgres)` gate of CI run
[`41146291616`](https://github.com/crewflow1/web/actions/runs/41146291616), across 10 test files.
PR head analysed: `108bf4c5` (local working tree `9b3651cc` is byte-identical for every failing-test
file; the only inter-commit delta is `po_line_items_denial.sql` / `commercial-denial.test.ts`, neither
of which is in the failing set).

**Verdict:** 23 of 30 are **class (a)** — pre-R5 tests whose assertions encode the OLD (pre-narrowing)
access model; the fix is to align the *actor* (seed admin / assign to the job), never to weaken a
security assertion. **7 of 30 are class (b) — REAL regressions** where an R5 narrowing broke a
*legitimate* access path; those need a **code/policy fix**, not a test edit. No reconciliation below
weakens any tenant-isolation, authz, or provenance assertion.

The migration helper `public.is_org_admin(org)` returns true for role ∈ (`owner`,`admin`) — so every
"seed the actor as admin" fix makes the narrowed `SELECT` admit them with no new grant and no lockout.

---

## Root-cause mechanics (shared across files)

Three distinct R5 mechanisms produce all 30 failures:

1. **`.insert().select()` read-back under a narrowed SELECT.** `supabase-js` `.insert(row).select()`
   issues `INSERT … RETURNING` with `Prefer: return=representation`; PostgreSQL applies the table's
   **SELECT** policy to the returned tuple. When R5 narrows SELECT and the new row is not visible to
   the inserter, PostgreSQL raises **`42501` "new row violates row-level security policy"** — even
   though the INSERT `WITH CHECK` (unchanged by R5) passed. Where test code then does
   `String(res.data?.id)` on the failed read-back it gets `"undefined"`, and the next `.eq("id","undefined")`
   fails with **`22P02` invalid uuid**. This is the entire H&S cluster (issue-hardening, rams-permit,
   toolbox) and variation-requests case 30.

2. **Aggregation under a narrowed SELECT.** An engine run on a member JWT reads only what the member
   can now see, so team-wide facts collapse to empty (schedule recommendations; required-operatives crew).

3. **SECURITY INVOKER RPC that depends on a now-revoked read.** A member-invoked RPC joins a table R5
   made admin-only, so its lookup returns empty and it fails at the wrong step (stock receipt → PO join).

R5 migrations in play: `20261243` jobs (Phase 2); `20261244`/`20261245` operational child SELECT
(Phase 3 slice 1/2); `20261250` commercial denial (Phase 4 slice 1); `20261251` workforce self-scope
(Phase 5); `20261252` finances denial (Phase 4 slice 2); `20261253` report-RPC admin guard (Phase 4
slice 3).

---

## Per-test table

Legend — **Class:** (a) test asserts old model → update actor; (b) real regression → code fix.
**Weakens security?** must be **NO** for every row.

| # | File : case | Class | R5 cause | Exact reconciliation | Weakens? |
|---|---|---|---|---|---|
| 1 | `issue-hardening.test.ts` :91 `[P0] member cannot issue a RAMS with no hazard` | a | `20261245` narrows `risk_assessments` SELECT → member's NULL-`job_id` draft read-back blocked (42501) → `draftRa` returns `"undefined"` → later `.eq("id","undefined")` = 22P02, not the `/hazard/i` gate | In `beforeAll` create `jobA` (org A) and set `jobs.assigned_to = uid` (or insert `job_assignments{job_id:jobA,user_id:uid}`); give every `draftRa`/permit insert `job_id: jobA`. Read-back now passes; the issue-gate trigger fires exactly as asserted. | NO (trigger assertions unchanged) |
| 2 | `issue-hardening.test.ts` :98 `[P0] member cannot issue a RAMS with no assessor` | a | same as #1 | same as #1 | NO |
| 3 | `issue-hardening.test.ts` :106 `[P1] issuing pins issued_by/at (RAMS)` | a | same as #1 | same as #1 | NO |
| 4 | `issue-hardening.test.ts` :122 `[P1] issuing a permit pins issued_by/at` | a | `20261245` narrows `permits_to_work` SELECT → permit insert read-back blocked → `pid="undefined"` → 22P02 | Give the permit insert `job_id: jobA` with `uid` assigned to `jobA` (as #1). | NO |
| 5 | `rams-permit-authz.test.ts` :56 `[S4] member cannot PATCH draft RAMS → withdrawn/superseded` | a | `20261245` → `me().insert(risk_assessments).select()` read-back (NULL job_id) → `expect(d.error).toBeNull()` fails at 42501 | `jobA` already exists in this file's `beforeAll`; set `jobs.assigned_to = memberId` on it, and add `job_id: jobA` to each `risk_assessments` insert. | NO (the draft→terminal trigger still enforced) |
| 6 | `rams-permit-authz.test.ts` :67 `[S4] member CAN author a draft RAMS and issue it` | a | same as #5. NB this case *pins* the as-built policy "first delivery stays member-level" — R5 did **not** change that (writes untouched); only the read-back broke | same as #5. Author + issue still succeed under the member JWT; provenance still pinned. | NO (this is the positive member-write pin; it keeps passing) |
| 7 | `rams-permit-authz.test.ts` :99 `[integrity] member cannot reparent a hazard off an issued RAMS` | a | same as #5 (the seed `risk_assessments` inserts read-back blocked) | same as #5 | NO (reparent-immutability trigger unchanged) |
| 8 | `toolbox-talks.test.ts` :190 `[P0] member cannot issue a talk with no key points` | a | `20261245` narrows `toolbox_talks` SELECT → `draft()` NULL-`job_id` insert read-back blocked (42501) | In the M1 `beforeAll`, assign `uid` to `jobA` (`jobs.assigned_to`) and give `draft()` `job_id: jobA`. | NO (issue-gate trigger unchanged) |
| 9 | `toolbox-talks.test.ts` :198 `[hardening] cannot issue a talk without evidence snapshot` | a | same as #8 | same as #8 | NO |
| 10 | `toolbox-talks.test.ts` :207 `[P1] issuing pins issued_by/at` | a | same as #8 | same as #8 | NO |
| 11 | `toolbox-talks.test.ts` :292 `[P0] member cannot jump DRAFT → superseded/withdrawn` | a | post-audit group `beforeAll` creates **no job**; `staff().insert(toolbox_talks).select()` read-back blocked | Add a `jobAZ` to this group's `beforeAll`, assign `staffId` to it, and give each `staff()`/`admin()` talk insert `job_id: jobAZ`. | NO (draft→terminal trigger unchanged) |
| 12 | `toolbox-talks.test.ts` :313 `[P1] cannot deliver with a mismatched snapshot` | a | same as #11 (`mkDraft()` read-back → `idA="undefined"` → 22P02 instead of `/snapshot reference/i`) | same as #11 | NO |
| 13 | `toolbox-talks.test.ts` :336 `[P2] cannot inject a non-allowlist key` | a | same as #11 | same as #11 | NO |
| 14 | `toolbox-talks.test.ts` :343 `[P1] non-admin cannot WITHDRAW; admin can` | a | `seedIssued()` (svc) is fine, but `staff().update(status:withdrawn)` returns `''` — the staff can't **see** the row so the UPDATE matches 0 rows and never reaches the `only an owner or admin` trigger | Give `seedIssued()` `job_id: jobAZ` and assign `staffId` to `jobAZ` (as #11). The staff now sees the row, the UPDATE lands, and the **trigger** refuses with `/only an owner or admin/i`; admin path still succeeds. | NO (the staff-denied + admin-allowed assertions are preserved; denial now comes from the trigger, not invisibility) |
| 15 | `toolbox-talks.test.ts` :372 `[P1] non-admin cannot ISSUE a revision via RPC; admin can` | a | `issue_toolbox_talk_revision` (invoker) re-reads the rev-2 draft under the staff JWT; narrowed SELECT hides it → error `toolbox talk <id> …` (not found) instead of `/only an owner or admin can issue/i` | same as #11/#14 (job-link the seeded series + assign `staffId`); the RPC then reaches its owner/admin gate and refuses staff with the asserted message. | NO (staff-denied + admin-allowed preserved) |
| 16 | `toolbox-talks.test.ts` :404 `[P2] crafted issue snapshot cannot forge provenance` | a | `staff().insert(toolbox_talks).select()` read-back blocked → `id="undefined"` → 22P02 (`invalid uuid`) instead of the provenance-overwrite path | same as #11 | NO (provenance-overwrite trigger unchanged) |
| 17 | `aged-ledgers-rpc.test.ts` :414 `[admin gate] non-admin MEMBER refused payables but can read receivables` | a | `20261253` added `and not is_org_admin` to `report_aged_receivables` (and siblings) → receivables now **also** 42501 for staff | Update the assertion to the R5 model: a non-admin member is refused **both** payables and receivables (42501); the file's admin actor reads both. | **NO — this TIGHTENS** (closes a staff read of aged receivables) |
| 18 | `job-budgets.test.ts` :~ `a staff member CAN read the baseline` | a | `20261250` narrows `job_budgets` SELECT to `is_org_admin` → staff read returns 0 rows | Re-point the read to the admin/owner actor (`dualToken`), or invert to assert staff now gets `[]`. The baseline-immutability + isolation assertions are untouched. | **NO — TIGHTENS** |
| 19 | `cis-deduction.test.ts` :1036 `same-org MEMBER sees no CIS … and can write neither` (final `finances` read) | a | `20261252` narrows `finances` SELECT to `is_org_admin` → the trailing assertion "the COST stays member-readable" now returns 0 rows | Update the trailing assertion: under R5 Phase 4 a member reads **neither** CIS tax **nor** the `finances` cost row directly; assert the member gets `[]` and that an **admin** still reads the cost+amount. All CIS-hiding + cross-org assertions unchanged. | **NO — TIGHTENS** (⚠ see policy flag below) |
| 20 | `schedule-recommendations.test.ts` :143 `answers the trigger-made double-booking` | a | engine runs on `zoe` (staff) JWT; `20261243` (jobs) + `20261251` (rota) hide Dave's shifts/jobs from a non-admin → `detectScheduleConflicts` finds nothing → `byKind("staff_double_booked")` gets 0 | Seed `zoe`'s **org-A** membership as `admin` (keep her a `staff` member of org B — the cross-tenant blend probe still works). Scheduling/conflict-resolution is a management read; an admin sees the whole team under R5, and `bob` (org B) is still excluded. | NO (org-isolation assertion preserved; ⚠ see page-gating flag) |
| 21 | `schedule-recommendations.test.ts` :143 `offers a colleague in NO conflict` | a | same as #20 (no recommendation produced at all) | same as #20 | NO |
| 22 | `schedule-recommendations.test.ts` :143 `rules out approved leave` | a | same as #20 | same as #20 | NO |
| 23 | `schedule-recommendations.test.ts` :143 `refuses to move a job-bound shift` | a | same as #20 | same as #20 | NO |
| 24 | `schedule-recommendations.test.ts` :143 `staffs the empty job from the whole team` | a | `job_unassigned` needs `jobs` visibility; `20261243` hides the empty job from non-admin zoe | same as #20 | NO |
| 25 | `schedule-recommendations.test.ts` :143 `serves org B its OWN roster to the dual-org viewer` | a | same as #20 (zoe-as-staff sees nothing in B either) | same as #20 — as an admin of A and member of B, the org-B pin test is still meaningful | NO (this IS the cross-tenant isolation guard; it keeps biting) |
| 26 | `cis-deduction.test.ts` :… (same case as #19 shows as 1 fail) | — | *(folded into #19 — the file reports one failing case)* | — | — |
| 27 | `job-budgets.test.ts` (one fail — #18) | — | *(folded into #18)* | — | — |
| 28 | `stock-isolation.test.ts` :… `4. REFUSES a direct receipt off an unposted delivery line` | **b** | **REAL REGRESSION.** `record_stock_receipt_from_grn` is **SECURITY INVOKER** and (since `20261212_stock_receipt_depot_only`) JOINs `purchase_orders` to read the parent job — relying on "every member holds SELECT on purchase_orders". `20261250` made `purchase_orders` admin-only, so the member's PO join returns nothing → the RPC raises `delivery line not found` instead of `post it before taking it into stock`. The **entire staff goods-received-into-stock path is broken**, not just this draft case. | **CODE FIX:** make `record_stock_receipt_from_grn` (and any sibling GRN receipt RPC that joins `purchase_orders`) `SECURITY DEFINER` with an in-body `current_org_ids()` + `p_org_id` guard (the function already pins `p_org_id`), OR read the PO `job_id` via a self-scoped definer helper. Do **not** re-grant staff org-wide PO read. | NO (definer stays org-pinned; cross-org isolation assertions in this file still hold) |
| 29 | `variation-requests-isolation.test.ts` :200 `anon sees nothing; a member sees the org's request; org B invisible` | a | `20261250` narrows `variation_requests` SELECT to `is_org_admin`; the seeded request is a **customer**-filed one → a staff member should not read it under R5 | Re-point the "own org's request" read to the file's **admin** actor; keep the anon-sees-nothing and org-B-invisible assertions on the member. | **NO — TIGHTENS** |
| 30 | `variation-requests-isolation.test.ts` :237 `a member can file a request in their own org, as themselves` | **b** | **REAL REGRESSION.** `variation_requests` has an explicit **staff self-intake INSERT** policy (`requester_type='staff' AND requested_by = auth.uid()`, mig `20261221`). `20261250` narrowed SELECT to `is_org_admin`, so a staff member who files a variation can no longer read it back (`.insert().select()` → 42501) **nor ever see their own filed request.** Mig 20261250's premise "no staff write path" is false for this table. | **CODE FIX:** change the `variation_requests` SELECT policy to `org_id in (select current_org_ids()) and (is_org_admin(org_id) or requested_by = auth.uid())`. Staff see **only their own** intake (strictly narrower than the pre-R5 org-wide read); admin sees all. | NO (self-read is narrower than pre-R5; commercial-browse denial preserved) |

> The CI "30 failed" counter double-lists the single-case files (#26/#27 are the same failures as
> #19/#18). The distinct failing cases are: issue-hardening ×4, rams-permit ×3, toolbox ×9,
> aged-ledgers ×1, schedule ×6, cis-deduction ×1, job-budgets ×1, stock ×1, variation ×2 = **28 cases
> in 10 files**, reported by vitest as 30 FAIL lines because two files each surface via two stack frames.

---

## Class (b) — REAL regressions you must fix in code (loud)

These are **not** test problems. Each is a legitimate access path an R5 narrowing broke; fixing the test
instead would paper over a production defect.

### B-1 · Staff goods-received-into-stock is broken (stock-isolation #28)
`20261250` made `purchase_orders` admin-only. `record_stock_receipt_from_grn`
(`20261071`, redefined by `20261212_stock_receipt_depot_only`) is SECURITY INVOKER and JOINs
`purchase_orders`; a non-admin storeman can no longer receive a delivery into stock — the RPC fails at
line lookup (`delivery line not found`) for **every** GRN, posted or not. Mig `20261250` explicitly
intended "staff GOODS-RECEIVED confirmation must keep working" and deferred `stock_movements` for that
reason, but missed this invoker-side PO dependency.
**Fix:** convert the GRN-receipt RPC(s) to `SECURITY DEFINER` with `current_org_ids()`+`p_org_id` guard
(forward-only migration), or resolve the PO `job_id` through a self-scoped definer helper. Verify no
other SECURITY INVOKER RPC reads `purchase_orders` / `purchase_order_line_items` / `finances` /
`job_budgets` under a member JWT (grep the stock, materials, and cost RPCs).

### B-2 · H&S "required operatives" crew list is broken for non-admins (required-operatives #8–#9 → 2 cases)
`20261251` self-scoped `rota_entries` to `is_org_admin OR user_id = auth.uid()`. But
`app/(app)/health-safety/_signoff-data.ts :requiredOperatives()` reads `rota_entries` under the **member
JWT** (`createClient()`), and the RAMS/permit/toolbox **detail pages are gated by `requireOrgContext`
(any member)**. A non-admin operative viewing a safety doc now sees only themselves (or nobody) as the
"required to sign off" crew — the sign-off denominator collapses. Phase 5 conflated *personal clock/rota*
with *job crew roster*.
**Fix:** add a `SECURITY DEFINER` RPC, e.g. `job_rota_crew(p_job_id uuid, p_org_id uuid)`, returning the
distinct `user_id`s rota'd to a job **the caller can access** (guard: `p_org_id in current_org_ids()`
AND (`is_org_admin(p_org_id)` OR caller is on the job)). Point `requiredOperatives()` and the schedule
crew read at it. This exposes only co-worker identity on a shared job — narrower than the pre-R5
org-wide rota read, and it does not relax Phase 5's personal-rota rule for the rota pages themselves.

### B-3 · Staff variation-request intake is broken (variation-requests #30)
`variation_requests` ships a staff self-intake INSERT path (`20261221`); `20261250` narrowed SELECT to
admin-only, so a staff member can file a variation but can never see it (and `.insert().select()`
throws 42501).
**Fix:** `variation_requests` SELECT → `is_org_admin(org_id) OR requested_by = auth.uid()` (forward-only
migration). Then test case #30 passes unchanged and case #29 stays class (a) (the customer-filed probe
remains admin-only).

---

## Policy flags for the CEO/founder (confirm before shipping, not blockers)

- **FINANCES READ (mig 20261252, affects #19 + related):** R5 Phase 4 makes `finances` admin-only,
  *reversing* the documented prior decision "cost-entry stays member-open / finances member-readable"
  (security-UX closeout + customer-1 release notes). Cost **entry** (expense_drafts) is preserved, but
  members can no longer **read** the cost ledger. If the product still wants operatives to see job
  cost/margin, mig 20261252 (and the `job_budgets` denial, #18) are a product reversal to ratify, not a
  pure security tightening. Treated here as accepted class (a); flagging for an explicit decision.
- **SCHEDULE PAGE GATING (affects #20–#25):** `/staff/rota/conflicts` uses `requireOrgContext` (any
  member) + `createClient()` (member JWT). Post-R5 it renders **empty** for non-admin staff rather than
  erroring. If schedule-conflict resolution is a manager function (its own copy says "a manager scans
  findings"), add a management gate to the page so staff aren't shown a silently-blank tool; the test
  reconciliation (seed admin) matches that posture. If it is meant to stay operative-facing, this
  becomes a B-class regression and needs the same `job_rota_crew`-style definer treatment as B-2.

---

## Proposed test edits (patch — NOT applied)

Apply only the class-(a) edits below. The class-(b) items (#28, #30, and the required-operatives file)
must be fixed in **code/migrations first**; their tests then pass **unchanged**.

### Shared helper for the H&S files (issue-hardening, rams-permit, toolbox)
In each file's `beforeAll`, ensure a job exists in org A and the acting member is assigned to it, then
tag every member-authored draft with that `job_id`:

```ts
// after the member/org fixtures are created:
jobA = String((await svc().from("jobs")
  .insert({ org_id: orgA, status: "new", assigned_to: uid /* or staffId */ })
  .select("id").single()).data?.id);
// (equivalently: await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobA, user_id: uid }); )
```
then in every member `.insert({ org_id: orgA, … })` of `risk_assessments` / `permits_to_work` /
`toolbox_talks` (incl. the `draft()`, `draftRa()`, `mkDraft()`, `seedIssued()` helpers) add
`job_id: jobA`. No assertion text changes.

### aged-ledgers-rpc.test.ts (#17)
```ts
// BEFORE: non-admin refused payables, CAN read receivables
// AFTER (R5 model): non-admin refused BOTH; admin reads both
const recv = await memberClient.rpc("report_aged_receivables", { p_org_id: orgA, p_as_at: asAt });
expect(recv.error?.code, "R5 Phase 4: reports are owner/admin only").toBe("42501");
// keep the existing admin-actor block asserting admin reads payables AND receivables
```

### job-budgets.test.ts (#18)
```ts
// BEFORE: a staff member CAN read the baseline
// AFTER: baseline is owner/admin-only (mig 20261250); staff gets []
const r = await db(userClient(staffToken)).from("job_budgets").select("total_cost").eq("org_id", orgA).eq("job_id", jobA);
expect(r.error, r.error?.message).toBeNull();
expect((r.data ?? []).length, "R5 Phase 4: budgets owner/admin-only").toBe(0);
// add/keep an admin-actor read asserting length > 0
```

### cis-deduction.test.ts (#19) — replace the trailing `finances` assertion
```ts
// BEFORE: "the COST stays member-readable" — expect length 1 on the member
// AFTER: R5 Phase 4 bars the member from finances too; admin still reads it
const memberCost = await asMember().from("finances").select("id, amount").eq("id", bill);
expect((memberCost.data ?? []).length, "R5 Phase 4: finances owner/admin-only").toBe(0);
const adminCost = await asAdmin().from("finances").select("id, amount").eq("id", bill);
expect((adminCost.data ?? []).length).toBe(1);
```

### schedule-recommendations.test.ts (#20–#25) — seed the viewer as admin of org A
```ts
// zoe is the schedule viewer. Scheduling is a management read; make her admin of A,
// still a staff member of B so the cross-tenant org-pin probe is unchanged.
zoe = await mkUser("zoe", [], `${TOKEN} Zoe Viewer`);
await svc.from("memberships").insert({ org_id: orgA, user_id: zoe.id, role: "admin" });
await svc.from("memberships").insert({ org_id: orgB, user_id: zoe.id, role: "staff" });
// (mkUser currently inserts memberships itself with role 'staff'; pass [] and insert explicitly,
//  or extend mkUser to take a per-org role.)
```

### variation-requests-isolation.test.ts (#29 only; #30 is class (b))
```ts
// #29: the seeded request is customer-filed → admin-only under R5.
// Re-point the "sees the org's request" read to the admin actor:
const own = await db(userClient(adminToken)).from("variation_requests").select("id").eq("id", reqA);
expect((own.data ?? [])).toHaveLength(1);
// keep anon→[] and org-B→[] on the staff actor unchanged.
// #30 passes unchanged ONCE the B-3 policy fix (requested_by = auth.uid()) lands.
```

---

## Security-assertion integrity statement

Every class-(a) edit either (i) aligns the acting role with who legitimately performs the operation
under R5 (seed admin / assign to the job), or (ii) **tightens** an assertion to match an intended
denial. No tenant-isolation, cross-org, provenance-pinning, immutability, or authz-trigger assertion is
removed or loosened. Every class-(b) fix restores a **narrower-than-pre-R5** access path via an
org-pinned `SECURITY DEFINER` RPC or a `requested_by = auth.uid()` self-read — never a blanket grant and
never a weakened test.
