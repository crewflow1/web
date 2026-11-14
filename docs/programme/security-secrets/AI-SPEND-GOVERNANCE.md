# CrewFlow — AI spending governance: audit, fixes, and what only the founder can set

**Date:** 2026-11-13/14 · **Baseline:** `origin/main` `8cec66a7` · **Branch:** `security/secrets-and-ai-spend`
**Companion files:** `AI-CALL-SITES.csv` (every call site, one row each) · `SECRETS-REGISTER.md` (Part A).

Evidence labels: **VERIFIED** · **IMPLEMENTED-UNTESTED** · **SIMULATED-ONLY** ·
**BLOCKED** · **NEEDS-FOUNDER** · **NOT-IMPLEMENTED**.

> **Provider legs are SIMULATED-ONLY throughout.** The AI keys are deliberately
> absent from this environment. Nothing in this workstream contacted Anthropic or
> OpenAI. Every test that "reaches a provider" reaches a mock; the inert
> `ANTHROPIC_API_KEY` values used in tests and in the canary build exist only to
> satisfy the readiness check. What IS real: the governor seam, the limiter, and
> the budget ledger on a real local Postgres under genuine concurrency.

---

## 1. The two kinds of cap — stated plainly

There are two different things people call "a spending limit". They are not
interchangeable, and this document never uses one name for the other.

| | **Application budget** (what CrewFlow's code enforces) | **Provider hard cap** (what the vendor enforces) |
|---|---|---|
| Where it lives | `lib/ai/governor.ts` + Postgres (`ai_reserve_invocation`) | Anthropic Console / OpenAI dashboard |
| What it bounds | Spend by calls that pass **through the application** | **All** spend on the key/workspace, however it is made |
| Holds if the key leaks? | **No.** A leaked key is used from outside the app; the governor never sees it. | **Yes.** |
| Holds if a code path skips the governor? | **No.** | **Yes.** |
| Holds if the accounting under-counts? | **No** — it enforces what it *recorded*. | **Yes** — the vendor meters its own bill. |
| Granularity | Per tenant org, per user, per feature | Per organisation / workspace / project |
| Status in CrewFlow | **Built, live, and strengthened on this branch** | **Unverified — NEEDS-FOUNDER** (§6) |

**An application budget is not a provider hard cap, and neither is a usage
alert.** CrewFlow's £100/org/month ceiling is a strong application budget. It is
the *only* cap I could verify. Whether any provider-side cap exists is a
console setting I cannot read.

---

## 2. Production state (what is actually live)

- **Anthropic is ACTIVE in production.** The ledger holds 584 invocations, 229 in
  the last 30 days, totalling **£2.74** in that window, across both production
  orgs. **VERIFIED** (aggregate, read-only catalogue query; a sibling workstream
  independently reports ~580 logged calls).
- **OpenAI** is reported by a sibling workstream as in use for HQ-internal memory
  embeddings. Not independently verified here.
- All five tiers are **bound in code** (`lib/ai/governor/registry.ts:173`): a
  vendor key in Vercel is the only remaining switch. `docs/ai-cost-governor.md:5`
  still opens with "The governor is still DARK" — **that header is stale**; an
  addendum on this branch corrects it.
- **0** per-org ceiling overrides and **0** per-employee limits are configured in
  production. **VERIFIED.** So before this branch, *nothing* bounded one user's
  share of an org's budget.
- Worst-case application-bounded exposure today: **£100 × (number of orgs + the
  HQ org)** per month, rising to £500/org only by an explicit super-admin
  override (hard-clamped in SQL at 50,000p).

---

## 3. What the governor already did well — re-verified, not copied

| Property | Evidence | Label |
|---|---|---|
| Every provider call in the build is inside `invokeWithGovernor` | 21 governed call sites and 8 provider transports enumerated from source (SDK imports, `new Anthropic(`/`new OpenAI(`, `fetch` to AI hosts). `__tests__/security/ai-governance-closure.test.ts` re-derives "0 ungoverned entry points" from source text — 38/38. | **VERIFIED** |
| The ceiling is atomic (no check-then-act race) | `ai_reserve_invocation` takes `pg_advisory_xact_lock` per org, then a conditional insert with both gates in its own `WHERE` (live definition read from the local catalogue). `__tests__/integration/ai/budget-reservation.test.ts` — **39/39 on real Postgres**, incl. 12-way and 100-way concurrency, cross-org isolation, TTL reclaim, idempotent settle. | **VERIFIED** |
| The write RPCs are service-role only | `routine_privileges` for `ai_reserve_invocation` / `ai_settle_reservation` / `ai_release_reservation` / `rate_limit_hit`: `postgres`, `service_role` only. | **VERIFIED** (local catalogue) |
| Budget exhaustion fails closed | `reserveBudget` returns `blocked` on any RPC error or unrecognised outcome; `checkBudget` fails closed on an unreadable ledger. | **VERIFIED** (unit + the new seam test) |
| A key alone cannot switch on an unbound tier; a dark tier cannot be run through another tier's door | per-tier own-class gates at every door caller + the `tier_dark_provider_live` backstop | **VERIFIED** (`governor-per-tier.test.ts`, closure ratchet) |
| Every request states `max_tokens` and a timeout | see CSV; now also pinned by `ai-reservation-envelope.test.ts` | **VERIFIED** |

The structure is sound. The gaps were in **speed**, **claim sizing**, **failure
accounting** and **who is attributed** — not in whether calls are governed.

---

## 4. Gaps found, and what was done

### G-1 · P2 · No limit on how FAST the ceiling could be spent — **FIXED**
- **Gap.** The reservation bounds how much; nothing bounded how fast. Only 2 of
  21 call sites had any rate limit, and both used the per-IP, per-lambda-instance
  in-memory counter (`lib/security/rate-limit.ts` `enforce`), which a serverless
  fleet does not share. The 19 others — every server action, webhook and cron —
  had none. One signed-in user looping a route or action with varied input (so
  dedupe never matches) could claim an org's whole month in minutes.
- **Fix.** `lib/ai/governor/velocity.ts` (new), called at
  `lib/ai/governor.ts:1025`, **before** the reservation: a durable
  (`rate_limit_hit`, one atomic upsert), **fail-closed** limiter, per org per
  feature always and per user per feature when attributed. Limits are derived
  from money — 25 % (org) / 10 % (user) of the default ceiling per hour, in the
  call's own worst-case claim — so a dearer tier gets proportionally fewer calls
  with no second table to maintain. A refused call takes no claim, writes no
  ledger row, reaches no provider; a dark tier still costs zero round trips.

  | Tier | Claim | Org / h / feature | User / h / feature |
  |---|---|---|---|
  | cheap (Haiku 4.5) | 4p | 625 | 250 |
  | mid (Sonnet 5) | 5p | 500 | 200 |
  | high (Opus 5) | 16p | 156 | 62 |
  | embedding | 1p | 2,500 | 1,000 |
  | transcription | 2p | 1,250 | 500 |

- **Commit** `8e373c91`.
- **Tests.** `__tests__/ai/governor-velocity.test.ts` — 11/11 (mocked provider):
  arithmetic; one user refused at exactly the limit with the function not called
  and no reservation taken; a different user unaffected; refusals don't consume
  the org window; per-feature / per-org isolation; fails closed when the store
  throws; dark tier untouched. `__tests__/integration/ai/velocity-and-ceiling-seam.test.ts`
  — 6/6 on **real Postgres**: 40 simultaneous callers admitted **exactly** to the
  limit on the durable path; org window under concurrency, no cross-org bleed.
- **Label.** **VERIFIED** (limiter + ledger) · provider leg **SIMULATED-ONLY**.
- **Honest limit.** It turns "minutes" into "hours" (≥4 h per feature per org,
  ≥10 h per user). It is a brake, not a second ceiling. The numbers are a
  reasoned default, not tuned against traffic — review `voice_turn` (500/h/org)
  before voice goes live.

### G-2 · P2 · The two AI HTTP routes were limited per IP, in memory — **FIXED**
- **Gap.** `POST /api/ai/question` and `POST /api/ai/site-manager` used
  `enforce(request, …)`. `site-manager` is open to **any authenticated member**
  and runs the **most expensive tier** (Opus, 16p claim). `askAi` passed
  `userId: null`, so neither attribution nor the per-employee limit applied.
- **Fix.** `app/api/ai/question/route.ts:54`, `app/api/ai/site-manager/route.ts:55`
  → `enforceIdentifiedStrict` keyed on `org:user` (durable, fail-closed, 20/h);
  `server/services/ai-question.ts:142` now attributes the signed-in user.
- **Commit** `a38675b3`.
- **Tests.** Source pins re-keyed to the stronger control and refusing a
  regression to `enforce(request`: `__tests__/security/phase7.test.ts`,
  `__tests__/security/site-manager-read-only.test.ts`; `__tests__/ai/ai-question-provider.test.ts` still green.
- **Label.** **VERIFIED** by source pin + unit; the route was **not** exercised
  end-to-end over HTTP (IMPLEMENTED-UNTESTED at that level).

### G-3 · P2 · The mid-tier claim was smaller than its own worst case — **FIXED**
- **Gap.** PR #1070 raised the quote writer's output cap 2,000 → 4,000 tokens
  (`server/services/ai-quote-writer.ts:95`) and left
  `TIER_MODEL.mid.reserveOutputTokens` at 2,000, with a comment that the envelope
  "still caps spend". It does not: the envelope is the budget **claim**. Every
  quote draft was admitted on 3p against a 5p worst case, so N concurrent drafts
  could overshoot the ceiling by 2p × N.
- **Fix.** `lib/ai/governor/registry.ts:212` → 4,000.
- **Commit** `047119a0`.
- **Tests.** New ratchet `__tests__/security/ai-reservation-envelope.test.ts` —
  6/6: derives from source that no governed generative call site can request
  more output tokens than its tier reserves; the call-site table is **closed**
  (a new governed file fails until classified); every provider request sets
  `max_tokens`. **Mutation-checked**: reverting the envelope to 2,000 fails 2
  tests naming the quote writer. `__tests__/ai/tier-bindings.test.ts` re-pinned.
- **Label.** **VERIFIED**.

### G-4 · P3 · A timed-out call was recorded as 1p — **FIXED**
- **Gap.** Every governed request is non-streaming with an `AbortSignal`. When it
  fires we stop waiting; the vendor finishes and bills the whole call. The
  governor settled that at the 1p failure floor — under-counting by up to the
  full claim, worst in a slow-provider incident when many calls time out at once.
- **Fix.** `lib/ai/governor.ts:1114` — timeout/abort failures settle at the
  **claim**; every other failure keeps the 1p floor; tokens stay 0; the error is
  still rethrown. `isTimeoutLike` matches by constructor name as well as `.name`
  because the vendor SDK error classes do not set `.name` (**VERIFIED** in
  `node_modules/@anthropic-ai/sdk/error.js`).
- **Commit** `b05b4d02`.
- **Tests.** `__tests__/ai/governor-timeout-settlement.test.ts` — 7/7. One
  existing fixture in `quote-writer-governor.test.ts` threw `new Error("timeout")`
  to prove the floor; it now throws a vendor-side failure and still asserts the
  floor is 1p — the assertion is unchanged, only the fixture (commented in place).
- **Label.** **VERIFIED** (seam) · the claim that a vendor bills an abandoned
  non-streaming request is vendor behaviour I could not test — **SIMULATED-ONLY**.

### G-5 · P2 · An AI call on a RENDER path — **NOT-IMPLEMENTED**
- **Gap.** `app/(app)/insights/page.tsx:66` calls `resolveInsightNarrative` on
  every page load. The governor's own doctrine is "AI wakes on meaningful change,
  never on page load". The only thing between a refresh and a model call is a
  daily KV cache — and KV is optional (`isKvConfigured()`); without it the
  governor's 15-minute dedupe is the sole brake, and only while the payload is
  byte-identical. Attribution is `userId: null`.
- **Now bounded by** G-1 (500/h/org) and the ceiling. Not eliminated.
- **Next step.** Move generation to an event (nightly cron or an explicit
  "refresh" action) and have the page read a stored narrative; confirm whether
  `KV_REST_API_URL` is set in production (**NEEDS-FOUNDER**).

### G-6 · P2 · Sub-penny calls are booked at a whole penny — **NOT-IMPLEMENTED**
- **Gap.** `lib/ai/governor/policy.ts:339` rounds every non-zero cost **up** to
  1p (deliberately: never round real spend to zero). For embeddings that is a
  ~100,000× over-statement: a query embedding costs about 0.00001p and is booked
  at 1p. `app/api/search/route.ts:302` embeds once per distinct search query, so
  ~10,000 searches in a month would exhaust an org's £100 **on paper** and switch
  off every other AI feature for that org. It is over-counting — a self-inflicted
  denial of AI, not overspend — and only bites once embeddings are armed for
  tenants.
- **Next step.** Store cost in micro-pence (schema change to `ai_invocations` /
  `ai_cost_reservations` + the two rollups), or account embedding queries in
  batches. Needs a migration and a decision; reserved versions
  `20261322000000–20261323000000` were **not used**.

### G-7 · P3 · Vision input is bounded in bytes, not tokens — **NOT-IMPLEMENTED**
- **Gap.** `lib/imports/ocr.ts` (via `app/(app)/imports/actions.ts:173`) has no
  page/size check of its own; `AUTOFILL_MAX_BYTES` is 15 MB
  (`lib/imports/autofill/mime.ts:9`). In practice Next's 1 MB server-action body
  default is the bound. A dense multi-page PDF under 1 MB can still exceed the
  32k-token cheap envelope several times over, so the true cost can exceed the
  claim (the documented "residue"; `overrun_count` on `/admin/ai-costs` is the
  alarm). Same shape for `research.*` evidence packs vs the 24k `high` envelope.
- **Next step.** Cap pages before the call (or pre-flight with the vendor's
  token-count endpoint) and refuse over-envelope inputs.

### G-8 · P3 · SDK retries are implicit — **NOT-IMPLEMENTED**
- **Gap.** All seven SDK constructions (`lib/ai/text/anthropic.ts:59`,
  `lib/ai/vision/anthropic.ts:62`, `lib/ai/embeddings/openai.ts:65`,
  `lib/ai/text/openai.ts:41`, `server/services/lead-summary.ts:199`,
  `server/services/receptionist.ts:3286`, `server/services/research-llm.ts:164`)
  inherit `maxRetries = 2` (**VERIFIED** in `node_modules/@anthropic-ai/sdk/core.js:124`).
  One reservation can therefore cover up to three HTTP attempts. Retries fire only
  on 408/409/429/5xx/connection errors (normally unbilled) and never after our own
  abort, so this is not a retry storm — but it is an unstated multiplier. There is
  **no** application-level retry loop around any provider call (**VERIFIED** by
  reading all 21 sites).
- **Next step.** Pin `maxRetries` explicitly (0 or 1) at each construction; the
  closure ratchet allow-lists these lines by name, so do it in one reviewed diff.

### G-9 · P3 · Webhook-driven AI is limited only per IP, in memory — **NOT-IMPLEMENTED**
- **Gap.** `app/api/webhooks/vapi/chat-completions/route.ts:74`,
  `app/api/receptionist/inbound/route.ts:105` and the Twilio/e-mail/WhatsApp
  webhooks use the in-memory `enforce`. Each inbound message or caller utterance
  triggers one governed call billed to the **tenant**. All of these channels are
  dark today.
- **Now bounded by** G-1's org window and the ceiling.
- **Next step.** Before any channel is activated, move these to the durable
  limiter keyed on the resolved org.

### G-10 · Info · Background fan-out
Crons that reach a model: `memory-embed` (every 2 min), `tenant-search-embed`
(5 min), `memory-lifecycle` (15 min, loops N candidates — governor re-asked each
iteration, plus per-run caps), `research-drain` / `saga-drain` (5 min),
`hq-exec-tick` and `hq-roster-workers-tick` (6 h, ~29 runners). All HQ work bills
`CREWFLOW_INTERNAL_ORG_ID` and fails closed when it is unset; `tenant-search-embed`
bills each tenant. None bypasses the governor. All are now additionally subject
to the org velocity window. **VERIFIED** by reading the routes and services; the
crons were not executed.

### What was looked for and NOT found
Call sites that skip the governor — **none**. Missing `max_tokens` — **none**.
Application-level retry loops — **none**. Client-enforced rate limits on an AI
path — **none**. A check-then-act race in the ceiling — **none** (39/39 on real
Postgres). A way for a tenant to forge, edit or delete budget rows — **none**
(the existing suite proves insert/update/delete are refused to tenants).

---

## 5. Behaviour when the budget is exhausted

For every one of the 21 sites: the provider is **not called** and the feature
takes its existing degraded leg (deterministic answer, empty draft, keyword
extraction, "AI drafting is unavailable"). No site falls back to an ungoverned
call. The seam test proves it through the TypeScript layer on real Postgres:
headroom for two claims, twelve simultaneous calls → **exactly two** reach the
mock provider, ten are refused with `ceiling`, committed spend lands **on**
10,000p and never over, and a different org is unaffected. A user id the
database does not know is also refused (`reservation_unavailable`), never
treated as "no limit applies". **VERIFIED**.

Residual, by design and documented: a call whose true cost exceeds its claim can
push committed spend past the ceiling by the shortfall (G-7 is the realistic
source). `overrun_count` counts it.

---

## 6. Provider-level hard caps — NEEDS-FOUNDER

I cannot read either console. Nothing below is verified as configured. Menu
names move; treat the paths as "where to look", and treat the **outcome** as
the requirement.

### Anthropic — ACTIVE in production
A true provider-side hard cap **does exist**: Anthropic lets an organisation set
a monthly spend limit, and lets each **workspace** carry its own spend limit;
when a limit is reached the API refuses further requests until the period rolls
or the limit is raised. Prepaid credit with auto-reload turned off is a second,
blunter hard stop.

Set, in the Claude Console (console.anthropic.com → Settings):

1. **A dedicated workspace for CrewFlow production** (Settings → Workspaces),
   and make the production `ANTHROPIC_API_KEY` a key that belongs to *that*
   workspace only. Local/test keys go in a separate workspace so a laptop key
   (see `SECRETS-REGISTER.md` §2) can never spend the production allowance.
2. **A workspace spend limit** on that workspace (Workspace → Limits). Suggested
   starting value: **the sum of the application ceilings plus a margin** — with 2
   tenant orgs + HQ at £100 each, ≈ **US$400–500 / month**. Raise it deliberately
   as tenants are added. It should sit *above* what the app can legitimately
   spend and far below "painful".
3. **An organisation-level monthly spend limit** (Settings → Limits) as the outer
   wall, a little above the workspace limit.
4. **Auto-reload OFF**, or capped, if the account is on prepaid credits
   (Settings → Billing). Auto-reload with no cap turns a hard stop back into an
   open tap.
5. **Workspace rate limits** (requests/tokens per minute) lowered to what
   production needs — a second, speed-shaped provider-side bound.
6. **Spend alert e-mails** at ~50 % and ~80 %. *An alert is not a cap.* It tells
   you; it stops nothing.
7. Confirm who else holds keys in the organisation and revoke any that are unused.

### OpenAI — reported in use (HQ memory embeddings); also bound for transcription
Be careful with vocabulary here: OpenAI's per-project **"budget"** has
historically been a **notification threshold, not an enforced stop** — requests
can continue past it. I could not confirm current behaviour, so **do not rely on
a project budget as a hard cap.** The dependable hard stop is **prepaid credits
with auto-recharge OFF**: when the balance is gone, calls fail.

Set, in the OpenAI dashboard (platform.openai.com → Settings):

1. **A dedicated project** for CrewFlow production; the production
   `OPENAI_API_KEY` is a key of that project, **restricted** to the endpoints
   used (Embeddings; Audio only if transcription is wanted).
2. **Billing → auto-recharge OFF**, with a deliberately small prepaid balance
   (embeddings at $0.02/MTok are tiny; US$10–20 lasts a long time). This is the
   safest available hard cap.
3. **Project limits**: set the monthly budget *and* verify in the UI whether it
   is labelled as enforcing or notifying; set per-model rate limits and
   **disable every model the app does not use** on that project (allow only
   `text-embedding-3-small`, and `gpt-4o-mini-transcribe` if wanted) so a leaked
   key cannot be pointed at an expensive model.
4. **Usage alerts** — again, not a cap.

### Not AI, same lesson
Twilio, Vapi and Meta are dark. Before any is activated it needs the same
treatment (Twilio: no auto-recharge + a usage trigger that *suspends*; Vapi: a
monthly account limit). Out of scope here; listed so it is not forgotten.

### If no provider cap can be set
The safest alternative, in order: prepaid balance with no auto-reload → a key
scoped to one workspace/project with the minimum models → tight provider rate
limits → the application budget. The application budget alone is the weakest of
these against a leaked key, because a leaked key does not go through it.

---

## 7. Founder decisions

| # | Decision | Why |
|---|---|---|
| 1 | Set the Anthropic workspace + organisation spend limits (§6) | The only cap that survives a leaked key. Anthropic is live. |
| 2 | Set OpenAI to prepaid / no auto-recharge and restrict the project's models (§6) | Same, for the second live vendor. |
| 3 | Confirm which AI keys are in Vercel Production, and that none is in Preview | A key is the last switch: every tier is bound in code. |
| 4 | Decide HQ's own ceiling | HQ's ~29 runners share one £100 default chosen for a *customer's* economics. |
| 5 | Decide per-employee limits | None are configured; the velocity limit is now the only per-user bound. |
| 6 | Approve the velocity numbers, or ask for different shares | They are a reasoned default (25 % / 10 % per hour), not tuned. |
| 7 | Prioritise G-5 (render-path call) and G-6 (penny rounding) | Both need product/schema decisions I did not take unilaterally. |

---

## 8. Test evidence (HEAD `b05b4d02` + docs)

| Command | Result |
|---|---|
| `heavy.sh npm run typecheck` | exit 0 |
| `heavy.sh npx vitest run` (unit tier) | 736 files, **12,041 passed** |
| `heavy.sh npx vitest run --config vitest.security.config.ts` | 347 files, **8,663 passed** |
| `npx vitest run --config vitest.integration.config.ts __tests__/integration/ai` (real Postgres) | 5 files, **62 passed**, 2 skipped (pre-existing skips in `vision-document-extraction`) |
| `heavy.sh npm run build` (canary build, Part A) | exit 0 |

Not run: Playwright E2E (no UI flow changed), the non-AI integration suites, and
any live provider call.
