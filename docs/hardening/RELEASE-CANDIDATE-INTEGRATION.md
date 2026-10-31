# R5 Release-Candidate Integration — consolidated PRs + CI

_Date: 2026-10-31 · base `origin/main` tip `ea2a502c` (#979) · migrations on main top out at `20261241`._

The local-only R5 staff-isolation stack has been pushed and opened as two CI'd PRs against `main`.
The piecemeal stacked PRs (#975 / #977 / #980 / #981) are left **OPEN for cross-reference only** — prefer
the consolidated PRs below.

## Pushed branches + PRs

| PR | Origin branch | Local source | Scope | Migrations added |
|----|---------------|--------------|-------|------------------|
| **#997** | `r5/consolidated-operational-rls` | `feat/r5-phase3-operational-rls` | Read-side staff isolation, Phases 1–5 (jobs + operational children + commercial/finances denial + workforce self-scope + report-RPC admin guard) + GDPR DSAR lane | `242,243,244,245,247,248,249,250,251,252,253` |
| **#998** | `feat/jobs-assignment-reconciliation` | `feat/jobs-assignment-reconciliation` | One transactional job-assignment model (primary + crew reconciled; serialized mutations; F1/F2 authz) | `242,246` |

`feat/r5-phase3-operational-rls` already existed on origin as the head of #981 (based on phase2); to avoid
clobbering #981 the consolidated stack was pushed to the **new** ref `r5/consolidated-operational-rls`
(identical commits, nothing rebased/squashed). The reconciliation branch had no prior origin ref, so it was
pushed under its own name.

## Migration prefix audit — no collision

Combined deployable chain across both PRs + `main`:

```
20261242 20261243 20261244 20261245 20261246 20261247 20261248 20261249 20261250 20261251 20261252 20261253
```

- **Contiguous `242 → 253`, each prefix appears exactly once, no gap, no collision.**
- `20261242_job_assignments.sql` is the **same commit** (`4d7579a3`) in both branches — one shared file, not a
  duplicate.
- `20261246` is unique to #998; `243–245` and `247–253` are unique to #997. Post-divergence the two branches
  edit **disjoint** app/test files — no inter-branch merge conflict in any order. Both PRs report
  `MERGEABLE` against `main`.
- Migrations are additive / forward-only. **Apply-held** — nothing applied to production by these PRs.

## CI results (observed 2026-10-31, GitHub Actions)

### #998 — jobs assignment reconciliation — **ALL GATES GREEN**

| gate | result |
|------|--------|
| typecheck | pass |
| lint | pass |
| tests (unit) | pass |
| integration (real Postgres) | pass |
| security (trust boundaries) | pass |
| e2e (real app, real Postgres) | pass |
| gitleaks | pass |
| Vercel | pass |

### #997 — consolidated read-side — **4 GATES RED** (typecheck/lint/gitleaks/Vercel green)

| gate | result |
|------|--------|
| typecheck | pass |
| lint | pass |
| gitleaks | pass |
| Vercel | pass |
| tests (unit) | **fail — 10 tests** |
| security (trust boundaries) | **fail — 4 tests** |
| integration (real Postgres) | **fail — ~20 tests** |
| e2e (real app, real Postgres) | **fail — 1 spec (flake)** |

**Root causes (NOT fixed here — not migration applies, not trivial lint; left for the branch author / coordinator):**

1. **Service-role in the material-request offline write path** (drives all 10 `tests` failures + 3 of 4 `security`
   failures). The Phase-3 material_requests slice changed `server/services/material-request-writes.ts` to use
   `createAdminClient()` (service-role) for the duplicate-key lookup and `ensureLines`, where it previously used
   the caller's `tenant` client. Consequences:
   - `__tests__/security/offline-write-expansion.test.ts` + `offline-write-queue.test.ts` reject **any**
     service-role client in the offline write path (a stolen queue item riding service-role is a privileged
     bypass) — correct rejection.
   - `__tests__/offline/expansion-write-cores.test.ts` (10×) throw because `createAdminClient()` instantiates a
     realtime client that fails under Node 20: _"Node.js 20 detected without native WebSocket support"_
     (`lib/supabase/admin.ts:27`).
   - Likely cause of the switch: Phase 3 narrows material_requests RLS to assigned jobs, so the offline replay can
     no longer read its own rows under the caller's JWT. The correct fix is a **guarded SECDEF RPC**
     (`current_org_ids()` + `42501`) or an assignment-aware policy that still lets the author read their own
     queued write — not service-role. **Security-design decision, deliberately not patched here.**
2. **Migration-slot pin** (1 of 4 `security` failures). `__tests__/security/material-requests.test.ts` asserts the
   material_requests lane owns _exactly_ `20261066` + `20261067`; the new `20261247_r5_phase3_material_requests_rls.sql`
   must be added to that allowlist.
3. **Access-policy surface reconciliation** (the `integration` failures: H&S issue-gates, RAMS/permit authz,
   required-operatives rota crew, toolbox-talks, aged-ledgers admin gate, schedule roster). R5 is an **access-policy
   change**; the new migrations applied to the integration DB shift member/admin read+write behavior that these
   pre-R5 integration tests pin. This is the "surface reconciliation" the branch flagged as outstanding — the tests
   must be reconciled to the new access model.
4. **e2e flake** (1 spec). `e2e/blueprint-offline.spec.ts:93 "Sign out purges the offline cache"` timed out at 30s;
   178 passed. Known PWA-offline logout-purge flake, unrelated to R5 (#998 passed e2e clean).

## Coordinated merge order (recommended to the coordinator)

1. **Merge #998 first** — fully green; provides `20261246`.
2. **Reconcile #997** — fix the three real items above (service-role → guarded RPC/policy; migration-slot allowlist;
   integration access-policy test reconciliation), re-run CI, then merge. The e2e flake is non-blocking (re-run).
3. **After both merge**, apply migrations to production in strict numeric order **`242 → 253`** as one coordinated,
   human-approved pass (apply-held; coordinator-owned). The piecemeal PRs #975/#977/#980/#981 can be closed as
   superseded (cross-referenced from each).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
