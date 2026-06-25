# ADR 0003 — The Communication Layer

> **Status:** Accepted · **Date:** 2026-06-25 · **Directive:** CEO Directive 010,
> Phase 4 (Communication Layer) · **Supersedes:** none · **Superseded by:** none
>
> Third ADR under the [`../README.md`](../README.md) *document-before-you-build*
> rule, recorded in the same PR as the code. Phase 4 is a **major** architectural
> decision: the shared **delivery substrate** that turns an approved draft into a
> sent message through a replaceable provider — and stops there. It builds on the
> Approval Engine ([ADR 0001](./0001-approval-engine.md)) and the Draft Generation
> engine ([ADR 0002](./0002-draft-generation.md)).

---

## Context

Phase 2 gave the workforce a way to **gate** an action behind a human decision.
Phase 3 gave it a way to **produce** the thing being decided on — a *draft* —
without ever acting. Phase 4 gives it a way to **deliver** an approved draft
through a replaceable provider, and *nothing more*. The CEO's constraint is
explicit and repeated:

> "The objective is communication infrastructure. Not automation. Not autonomous
> outreach. Not campaign management… Nothing should ever send automatically.
> Every outbound communication still requires the Approval Engine. The Draft
> Engine and Communication Layer remain separate systems. No autonomous sending.
> No autonomous campaigns. No autonomous follow-ups."

So this is **infrastructure, not behaviour**. It is the third reusable layer of
the workforce communication stack — Shared Memory + Approval Engine + Draft
Intelligence + **Communication Layer** — and like the two engines before it, it is
shared substrate every future AI employee inherits, not Outreach-specific code.

The reuse audit found most pieces already present: a Resend email **transport**
([`lib/email/send.ts`](../../../lib/email/send.ts)) that already degrades to
`{sent:false,reason:"no_key"}` with no key, never throws, and guards self-loops; a
**rate limiter** ([`lib/security/rate-limit.ts`](../../../lib/security/rate-limit.ts))
that fails open; the **event spine** (`hq_emit_event`) and its single verb
[registry](../../../lib/events/registry.ts); the **Approval Engine**
(`hq_approvals` + [`lib/approvals/state.ts`](../../../lib/approvals/state.ts)) that
holds a proposal pending a human decision; the **Draft Engine** (`hq_drafts`) that
produces approval-ready drafts; the **provider-seam** pattern
([`lib/ai/text`](../../../lib/ai/text/index.ts)) of `getX(): X | null` (null when
unconfigured) where `generate()` *throws* and the caller owns recovery; the env
pattern (optional selector keys); and the trigger-enforced **state-machine
migration** pattern from `hq_approvals`.

What was **missing** is a deterministic, provider-agnostic delivery layer that
records every attempt immutably, is gated by the Approval Engine *at the database
level*, tracks delivery / bounce / complaint outcomes, honours a suppression list,
rate-limits, retries by superseding, accounts for cost, and **never sends
autonomously**.

## Decision

Build a generic **Communication Layer** in three mirrored layers — the same shape
as the Approval and Draft engines: a pure deterministic core, a DB-enforced
immutable artifact, and a thin orchestrating service. **The database is the
enforcer; the approval gate lives in SQL.**

1. **A pure core** ([`lib/comms/`](../../../lib/comms)). No I/O, no `server-only`.
   - `types.ts` — the **provider seam**: an `EmailProvider` interface
     (`info: { provider, channel }` + `send(message) → EmailAcceptance`), plus the
     pure `EmailMessage` and `EmailAcceptance` shapes. The seam is what makes every
     provider replaceable; the contract lives in pure code so the service and tests
     depend on the interface, never a vendor.
   - `state.ts` — the **delivery state machine**, mirroring `lib/approvals/state.ts`:
     one *active* state `sent` and the *terminal* set `delivered`, `bounced`,
     `complained`, `failed`, `suppressed`. A row is born `sent` (a provider accepted
     it), or born terminal `failed` (no provider, or a synchronous rejection), or
     born terminal `suppressed` (the address was on the list and was never handed to
     a provider). The only moves are the asynchronous outcomes
     `sent → delivered | bounced | complained`. Every action maps 1:1 onto a reserved
     `comm.*` verb — the engine mints no vocabulary beyond what the registry froze.
   - `policy.ts` — pure decisions: address normalisation, suppression matching,
     deterministic retry/backoff (`attempt → delay`), the plaintext→HTML lift the
     transport needs, and the rule that a `bounced` / `complained` / `suppressed`
     address must **never** be retried.
   - `cost.ts` — `emailCostUsd(...)`, mirroring `lib/drafts/cost.ts`. Email is
     effectively free at the provider, so today it returns a nominal/`null` cost;
     the ledger column exists for parity and for the SMS/voice channels that will
     reuse this artifact. Per the seam doctrine, **cost is observability, never a
     correctness gate**.

2. **A generic, RLS-locked artifact + suppression list** (migration
   [`supabase/migrations/20260801000000_hq_communications.sql`](../../../supabase/migrations/20260801000000_hq_communications.sql)).
   - `hq_communications` is one row per delivery **attempt** — generic by design
     (`subject_type` / `subject_id`), exactly like `hq_approvals` and `hq_drafts`. It
     carries `draft_id` (FK `hq_drafts`), **`approval_id` (FK `hq_approvals`, NOT
     NULL — the gate)**, `channel`, `provider`, `provider_message_id`, `to_address`,
     `status`, `failure_reason`, `attempt`, `supersedes_id` (self-ref), the cost
     ledger (`cost_usd`, `latency_ms`), `correlation_id`, and timestamps.
   - **The approval gate is enforced in SQL.** A `BEFORE INSERT` trigger looks up
     `(select state from public.hq_approvals where id = new.approval_id)` and raises
     unless it equals `'approved'`. A CHECK constraint cannot subquery; a trigger
     can. This is **the** security boundary: a delivery row *physically cannot exist*
     unless an approval sits in the `approved` terminal state. This is the
     architectural enforcement the CEO demanded — "every outbound communication still
     requires the Approval Engine," enforced through architecture, not convention.
   - A second `BEFORE` trigger enforces the state machine: born `sent` / `failed` /
     `suppressed`; terminal rows frozen (`restrict_violation`); write-once columns
     (draft, approval, recipient, correlation) immutable; only legal transitions; it
     auto-stamps the outcome timestamps.
   - An `AFTER INSERT/UPDATE` trigger (SECURITY DEFINER, `search_path=''`) emits one
     canonical `comm.*` event into the append-only spine **in the same transaction**.
     As in Phases 2 and 3, the payload carries **identifiers and metadata only**
     (status, channel, provider, `provider_message_id`, `draft_id`, `approval_id`,
     attempt, cost, latency, `failure_reason`, supersedes) — **never** the
     `to_address` and **never** the subject or body. PII stays in the RLS-locked row.
   - `hq_comms_suppressions` is the do-not-contact list — `address` (unique),
     `reason` (`bounce` / `complaint` / `manual`), `source`, `created_at` — also
     RLS-locked. A bounce or complaint adds to it; the policy refuses any send to a
     suppressed address.

3. **A thin service** ([`server/services/hq-comms.ts`](../../../server/services/hq-comms.ts)).
   `deliverDraft(input)`: load the draft and **fast-fail if its approval is not
   `approved`** (a clean mirror of the trigger) → check suppression → normalise the
   address → rate-limit (a `comms_send` preset on the existing limiter) → resolve
   `getEmailProvider()` **or** `null` → if null or the send throws, persist a
   terminal `failed` row (`reason:"no_provider"` / the error) and **send nothing** →
   else persist a `sent` row with the `provider_message_id`, cost, and latency.
   `recordDeliveryEvent(providerMessageId, outcome)` applies a webhook result
   (`delivered` / `bounced` / `complained`) and auto-suppresses on bounce/complaint.
   `retryDelivery(id)` lands a **new** attempt carrying `supersedes_id` (refusing a
   suppressed address). Plus `addSuppression` / `isSuppressed` and the reads. The
   service is the orchestrator and the fast-fail layer — **not** the boundary. The
   boundary is the trigger.

**One registry, a new domain.** A `comm.*` group is added **inside**
[`lib/events/registry.ts`](../../../lib/events/registry.ts) — a new *domain*, exactly
as `approval.*` and `memory.*` were, **not** a second vocabulary. Six reserved
verbs, past tense: `comm.sent`, `comm.delivered`, `comm.bounced`, `comm.complained`,
`comm.failed`, `comm.suppressed`. There is no `comm.queued` — the send is
synchronous, so there is no queued state to narrate.

**Two separate systems.** The Draft Engine and the Communication Layer are joined
only by a `draft_id` reference and their shared approval; neither imports the
other's internals. The Draft Engine *produces*; the Communication Layer *delivers*.
This is the CEO's "remain separate systems," kept true at the module boundary.

**No autonomy — a callable primitive only.** The service exposes `deliverDraft`,
and **nothing calls it on a timer**. There is no cron, no scheduler, no
queue-drainer, no follow-up logic anywhere in this PR. A human decision (an
approved `hq_approvals` row) and an explicit invocation are always upstream of any
send — mirroring how Phase 2 deferred the expiry scheduler and Phase 3 deferred
auto-submission.

**Determinism, and the CI path.** The pure core (state machine, policy, cost) is
exhaustively unit-pinned. CI runs with **no provider key**, so `getEmailProvider()`
returns `null`, `deliverDraft` records a terminal `failed` / `no_provider` row and
sends nothing — and **that** is the path the integration suite exercises
end-to-end, fully reproducible, exactly as Phase 3's deterministic fallback was.

## Alternatives weighed

- **Reuse `notification_email_queue` directly.** Rejected. It is a different
  bounded context — a mutable queue for internal transactional notifications,
  uncoupled from drafts and approvals, with no approval gate, no immutable
  per-attempt audit, no suppression/bounce model, and no provider abstraction.
  Coupling outbound *customer* communication to it would entangle two unrelated
  lifecycles. We **reuse the transport beneath it** (`lib/email/send.ts`), not the
  queue.
- **A `status` column instead of a state machine.** Rejected, as in ADR 0001. A
  column records *where* a row is but not *which moves are legal*; an enumerated
  machine makes "terminal is frozen" and "a bounced address is never un-bounced"
  provable, not conventional.
- **Enforce the approval gate in the service.** Rejected as the *boundary*
  (it remains as a fast-fail mirror). Service checks are bypassable by a second
  caller or a future job; the `BEFORE INSERT` trigger requiring
  `hq_approvals.state = 'approved'` is the unbypassable enforcer — architecture,
  not convention. The security suite pins that the service mirror and the SQL
  enforcer never diverge.
- **Mint `comm.*` outside the registry, or reuse `ai.*` / `notification.*`.**
  Rejected. `ai.*` is run-lifecycle (it narrates draft generation); `notification.*`
  is the internal-notification lifecycle; delivering an approved customer
  communication is its own domain. The directive mandates one registry — so a new
  domain group goes **in** it; it is not a duplicate vocabulary.
- **Retry by mutating the failed row in place.** Rejected. A delivery attempt is an
  immutable record; a retry is a **new** attempt that supersedes the old one,
  mirroring approval-recover and draft-supersede. The audit trail stays append-only.
- **Build the live webhook route, a second provider, and budget enforcement now.**
  Deferred. Phase 4 ships the `recordDeliveryEvent` primitive and the provider seam;
  a public, signature-verified, idempotent Resend webhook endpoint and a second
  provider are their own reviewable changes — mirroring how ADR 0001 deferred the
  reviewer UI / scheduler and ADR 0002 deferred the approval-submission wiring.

## Consequences

**What the workforce inherits.** One delivery substrate: an employee with an
approved draft calls `deliverDraft` and gets provider abstraction, delivery /
bounce / complaint tracking, suppression, rate limiting, retry-by-supersede, cost
accounting, and an immutable, spine-audited record — and never re-implements
transport, suppression, or audit.

**Security boundary.** Deliveries are reachable only through the HQ admin client;
the table is RLS-locked with no policies; the `BEFORE INSERT` trigger physically
refuses any delivery whose approval is not `approved`; the recipient address and
the prose never reach the event spine. The boundary cannot be bypassed from the
application layer because the application layer is not the boundary.

**What this explicitly does NOT do.** No autonomous sending, no campaigns, no
follow-ups, no scheduling, no automation. It delivers an approved draft when
explicitly invoked, records the outcome, and stops.

**Validation bar.** The full six-gate suite: the pure core unit-pinned (state
machine + policy + cost), security invariants (the approval gate, RLS, one
vocabulary, PII off-spine, mirror == enforcer), and the lifecycle against real
Postgres.

**Follow-ups (not in this PR).** The live Resend **webhook route**
(signature-verified, idempotent) feeding `recordDeliveryEvent`; suppression
management / un-suppression; a **second provider** that proves replaceability;
cross-employee send-budget enforcement; and additional channels (SMS, voice)
reusing this same artifact. Each is its own reviewable change.
