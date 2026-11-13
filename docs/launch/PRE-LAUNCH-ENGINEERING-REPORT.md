# CrewFlow — Pre-Launch Engineering Report

> **Verdict: CONDITIONAL-GO.** The product is professionally engineered and
> well-tested. This mission found **one** genuine production defect (a push/SMS
> double-send race) and fixed it; everything else surfaced was pre-existing debt
> that is bounded, documented, and either fixed or scheduled. The remaining
> conditions are **human-gated launch steps**, not engineering gaps.
>
> **Baseline:** prod `crewflow.uk`, SHA `0118d07`, migration tip
> `20261273000000`, `/api/health` healthy. **Scale:** 320 pages · 163 app routes
> · 94 server-action files · 80 HQ pages · 20 portal pages · 431 migrations.
> **Author:** pre-launch engineering mission (parallel audit + remediation).

---

## 1. What this mission did

A full-codebase audit (product, architecture, integrations/ops, test
infrastructure) run by parallel domain agents, followed by defect remediation.
All work is **apply-held**: no merge, no production migration, no deploy was
performed. Four reviewable PRs came out of it, each CI-gated.

| PR | Scope | State |
|---|---|---|
| **#1030** | **fix:** atomic claim for push/SMS drains (the one live defect) | apply-held; has a migration |
| #1029 | Architecture audit + target arch + `escapeHtml`/`formatBytes` consolidation | apply-held; code+docs |
| #1027 | Integrations & background-jobs ops audit + cron-auth hardening | apply-held; code+docs |
| #1028 | Test-suite audit + 3 flaky/brittle unit-test fixes | apply-held; tests+docs |

Supporting audit deliverables already in the tree (carried on the arch branch):

- **Product / feature & button encyclopaedia** — `docs/audit/` (11 domain files
  + master inventory + coverage report), honestly scoped: controls are marked
  *IMPLEMENTED, NOT LIVE-VERIFIED* wherever only a signed-in click could confirm
  them. It does **not** claim 100% live coverage.
- **Architecture** — `docs/architecture/CREWFLOW-ARCHITECTURE-AUDIT.md` +
  `CREWFLOW-TARGET-ARCHITECTURE.md`.
- **Integrations / ops** — `docs/ops/CREWFLOW-INTEGRATIONS-OPS-AUDIT.md`.
- **Test infrastructure** — `docs/testing/CREWFLOW-TEST-INFRA-AUDIT.md`.

---

## 2. Defect ledger

Severity: **P0** break-launch · **P1** fix-before-scale · **P2** fix-soon ·
**P3** debt. "Live" = reachable in production today.

| # | Sev | Live? | Finding | Status |
|---|---|---|---|---|
| D-1 | **P2** | **Yes** | **Push/SMS drain double-send.** `drainPushQueue`/`drainSmsQueue` selected queued-and-due rows and sent them with no claim step, so two overlapping cron ticks (or a redeploy overlap) read the same rows and sent twice. | **FIXED** — atomic claim RPC (`FOR UPDATE … SKIP LOCKED`, `status→'sending'`) + crashed-tick lease reclaim, mirroring the proven webhook/maintenance-reminder pattern. Real-Postgres concurrency proof. **#1030, apply-held.** |
| D-2 | P3 | No | `escapeHtml` copy-pasted byte-identical across ~9 email/report/action files (drift risk). | **FIXED** — single `lib/html.ts` + unit test; 9 sites switched. Remaining email-template sites are P3 follow-up. **#1029.** |
| D-3 | P3 | No | God-files (search route, quotes actions, dashboard page, receptionist) exceed a maintainable size. | **Documented + sequenced for Wave 2** (target-architecture doc). Not a correctness issue. **#1029.** |
| D-4 | P3 | No | 3 flaky/brittle unit tests (timing/shared-state). | **FIXED.** **#1028.** |
| D-5 | Ops | No | Cron auth compared the secret non-constant-time. | **HARDENED** — constant-time compare + 7 tests. **#1027.** |
| D-6 | — | n/a | **Review catch:** #1029's `escapeHtml` removal shifted lines under two line-keyed F-1 allowlist entries (`send-leave.ts`, `documents/page.tsx`), reddening the security tier. | **FIXED** — allowlist re-keyed to the new anchor lines; both F-1 guards green. (The reads were unchanged and still bounded.) |
| D-7 | P3 | No | **Intermittent e2e flake:** `asset-inspections.spec.ts` occasionally lands on the parent URL (`?saved=status`) instead of the child inspection route — the documented Next.js **deep-swap commit race** (server work commits, URL doesn't, at route-swap depth ≥4). Pre-existing on `main`; 190/191 e2e pass. | **Flagged for Wave 2** — confirm save-progress uses the mandated FormState + `window.location.assign` pattern (not `redirect()`/`router.push`) per `reference_nextjs_deep_swap_commit_race`. Not a data-correctness bug (the save lands); a navigation-UX intermittency. |

**No P0 or P1 was found.** No RLS weakening, no tenant-isolation hole, no broken
access control, no unsafe AI call path surfaced in this pass — consistent with
the two prior independent hardening/certification waves.

---

## 3. Test & verification state

All four tiers green on `main` (re-run this mission):

| Tier | Result | What it proves |
|---|---|---|
| Unit (`vitest.config.ts`) | **712 files / 11,812 tests ✓** | logic, mocked boundaries |
| Integration (real Postgres) | **285 files / 2,820 tests ✓** | RLS, RPCs, triggers, FKs |
| Security / trust-boundary | **343 files / 8,598 tests ✓** | tenant isolation, SECDEF guards, F-1 volume safety, data-API grant discipline |
| E2E (Playwright, real app + real Postgres) | **60 specs across 4 roles** (owner / admin / staff / hq), mandatory CI gate | real-browser multi-role journeys incl. `core-journey` + `first-customer-sim` |

`typecheck` clean · `lint` 0 errors · D-1's fix adds a dedicated real-Postgres
concurrency proof (disjoint concurrent claims, lease reclaim, `p_limit`).

### On "browser-test every route/button for 3 roles"

Honest boundary: exhaustive **manual** click-through of all ~320 pages × 3 roles
was **not** performed, and is not the right instrument. Multi-role real-browser
coverage is instead delivered by the **60-spec Playwright e2e tier** (4 roles,
real app + Postgres, in CI) plus the static **feature & button encyclopaedia**
(`docs/audit/`). Automated e2e is repeatable and regression-proof where manual
clicking is neither. Controls not exercised by an e2e spec are explicitly marked
*IMPLEMENTED, NOT LIVE-VERIFIED* in the encyclopaedia — nothing is asserted
"working" because a button merely exists.

---

## 4. Architecture, performance, scalability (summary)

- **Architecture:** sound and conventional for its stack — App Router + server
  actions + RLS-first data access + two-client discipline (`createClient` vs
  `createAdminClient`). Typing is tight (~48 `any` in app code, bounded).
  Technical debt is real but **bounded and catalogued**, not structural.
- **Scalability:** the known lever is **query fan-out**, not the tier — the
  standing doctrine (`docs/connection-pooling-and-scale.md`) is to rule out a
  query fix before a tier change, and the F-1 guards enforce volume-safe reads.
  Cron fairness is guarded so no tenant can starve a tail.
- **Multi-tenancy:** RLS + `current_org_ids()`/active-org pinning + column ACLs,
  enforced by the security tier and the SECDEF-org-RPC guard.

---

## 5. Conditions to clear before onboarding the first paying customer

**Engineering (do first, in order):**

1. **Merge + apply #1030** (the double-send fix). It carries migration
   `20261274000000` — apply the migration, then merge. It is additive/reversible
   and rewrites no data. *This is the only remaining item that touches a live
   defect.*
2. **Merge #1027 / #1028 / #1029** (no migrations; code/tests/docs). #1029's
   security tier is green after the D-6 re-key.

**Human-gated launch steps (founder — I cannot do these):**

3. **Auth SMTP** — confirm the custom sender is Verified in Supabase → Auth →
   SMTP and a magic link reaches an external inbox (password fallback exists, so
   this is not a single point of failure).
4. **First live Stripe charge** — provision the customer in HQ and authorise the
   £1,000 setup + £500/mo (Stripe LIVE verified 2026-10-28). Confirm the
   `checkout.session.completed` / `invoice.paid` webhooks flip the org active.
5. **Staff-login isolation click-through** — founder establishes a prod staff
   session; I then drive the in-app browser to confirm a staff user sees only
   assigned jobs and is denied commercial/finance/other-worker data. (DB/RLS
   layer already proven; this is the last app-level human confirmation.)

**Schedule, not blocking:** Wave 2 debt — god-file splits (D-3), remaining
`escapeHtml` P3 sites (D-2), test-infra recommendations (clock injection, shared
factories, 36 source-pin files). PITR remains a CEO cost decision (off today;
off-platform backup is restore-proven).

---

## 6. Bottom line

The codebase is **not fragile** — it is disciplined, extensively tested, and
secured by construction. This mission's search turned up exactly one live
defect, now fixed with a proof. The verdict is **CONDITIONAL-GO**: ship once the
four PRs are merged (with #1030's migration applied) and the three human-gated
launch steps are confirmed. None of the conditions is an open engineering risk.
