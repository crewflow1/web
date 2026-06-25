# CrewFlow Vision 2030 — programme roadmap

> **The destination.** CrewFlow is the operating system for UK construction
> businesses. Vision 2030 is the build toward an **AI-operated company**: a
> boardroom of specialised AI employees that research, qualify, win, onboard,
> and support customers end-to-end — every decision explainable, every action
> audited, every artifact reconstructable. Not a black box that runs the
> business, but a **transparent, gated, six-times-verified** one.

This is the living index of that build. It is updated **after every merged
module** (CEO standing mandate): completed modules marked, progress refreshed,
architectural decisions logged, and a handover summary kept current so anyone —
human or AI employee — can pick the work up cold.

**Last updated:** 2026-06-24 · on the merge of the **Shared Memory Engine**
(Directive #009; the roadmap previously labelled it #002) — PR #183,
merge `91eec1b`, tag `crewflow-shared-memory-v1.0`. _Previous: 2026-06-21, Module 3
— Lead Qualification AI (#180, `a21389d`)._

---

## Progress at a glance

| Workstream | Status | Progress |
|---|---|---|
| **HQ Sales AI programme** (Directive 003) | 3 of 7 modules shipped | ▓▓▓░░░░ **~43%** |
| **AI Boardroom roster** (Directive 001) | 14 employees seeded · 2 executing real work | ▓▓░░░░░░░░░░░ seeded; **execution unlocking** |
| **Event Spine** foundation (Directive 004) | core shipped (PR1–PR5) · Realtime + Hooks remain | ▓▓▓▓▓░░ **~71%** |
| **Shared Memory Engine** (Directive #009) | merged · validated to a 100k corpus · the reference implementation | ▓▓▓▓▓▓ **code live; prod migration gated** |
| **Six-gate CI bar** | enforced on every PR; newest modules at full bar | ▓▓▓▓▓▓ **live** |

Honest reading: the **foundation and the front of the sales funnel are built**.
Three Sales-AI modules and the Event Spine give CrewFlow HQ a working
prospect→intelligence→verdict pipeline with a permanent audit timeline. The
**conversion half of the funnel** (outreach → reply → demo → won) and the
**broader boardroom** (turning the 11 framework-only employees into executing
ones) are the open frontier.

---

## How to read this document

Two numbering schemes coexist in the repo, and conflating them causes confusion,
so this roadmap states the rule explicitly:

- **The HQ Sales AI programme** (this document's primary spine) numbers its
  modules **1 = Company Intelligence Database, 2 = Company Research AI,
  3 = Lead Qualification AI** — matching the merged PR titles (#178, #179, #180).
- **The Event Spine** is numbered **within its own doc** as "Module 1 of the HQ
  programme" with an internal PR1–PR7 sequence. It is **HQ-wide infrastructure**
  (the audit/timeline substrate every module writes to), not a Sales-AI module —
  this roadmap treats it as the **foundation track**, below.

When a doc header says "Module N", check which track it means.

---

## The governance layer — CEO Directives

The directives are the constitution; the modules are the build. Confirmed,
in-repo directives:

| # | Title | What it governs | Anchor |
|---|---|---|---|
| **001** | AI Employee Framework / AI Boardroom | The roster of specialised AI employees and the `ai_employees` table; framework + seed. | `supabase/migrations/20260712000100_ai_employees_seed.sql` |
| **003** | HQ Sales AI programme | The umbrella for the Sales-AI module sequence (this roadmap's spine). "Maximum reuse. Minimum complexity. One architecture. One source of truth." | `docs/sales-ai.md`, `docs/lead-qualification.md` |
| **003.5** | Lock the Foundation | Freeze Architecture v1.0 + the governance "programme pack". | commit `6d63d60` |
| **004** | Engineering Bible / Event Spine / six-gate CI | The frozen data-model reservation (the `hq_sales_*` family), the Event Spine architecture, and the **mandatory six-gate, production-equivalent verification**. | `docs/event-spine.md`, `.github/workflows/ci.yml` |
| **005** | Company Research AI | The first **operational** AI employee (Sales programme Module 2). | `docs/research-ai.md` |
| **009** | Shared Memory Engine — ✅ **shipped** | The company knowledge graph every AI employee reads/writes — the "company brain". Built end-to-end: `queue→embed→store→ANN→recall`, lifecycle, `forget`, and the `ctx.memory` SDK facet. Merged PR #183 (`91eec1b`), tag `crewflow-shared-memory-v1.0`. _Canonical **#009** — the roadmap previously labelled this #002, now retired; see `docs/bible/governance/numbering.md`._ | `supabase/migrations/20260722…20260728_*`, `server/sdk/memory.ts` |
| **010** | The Conversion Arc | The shared conversion substrate — **Approval Engine**, **Draft Generation**, **Communication Layer** — plus Outreach AI Phases 1–4. Each phase carries an ADR (`0001`–`0003`). Phases authored; PRs #187/#188/#189 pending merge. | `supabase/migrations/20260730…20260801_*`, `docs/bible/decisions/0001-approval-engine.md` |

> ✅ **Numbering — resolved (CEO Directive #011 / Master Roadmap D-01).** One
> canonical scheme now governs, recorded in full at
> `docs/bible/governance/numbering.md`: the **thing-name is the identity**, the
> number is metadata, monotonic from **#011** and never reused. The Shared Memory
> Engine's canonical number is **#009** (the old **#002** label is retired);
> `#006`–`#008` were never issued (they survive only as directory self-labels and
> branch names); the first operational employee is **#005** (the brief that called
> "the first AI employee #004" collided with the Event Spine, which is #004). The
> highest substantive directive before this reconciliation is **#010** (The
> Conversion Arc); this reconciliation is **#011**; the next free number is **#012**.

---

## The AI Boardroom — 14 employees seeded

The roster (Directive 001) is the org chart. **Seeded ≠ executing**: most
employees are framework rows awaiting their execution module. Two now perform
real, gated work — and they are the template for the rest.

| # | Slug | Role | Executes? |
|---|---|---|---|
| 1 | `ceo-ai` | CEO AI | framework |
| 2 | `cto-ai` | CTO AI | framework |
| 3 | `sales-ai` | Sales AI | framework (the platform; see Directive 003) |
| 4 | `marketing-ai` | Marketing AI | framework |
| 5 | `design-ai` | Design AI | framework |
| 6 | `qa-ai` | QA AI | framework |
| 7 | `documentation-ai` | Documentation AI | framework |
| 8 | `product-ai` | Product AI | framework |
| 9 | `finance-ai` | Finance AI | framework |
| 10 | `support-ai` | Support AI | framework |
| 11 | `operations-ai` | Operations AI | framework |
| 12 | `research-ai` | **Company Research AI** | ✅ **executing** (read + draft, human-approved) |
| 13 | `lead-qualification` | **Lead Qualification AI** | ✅ **executing** (autonomous, deterministic) |
| 14 | `outreach-ai` | **Outreach AI** | framework — seeded Directive #010 Ph.1 (draft-only; no `send` scope) |

The **12th and 13th** members are the first to leave the framework and do work.
Each future executing employee follows the same template (see _Architectural
decisions_): one row here, one task type, one `server-only` runner, pure shared
`lib/*` layers, the same six-gate coverage — and **no new data surface**.

---

## Workstream A — the HQ Sales AI programme (Directive 003)

A seven-module arc from "a name on a list" to "a won customer". Each module is
one executing capability layered on the inert Directive-004 `hq_sales_*`
foundation, reusing it wholesale.

### ✅ Module 1 — Company Intelligence Database — _shipped (PR #178)_

The data foundation: the `hq_sales_*` family (companies, contacts, timeline,
tasks, sources, scores) with RLS-on / zero-policy isolation, tenant-decoupled
from the customer product. The schema every later module writes to.
→ `docs/sales-ai.md`

### ✅ Module 2 — Company Research AI — _shipped (PR #179, Directive 005)_

The first executing employee. Given a name / website / Companies House number it
builds a transparent intelligence profile, a **ten-factor explainable score**, a
cold-call brief, and **draft** outreach — fetching public signals, SSRF-hardened,
degrading to a deterministic path without a model key, **never inventing** (a
silent source is `null`). Read + draft only; every outbound artifact waits for a
human (`requires_approval = true`). It scores a company but leaves it at
`status = 'new'`.
→ `docs/research-ai.md`

### ✅ Module 3 — Lead Qualification AI — _shipped (PR #180) · this update_

The decision-maker. It reads what Research AI persisted and returns **one
explainable verdict** — qualified / disqualified / needs-review — moving the
right leads off `new` along the existing pipeline and holding the uncertain for a
human. Two deliberate divergences from Research AI, each bounded in code and
pinned in the security tier:
- **Autonomous** (`requires_approval = false`) — the call *is* the module; safe
  because it is an internal, reversible classification with tight scopes
  (read/score/qualify), a transition guarded by `status === 'new'`, and a target
  typed so it can only ever land on a qualification status.
- **Deterministic** (no LLM) — a gating verdict must be reconstructable from
  named rules (five weighted criteria, a hard territory gate, named thresholds),
  not an opaque sample. The rubric is the whole arbiter; the model is NULL.

Shipped with the **full six-gate bar from the start** (not retro-fitted).
→ `docs/lead-qualification.md`

### ◻ Modules 4–7 — the conversion arc — _not yet specified_

These modules are **not named or scoped anywhere in the repo yet**, so this
roadmap does not invent them. What *is* grounded is the destination: the existing
pipeline ladder and seeded task types name the work that remains to carry a
**qualified** lead to **won**:

```
new → qualified → outreach_ready → contacted → replied → demo_booked → won
                                                                      ↘ lost
```

Seeded `hq_sales_task_types` already reserve the vocabulary for it — generate /
send email, LinkedIn touch, cold-call, objection handling, demo, follow-up,
proposal. The natural shape of Modules 4–7 (subject to a CEO directive that
names them): an **Outreach AI** that drafts and sequences the first touch on a
qualified lead (human-approved send), a **Conversation / Reply AI**, a **Demo /
Meeting AI**, and a **Close / Proposal AI** — each an executing employee built on
the same template, each adding *work*, not a new data surface. **Treat the names
above as projection, not commitment, until a directive fixes them.**

---

## Workstream B — the Event Spine (Directive 004 foundation)

HQ-wide infrastructure: an append-only, partitioned **truth log** (`hq_events`)
plus its consumers and the timeline projection that powers The Pulse. It is the
audit backbone the Sales-AI modules' own timelines complement. Internal sequence
(see `docs/event-spine.md`): PR1 Spine Core · PR2 Producers · PR3 Offset Consumer
· PR4 Historical Backfill · PR5 Timeline / The Pulse — **all shipped**. PR6
(Realtime) and PR7 (Hooks) remain.

> Boundary the Sales-AI modules honour: a module **never writes the spine truth
> log directly** — `hq_events` is the spine's. Each module keeps its own
> `hq_sales_timeline_events` rows. This separation is pinned in every module's
> security tier.

---

## Workstream C — the Shared Memory Engine (Directive #009)

HQ-wide infrastructure, parallel to the Event Spine: the **company brain** every AI
employee reads and writes through **one** engine. Shipped end-to-end and merged at
`91eec1b` (PR #183), tagged `crewflow-shared-memory-v1.0`.

**What shipped.** The full `queue → embed → store → ANN → recall` loop over
`hq_memories` + pgvector; lifecycle dedupe; a `forget` primitive; the `ctx.memory`
SDK facet (`server/sdk/memory.ts` — the **first built piece of the AI Employee
SDK**); two dark-by-default background workers (embed `/2m`, lifecycle `/15m`).
Permission is **always enforced first, server-side**; embeddings/LLM are a
**graceful plug-in, never a hard dependency** (no key ⇒ semantic search goes dark,
every other recall channel keeps working).

**How it was validated.** Entirely on a **local Docker Supabase** (Postgres 17.6 /
pgvector 0.8.0) with a deterministic offline provider — **production was never
touched**. All six gates green; performance measured to a **100k-memory corpus**;
crash/lease-reclaim, backoff, dead-letter and the adversarial security surface
proven against real Postgres. The finalize gate caught and fixed **two real
production bugs** invisible to mocks (a recall system-memory leak; a `callRpc`
this-binding), each now pinned by a real-client test. **This is the reference
implementation** for every module that follows, and the local-validation strategy
is now the standard.

> **Doctrine adopted (permanent):** _a mock proves orchestration, never the wire._
> Every service path that reaches Postgres carries at least one real-client test.

**Production migration is a separate, gated step.** The merge is code-only. Prod has
the base memory schema (`20260713_*`) but **not** the 7 engine migrations
(`20260722…20260728`). Prod's ledger also lags `main` by two prior migrations
(`hq_timeline_projection`, `lead_qualification_employee`), so a future
`supabase db push` would apply **9** migrations — to be scheduled with CEO approval,
never auto-applied.

### ◻ Module 1A — Recall Optimisation — _follow-up, not yet built_

A scoped, **performance-only** fast-follow flagged at the finalize gate (CEO-approved
as a follow-up, explicitly **not** part of Module 1). On a corpus-wide query the
unbounded `lexical` CTE feeds every permitted match into an exact per-candidate
cosine recompute (≈600 ms at 100k for the worst-case bench query that matches the
whole corpus). The fix: **cap the lexical candidate set with a bounded `ts_rank`
pre-limit before cosine enrichment**, mirroring the already-bounded `LIMIT 60`
semantic channel. **Strict boundary: no behavioural, ranking, permission, or API
change — latency only.** The recall *contract* (permission-first, frozen order, no
body/embedding/system leak) is unaffected. A future project, not Module 1.

---

## The quality regime — the six-gate bar (Directive 004)

Every PR clears six independent CI jobs (`.github/workflows/ci.yml`); a module is
not "done" until all six are green on real infrastructure:

| Gate | Job | Proves |
|---|---|---|
| 1 | **typecheck** | `tsc --noEmit` clean |
| 2 | **lint** | `eslint` clean (warnings non-fatal) |
| 3 | **tests** | unit tier (pure logic, mocked Supabase) |
| 4 | **integration (real Postgres)** | runners vs a real DB via `supabase start` |
| 5 | **security (trust boundaries)** | trust-boundary invariants pinned against source |
| 6 | **e2e (real app, real Postgres)** | the real production build + Playwright auth wall |

CI-issue protocol (non-negotiable): **Stop. Fix it. Document it. Re-run every
gate. Continue only once green. Never work around CI.**

The **living-knowledge-base rule** pairs with it: every engineering lesson is
documented in the *same* change that taught it (each module's `docs/*.md` carries
an "Engineering lessons" section).

---

## Architectural decisions log

The load-bearing decisions, so future modules inherit them rather than rediscover
them:

1. **The AI-employee runner template.** A new executing employee is: one
   `ai_employees` row + one `hq_sales_task_types` slug + a `server-only`,
   service-role runner that *claims* its task off `hq_sales_ai_tasks` (a
   conditional `pending → running` update — idempotent, double-kick-safe),
   checkpoints `result` jsonb per step, mirrors steps to the company timeline,
   and persists through the existing `hq-sales.ts` writers. It **owns no new
   table**. Pure `lib/<employee>/*` layers are shared verbatim by runner, UI, and
   tests.
2. **Reuse over invention (Directive 003's core).** A new provenance channel is a
   **lookup row** (`hq_sales_sources`), not a schema change; a verdict reuses the
   existing `scored` event type; a transition reuses `setCompanyStatus`. Reach
   for the existing vocabulary before touching a constraint.
3. **Honest nulls — never fabricate.** When a source is silent the value is
   `null` / "unknown", surfaced as a first-class, non-failing result. An
   unevidenced criterion is listed and excluded from confidence, never silently
   scored.
4. **Transparency as a contract.** Where a number gates a decision it must be
   explainable — Research AI's ten weighted factors, Lead Qualification's five
   weighted criteria with a confidence figure and a plain-English rationale. "No
   black box."
5. **Determinism as a _security_ property (Module 3).** For a gating decision,
   "no model" is a testable invariant, not a style choice: NULL provider, no
   provider name in the path, no clock/RNG in the rubric — pinned so a model can
   never silently creep in.
6. **Bounded autonomy in code, not by a label (Module 3).** Removing the human
   approval gate is safe only when the autonomy is bounded structurally — tight
   scopes, a status-guarded transition, and a target made unreachable by type —
   and every part of that bound is pinned in the security tier.
7. **The 404-not-403 non-disclosure gate.** Every HQ surface sits behind the
   single `app/admin/layout.tsx` chokepoint (`requireHqPage()`); routes and
   actions re-check the Super-Admin allowlist (defence in depth) and answer
   **404** to non-allowlisted callers — a 403 would announce the surface exists.
8. **Tenant decoupling.** No HQ prospect engine ever reads a customer/tenant
   table (`organizations`, `customers`, `leads`, `jobs`, `quotes`, `invoices`)
   or the spine truth log (`hq_events`).

---

## Handover summary (pick-up-cold briefing)

**Where we are.** Module 3 (Lead Qualification AI) is merged to `main` (PR #180,
`a21389d`) and deploying. The Sales-AI funnel now runs `new → researched/scored
→ qualified | disqualified`, with a permanent, attributed audit trail and a live
HQ UI at `/admin/qualification`. The repo is green on all six gates. The **Shared
Memory Engine** is now also merged (PR #183, `91eec1b`) — the company brain plus the
first SDK facet (`ctx.memory`); its production migration is gated, not yet applied
(see Workstream C).

**What exists to build on.**
- **Template:** copy the Research AI / Lead Qualification AI shape (see decision
  #1). The two `docs/{research-ai,lead-qualification}.md` files are worked
  examples end-to-end.
- **Foundation:** the `hq_sales_*` family + the Event Spine are in place; reuse
  them. The pipeline ladder and seeded task types already name the unbuilt work.
- **Quality bar:** `.github/workflows/ci.yml` is the six-gate definition;
  `npm run typecheck|lint|test|test:integration|test:security|test:e2e` runs them
  locally (integration/e2e self-skip without a DB and run in CI). The local
  `next build` needs three `NEXT_PUBLIC_*` env vars present (see
  `docs/lead-qualification.md` validation gate).

**What's next (in priority order).**
1. **A CEO directive naming Modules 4–7** (the conversion arc). Until it lands,
   the module names are projection, not commitment — do not invent the schema.
2. **Module 4 — the first conversion employee** (likely Outreach AI on qualified
   leads, human-approved send). Built on the template; the qualified-lead handoff
   is already the natural trigger.
3. **Event Spine PR6 (Realtime) + PR7 (Hooks)** to finish the foundation track.
4. **Continue unlocking the boardroom** — turn framework-only employees into
   executing ones as their modules are directed.

**Operating rules that don't change.** UK construction domain · British spelling
· maximum reuse / minimum complexity · honest nulls · six-gate bar on every PR ·
living-knowledge-base on every change · branch → preview → human-approved merge ·
**this roadmap updated after every merged module.**

---

### Module changelog

| Date | Module | PR | Merge |
|---|---|---|---|
| 2026-06-24 | Shared Memory Engine — _Directive #009_ (canonical; early artifacts labelled it #002) | #183 | `91eec1b` |
| 2026-06-21 | Module 3 — Lead Qualification AI | #180 | `a21389d` |
| — | Module 2 — Company Research AI | #179 | `8d0b531` |
| — | Module 1 — Company Intelligence Database | #178 | `465937d` |
