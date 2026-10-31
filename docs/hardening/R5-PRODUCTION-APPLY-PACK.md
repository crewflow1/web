# R5 — Production Migration Apply Pack

**Prepared:** 2026-10-31 · **Author:** autonomous engineering (Claude) · **Status:** awaiting explicit founder DB-apply approval.

This pack covers **applying R5 migrations `20261242` → `20261259` (incl `20261246`) to the single production Supabase**. The **code is already merged and live** (founder-authorized code-only merge of #997 + #998); this is the remaining, separately-gated production-database step.

> **Approval boundary.** Nothing in this pack has been executed against the production database. No migration has been applied. The apply is **held** pending the founder's explicit "apply approved" in chat.

---

## 1. Where we are now (verified)

| Fact | Value | How verified |
|---|---|---|
| main tip | `9005fd0b` | `git rev-parse origin/main` |
| main tree | `dbe583a5` (== the tree that passed 8558 security + 1696 RLS integration tests) | tree-oid equality |
| R5 migrations on main | `20261242`–`20261259` incl `246`, contiguous, each prefix once (418 total = 400 + 18) | `git ls-tree` |
| **Production DB tip** | **`20261241000000`** (R5 NOT applied) | `supabase db query --linked` on `schema_migrations` |
| `job_assignments` in prod | **absent** | `to_regclass` probe on prod |
| `stock_movements_operational` in prod | **absent** | `to_regclass` probe on prod |
| Prod app health | `200 healthy`, `db: ok`, serving sha `8a166c8` | `GET crewflow.uk/api/health` |
| Off-platform backup (freshest) | `~/CrewFlow-backups/pre-20261241-2026-10-29` (+ full encrypted dump `2026-10-20.tar.enc`) | `ls` |
| PITR | **OFF** (CEO-deferred cost decision) | standing decision |

---

## 2. Deployment health — the code-ahead-of-schema window (READ FIRST)

Merging to `main` **auto-deploys to Vercel production.** The merged R5 **code** is therefore reaching production **before** its **schema**. This is an inherent consequence of the "merge code now, apply migrations later" sequence. Impact, assessed from the actual code paths:

**Currently live (prod = `8a166c8`, the #998 merge) — LOW impact, no outage:**
- The owner/admin **job crew panel** (`_assignments.tsx`) reads the not-yet-existing `job_assignments` table. The read is **error-handled**: it renders a contained red "Couldn't load who's assigned…" panel and **does not crash the page**. It is **owner/admin-only** (`{isAdmin ? … : null}`), inside a Suspense boundary — **staff are unaffected**, and every other section of the job page renders normally.

**Will occur once the #997 merge (`9005fd0b`) promotes to prod — BOUNDED hard-error until migrations apply:**
- `listStockMovements` (loud read — **throws** on error, by the #480 doctrine) reads the not-yet-existing `stock_movements_operational` view. Blast radius is **exactly two pages**: `/stock/items/[id]` and `/stock/locations/[id]`. They will error until migration `20261257` is applied. (Loud-throw is correct design — the fix is to apply the schema, **not** to soften the read.)
- **Offline replay** of a re-sent material-request / site-diary item uses `find_own_*` RPCs (migrations `255`/`259`), absent in prod → the replay idempotency branch errors. First-sync is unaffected; only a *replayed* queued item is affected.

**Resolution:** applying migrations `242`→`259` **fully closes this window** — the crew panel, both stock detail pages, and offline replay all recover immediately. **This is the main reason to apply promptly.**

**Founder options if you want zero window before applying:**
1. **Apply now** (recommended) — approve this pack; the window closes on completion.
2. **Hold the `9005fd0b` Vercel production promotion** until the apply is done (prod stays on `8a166c8`, which only has the graceful admin-panel degradation). Requires a Vercel-side action (not performed autonomously).

---

## 3. Exact migration sequence (apply in prefix order, one at a time)

```
20261242  job_assignments .............. P1 table + backfill (service-role-only)      [#998]
20261243  r5_phase2_jobs_assignment_rls  P2 jobs assignment-aware SELECT              [#997]
20261244  r5_phase3_operational_child_rls P3 children slice 1 + my_assigned_job_ids() [#997]
20261245  r5_phase3_operational_child_rls_slice2  P3 children slice 2                 [#997]
20261246  job_assignment_reconciliation  reconciliation RPCs + per-job advisory lock  [#998]
20261247  r5_phase3_material_requests_rls P3 material requests + lines                [#997]
20261248  r5_phase3_job_documents_rls .. P3 job documents + versions + download gate  [#997]
20261249  r5_phase3_job_photos_storage_rls P3 job-photo storage read                  [#997]
20261250  r5_phase4_commercial_denial .. P4 8 commercial tables → admin-only SELECT   [#997]
20261251  r5_phase5_workforce_self_scope P5 rota/time entries self-scope              [#997]
20261252  r5_phase4_finances_denial .... P4 finances SELECT → admin (cost entry kept) [#997]
20261253  r5_phase4_report_rpc_admin_guard P4 6 report RPCs → is_org_admin            [#997]
20261254  r5_phase4_po_line_items_denial P4 PO line items → admin-only                [#997]
20261255  r5_material_request_own_lookup_rpc  offline own-row lookup RPCs             [#997]
20261256  r5_phase4_access_regressions . P4 GRN/crew/variation regressions            [#997]
20261257  r5_phase4_stock_movements_masking  P4 stock read-split (operational view)   [#997]
20261258  r5_phase4_stock_write_rpcs_definer P4 stock write RPCs → SECURITY DEFINER   [#997]
20261259  r5_fix_own_lookup_rpc_uuid_param   fix: own-lookup RPC uuid param (255 bug) [#998/#997]
```

Hard dependency encoded by prefix order: `246` needs the `244` union helper (`my_assigned_job_ids()`); `259` supersedes the `255` RPC signatures. The whole chain was applied in this order on a fresh DB (exit 0) and the combined schema passed the full RLS integration tier (130 files / 1696 tests).

**Apply mechanism (CrewFlow standard — run from `~/Code/web`, linked project):** apply each migration file in order and mark it applied; verify the catalogue after each. Do **not** chain `checkout → db push` with `;` (worktree-lock lesson). The exact operator commands are withheld from this doc until approval; on approval they will be run one-at-a-time with per-step verification.

---

## 4. Lockout risks + mitigations

| # | Risk | Likelihood | Mitigation / evidence |
|---|---|---|---|
| L1 | **P2 jobs SELECT (`243`) hides all jobs from staff** if `my_assigned_job_ids()` is wrong | Low | `jobs-assignment-access` + `job-assignments` integration tests green on combined schema; staff see assigned jobs, admins see all. Backfill (`242`) carries existing `jobs.assigned_to` into `job_assignments`, and the crew panel bridges the legacy single-assignee, so no currently-assigned worker loses access. |
| L2 | **Commercial/finances denial (`250`/`252`) locks an admin out of money** | Very low | Policies are `is_org_admin OR owner`; owners are wildcard. `commercial-denial` 7/7, `active-org-finance-scoping` 64/64. Staff **cost entry preserved** (regression-tested) — only *reads* of the ledger are narrowed. |
| L3 | **Report RPCs (`253`) 42501 for legitimate admins** | Very low | Guard is `is_org_admin`; `report-rpc-admin-guard` 6/6; reporting intact for admins/owners. |
| L4 | **Stock masking (`257`) zeroes staff stock quantities** | Low | Read-split, not blanket denial: staff read the cost-free `stock_movements_operational` (quantities intact, unit-cost/cost-effect NULL). Quantity visibility preserved by design. |
| L5 | **Prod has multi-org users who straddle the new scope** | None known | Prod has **0 multi-org users** (active-org programme finding). |
| L6 | **Code-ahead-of-schema window** (§2) | Active now | Closed by this apply. Bounded to 2 stock pages + admin crew panel + offline replay in the interim. |

No migration drops a column or table that holds live data; all are additive (new table `job_assignments`, new view, new RPCs) or policy/grant changes. Data-API grant discipline honoured (`job_assignments` is service-role-only — no client grant).

---

## 5. Rollback / recovery procedure

**Per-migration rollback (fast path, no data loss):** every R5 migration carries a `ROLLBACK:` header. Because the set is additive + policy-only:
- **Policy/RPC migrations** (`243`–`254`, `256`–`259`): roll back by `DROP POLICY` / `DROP FUNCTION` / restoring the prior policy from the migration's rollback header. No data is touched.
- **`242 job_assignments`**: `DROP TABLE public.job_assignments` (new table; the legacy `jobs.assigned_to` data is untouched and remains the source of truth).
- **`257 stock masking`**: drop the `stock_movements_operational` view and restore the prior direct grants (header documents this).

**Full restore (worst case):** restore the off-platform snapshot. Current freshest is `pre-20261241-2026-10-29`. **Recommended before apply:** take a **fresh at-`20261241` snapshot** (non-destructive `pg_dump` via the IPv4 pooler with stored creds) so the restore point is exactly the pre-R5 state. Restore is **proven** (80s real-data exact-match, ops-gate 2026-08-29).

**No PITR:** point-in-time recovery is OFF (CEO cost decision), so the restore granularity is the snapshot, not arbitrary time. This raises the value of the fresh pre-apply snapshot.

**Recovery triggers:** any post-apply verification step (§6) failing that cannot be hot-fixed forward within minutes → roll back the offending migration via its header; if integrity is in doubt → full restore from the pre-apply snapshot.

---

## 6. Post-apply security verification (run immediately after apply)

1. **Catalogue:** prod `schema_migrations` tip == `20261259000000`; `job_assignments`, `stock_movements_operational`, `my_assigned_job_ids()`, reconciliation RPCs, `find_own_*(uuid,uuid)` all present.
2. **Health:** `GET crewflow.uk/api/health` → `200 healthy db:ok`; the two stock detail pages and the admin crew panel render (window closed).
3. **Staff isolation (the core proof):** on a **real staff login** — assigned job visible, non-assigned job denied; commercial/finance tiles absent; stock quantities visible but costs masked; another worker's rota/time not readable.
4. **Admin/owner intact:** admin sees all jobs + money + reports; cost entry by a non-admin still succeeds; reporting works.
5. **Regression guards on prod data:** `secdef-org-rpc-guard` shape holds (no new anon/PUBLIC exposure); `job_assignments` carries no client grant.
6. **First-customer smoke:** the staff-denial scenario behaves on prod as in CI.

A scripted read-only verification harness will be run for 1/2/5; 3/4 require a real login (founder-assisted or a seeded staff account).

---

## 7. Approval requested

**Requested:** explicit founder approval to **apply migrations `20261242`→`20261259` (incl `20261246`) to production**, in prefix order, one-at-a-time with per-step catalogue verification, immediately preceded by a fresh pre-apply snapshot.

On "apply approved" I will: (a) take the fresh `20261241` snapshot, (b) apply the chain with verification after each step, (c) run §6, (d) report the result. On any failure I will stop, roll back per §5, and report — I will not force past a failed verification.

**Still outside this pack (unrelated external gates):** Stripe (`STRIPE_SECRET_KEY`/webhook), Resend (`RESEND_API_KEY` + domain), Sentry DSN, Supabase Auth custom SMTP, AI keys (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`CREWFLOW_INTERNAL_ORG_ID`). Code-complete; dark pending credentials.
