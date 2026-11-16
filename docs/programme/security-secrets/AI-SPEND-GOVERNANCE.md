# CrewFlow — AI spending governance: audit, fixes, and what only the founder can set

**Date:** 2026-11-13/14, updated 2026-11-16 · **Baseline:** `origin/main` `8cec66a7` (2026-11-16 additions: `d24295e`) · **Branch:** `security/secrets-and-ai-spend` → `ai/spend-governance`
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
| Status in CrewFlow | **Built, live, and strengthened on this branch** — per org, per employee, and CrewFlow-wide (§4b) | Vendor behaviour **VERIFIED from docs**; console settings **NEEDS-FOUNDER** (§6) |

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

### G-8 · P3 · SDK retries are implicit — **FIXED 2026-11-16 (§4b)**
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

### What was looked for and NOT found — addendum
See §4b for the 2026-11-16 bypass audit.

---

## 4b. Additions on `ai/spend-governance` (2026-11-16)

### G-11 · CrewFlow-wide monthly ceiling — **FIXED** (migration `20261358000000`)
One platform budget (`ai_platform_budget`, default **50,000p = £500 / Europe-London
month, pending founder confirmation**, clamped at 1,000,000p) enforced inside
`ai_reserve_invocation` under the org lock then a platform lock (fixed order, no
deadlock): a call must fit org **and** employee **and** platform headroom; refusal
reason `platform_ceiling`. Changed only via the audited service-role
`ai_set_platform_ceiling` (HQ section on `/admin/ai-costs`). **VERIFIED**:
`proofs/platform-ceiling-proof.sql` (rolled back; output identical to the
recorded `.out` on re-run) and `proofs/platform-ceiling-concurrency.sh`
(20 simultaneous 10p claims across 4 orgs, 50p platform headroom ⇒ exactly 5
reserved, 15 `platform_ceiling`; re-run 2026-11-16, state restored).

### G-12 · Alerts before limits — **FIXED** (migration `20261363000000`)
- **Was.** `warn_50` / `warn_80` / blocked rendered only on `/admin/ai-costs`.
- **Now.** HQ is notified (in-app HQ notification + the HQ e-mail recipients
  configured on `/admin/settings`, quiet hours honoured) the **first** time in a
  Europe/London month that an **org's** ceiling or the **CrewFlow-wide** ceiling
  reaches **80%** (priority high) and **100%** (urgent).
- **Exactly once.** `ai_claim_spend_alerts` inserts the crossed thresholds into
  `ai_spend_alert_marks` with `ON CONFLICT DO NOTHING` against partial unique
  indexes and returns only the rows it inserted — the database picks the single
  notifier across any number of instances. 100% also claims 80% so a stale 80%
  notice cannot follow a 100% one. A ceiling of 0 (AI switched off) raises
  nothing. Claim-then-notify: a crash between the two loses one notice
  (at-most-once), never duplicates.
- **"100%".** The reservation refuses the call that would cross the ceiling, so
  committed spend stops just short of it: the refusal (`ceiling` /
  `platform_ceiling`) **is** the limit-reached event; committed ≥ ceiling also
  counts. 80% is measured on committed (ledger) spend.
- **Cost on the request path.** Raised after settlement or on a refusal — never
  before a provider call, never a provider call itself. Most calls make **no**
  extra round trip: the org check runs only when the reservation's own figures
  (already in hand) put the org at ≥80% after this claim; the platform check at
  most once a minute per server instance; nothing once this instance has seen the
  month's marks. A check is one RPC bounded at 1.5 s with an early exit. Never
  throws (`lib/ai/governor/spend-alerts.ts`).
- **Evidence.** Unit `__tests__/ai/governor-spend-alerts.test.ts` (18);
  integration `__tests__/integration/ai/spend-threshold-alerts.test.ts` (7, real
  Postgres: 30-way concurrent refusals ⇒ exactly one claimant; org override
  honoured; AI-off org silent; platform refusal one-of-20; end-to-end three
  refusals ⇒ ONE `ai.budget.reached` HQ notification); rolled-back
  `proofs/spend-alerts-proof.sql` (platform 80% by spend, 100% by refusal, once
  each; client roles have no access). **VERIFIED.**

### G-13 · P3 · The quote writer told users "budget used up" for every refusal — **FIXED**
The panel rendered "This month's AI budget is used up (£spent of £ceiling)" for
**every** governor refusal, so a CrewFlow-wide, per-employee, rate-limit or
reservation-unavailable refusal showed e.g. "used up (£0.00 of £100.00)". The
service now passes the `BlockReason` through and `lib/ai/governor/refusal-copy.ts`
words each reason (figures only for the org ceiling; both limits point to CrewFlow
support, since only HQ can change them). `__tests__/ai/refusal-copy.test.ts`.

### Safe refusal — every governed site re-checked (call sites: `AI-CALL-SITES.csv`)
No call site branches on the refusal reason (grep of `app/ server/ lib/`), so
`platform_ceiling` degrades exactly like `ceiling` everywhere. **VERIFIED** by
reading each site's blocked branch:

| Site(s) | When refused, the user sees | Clear? |
|---|---|---|
| G03 quote writer | reason-specific message + "Write the quote as usual." | **Yes** (G-13) |
| G01 insights question, G17 site manager | the deterministic answer (labelled deterministic in the API result) | Sensible; does not say *why* |
| G02 insights narrative | deterministic cards only | Sensible; silent |
| G11 OCR import | an import with no rows to review | Sensible; silent (P3: say "AI unavailable — upload CSV/Excel") |
| G12 autofill, G13 expense receipt | an empty form/draft to complete by hand | Sensible; silent |
| G14 lead summary | the deterministic summary | Sensible; silent |
| G21 search | keyword results | Sensible; silent |
| G04–G10, G15, G16, G18–G20 | channel/HQ/cron paths: fixed acknowledgement, template, skipped step, deferred transcript | n/a to tenants (dark or HQ-internal) |

Nothing crashes or renders blank; only the quote writer explains itself. Adding
the same `aiRefusalMessage` to OCR / autofill / expense is a small P3 follow-up.

### Bypass audit — retries, parallel requests, alternate provider paths
- **Retries — FIXED (G-8).** All seven SDK constructions now pass
  `maxRetries: AI_SDK_MAX_RETRIES` (= **0**, `lib/ai/governor/policy.ts`). Both
  SDKs default to 2 retries on connection errors and 408/409/429/5xx
  (**VERIFIED** in `node_modules`: `@anthropic-ai/sdk` 0.32.1 and `openai`
  4.104.0 `core.js`); our own abort is not retried. A retry was a provider
  request inside one reservation — unreserved, not velocity-counted, and
  unledgered when the failed attempt had been billed. Now one governed call is at
  most one provider request; a transient error takes the feature's degraded path
  and a user retry goes back through velocity + reservation. The transcription
  transport is raw `fetch` with no retry loop. Ratcheted.
- **Parallel requests — no gap.** Org, employee and platform gates are decided in
  one locked transaction (concurrency proofs above; the existing 39/39 seam test);
  the velocity counter is one atomic upsert (40-way test in
  `velocity-and-ceiling-seam`).
- **Alternate provider paths — no gap; ratchet extended.**
  `__tests__/security/ai-governance-closure.test.ts` now also derives from
  source: the only AI-vendor host literal in `app/ lib/ server/` is
  `lib/ai/transcription/openai.ts` (one `fetch`, no loop), reached only via the
  private dispatcher inside the governed `voice_note.transcription` call; the
  OpenAI embedding transport is constructed only by the embedding door, which is
  governed (`memory.embedding_write|query`); every AI credential name —
  including `TRANSCRIPTION_API_KEY`, and bracket / destructured forms — is read
  only by the nine pinned files; `maxRetries` is pinned at every construction
  and never overridden. Mutation-checked (removing one pin fails the test).
- **Follow-ups (not done).** Surface a provider spend-cap refusal
  (`enforced_spend_limit_reached`, `*_spend_limit_exceeded`) to HQ as an alert,
  not just a log line; G-5, G-6, G-7, G-9 unchanged.

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

Since 2026-11-16 the same holds for the **CrewFlow-wide** ceiling
(`platform_ceiling`), HQ is **notified** at 80% and at the refusal (G-12), and
the quote writer states the true reason (G-13).

Residual, by design and documented: a call whose true cost exceeds its claim can
push committed spend past the ceiling by the shortfall (G-7 is the realistic
source). `overrun_count` counts it.

---

## 6. Provider-level hard caps — NEEDS-FOUNDER (console settings; vendor behaviour VERIFIED from docs 2026-11-16)

Nothing below is verified as **configured** — I cannot read either console and
made no console change. What changed on 2026-11-16 is that the vendors' own
current documentation was read, so the **behaviour** of each control is no
longer a guess. Sources: Anthropic, [Rate limits → Spend limits](https://platform.claude.com/docs/en/api/rate-limits);
OpenAI, [Spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
and [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits).

| Control | Anthropic (live) | OpenAI (embeddings; transcription bound) |
|---|---|---|
| Vendor-imposed monthly cap | **Hard.** Each tier has a monthly spend cap (Start $500, Build $1,000, Scale $200,000; Custom: none). At the cap requests return **HTTP 429** `rate_limit_error`, `error_code: enforced_spend_limit_reached`, **no `retry-after`**, until 00:00 UTC on the 1st. **VERIFIED (docs)** | An approved monthly **usage limit** per tier (Free $100, Build $500, Launch $5,000, Grow $200,000); error code `organization_usage_limit_exceeded`. **VERIFIED (docs)** |
| Customer-set org cap | **Hard.** Console → Settings → Spend limits (`platform.claude.com/settings/spend-limits`) → *Monthly spend limit* → *Set/Adjust limit* (≤ tier cap). Reached ⇒ **HTTP 400** `invalid_request_error` "You have reached your specified API usage limits…". **VERIFIED (docs)** | **Hard, if "Enforce a hard limit" is ON.** Settings → Organization limits → Spend → *Edit spend limit* → *Monthly spend limit* + **Enforce a hard limit**. Reached ⇒ **HTTP 429** `organization_spend_limit_exceeded`. Without the toggle it is only an alert. **VERIFIED (docs)** |
| Workspace / project cap | **Hard**, per workspace ("You can't set spend limits on the default workspace"); message "…specified workspace API usage limits". Workspace rate limits (RPM/ITPM/OTPM) too. **VERIFIED (docs)** | **Hard, if enforced**, per project: Project settings → Limits → Spend; ⇒ 429 `project_spend_limit_exceeded`; other projects unaffected. **VERIFIED (docs)** |
| Alerts | Not described on the spend-limits page. **UNVERIFIED** | "Spend alerts send a notification and do not cap spend"; a project limit creates a 100% alert by default. **VERIFIED (docs)** |
| Prepaid credits | Not described on that page. **UNVERIFIED** whether an exhausted prepaid balance stops calls or what auto-reload does today. | An exhausted prepaid balance ⇒ `credit_balance_exhausted` (calls fail). Auto-recharge **not described** on the page. **UNVERIFIED** |
| Precision | Not stated. | "Enforcement is not instantaneous" — recorded spend can slightly exceed the limit. **VERIFIED (docs)** |
| Endpoint coverage | Org/workspace spend limits apply to API usage of the org/workspace. | Docs say "API traffic" generally; embeddings / audio are **not named**. **UNVERIFIED** per endpoint. |

**This corrects the 2026-11-14 text**, which said an OpenAI project "budget" was
historically only a notification and that prepaid-without-auto-recharge was the
dependable stop: OpenAI now documents an enforced **hard** spend limit at
organisation and project level. The alert-only mode still exists — the toggle is
what makes it a cap.

### What the founder should set (no console change was made)
**Anthropic** — (1) a dedicated *CrewFlow production* workspace whose key is the
production `ANTHROPIC_API_KEY` (the default workspace cannot carry a spend
limit, so production must not live there); (2) a **workspace monthly spend
limit** slightly above the application's worst case — at the current
application settings that is the CrewFlow-wide ceiling, **£500 = US$625** at
the governor's `USD_TO_GBP = 0.8`, so ≈ **US$650–700**; (3) an **organisation spend
limit** a little above that as the outer wall; (4) lower workspace rate limits to
what production needs; (5) local/test keys in a separate workspace with a small
limit; revoke unused keys.

**OpenAI** — (1) a dedicated production project; key restricted to the endpoints
used (Embeddings; Audio only if transcription is wanted) and models allow-listed
(`text-embedding-3-small`, `gpt-4o-mini-transcribe`); (2) a **project monthly
spend limit with "Enforce a hard limit" ON** (embeddings are tiny — US$10–20
is generous); (3) an **organisation hard limit** above it; (4) keep alerts at
~50% / ~80% — they warn, they do not stop.

### How the application reacts when a provider cap bites
A provider refusal typically arrives as an exception inside the governed call
(the doors throw on a non-2xx): the reservation is **settled as a failure** at the 1p floor (it is not a timeout, so
not at the claim) and the feature takes its degraded path. With
`AI_SDK_MAX_RETRIES = 0` the SDK no longer retries the 429 (Anthropic notes its
SDK's automatic retries would fail anyway). So a provider cap degrades exactly
like the application budget — but the application does **not** yet tell HQ
*why*; an `enforced_spend_limit_reached` / `*_spend_limit_exceeded` code is only
in the logs (follow-up, §4b).

### Not AI, same lesson
Twilio, Vapi and Meta are dark. Vapi minutes (its own STT/TTS/telephony) are
billed by Vapi and are **outside** the AI governor by construction — only the
LLM turn it calls back into (`receptionist.voice_turn`) is governed. Before any
is activated it needs a vendor-side cap (Twilio: no auto-recharge + a usage
trigger that *suspends*; Vapi: a monthly account limit).

### If no provider cap can be set
In order: an enforced provider spend limit on a dedicated workspace/project →
a prepaid balance with no auto-reload → a key scoped to the minimum models →
tight provider rate limits → the application budget. The application budget
alone is the weakest of these against a leaked key, because a leaked key does
not go through it.

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
| 8 | **Confirm the CrewFlow-wide ceiling: £500 / month** (default in `20261358000000`; change on `/admin/ai-costs`) | It caps the sum of every org's AI spend; production spent £2.74 in 30 days to 2026-11-13. |
| 9 | Configure **HQ e-mail recipients** on `/admin/settings` | Without them the 80% / 100% alerts (G-12) are in-app HQ notifications only. |
| 10 | Accept **`AI_SDK_MAX_RETRIES = 0`** or choose 1–2 | 0 = one governed call is one provider request (exact ledger); each retry step re-admits up to one unrecorded billed request per reservation in the worst case, in exchange for riding out transient 429/5xx. |
| 11 | Set the provider caps in §6 with the **enforcing** options (Anthropic workspace + org spend limits; OpenAI project + org spend limit with *Enforce a hard limit* ON) | Vendor docs confirm both are hard stops; alerts alone are not. |

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

### 2026-11-16 re-run on `ai/spend-governance` (base `d24295e`)

| Command | Result |
|---|---|
| `heavy.sh npm run typecheck` | exit 0 (re-run after the last code change) |
| `heavy.sh npx vitest run` (unit tier) | 747 files, **12,110 passed** |
| `heavy.sh npx vitest run --config vitest.security.config.ts` | 350 files, **8,752 passed** (first run caught one new error-discarding read in `spend-alerts.ts`; fixed by binding + logging the error, then re-run green) |
| `npx vitest run --config vitest.integration.config.ts __tests__/integration/ai/` (real Postgres) | 6 files, **69 passed**, 2 skipped (pre-existing, `vision-document-extraction`) |
| `npx vitest run --config vitest.integration.config.ts __tests__/integration/rls/gdpr-export.test.ts` | 10 passed, 1 failed — REVERSE names only `subscription_cancellations` (billing #1090, known noise); `ai_spend_alert_marks` is classified |
| `npx eslint` on every changed .ts/.tsx | 0 errors (2 pre-existing warnings in `transcription-governed.test.ts`) |
| `proofs/platform-ceiling-proof.sql` (rolled back) | output identical to the recorded `.out` |
| `proofs/platform-ceiling-concurrency.sh` (local only, restores state) | 5 reserved / 15 `platform_ceiling` (expected 5) |
| `proofs/spend-alerts-proof.sql` (rolled back) | platform 80% once, 100% once, client roles denied |

Not run: Playwright (the only UI change is one message string in the quote-writer
panel), `npm run build`, the non-AI integration suites, and any live provider call.
