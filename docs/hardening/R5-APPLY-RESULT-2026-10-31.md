# R5 Production Migration — Apply Result & Verification (2026-10-31)

**GO — R5 applied to production and verified.** Migrations `20261242`→`20261259` (incl `20261246`)
are live. Production is healthy. Staff-isolation security proven with real authenticated evidence.

## Exact migration results
- Applied **18/18** one-at-a-time, each in its own `BEGIN…COMMIT` transaction, error-gated, recorded, tip-verified. **0 failures**, ~57 s total.
- Order applied = prefix order `20261242000000 … 20261259000000` (`20261246000000` applied once, in position).
- **Production database tip: `20261259000000`** (418 migrations applied; was 400 / `20261241000000`).
- Per-migration evidence: `scratchpad/r5-apply-evidence/<version>.sqlout.txt` + `.repair.txt`.

## Production identifiers (post-apply)
- **Prod SHA:** `f110944` (branch `main`) — unchanged (code already deployed; this was a DB-only change).
- **DB migration tip:** `20261259000000`.
- **Health:** `200 healthy`, `db: ok`, crons last success 0 min, monitoring on.
- **Code-ahead-of-schema window: CLOSED** — `stock_movements_operational`, `set_job_primary_assignment`, `find_own_material_request`, `job_rota_crew`, `job_assignments` and the other R5 objects were all ABSENT pre-apply (deployed main called them with no fallback) and are now present.

## Real security verification evidence
All run as the `authenticated` role under live RLS, inside the **CrewFlow (Internal HQ)** org only,
in a transaction that was **rolled back** (post-test residue check = 0 rows; customer org "one electrical" never read or written).

**Staff (role `staff`):**
| Assertion | Expected | Actual |
|---|---|---|
| Jobs visible in org | only own assigned job | **only `1111…` (not the other worker's `2222…`)** |
| Direct fetch of other worker's job | denied | **0 rows** |
| `is_org_admin` | false | **false** |
| Commercial (`job_budgets`) rows | 0 (denied) | **0** |
| Finances rows | 0 (denied) | **0** |
| Another worker's rota rows | 0 (denied) | **0** |
| Another worker's time rows | 0 (denied) | **0** |
| `stock_movements_operational` | readable, no error | **0 rows, no error** |

**Owner (role `owner`):**
| Assertion | Expected | Actual |
|---|---|---|
| Jobs visible | all org jobs | **both `1111…` + `2222…`** |
| `is_org_admin` | true | **true** |
| Commercial (`job_budgets`) | visible | **1** |
| Finances | visible | **1** |

**Structural / catalogue:**
- Grants: `job_assignments` has **no** anon/authenticated/public grant (service-role only); `stock_movements_operational` grants **authenticated SELECT only**.
- SECDEF guards: `set_job_primary_assignment`, `job_rota_crew`, `add_job_worker`, `remove_job_worker` all carry the in-body `42501` + `current_org_ids()` org guard; `find_own_material_request`, `own_material_request_line_count`, `my_assigned_job_ids` are `SECURITY DEFINER` + `auth.uid()` self-filter.
- Stock cost masking is structural: `unit_cost`, `cost_effect`, `costed_qty_effect` are `NULL` in the operational view by definition.
- Backfill correct: "one electrical" 1 assigned job → 1 `job_assignments` row; Internal HQ 0 → 0.

## Verified recovery backup
`~/CrewFlow-backups/pre-R5-20261242_2026-10-31/` — captured at pre-R5 tip `20261241000000`, SHA256 3/3 OK,
restore-proven (17 s RTO, exact business-table match) before apply. Scope: DB logical backup (no Storage
objects); **PITR OFF** (CEO cost decision).

## Honest GO / NO-GO launch assessment

**R5 security release: GO — production-verified.** The assigned-job isolation model is enforced in prod and
proven with real authenticated queries. No failure, no data loss, no lockout (owner retains full access).

**Platform launch readiness (first design-partner customer): GO, with these honest caveats — none are engineering blockers:**
1. The staff-isolation proof above is at the database/RLS layer (the authoritative control). A real end-user **staff-login click-through** of the stock / assignment / material-request / H&S pages is the one remaining human-assisted smoke test — offered, not yet run (needs a founder-assisted login).
2. AI features and transactional email custom-SMTP remain dark pending **founder-side credentials** (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` + `CREWFLOW_INTERNAL_ORG_ID`; Supabase Auth SMTP verify). Stripe/Resend/Sentry already configured.
3. Offline mode is read-only by design (no write queue) — a known product limitation, not a defect.
4. PITR is OFF — the off-platform snapshot is the recovery floor.

**Not done (correctly withheld):** no customer charges, no restricted-provider activation, no bulk comms, no
unrelated production changes. `#1007` (compat fallbacks) is now dead code and can be closed.
