# CrewFlow Test-Infrastructure Audit

_Audit of the **test suite itself** — quality and sustainability, not product coverage._
_Scope: the UNIT tier (`vitest.config.ts`). Integration / security / e2e tiers were
not executed (owned by the lead), but are characterised from their configs and source._
_Date: 2026-11-02 · Author: Test-Infrastructure engineer._

---

## 0. Suite shape (measured)

| Metric | Count |
|---|---|
| Test files total (`__tests__/**/*.test.ts[x]`) | 1340 |
| └ unit tier (excl. integration + security) | **712** |
| └ integration tier (`__tests__/integration/`) | 285 |
| └ security tier (`__tests__/security/`) | 343 |
| e2e specs (`e2e/*.spec.ts`) | 60 |
| `describe(` blocks (unit) | 3014 |
| `it`/`test` cases (unit) | 10963 |
| `expect(` assertions (unit) | 26948 |
| Full unit tier run | **712 files / 11812 tests PASS, ~51s** |

**Headline:** the suite is large, fast, and **disciplined**. The things that usually
rot a suite are essentially absent: **0** `it.only`/`describe.only` left behind, **0**
`.skip`/`.todo`, **0** test files with a `it()` body but no `expect()`, and only **1**
literal tautology in the whole unit tier (now fixed). The real debt is concentrated in
**two patterns** — implementation-text pinning and a thin seam of wall-clock
non-determinism — plus a latent-but-mostly-safe constant-seed smell. Details below.

---

## 1. Flaky-risk patterns

### 1.1 Wall-clock non-determinism (the one genuine flake class) — MEDIUM

Unit files touching the real clock (`new Date()` / `Date.now()`): **31**, of which
**29 have no fake timers**. Most are harmless (they stamp a fixture `created_at` that is
never asserted, or pass through a mocked store). The dangerous shape is a **double clock
read**: the subject-under-test reads the clock internally *and* the test re-reads it to
build the expected value — if the two reads straddle a UTC-midnight tick, the date-only
strings disagree by a day and the test fails ~1 run in 86 400, i.e. eventually, on a
busy CI matrix, at the worst possible time.

Confirmed instances (both FIXED in this PR):

- `__tests__/invoices/due-date.test.ts:44-46` — computes `expected = new Date()` + 14d
  and compares to `invoiceDueDate("not-a-real-date")`, whose fallback is `new Date()` +
  14d **inside the lib** (`lib/invoices/due-date.ts:30`). Two independent reads.
- `__tests__/integrations/hmrc-cis-verify.test.ts:517` — `expect(input.verified_at)
  .toBe(new Date().toISOString().slice(0,10))`; the orchestrator stamps `verified_at`
  from its own `new Date()`. Same midnight race.

Other `new Date()`-in-expected sites to watch (currently pass, but same anti-pattern —
pin them if they ever flake): `quality/itp.test.ts:260,281`,
`integrations/banking-feed.test.ts` (several `isDueForSync` cases, e.g. `:698`).

**The good pattern already exists in-repo** and should be the template:
`__tests__/time/relative.test.ts` pins `const NOW = new Date(...)` and **injects** it
into every call (`{ now: NOW }`); `enterprise-sso/oidc.test.ts:16,50` and
`retention/reminder-scheduler.test.ts:107,162` do the same. The defect is not "tests use
dates" — it's the handful that read the ambient clock twice instead of injecting one.

### 1.2 Shared mutable state / order-dependence — LOW

42 unit files declare a top-level `let`/`var`; 11 have no `beforeEach`. **Manual review
of all 11 found no live order-dependence bug** — they either populate immutable state in
`beforeAll` (`enterprise-sso/oidc.test.ts:19,52`) or use a monotonic id counter whose
value is never asserted (`commercial/ageing.test.ts:19` `let seq = 0` → `doc-${seq}`;
`stock/valuation.test.ts:36`). These are actually *good* uniqueness factories.

Caveat worth a convention (not a present bug): several files build a mutable fixture
(`const st = new Map()`, `rows = [...]`) at **module-collection time** inside a
`describe` body rather than in `beforeEach` (`stock/valuation.test.ts:568,609`). It is
safe today only because the consumers (`foldItemValuations`, etc.) are pure. A future
test that mutates `rows`/`st` would leak across cases with no reset. Prefer per-case
construction or `beforeEach`.

### 1.3 Collision-prone constant seeds — LOW (latent)

24 unit files hard-code **≥3 constant UUID literals** (e.g.
`stock/valuation.test.ts:29` `"11111111-...-111111111111"`,
`admin/sales-ai.test.ts`, `integrations/telematics-*`) and only **6** unit files ever
use `randomUUID`/`faker`/`Math.random`. Today this is safe: each test builds an isolated
in-memory store, so a reused constant id cannot collide across tests. It becomes a bug
the moment a shared mock store (or the integration tier's real Postgres) keys on these
ids across cases. **Recommendation is preventative** (see §4), not a fix.

---

## 2. Brittle / low-value tests

### 2.1 Implementation-text ("source-pin") tests — the dominant debt — MEDIUM/HIGH

**36 unit files** `readFileSync` a source/migration/workflow file and assert on its text
with `toContain`/`toMatch` instead of exercising behaviour. (Suite-wide there are
**4933** `toContain`/`toMatch` assertions; a large share of the heaviest files are
source-pins.) These break on a harmless rename/reformat even when the invariant still
holds, and — worse — give a *false sense of safety*: matching a regex in a file is not
proof the code runs correctly.

Worst offenders by number of implementation-text assertions:

| Assertions | File | What it pins |
|---:|---|---|
| 56 | `__tests__/marketplace/migration-contract.test.ts` | SQL text of two migrations (FKs, grants, gates) |
| 50 | `__tests__/hq/alerts-scheduler.test.ts` | migration columns **and** scheduler *source structure* |
| 23 | `__tests__/branding/logo-migration.test.ts` | migration SQL text |
| 22 | `__tests__/onboarding/tos-stamp.test.ts` | source/migration text |
| 21 | `__tests__/ci/workflow-gates.test.ts` | `.github` workflow YAML text |
| 21 | `__tests__/imports/migration-os-v2.test.ts` | migration SQL text |
| 18 | `__tests__/offline/registry.test.ts` | source text |
| 16 | `__tests__/customers/customers-list.test.ts` | component source text |
| 14 | `__tests__/jobs/jobs-list.test.ts` | component source text |
| 13 | `__tests__/integrations/hmrc-cis-verify.test.ts` | source text (alongside real behaviour tests) |

**12 of the 36** pin **migration SQL text** specifically. These are the most defensible
sub-class: migrations are append-only, so text ≈ behaviour, and a text tripwire on a
cross-tenant composite FK (`marketplace/migration-contract.test.ts:40`) is cheap
insurance. The genuinely low-value ones pin **application/source structure** — e.g.
`hq/alerts-scheduler.test.ts` pins "scheduler reuses the pipeline (no duplication)" and
the dedup rule by matching source lines, rather than running the scheduler twice and
asserting the second run emits nothing. That is behaviour that *should* be tested by
execution; the file even has the fake-client machinery to do it.

> Note: the **security tier** (`__tests__/security/`, 343 files) is *intentionally*
> filesystem-scan + source-pin by design (see `vitest.security.config.ts` header —
> "hermetic … filesystem scans + pure functions"). Source-pinning there is a deliberate
> architecture choice and is **out of scope** for this criticism. The concern is the
> **unit** tier adopting the same style for things that have real runtime behaviour.

### 2.2 Tautological / weak assertions — LOW (effectively clean)

- Exact tautologies `expect(X).toBe(X)`: **1** across 712 files —
  `__tests__/access-gate/routing-rules.test.ts:223` (`expect(true).toBe(true)` as a
  "Rule 10" sentinel). **FIXED** in this PR (now asserts the companion suites it claims
  to index actually exist on disk and are non-empty).
- `toBe(true)` appears 1965× / `toBe(false)` 2012×, but spot-checking shows the
  overwhelming majority are real (`expect(res.ok).toBe(true)` etc.), not tautologies.
- `toBeTruthy()` 144× in 76 files, `toBeDefined()` 39× in 25 files — acceptable;
  consider tightening `toBeTruthy()` to value assertions opportunistically, not urgent.

### 2.3 Excessive mocking (mocking the subject) — LOW, 1 outlier

Files with ≥5 `vi.mock()`: **30**. Most are legitimate (mocking Supabase, services,
transport at the trust boundary). One clear outlier:
`__tests__/jobs/per-job-cost-volume.test.ts` with **32** `vi.mock()` calls — worth a
review that the subject under test isn't itself substituted. Next highest are far lower
(`reports/report-delivery.test.ts` 10, then 8s), which is normal for action tests.

---

## 3. Missing negative tests + coverage gaps (high level)

Negative-path coverage is **a strength**, not a gap: **257** `toThrow`/`rejects.`
assertions across **80** files, plus extensive value-level negative cases (e.g.
`enterprise-sso/oidc.test.ts` rejects alg=none, HS256 confusion, wrong key, every bad
claim; `commercial/ageing.test.ts` drops negative amounts; `stock/valuation.test.ts`
floors book value at 0). Critical domains all have dedicated unit dirs: `auth` (3),
`auth-flow` (1), `access-gate` (5), `billing` (10), `payments` (5), `invoices` (14),
`payroll` (9), `finances` (4), `stripe` (6), `cis` (7).

Gaps to note (high level — confirm against integration/security tiers before acting):

1. **Permission/tenant-isolation negatives live mostly in other tiers.** The unit tier
   proves *logic*; cross-tenant RLS denial is (correctly) in integration/security. Keep
   that split, but ensure every new money/permission server action has at least one
   unit-level "denied → throws/returns error" case, not only the happy path.
2. **Financial invariants pinned by text, not execution.** Several money-critical
   guarantees are asserted via source-pin (§2.1) rather than by running the function on
   adversarial inputs. The valuation/ageing files show the right model — extend it to
   the migration-contract-style areas where a behavioural test is feasible.
3. **Wall-clock-dependent business rules** (due dates, retention reminders, sync-due
   windows) should each have a fixed-clock boundary case, so "what counts as overdue/
   due today" is pinned deterministically rather than sampled against the ambient clock.

---

## 4. Recommended sustainable improvements

1. **Clock injection everywhere (deterministic fixtures).** Make "inject `now`, never
   read the ambient clock in a test's expected value" a reviewed rule. Where a lib reads
   `new Date()` internally and can't take an injected clock, the test must
   `vi.useFakeTimers()` + `vi.setSystemTime(FIXED)` (template now applied in the two
   files fixed here). Follow the `time/relative.test.ts` model for injectable code.

2. **A shared test-factory module (`__tests__/_factories/`).** Provide `uuid()` (wrapping
   `crypto.randomUUID`), `orgId()`, `job()`, `invoice()`, etc. that return unique keys by
   default with override params — the pattern `commercial/ageing.test.ts` already uses
   ad-hoc. This removes the constant-UUID smell (§1.3) before it becomes a collision bug,
   and makes fixtures self-documenting.

3. **Fixture-ownership convention.** Build mutable fixtures in `beforeEach` (or construct
   per-case), never at `describe`-collection time. One owner resets state; tests never
   mutate another test's fixture. Add a lint/CI note discouraging top-level mutable
   `let` without a `beforeEach` reset.

4. **Behaviour over source-text in the unit tier.** When a unit file is tempted to pin
   application/source structure, prefer executing the unit and asserting the observable
   result (the fake-client harnesses already present make this cheap). Reserve text-pins
   for (a) the security tier, where they are by design, and (b) append-only migration
   SQL, where text ≈ behaviour. Track the 36-file source-pin inventory and convert the
   application-structure ones opportunistically.

5. **Isolation hygiene.** The suite already runs `pool: "forks"` (good). Keep every file
   self-contained: a global `afterEach` that calls `vi.useRealTimers()` /
   `vi.unstubAllGlobals()` / `vi.restoreAllMocks()` where timers or globals are stubbed,
   so a stubbed clock can never leak into the next file.

---

## 5. Fixes landed in this PR (unit tier only)

All verified: **full unit tier 712 files / 11812 tests green**; lint clean on changed
files (pre-existing `_args` warnings only); the 11 `tsc` errors present are pre-existing
e2e/playwright cross-worktree type-resolution issues, none in changed files.

1. `__tests__/access-gate/routing-rules.test.ts` — replaced the `expect(true).toBe(true)`
   tautology (Rule 10 sentinel) with a real assertion that the five companion suites the
   file claims to index exist on disk and contain `describe(` blocks. The sentinel now
   actually fails if that coverage is deleted — which was its documented intent.
2. `__tests__/invoices/due-date.test.ts` — pinned the clock
   (`setSystemTime(2026-05-31T23:59:59.999Z)`, the worst-case boundary) around the
   parse-fallback case, removing the midnight double-read race and strengthening the
   assertion to an exact `"2026-06-14"`.
3. `__tests__/integrations/hmrc-cis-verify.test.ts` — pinned the clock around the
   "verified_at = today" case (`setSystemTime(2026-08-29T23:59:30Z)`, restored in a
   `finally`), removing the same midnight race and asserting the exact day.
