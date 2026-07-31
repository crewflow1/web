# The AI Cost Governor — the atomic budget reservation

Migration `20261070000000`. Seam: `lib/ai/governor.ts`. Surface: `/admin/ai-costs`.

**The governor is still DARK.** Every cost tier maps to no model
(`lib/ai/governor/registry.ts`), so on production this wave creates a correct and
permanently **empty** `ai_cost_reservations` table and changes nothing a user or
a bill can observe. It introduces no provider, no credential, no network call
and no cron.

---

## THE TWO DEFECTS THIS CLOSES

Both were **measured and pinned as findings** in
`__tests__/ai/quote-writer-governor.test.ts` before they were fixed, and both had
one root cause: a **read-then-act** decision in application code.

### 1. The £100/org/month ceiling was a START GATE, not a reserve

`invokeWithGovernor` read the month's total, ran the provider call, then recorded
the cost. N calls issued in the same tick all read the **same pre-spend total**,
all found themselves under the ceiling, and all spent. Overshoot was bounded only
by `(calls in flight) x (cost of the most expensive single call)`.

Sequential traffic was exact — which is why it looked fine.

### 2. Dedupe raced identically

The recent-duplicate probe was a `select` over the ledger, so ten **simultaneous**
identical submits all missed and all paid. One impatient double-click cost ten
times. Sequential repeats were caught correctly.

---

## THE MECHANISM: RESERVE, THEN SETTLE

```
1. RESERVE   ai_reserve_invocation()   — atomic. Claims budget or refuses.
2. CALL      the provider              — the lock is NOT held across this.
3. SETTLE    ai_settle_reservation()   — ledger row + claim release, one txn.
   or
3'. RELEASE  ai_release_reservation()  — no provider was reached; nothing owed.
```

The budget is **committed + live-reserved**. A caller's own claim is visible to
every other caller from the instant it commits — the property a post-hoc ledger
row can never have.

### Two tables, not one

| | |
|---|---|
| `ai_invocations` (20261062) | **COMMITTED** spend. Immutable. A fact that happened. |
| `ai_cost_reservations` (20261070) | **IN-FLIGHT** claims. A short-lived state machine. |

`ai_invocations` is UPDATE-immutable by trigger, carries `success boolean not
null`, and enforces "a success has nothing to explain, a failure must carry a
code". Every one of those is load-bearing and every one is **incompatible with an
in-flight row**: a reservation has no outcome yet and must transition when it gets
one. Bolting a lifecycle onto that table would have meant weakening its
immutability trigger — the strongest thing it has. **Nothing in 20261062 was
altered.**

### The serialisation point: a per-org advisory xact lock

A conditional `insert ... select ... where (committed + reserved + this) <=
ceiling` is **not sufficient on its own**. At READ COMMITTED two concurrent
transactions both evaluate that predicate against a snapshot taken before either
inserted, both find room, and both commit. **This is measured below** — the
counterfactual keeps the conditional insert and removes only the lock.

So `ai_reserve_invocation` takes `pg_advisory_xact_lock` on the **org** before it
reads. The codebase's established idiom for this exact shape: per-(item, site) in
`20261065000000`, per-purchase-order in `20261060000000`, per-contract in
`20261051000000`. Transaction-scoped, so a crashed backend releases it
automatically.

**Why per-org and not per-(org, month)**, which would be narrower: the dedupe
decision is serialised by this same lock, and the 15-minute dedupe window can
straddle a month boundary. A per-month key would open a once-a-month hole in which
two simultaneous identical submits either side of midnight-on-the-1st took
different locks and both paid. The cost of the wider key is nil: the lock is held
only for a bounded aggregate and one insert, never across the provider call, and
two different orgs never contend (proven below).

### The two gates

| | |
|---|---|
| `committed + reserved < ceiling` | The **band** gate — `evaluateBudget`'s rule in SQL. Reaching the ceiling exactly must refuse; without this, a zero claim would slip through at exactly 100%. |
| `committed + reserved + claim <= ceiling` | The **reserve** gate, and the fix. A call that cannot fit is refused *before* it reaches a provider. |

Both are evaluated inside the lock, and the claim is written by a conditional
`insert ... select ... where`, so the check and the write are one indivisible act.

### Alternatives rejected

- **SERIALIZABLE isolation** — cannot be set per-request through PostgREST, and
  converts the race into serialisation failures the application must retry. A
  budget control whose refusal path needs a retry loop is worse than one that
  answers.
- **A unique-constrained `ai_budget_months` counter row locked `FOR UPDATE`** —
  works, but introduces a mutable aggregate that can drift from the ledger it
  summarises, and a drifted counter is either invisible over-blocking or invisible
  over-spend. Re-summing one org-month is index-served against
  `ai_invocations_org_created_idx` and costs nothing at the ≤10,000 rows a £100
  ceiling can buy, so the ledger stays the single source of truth.
- **A unique index on (org, feature, content_hash) for dedupe** — would make
  dedupe **permanent** rather than a 15-minute window, refusing a genuine re-ask
  forever. A tumbling-window generated column instead lets two identical submits
  either side of a bucket edge both pay. Serialising the **sliding-window** probe
  under the lock preserves the exact existing semantics with no new false
  positives *or* false negatives.
- **A cron sweeper for stale claims** — see the TTL policy below; lazy reclaim
  needs nothing external in the refusal path.

---

## POLICIES

### The claim size

The claim is `estimateCostPence(binding, binding's worst-case token envelope)`,
floored at 1p. The envelope is **two required fields on `AiModelBinding`**
(`reserveInputTokens` / `reserveOutputTokens`), so TypeScript refuses an
activation diff that binds a model without stating its worst case. A call site
cannot shrink it — that would be a way to under-reserve and slip past the gate.

**The 1p floor is not a formality.** `estimateCostPence` returns 0 for an unpriced
or unbound model, and a claim of zero consumes no budget, so N concurrent
unpriced calls would all pass however many there were — precisely the hole the
reservation exists to close. One penny per in-flight call bounds worst-case
concurrency at 10,000 calls. It floors the **claim only**; what a call is
*recorded* as costing is still exactly what the estimator says.

### Failed calls: SETTLE at the real cost, with a 1p floor — do not release

A failure is **settled, not released**, and it costs **at least one penny**.

A call that reached a provider and then failed has, on every major vendor,
already billed its input tokens. We get no usage report, so the token counts are
honestly `0, 0` — but recording the **cost** as £0 would make a retry storm
completely invisible to the ceiling, and a retry storm is the single most likely
way the ceiling ever gets tested. "Ten thousand failures cost nothing" is the same
arithmetic `estimateCostPence` already refuses when it rounds a sub-penny call
*up*.

The trade is explicit: at most 1p per failed call of over-reporting, against an
unbounded and unbudgeted spend. It also bounds a crash loop — and because each
failure still *claims* a whole call's worth of budget, the wall arrives well
before 10,000 failures.

Releasing instead would have been the alternative, and it is wrong for the same
reason `20261062`'s own comment gives: *a failure is recorded, never dropped.*

### `usage: null` → RELEASE, record nothing

The governed function took its own degraded leg and never called a model. There
is nothing to account for — inventing a phantom invocation is exactly what
`GovernedCall.usage === null` exists to prevent. The claim is given back
immediately rather than left to time out.

### TTL: 10 minutes, reclaimed LAZILY

`RESERVATION_TTL_MS = 10 * 60_000`, bounded on both sides:

- **Lower** — it must comfortably exceed the longest a governed provider call can
  take, retries included. A TTL that lapsed mid-call would let a second caller
  reserve headroom the first was still spending.
- **Upper** — it is the maximum time a **crashed** process can hold budget
  hostage. Ten minutes of one call's headroom is bounded and self-healing;
  "until the month rolls" would be an outage.

It is deliberately **shorter than `DEDUPE_WINDOW_MS` (15 min)**: a crashed
request's claim must expire before its duplicate-suppression does, or retrying the
exact request that crashed would be refused as a duplicate of a call that never
completed.

**Reclaim is lazy, with no cron.** Every arithmetic path counts only claims with
`expires_at > now()`, so an abandoned claim stops consuming budget the instant its
TTL passes. `ai_reserve_invocation` additionally stamps lapsed rows to `'expired'`
so the audit view tells the truth — but **the ceiling is correct whether or not
that stamp ever runs**, which is why the stamp is cosmetic and the predicate is
the rule.

### Duplicates get a clear state, not the winner's result

`{ status: "duplicate", reason: "in_flight" | "recent_success" }`.

Handing back the winner's output would need either a **cache of model outputs** —
a new store of customer prose in a subsystem that deliberately keeps only a
SHA-256 fingerprint — or a **wait on another request**, which turns a cost control
into a latency coupling with its own timeout failures. The two reasons are kept
distinct because they mean operationally different things ("wait" vs "you already
have this").

### The reservation fails CLOSED. `checkBudget` still fails OPEN.

This is a deliberate asymmetry, not a contradiction:

- `checkBudget` is a **read** feeding an advisory status (HQ view, spike baseline,
  warning bands). Failing open costs a wrong number on a dashboard; the call still
  runs and is still recorded, so any consequence is visible. Its original
  fail-open note is preserved verbatim.
- `reserveBudget` is the **authorisation**. Failing open would mean the ceiling is
  unenforced whenever the database hiccups — "the control is bypassed on error" is
  not a control. Failing closed costs exactly the documented degraded path each
  governed feature already has and already tests.

An unrecognised SQL outcome is also refused, never assumed benign.

---

## THE ONE RESIDUE, STATED RATHER THAN HIDDEN

**The ceiling holds exactly while each call's true cost is no greater than the
claim it was admitted on.** A call that costs *more* than its own worst-case
envelope can push committed spend past the ceiling by the shortfall. The true cost
is only knowable afterwards, so this cannot be prevented from inside the gate.

Mitigations:

1. The envelope is a **required** field on every model binding, so it cannot be
   forgotten at activation.
2. `ai_reservations_month_totals.overrun_count` counts settled claims whose real
   cost exceeded their estimate, and `/admin/ai-costs` renders a red banner when
   it is non-zero. A non-zero figure means the envelope is too tight for the bound
   model.

Proven both ways: `__tests__/integration/ai/budget-reservation.test.ts`
("THE RESIDUE: an over-run is possible, and it is COUNTED") and the unit tier.

---

## PROOF

### Deterministic two-session interleave — psql, real Postgres

Fixture: £90 already committed this month ⇒ £10 of headroom. Each session
reserves a £10 claim. Session A opens a transaction, reserves, sleeps 3s, commits;
session B starts 1s in and reserves. The ordering is forced by the sleeps, so the
result does not depend on process-start luck.

**LOCK REMOVED (counterfactual — the conditional insert is still there):**

```
=== SESSION A ===
 A reserves 1000p | reserved |            9000 |              0
=== SESSION B ===
 B reserves 1000p | reserved |            9000 |              0     <-- read a stale 0
=== FINAL POSITION (ceiling is 10000p) ===
 committed_pence | reserved_pence | total_pence | claims_admitted
            9000 |           2000 |       11000 |               2
```

**£10 over the £100 ceiling. Two claims admitted where one fits.**

**AS SHIPPED (lock present):**

```
=== SESSION A ===
 A reserves 1000p | reserved |            9000 |              0
=== SESSION B ===
 B reserves 1000p | blocked  |            9000 |           1000     <-- waited, then saw A
=== FINAL POSITION (ceiling is 10000p) ===
 committed_pence | reserved_pence | total_pence | claims_admitted
            9000 |           1000 |       10000 |               1
```

**Exactly at the ceiling. The caller that would have breached is REFUSED.**

Session B blocked on `pg_advisory_xact_lock` for the ~2s A held its transaction,
then read A's committed claim. That is the whole mechanism in one transcript.

### N-way fan-out — 12 concurrent psql sessions

£70 committed ⇒ £30 headroom, £10 claims ⇒ exactly three fit.

| | reserved | blocked | committed + reserved | claims |
|---|---|---|---|---|
| **as shipped** | **3** | 9 | **10,000p** | 3 |
| lock removed (sample 1) | 5 | 7 | **12,000p** (20% breach) | 5 |
| lock removed (sample 2) | 3 | 9 | 10,000p — *race not won* | 3 |

### Simultaneous identical submits — 10 concurrent sessions, one content hash

| | reserved (paid) | duplicate |
|---|---|---|
| **as shipped** | **1** | 9 (`in_flight`) |
| lock removed (sample 1) | **6** — 6x the cost | 4 |
| lock removed (sample 2) | 1 | 9 — *race not won* |

**On the honesty of the "race not won" rows:** an unsynchronised fan-out of
`docker exec psql` processes only reproduces the defect when enough of them align
inside the window, so the lock-removed arm is **probabilistic** — it overshot in
some samples and not others. That is what a race *is*, and it is exactly why the
fix cannot be "be careful" and why the deterministic two-session interleave above
is the load-bearing counterfactual. The lock-removed arm never *prevents*
overshoot; it merely sometimes gets lucky. The shipped arm was exact in every
sample.

### Mutation proof — atomicity removed from the shipped migration, replayed

`pg_advisory_xact_lock` deleted from
`supabase/migrations/20261070000000_ai_budget_reservation.sql`, then
`supabase db reset --local`, then the real integration suite:

```
sample 1:  Tests  3 failed | 36 passed (39)
  - 100 simultaneous one-penny claims: expected 50 admitted, got 55   (10,005p vs 10,000p)
  - ten SIMULTANEOUS identical submits: expected 1 claim, got 7        (7x the cost)
  - concurrent storms in two orgs: expected 2000p reserved, got 4000p  (£20 breach)

sample 2:  Tests  4 failed | 35 passed (39)
  - 12 concurrent claims: expected 3 admitted, got 5
  - 100 simultaneous one-penny claims: expected 50, got 55
  - ten identical submits: expected 1 claim, got 4
  - concurrent storms in two orgs: expected 2000p, got 5000p           (£30 breach)
```

Lock restored, `supabase db reset --local` replayed, suite re-run:
**`Tests  39 passed (39)`**.

The three-to-four tests that fail are exactly the atomicity claims; the other 35
(RLS, teardown, settlement idempotence, TTL, the state machine) are indifferent to
the lock, which is the right shape for a mutation proof.

### The rest of the integration proof (39 tests, real Postgres)

- **Ceiling exact** under 12-way and 100-way concurrency; a claim that fits
  exactly is admitted and the next 1p claim is refused; a claim larger than the
  whole ceiling is refused outright; a non-positive ceiling means no spend.
- **Dedupe** — 10 simultaneous identical submits ⇒ 1 claim, 9 `in_flight`; after
  settlement a repeat is `recent_success` and is charged once; a *different*
  request is never suppressed; a **failed** or **released** attempt does not
  suppress its own retry; a claim with no hash is never deduplicated.
- **Stale claim reclaimed** — a 1s-TTL claim consumes budget while live (a
  competing reserve is blocked), then its headroom becomes usable with nothing
  external having run; exactly one of 8 concurrent callers reclaims it; an expired
  claim no longer suppresses its duplicate; **the TTL cannot be extended** (the
  identity columns are frozen, so staleness cannot be faked by UPDATE either).
- **Org isolation** — org A at its ceiling leaves org B unaffected; an identical
  request in org B is not a duplicate of org A's; concurrent storms in two orgs
  each fill their own ceiling exactly and do not bleed (`2,000p` and `1,000p`
  live, both totalling `10,000p`).
- **Settlement** — a success commits the *real* cost (250p against a 1,000p
  claim) and frees the claim; a failure settles with a code, zero tokens and 1p;
  a failure with no code gets `unknown_error`; settling twice writes **one**
  ledger row and returns the same `invocation_id`; settling a vanished claim
  writes nothing; a settled claim cannot be walked back to `reserved`; a claim's
  amount cannot be edited.
- **Trust boundary** — org admin reads own claims; **staff member sees nothing**
  (usage is admin information); another org's admin sees nothing; anon sees
  nothing; a tenant cannot INSERT (the DoS primitive — a forged 10,000p claim
  would refuse every AI call in the org), cannot DELETE, cannot UPDATE; the write
  RPCs are not executable by a tenant; the read rollup is invoker-rights so
  another org's admin gets nothing from it.
- **Teardown cascades** — `delete from organizations` removes claims *and* ledger
  rows with no error (the `20261052` lesson: no BEFORE DELETE guard).
- **Month window** — both rollups bucket the same invocation into the same
  Europe/London month, pinned against each other rather than against a literal.

### Unit and source proof

- Band maths at **0 / 49 / 50 / 79 / 80 / 99 / 100 / 101 %** of the ceiling, plus
  exactly-at-the-ceiling, zero/negative/NaN ceilings, and negative/NaN spend.
- Month boundaries in **Europe/London**: a BST month begins at 23:00Z the previous
  day; March is an hour short and October an hour long; `ukMonthKeyOf` and
  `ukMonthWindow` are mutual inverses at the boundary.
- Claim arithmetic: pessimistic, integer, never zero, always ≥ the cost it stands
  in for; TTL bounded on both sides and shorter than the dedupe window; failure
  floor.
- `__tests__/security/ai-cost-governor.test.ts` pins, against **source text**:
  the lock is present and precedes the aggregates; both gates are in the insert's
  own `WHERE`; dedupe is inside the critical section; no `SECURITY DEFINER`
  anywhere; no dynamic SQL; write RPCs granted to `service_role` **only**; exactly
  one RLS policy and it is admin `SELECT`; no insert/update/delete policy; DELETE
  unguarded; `deterministic` absent from the `task_class` CHECK; the claim floor is
  structural; the identity columns are frozen; no prompt/output column; **no cron,
  no provider, no credential**; the dark short-circuit precedes the reservation;
  and `invokeWithGovernor` contains no `await checkBudget(` and no
  `hasRecentIdentical`.

---

## THE CLOSURE (a later wave) — WHY WRAPPING WAS NOT ENOUGH

This document described three governed paths. An audit found five more that
reached a provider without the governor; sweeping for **provider-SDK
constructions** rather than for `isAiConfigured()` **gates** found two beyond
that, for seven — three of them tenant-facing (`/insights` prose, the `/insights`
answer box, lead summaries).

The non-obvious part: **wrapping them would have closed nothing.** The dark
short-circuit above runs the caller's function immediately when no tier is bound,
so a credential with no binding produced real, unmetered spend through the
*already-governed* paths too. The gate had to change, not just the wiring:

- Both provider doors — `lib/ai/text` and the new `lib/ai/vision` — require
  `isGovernorActivated()`, i.e. a **bound cost tier**, not merely a key.
- `isAiConfigured()` now has **zero callers**; it survives as an env probe only.
- The two OCR paths (`lib/imports/ocr.ts`, `server/services/expense-drafts.ts`)
  converged on `lib/ai/vision`; each previously built its own SDK client, and
  their hard-coded models had already drifted apart.
- `ungovernedCredentialRisk` is derived from
  `AI_UNGOVERNED_INFERENCE_ENTRY_POINTS` (0), which
  `__tests__/security/ai-governance-closure.test.ts` recomputes from source text.

## WHAT REMAINS BEFORE ACTIVATION IS SAFE

1. **Calibrate the reservation envelope** against the chosen model's real token
   distribution, in the same diff that binds it. `overrun_count` is the alarm; it
   should be zero in steady state.
2. **CEO authorisation + a credential**, neither of which this wave touches.
2b. **EMBEDDINGS ARE STILL UNGOVERNED, and this needs a migration.**
   `lib/ai/embeddings` spends real money and cannot enter this registry: the
   ledger's `task_class` CHECK admits only classification / drafting / complex,
   and an embedding is none of the three. Its exposure is bounded differently —
   the embedding worker is gated on `memory_embedding.worker_enabled`, so a
   credential alone does not start it — but HQ recall embeds a query on demand.
2c. **Decide HQ's ceiling.** `hq.draft`, `memory.summarise` and `research.*` have
   no tenant, so they bill CrewFlow's own org via `CREWFLOW_INTERNAL_ORG_ID`
   (fail-closed when unset). £100/month was chosen for a *customer's* unit
   economics; whether HQ deserves its own limit is a product decision.
2d. **Move the last three SDK constructions behind the doors.**
   `lead-summary.ts`, `receptionist.ts` and `research-llm.ts` are governed and
   activation-gated but still build their own clients. Not a hole — a duplication
   the ratchet allowlists by name and count.
3. **Decide the duplicate UX** — the seam returns `in_flight` vs `recent_success`;
   no surface distinguishes them yet (all callers currently degrade identically,
   which is correct but not maximally helpful).
4. **Watch the blocked-reason split** — `reservation_unavailable` blocks are a
   plumbing signal, not a money signal. They are logged loudly; a metric would be
   better than a log line once anything is live.
