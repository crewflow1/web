# R5 Production Migration — Preflight Result (2026-10-31)

**Decision: GO** — all 7 founder preflight requirements verified pass. Awaiting explicit
database-application approval. **No migration has been applied. Prod DB is untouched at tip
`20261241000000`.**

---

## Preflight results

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Prod SHA + migration tip | ✅ | Prod SHA `f110944` = `origin/main` tip `f110944f`; health `200 healthy db:ok`. Prod migration tip `20261241000000` (400 applied). |
| 2 | Fresh backup created + restored + tested recovery | ✅ | Fresh pre-R5 snapshot `~/CrewFlow-backups/pre-R5-20261242_2026-10-31` (schema 2.28 MB, data 190 MB, auth 93 KB); SHA256 3/3 OK. **Restored into isolated Supabase-image Postgres: 317 public tables, 0 schema errors, RTO 17 s, business tables EXACT-MATCH prod** (orgs 2 / memberships 1 / users 2 / customers 601 / jobs 3 / quotes 5 / invoices 1). |
| 3 | Exact 242→259 incl 246, no missing/dup | ✅ | 18 migration files on `origin/main`, contiguous `20261242`→`20261259`, `20261246` present exactly once, **zero duplicate version prefixes**, nothing above `259`. Files byte-identical to the compat branch. |
| 4 | No unacceptable lockout / data loss / downtime | ✅ | After stripping all function bodies, the **only** top-level DML across all 18 is one additive backfill `insert into job_assignments … on conflict do nothing` (new table). No DROP TABLE / DELETE / TRUNCATE / DROP COLUMN / ALTER DROP / table rewrite. Indexes created only on the new (near-empty) `job_assignments`. All other ops are metadata-only (policy/function/view/grant). Prod backfill size = 1 row (1 job has `assigned_to`). |
| 5 | App compatibility + rollback | ✅ | All 18 migrations carry a `ROLLBACK:` header (additive drops / policy restores). Full-restore path proven (point 2). Deployed main already runs R5 code → apply makes schema+code consistent. |
| 6 | Staff-security tests runnable on authorised accounts w/o exposing customer data | ✅ | Isolated test ground = org **CrewFlow (Internal HQ)** `b343ced5…`; customer org **one electrical** `89350c87…` never read/written. Read-only post-apply harness built (catalogue + Internal-HQ-scoped). Behavioural RLS/security suites run against local Postgres (never prod). |
| 7 | Prod health + active errors | ⚠️→fixed-by-apply | Health endpoint `200 db:ok`, crons fresh, monitoring on. **BUT** deployed main calls R5 objects with no fallback — `stock_movements_operational` (stock.ts:215), `set_job_primary_assignment`, `find_own_material_request`, `job_rota_crew` — and all are **confirmed ABSENT in prod**. Those paths error now (code-ahead-of-schema window). Current data impact low (0 stock movements, 0 material requests). **Applying 242→259 closes the window.** |

---

## Verified backup details (restore point)

- **Path:** `~/CrewFlow-backups/pre-R5-20261242_2026-10-31/` (dir mode 700, off-platform, not committed)
- **Captured:** 2026-10-31 ~20:22 UTC, prod `jzntbskdqdopzwdqwvkp` via IPv4 session pooler (CLI 2.116.0)
- **Tip at capture:** `20261241000000` — exactly the pre-R5 state
- **Contents:** `schema.sql` (DDL), `data.sql` (public data, `session_replication_role=replica`), `auth-data.sql`, `SHA256SUMS`
- **Integrity:** `shasum -a 256 -c` → 3/3 OK
- **Restore proven:** 17 s RTO, exact-match business-table counts (this preflight)
- **Scope limit:** DB logical backup only — does **not** include Storage bucket objects; **PITR is OFF** (CEO cost decision), so restore granularity is this snapshot, not arbitrary time.

---

## Exact risks

- **R-1 (active now, closed by apply):** code-ahead-of-schema window — stock module, owner/admin job-assignment write, material-request creation, H&S sign-off rota error in prod until schema lands. Low current data impact.
- **R-2 (lockout, low→very-low):** per apply-pack §4 L1–L4 — P2 jobs SELECT, commercial/finance denial, report-RPC guard, stock masking. All regression-tested on the combined schema; owners are wildcard; staff cost-entry preserved; quantities preserved (only costs masked).
- **R-3 (multi-org):** none — prod has 0 multi-org users.
- **R-4 (partial apply):** contained — migrations apply one-at-a-time, each transactional; a failure rolls back that single step and leaves prod at the last good tip.
- **R-5 (storage/PITR):** backup excludes Storage objects; no PITR. Mitigated — R5 adds no destructive storage/data ops; snapshot is the recovery floor.

## Approval requested

Explicit founder approval to **apply migrations `20261242`→`20261259` (incl `20261246`) to production**,
in prefix order, one-at-a-time with per-step catalogue verification, immediately preceded by the
verified fresh snapshot above. On approval I will: apply the chain with verification after each step;
run the read-only post-apply harness + founder-assisted Internal-HQ staff-isolation check; verify prod
health and critical workflows; and on any failed verification stop and roll back per apply-pack §5
rather than force past it.
