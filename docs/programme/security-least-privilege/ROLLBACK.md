# D-17 rollback (migrations 20261340–20261346)

**What it is.** `proofs/rollback-20261340-46.sql` — generated from an exact catalogue diff between the
schema at `20261327` and the schema at `20261346` (`proofs/catalogue-capture.sh` snapshots policies,
triggers, functions, table grants and column grants). It drops the 631 policies, 240 triggers and 6
functions D-17 adds, restores the 5 functions and 1 policy it changes, and re-grants the 10 table-level
SELECT grants the column ACLs replaced. **It changes no data.**

**Tested (local, 2026-11-15).** Database at `20261346` → run the script (one transaction) → every policy,
trigger, function, table grant and column grant in schema `public` is byte-identical to the `20261327`
snapshot. The only `pg_dump` difference is five documentation `COMMENT ON COLUMN` strings. Re-applying
`20261340`–`46` afterwards reproduces the `20261346` snapshot exactly.

**Before using it on production.** The script was generated against the LOCAL `20261327` schema. Run
`catalogue-capture.sh` against production BEFORE the migrations are applied and keep the snapshot: if
production has drifted from the migrations, regenerate the rollback from that snapshot.

**Order — DATABASE FIRST, then the application.** (Corrected and tested 2026-11-15.)

The pre-D-17 application cannot run on the migrated schema: it reads columns that `20261341`–`43`
remove from the Data API. Measured locally, old application on the migrated database: 168 browser tests
passed, 20 failed, 13 did not run (asset detail, fleet / vehicle pages, document import, company
settings). The D-17 application runs on BOTH schemas. So:

1. **Database:** `psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f rollback-20261340-46.sql` — one transaction;
   nothing is applied if any statement fails. The D-17 application keeps serving throughout.
2. `supabase migration repair --status reverted 20261346000000 … 20261340000000` (only for versions that
   were actually applied).
3. **Application:** only now promote the pre-D-17 deployment in Vercel (if the application also has to
   go back — the D-17 build is fully functional on the rolled-back schema apart from staff
   goods-receiving, so step 3 is optional and can wait).

Tested end to end on the local production-equivalent database, in this order: rollback script applied
LIVE while the D-17 build was serving (health stayed 200; catalogue byte-identical to the pre-D-17
snapshot) → D-17 build on the rolled-back database: 269 passed, 1 expected failure (staff cannot open a
purchase order — pre-D-17 behaviour), 6 not run (same serial spec) → pre-D-17 build on the rolled-back
database: 191 passed, 1 intermittent failure in that build's own owner-management spec (a form-fill race
unrelated to the schema; the spec passed in full on re-run).

**Partial application of the migrations.** If a migration fails part-way through the release, STOP. Each
file is applied in its own transaction, so the database is at the last version that succeeded. The D-17
application tolerates every intermediate state (it runs on `20261327` and on `20261346`). Either fix
forward, or run the rollback script — every statement in it is `drop … if exists` / `create or replace`
/ `grant` / `revoke`, so it is written to be safe against a partially migrated database (that partial case has NOT been
tested; the full 20261346 → 20261327 case has) — and mark as reverted only the versions that were applied.

**What rollback reopens.** Everything D-17 closed (staff direct-API writes to operations tables,
self-approval, non-active-company access, private columns). Use it only for a production-breaking
defect; a defect in one area is better fixed forward.

**Partial fallback (no schema change).** If the only problem is latency or a false refusal from the
write guard: `alter table public.<t> disable trigger held_org_write_guard;` per table — the RESTRICTIVE
policies still protect every client-writable table.
