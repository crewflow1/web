# R5 Phase 3 remainder — production apply plan (PR #1023)

> **Apply-held.** No merge/apply without explicit founder approval.

## What applies
Five additive migrations narrowing the last operational child tables to the
assigned-job model (owners/admins keep full org access):

| Mig | Tables | Scope |
|---|---|---|
| `20261269000000` | job_programme_baselines | assigned-job |
| `20261270000000` | blueprints, blueprint_markup, blueprint_pins | assigned-job |
| `20261271000000` | delay_events, job_warranties | assigned-job |
| `20261272000000` | asset_assignments | assigned-job; job-less → admin-only |
| `20261273000000` | worker_acknowledgements | admin-only in-app (see PR decision) |

## Why this is simpler than #1019 (no expand-and-contract needed)
These are **pure RLS SELECT-policy swaps** — no function signatures change, and
**no application code change ships with them** (the app already reads through RLS;
no caller passes a new argument). So there is **no app↔DB coupling and no
deploy-order window**: each `drop policy … / create policy …` is atomic, reads
simply narrow, and every write path was verified to remain self-consistent
(members act only on assigned jobs; service-role/portal writes bypass RLS).
→ **Straightforward migrations-first, zero-downtime.**

## Dependencies
All five depend only on helpers already LIVE in prod (`current_org_ids()`,
`is_org_admin()`, `my_assigned_job_ids()`). They are mutually independent (distinct
tables) — apply in prefix order per discipline. Prod tip is `20261268000000`;
these are the next free prefixes, collision-free.

## Pre-apply gates
1. CI green on #1023 (all mandatory checks).
2. Founder approval (incl. the worker_acknowledgements admin-only decision).
3. Fresh off-platform backup + integrity + restore-proof (as for #1019).
4. `supabase migration list --linked` shows tip `20261268000000`, no drift.

## Apply sequence (migrations-first, one at a time)
For each of `20261269` → `20261273`, in order, from `~/Code/web` (the linked-to-prod
checkout):
```
supabase db query --linked -f supabase/migrations/<file>.sql   # (txn-wrapped)
supabase migration repair --status applied <version> --linked  # file must be staged in the linked dir
```
Then merge #1023 to `main` (the Vercel deploy is a **no-op** for behaviour — no app
change — so order vs merge does not matter; applying first is fine).

## Post-apply verification (read-only on prod)
- `supabase migration list --linked` → tip `20261273000000`.
- `pg_policies`: each of the 8 tables has exactly one SELECT policy carrying the
  narrowed predicate (assigned-job / admin-only).
- Staff-isolation spot check (txn-rolled-back, as in the 2026-10-31 R5 apply): a
  staff user sees only assigned-job rows for these tables; a non-admin sees no
  worker_acknowledgements; job-less asset_assignments are admin-only.
- `/api/health` OK.

## Rollback
Each is independently reversible via a forward migration recreating the prior
org-only policy (`using (org_id in (select current_org_ids()))`). No data is
written, so no data-restore path is involved.
