# CrewFlow Bible — Adoption & Gap Analysis

> **Status:** Constitutional study. **No implementation.** This document reads the
> CrewFlow Bible as a new executive engineer would on day one, measures it against
> the *actual* codebase, and answers the ten questions posed on adoption. It
> changes no product code, no schema, no configuration. It is the first artifact
> of the in-repo Bible (`docs/bible/`).
>
> **Date:** 2026-06-21 · **Author:** Engineering (onboarding review) ·
> **Method:** evidence-based — every claim about "what is built" is grounded in a
> repository census (Appendix B), not memory or assumption. Where the Bible says a
> thing exists and the repo disagrees, the repo wins and it is recorded as a gap.
>
> **Now also the living engineering tracker (CEO Directive #011 / D-01).** The
> study in §0–§10 is the **2026-06-21 baseline**, frozen as authored. From Directive
> #011 onward this file is updated **after every merged directive**: the
> [Living engineering tracker](#living-engineering-tracker) immediately below carries
> the current census and the per-directive merge log. Where a baseline figure has
> since moved, the tracker is authoritative.

---

## Living engineering tracker

> Updated after every merged directive (CEO standing mandate). The 2026-06-21 study
> below is the frozen baseline; this section is the moving picture. Numbering is
> canonical per [`governance/numbering.md`](./governance/numbering.md).

**Current census (delta from the 2026-06-21 baseline):**

| Metric | Baseline (2026-06-21) | Current | Note |
|---|---|---|---|
| Migrations | 92 | **103** | +11: Shared Memory engine (×7), approvals, drafts, communications, plus the outreach/research/qualification employee seeds |
| AI employees seeded | 13 | **14** | +1: `outreach-ai` (Directive #010, Phase 1) |
| AI employees executing | 2 | **2** | `research-ai`, `lead-qualification` (unchanged) |
| Employee specifications | — | **42** | `docs/bible/workforce/employees/01..42-*.md` |
| ADRs recorded | 0 | **3** | `decisions/0001`–`0003`; next free `0004` |

**Per-directive merge log:**

| Canonical # | Directive | State | Anchor |
|---|---|---|---|
| **#009** | Shared Memory Engine | merged (PR #183) · prod migration gated | tag `crewflow-shared-memory-v1.0` |
| **#010** | The Conversion Arc — Approval · Draft · Comms · Outreach Ph.1–4 | phases authored; PRs #187/#188/#189 pending merge | ADRs [`0001`](./decisions/0001-approval-engine.md)–[`0003`](./decisions/0003-communication-layer.md) |
| **#011** | Governance, Numbering & Scope Reconciliation (D-01) | in progress (this change) — documentation only | [`governance/numbering.md`](./governance/numbering.md) |

> The §9 directive sequence (#006…) below is the **original recommendation**,
> superseded for anything not yet issued; the live forward plan is the Master
> Roadmap (D-01…D-19 → #011…#029).

---

## 0. How this was measured

The Bible is aspirational doctrine; the repository is fact. To compare them I
took a census of `/Users/moetalibi/Code/web-ci` (`origin/main` @ the Module-3
merge). The load-bearing numbers (full table in Appendix B):

- **137** customer/admin pages, **~53** internal API route handlers, **13** cron
  drains/pollers.
- **~50** server services (`server/services/*.ts`), **~50** pure `lib/*` domains.
- **92** migrations declaring **99** tables (baseline; **103** as of Directive
  #010 — see the living tracker); **40** migrations enable RLS, **26** declare
  policies.
- **154** unit test files across **~45** domains; **5** Playwright e2e specs;
  the **six-gate CI** (typecheck · lint · unit · integration-real-Postgres ·
  security · e2e) is live.
- **13** AI employees seeded (baseline; **14** as of Directive #010 Phase 1 —
  `outreach-ai`); **2** actually executing (`research-ai`, `lead-qualification`).
- **2** shared UI primitives (`components/ui/button.tsx`, `skeleton.tsx`).
- Integrations present: **Stripe, Twilio, Resend, Anthropic, OpenAI, PostHog,
  Sentry**. **`inngest` is installed but unwired (0 usages).** No realtime push,
  no `/api/v1`, no public API.

The single most important measured fact: **the operational SaaS underneath
CrewFlow is real and substantial; the "AI operating system" thesis that the
Bible is *named for* is still nascent** (two isolated runners, a roster view, no
orchestration, no live shared memory). Hold that split in mind through everything
below.

---

## 1. Executive summary

CrewFlow's Bible is a **coherent, unusually disciplined product constitution.**
Its spine is a single promise repeated in every volume — *save time, make money,
reduce admin, reduce mistakes, give peace of mind* — and two filters that decide
what gets built (the **Golden Rule** and the **30% Rule**). Its bet is bigger
than "construction SaaS": CrewFlow intends to be an **AI-operated company**
running an AI operating system for its customers, with a workforce of
specialised, permissioned, audited AI employees coordinated through an **AI
Boardroom**.

The doctrine is strongest where it is most concrete: the **Engineering Standards
(IX), Security (VII), and Database (V)** volumes describe a regime that the
repository **actually honours today** — RLS-first multi-tenancy, least
privilege, a six-gate production-equivalent CI, and an append-only event spine.
This is the part of the Bible that is already lived, not just written.

The doctrine is weakest — and most duplicated — where it is most ambitious: the
**AI workforce**. The AI material is written **three times** (Volume IV, the
second "Volume VII — AI Workforce Architecture", and the second "Volume VIII —
AI Boardroom Architecture") with **conflicting rosters** (13 employees vs ~30)
and a numbering collision against Security/Design. In the codebase this layer is
~10–15% real: the *template* for an AI employee is proven twice, but the
**orchestration, communication protocol, decision centre, live shared memory,
cost controls and the other ~28 employees do not exist**.

The honest headline: **CrewFlow has built an excellent foundation for the Bible's
*platform* and *engineering* volumes, and has barely begun the Bible's
*defining* idea — the coordinated AI workforce.** The foundation is the moat that
makes the AI thesis buildable; the AI thesis is the reason the foundation is
worth building. The strategic risk is not the foundation — it is starting more
*individual* AI employees before the **shared substrate** (employee SDK,
permission/guardrail model, explainability/audit framework, event bus, live
memory) that every one of them depends on is itself made doctrine and built once.

**Recommendation in one line:** ratify the Bible, fix its internal numbering and
roster contradictions, and make the **AI substrate** — not the next employee —
the next directive.

---

## 2. Contradictions & architectural conflicts

Grounded, specific, and ordered by how much they should change a decision.

**C1 — The AI workforce is specified three times, inconsistently (structural).**
The AI employees appear in *Volume IV — The AI Workforce* (≈13 roles), in a
**second** *Volume VII — AI Workforce Architecture* (≈30 roles: adds COO, CFO,
Engineering Manager, Security, DevOps, Database, API, Customer Success,
Onboarding, Analytics, HR, Legal & Compliance, AI Orchestrator, Memory Manager,
Workflow, Notification, Monitoring & Incident), and a **second** *Volume VIII —
AI Boardroom Architecture*. The rosters disagree on **count and roles**, and the
volume numbers **collide** with *Volume VII — Security* and *Volume VIII — Design
System*. A constitution cannot have two Volume VIIs. **Resolve before any AI
directive is written.**

**C2 — "Humans always decide" vs an already-shipped autonomous employee.**
Volumes I, the Philosophy prelude, and IV state repeatedly that *no irreversible
action happens without approval* and Level-5 Autonomy is *"only for low-risk,
reversible actions."* The platform already ships `lead-qualification` with
`requires_approval = false`. This is **defensible** (qualification is an
internal, reversible classification, bounded by a status guard and a
type-constrained target — see ADR in `docs/lead-qualification.md`) but the Bible
never states the **test** that licenses autonomy. Doctrine and product currently
agree by luck, not by rule. **Codify the reversibility/risk test.**

**C3 — "Nothing polls. Everything reacts." vs a cron-drain architecture.**
The second Volume VIII calls the Event Bus the nervous system and asserts
*"Nothing polls. Everything reacts."* The repository is the opposite today: **13
cron pollers** drive every async path, `inngest` is installed but **unused (0
references)**, and the live-run views are HTTP **state pollers**, not push. The
Event Spine (`hq_events`) is append-only and real, but its **Realtime** consumer
is explicitly pending. This is a target-state vs current-state conflict that
should be **labelled as such** in the Bible, not left as an assertion of fact.

**C4 — "AI never bypasses security / no unrestricted database access" vs the
service-role runner pattern.** The executing AI employees run as `server-only`
service-role processes that **bypass RLS by design** (that is how a runner writes
across tenant-free HQ tables). The Bible's Security and AI volumes assert AI
operates under least privilege and zero-trust. Both can be true, but only if the
Bible **defines the AI guardrail model explicitly** (what the service role may
touch, how it is bounded in code, how it is audited). Today that boundary lives
in test invariants, not doctrine. **This is the highest-stakes reconciliation.**

**C5 — "One source of truth / never duplicate" vs three parallel event logs.**
Volume V forbids duplication, yet the system maintains **three** activity/event
trails: the customer `activity_log`, the per-module `hq_sales_timeline_events`,
and the spine `hq_events`. This was a deliberate engineering choice (complementary
projections, different trust boundaries) — but the Bible should **say so**, or
the rule reads as self-violating.

**C6 — Shared memory is doctrine, not yet substrate.** Volumes III/IV/V and both
AI volumes make *shared company memory* the centre of the org. The repo has
`hq_shared_memory` (seeded) and an admin memory UI — but the **two executing
runners do not read or write it.** "Shared memory" is currently a table and a
screen, not the live brain every AI employee consumes. Doctrine describes a
system that is not yet wired.

**C7 — The 30% Rule vs the 15-phase maximalist roadmap.** Volume Philosophy gates
features at *"≥30% of customers benefit."* Volume XII's roadmap reaches fleet
management, warehouse/stock, marketplace, SDK and global multi-tax. Several Phase
5–15 items will struggle to clear 30% for a UK SMB construction base. Not a
logic error — a **prioritisation tension** the roadmap should acknowledge.

**C8 — Directive numbering already conflicts with the request.** The adoption
brief asks which volumes become *Directive #004, #005, #006…* — but **004 and
005 are already issued** (004 = Engineering Bible/Event Spine/six-gate; 005 =
Research AI). New volume→directive assignments must start at **#006** or the
ledger corrupts. Flagged here because it changes the answer to deliverable #9.

> **Resolved (Directive #011 / D-01).** Numbering is now canonical in
> [`governance/numbering.md`](./governance/numbering.md): `#002` retired (→ #009),
> `#006`–`#008` never issued, monotonic from `#011`. The "start at #006" advice in
> §9 is the original recommendation, superseded for anything not yet issued.

**C9 — "Volume VI — API Architecture (Part 2)" has no Part 1.** The provided API
volume is explicitly *Part 2*. The foundational half (resource model, auth model,
pagination, error taxonomy) is **absent from the canon.** A gap in the
constitution itself.

---

## 3. Missing systems

Mandated by the Bible, **not present (or barely present)** in the repository.
Grouped by layer; each is a real, checkable absence.

**The AI substrate (the defining gap):**
- **AI Employee SDK / runner contract** — the pattern exists twice (research,
  qualification) but is **not a reusable framework**; each employee is hand-rolled.
- **AI Communication Protocol + Event Bus** (second Vol VIII / promised Vol IX) —
  message formats, typed event schemas, task contracts, idempotent consumers.
  Today: cron polling; `inngest` unused.
- **Decision Centre / Boardroom orchestration** — multi-AI debate, confidence
  weighting, conflict resolution, CEO morning briefing as a *generated* artifact.
  Today: `ai-boardroom` is a **roster/status view**, not an engine.
- **Live shared memory** wired into runners (see C6).
- **Per-employee cost controls / budgets** (Vol VII-AI §16) — daily/monthly
  spend ceilings, efficiency targets. Absent.
- **A general explainability + confidence + audit framework** — present *inside*
  the two runners, not as a shared contract every employee inherits.
- **The other ~11–28 AI employees** — Outreach, Sales (executing), Marketing,
  Support, Product, CTO/QA/Documentation/Finance/Operations as *doers* (seeded as
  framework only); and the entire ops cohort (Orchestrator, Memory Manager,
  Workflow, Monitoring, Security, DevOps, Database, API, HR, Legal) — unseeded.

**Platform (Volume II) WOW + later phases:**
- **Blueprint Centre**, **AI WhatsApp Assistant** (Twilio present; WhatsApp flows
  absent), **native mobile apps**, **offline mode**, **AI Quote Writer /
  Scheduler / Cashflow / Business Coach / Voice Receptionist** (a foundational
  AI receptionist exists; the rest do not), **OCR**, **snagging**, **site
  diary**, **RAMS / toolbox talks / H&S**, **CIS / VAT automation**,
  **purchase orders / supplier invoices** (suppliers exist; PO flow thin),
  **fleet / asset / warehouse**.

**Design (Volume VIII-design):**
- **A design system at all, as a system.** `components/ui` holds **two**
  primitives. No token layer, no component library, no motion standard. 137 pages
  are styled with ad-hoc Tailwind. This is the **largest silent gap** relative to
  a volume that demands every screen look "designed by the same world-class team."

**API / ecosystem (Volume VI / Roadmap Phase 10/14):**
- **Versioned public API (`/v1/`)**, **Open API + SDK**, **Marketplace**,
  **partner platform**, **webhooks *outbound* as a product** (Stripe inbound
  exists). None present.

**Integrations (Volume VI):**
- **Accounting** (Xero/QuickBooks), **HMRC**, **merchant/bank feeds**, **supplier
  catalogues** (Travis Perkins/Jewson/etc.), **calendar/365**. Only Stripe,
  Twilio, Resend are wired.

**Cross-cutting:**
- **Realtime layer** (Event Spine PR6) and **Hooks** (PR7).
- **Compliance tooling** as a system (GDPR export/erase flows, consent, retention
  beyond `activity_log_retention`).
- **A formal incident/monitoring AI loop** (Sentry is wired; the *AI* response
  loop is not).

---

## 4. Duplicated concepts

Where the canon says the same thing in multiple places — costly for a document
meant to grow to 1,000+ pages, because duplication drifts out of sync (C1 is the
proof).

- **The AI workforce — defined 3×** (Vol IV, Vol VII-AI, Vol VIII-Boardroom) with
  divergent rosters. *Collapse to one multi-part volume.*
- **Vision 2030 — stated 3×** (the standalone "Vision 2030" prelude, Volume I, and
  Volume XII's roadmap restate the same north star and four-objective promise).
  *Define once; reference.*
- **The promise / Golden Rule / 30% Rule — restated in nearly every volume.**
  Intentional reinforcement, but as a manual it should live in one
  "Constitution/Volume 0" and be cited, not copy-pasted.
- **Security principles — spread across Vol I, VII-security, and IX** (zero-trust,
  least privilege, audit). *One canonical security volume; others link.*
- **Event/audit trails — three implementations** (`activity_log`,
  `hq_sales_timeline_events`, `hq_events`) for one concept ("remember
  everything"). Converge on the spine with typed projections.
- **Two roadmaps now coexist:** `docs/roadmap.md` (the HQ-Sales-AI programme
  roadmap, narrow) and Volume XII (master product roadmap, broad). *Declare the
  former a **sub-roadmap** of the latter to prevent the exact confusion the
  roadmap warns about for its own module numbering.*
- **AI employee specification templates** appear in both Vol IV and Vol VII-AI
  (the 19-section spec). Keep the richer one; delete the other.

---

## 5. Improvements (preserving the vision)

Each preserves the Bible's intent; none rewrites it.

1. **Renumber once, canonically** (Appendix A). Resolve the VII/VIII collisions;
   make the AI workforce a single Volume with parts (Workforce · Boardroom ·
   Protocol); add the missing "API Part 1"; add a **Volume 0 — Constitution** that
   states the promise and the two rules *once*.
2. **Turn the proven runner into doctrine: an "AI Employee SDK."** The
   research/qualification template (one `ai_employees` row + one task type + a
   `server-only` claiming runner + checkpointed `result` + timeline mirror +
   `lib/<employee>/*` pure core, owning no new table) is already documented as
   ADRs in `docs/roadmap.md`. Promote it to a Bible volume so employees 3→N are a
   thin config, not a rewrite.
3. **Make explainability + confidence + audit a shared framework**, not a
   per-employee reimplementation. One contract: every AI output carries
   `{summary, reasoning, confidence, evidence, alternatives, approvalRequired}`
   and writes one audit row. Build it once; every employee inherits it.
4. **Define the AI guardrail model explicitly** (answers C4). Service-role runners
   + an allow-listed surface + the type-bounded-target pattern (Module 3's
   `RecommendedStatus`) + mandatory audit. This is the safety doctrine that must
   exist *before* more autonomy ships.
5. **Adopt the Event Bus incrementally on what exists.** Spine (done) → Realtime
   (PR6) → typed event schemas + idempotent consumers → retire cron pollers where
   latency matters (wire the already-installed `inngest`). Change "Nothing polls"
   from an assertion to a migration plan.
6. **Pay down the design-system debt before more UI.** A token layer + a headless
   component library + a motion standard, retrofitted behind the existing 137
   pages. Every new page after that is cheaper and on-brand by default.
7. **Wire shared memory into the runners** so "company brain" becomes real: the
   research employee should *write* what it learned and the qualification employee
   should *read* it, both through `hq_shared_memory`.
8. **Annotate the roadmap with the 30% Rule.** Tag each Phase 5–15 item with its
   estimated reach; let the rule visibly sequence the maximalist list.
9. **Operationalise "document before you build."** Adopt an ADR convention in
   `docs/bible/decisions/` (see README); no major architectural change merges
   without its ADR in the same PR — the living-knowledge-base rule, enforced.

---

## 6. Current platform vs the Bible

A volume-by-volume read of doctrine against the measured repository.

| Volume | The Bible asks for | What actually exists | Verdict |
|---|---|---|---|
| **I — Vision / Philosophy** | An AI OS for construction; the promise + Golden/30% rules | Lived in practice; not written down in-repo until now | **Adopted, undocumented** |
| **II — Product** | Full construction OS, lead→cash + WOW + 15 phases | CRM, leads, customers, quotes, jobs(+calendar), variations, invoices, payments, payroll, staff(+rota/leave), suppliers, expenses, finances, tax, compliance, support, reviews, customer portal (token), AI receptionist (foundation), marketing site | **Foundation strong; WOW/later phases mostly absent** |
| **III — HQ** | The company's own OS + Boardroom + decision centre | Rich admin surface: ai-boardroom, sales (companies/calling/comms/learning/tasks/analytics), research, qualification, memory, pulse, ceo, health, ops, billing, demos, organisations, support | **Surfaces built; orchestration/decision-centre not** |
| **IV / VII-AI / VIII-Boardroom — AI workforce** | ~13–30 coordinated, permissioned, audited employees + Boardroom + protocol | 14 seeded, **2 executing** in isolation; boardroom is a *view*; no protocol, no live memory, no cost controls | **~10–15% — the defining gap** |
| **V — Database** | RLS-first, event-driven, audited, scalable | 103 migrations / 99+ tables, 40 RLS-enabling, event spine (core→timeline), shared memory, scale indexes, rate-limit guards | **Strong (~70%)** |
| **VI — APIs** | Internal + versioned public + webhooks + SDK + marketplace | ~53 internal routes, Stripe webhook inbound, 13 crons; **no `/v1`/public/SDK/marketplace; "Part 1" missing** | **Internal solid; ecosystem absent (~40%)** |
| **VII — Security** | Zero-trust, least privilege, RLS, audit, MFA, compliance | RLS across 40 migrations, secdef RPC guards, rate limiting, storage hardening, impersonation isolation, security CI gate | **Strong (~70%); AI guardrail doctrine missing** |
| **VIII — Design System** | Tokens + library + motion; one world-class look | Tailwind + globals + **2 UI primitives**; ad-hoc styling | **Weak (~15%) — largest silent gap** |
| **IX — Engineering** | Clean architecture, six-gate, tests, ADRs | Six-gate CI, 154 unit files, 5 e2e, living docs, migration discipline | **Strong (~80%) — the model citizen** |
| **X — Marketing** | Education-first engine + brand + video + Marketing AI | Marketing site (blog/compare/features/industries/pricing/tools), SEO lib; content/video non-code; Marketing AI not executing | **Site built (~30%)** |
| **XI — Sales** | Consultative funnel + AI sales cohort | HQ Sales programme modules 1–3 (intelligence DB, research, qualification); outreach/sales-exec/forecast pending | **~35%** |
| **XII — Roadmap** | 15 phases to global platform | Phase 1 largely done; Phases 2–15 5–20% | **Foundation phase done; rest early** |

**The pattern:** CrewFlow is a **strong operational SaaS** wearing the *name* of
an AI OS. The volumes that read as "already true" (V, VII-sec, IX) are the
foundation; the volumes that read as "the reason we exist" (the AI trio, VIII-
design, VI-ecosystem) are the frontier.

---

## 7. Percentage of the Bible already built

A single number flatters or insults depending on what you weight, so here is the
honest, three-tier split, then a headline.

**By tier:**
- **Operational SaaS foundation** (Platform core, Database, Security, Engineering,
  internal APIs): **~60–70% built.** This is genuinely strong.
- **The AI operating system** (the AI trio: workforce, boardroom, protocol; live
  memory; orchestration): **~10–15% built.** Two employees, a roster, no engine.
- **Ecosystem & reach** (public/Open API, marketplace, SDK, mobile/offline,
  accounting/HMRC integrations, global): **~0–5% built.**

**Weighted headline: ~30% of the Bible is built** — but the 30% is **almost
entirely the foundation, not the thesis.** Read it as: *the hard, unglamorous
substrate that makes the AI OS *possible* is largely in place; the AI OS itself
is at the starting line.* The number will feel like it stalls even as real work
ships, because the remaining 70% is front-loaded with the most ambitious, least-
built layer.

*(Method: per-volume estimates in §6, weighted by the Bible's own emphasis — the
AI workforce is weighted heavily because the Bible names the entire company after
it. Estimates are deliberately ranged, not false-precise.)*

---

## 8. Dependency graph — correct implementation order

Read top-to-bottom; each layer depends on the ones above. **Doctrine before
code** at every layer (the user's own mandate).

```
LAYER 0 — CONSTITUTION (doctrine only, no code)
  Volume 0 Constitution · renumber the canon · resolve C1/C9 · ratify the Bible
        │
        ▼
LAYER 1 — FOUNDATION  [≈70% done — finish, don't restart]
  Database (V) ─ Security (VII) ─ Engineering regime (IX) ─ internal APIs (VI-pt1)
        │
        ▼
LAYER 2 — EVENT/DATA SUBSTRATE
  Event Spine Realtime (PR6) + Hooks (PR7) ─ typed event schemas ─ converge the
  three audit logs ─ wire inngest (retire pollers where latency matters)
        │
        ▼
LAYER 3 — AI SUBSTRATE  ★ the unlock — build ONCE, before more employees
  AI Employee SDK (runner contract) ─ Permission/Guardrail model (C4) ─
  Explainability+Confidence+Audit framework ─ live Shared Memory wiring (C6) ─
  per-employee Cost Controls
        │                                   │
        ▼                                   ▼
LAYER 4 — INDIVIDUAL AI EMPLOYEES      LAYER 4′ — DESIGN SYSTEM (parallelisable,
  Outreach → Sales(exec) → Support →     pay down early): tokens + component
  Marketing → Finance/Ops/… each a       library + motion standard (VIII-design)
  thin config on the SDK
        │
        ▼
LAYER 5 — ORCHESTRATION
  AI Communication Protocol ─ Decision Centre ─ Boardroom engine ─ CEO briefing
  (needs ≥3 employees + Layer-3 substrate to coordinate anything real)
        │
        ▼
LAYER 6 — CUSTOMER WOW (on Platform + Design System)
  Blueprint Centre · WhatsApp Assistant · Mobile + Offline · AI Quote/Schedule/
  Cashflow/Coach · site ops (snagging/diary/RAMS/H&S) · finance (CIS/VAT/PO/OCR)
        │
        ▼
LAYER 7 — ECOSYSTEM & GLOBAL
  Public API /v1 · Open API + SDK · Marketplace · accounting/HMRC/merchant
  integrations · multi-country/tax/currency
```

**The one ordering insistence:** **Layer 3 precedes Layer 4.** Building a third,
fourth, fifth AI employee before the shared SDK/guardrail/audit/memory substrate
exists will triplicate the substrate by hand and guarantee drift. The Bible's own
"maximum reuse, one architecture" rule demands the substrate first.

---

## 9. Recommended directive mapping (#006 and beyond)

> **Superseded for forward planning (Directive #011 / D-01).** What was *actually*
> issued diverged from this recommendation: `#006`–`#008` were never issued, Shared
> Memory shipped as `#009`, and the Conversion Arc shipped as `#010`. Canonical
> numbering is now [`governance/numbering.md`](./governance/numbering.md), and the
> live forward plan is the Master Roadmap (D-01…D-19 → #011…#029). The table below
> is retained as the original dependency-ordered reasoning, not the live sequence.

**Important correction (C8):** the brief asks for Directives #004/#005, but those
are **already issued** (004 = Engineering Bible/Event Spine/six-gate; 005 =
Research AI). New assignments therefore begin at **#006**. Proposed sequence,
ordered to match the dependency graph:

| Directive | Volume(s) it ratifies | Why it is next | Layer |
|---|---|---|---|
| **#006 — Bible Adoption / Constitution** | Vol 0 + the renumbered canon | *This message.* Ratify the Bible, fix C1/C9, set the doctrine-before-code rule. No code. | 0 |
| **#007 — AI Employee SDK & Guardrail Doctrine** | Vol IV + VII-AI (execution primitives) | The substrate every future employee needs: runner contract, permission/guardrail model (C4), explainability/audit framework, live memory wiring, cost controls. | 3 |
| **#008 — Event Bus & Realtime** | Vol V (event) + VIII-Boardroom (bus) | Finish Spine PR6/PR7, typed schemas, retire pollers — Layer 2, enables orchestration. | 2 |
| **#009 — Design System** | Vol VIII-Design | Pay the compounding UI debt before more pages; cross-cutting, can start in parallel with #007. | 4′ |
| **#010 — Sales Conversion Arc** | Vol XI (Modules 4–7) | First employees *on* the new SDK: Outreach → Sales(exec) → forecast. The qualified-lead handoff is the natural trigger. | 4 |
| **#011 — AI Boardroom & Protocol** | Vol VIII-Boardroom + promised Vol IX | Orchestration once ≥3 employees + substrate exist: decision centre, debate, CEO briefing. | 5 |
| **#012 — Customer WOW** | Vol II Phase 2 | Blueprint Centre, WhatsApp, Mobile/Offline — on Platform + Design System. | 6 |
| **#013 — Ecosystem** | Vol VI (Part 1 + public API), Roadmap Ph.10/14 | Public/Open API, SDK, marketplace, accounting/HMRC integrations. | 7 |

*(Marketing-AI, Support-AI, Finance/Ops-AI etc. slot in as sub-directives of #007
once the SDK exists — each is a thin config, not its own programme.)*

---

## 10. Decisions to make before writing more code

The questions whose answers change the architecture. None of these should be
resolved by an engineer mid-PR; they are CEO/CTO calls, and they are cheap now
and expensive later.

1. **Does the Bible supersede Directive 004?** 004 (Engineering Bible/Event Spine)
   and the new Bible overlap heavily. Decide the precedence rule explicitly, or
   the "single source of truth" is itself ambiguous. *(C8)*
2. **Canonical numbering.** Approve the Appendix-A renumber (or an alternative) so
   there is exactly one Volume VII and one Volume VIII before the manual grows.
   *(C1, C9)* — **Directive numbering resolved** by Directive #011 / D-01
   (`governance/numbering.md`); the volume renumber stays **principle-only** (no
   flag-day rewrite — `numbering.md` §6).
3. **The AI guardrail model — the safety keystone.** Service-role runners bypass
   RLS. Before a *third* employee ships, ratify: what surface the runner may
   touch, how autonomy is bounded in code, how every action is audited, and the
   **explicit test that licenses Level-5 autonomy** (reversible + low-risk +
   type-bounded target). *(C2, C4)*
4. **Orchestration substrate: event-driven vs cron.** Commit to wiring `inngest`
   + Spine Realtime and a poller-retirement plan, or formally accept cron-drain as
   the standing pattern and strike "Nothing polls" from the canon. *(C3)*
5. **One audit substrate or three?** Decide whether `activity_log`,
   `hq_sales_timeline_events`, `hq_events` converge, or codify why they are
   deliberately separate. *(C5)*
6. **Design system: now or later?** The debt compounds with every page. Decide
   whether #009 starts in parallel with #007 or waits. *(§3 design gap)*
7. **AI Employee SDK contract — freeze it before reuse.** The output schema,
   audit row, memory read/write interface, and task lifecycle must be frozen
   *once*; every employee inherits it. *(improvement #2/#3)*
8. **Reconcile the two roadmaps.** Declare `docs/roadmap.md` a sub-roadmap of
   Volume XII (or merge them) so there is one programme spine. *(C-dup)*
9. **Scope discipline.** Re-affirm the 30% Rule as the gate on Phases 5–15, so the
   maximalist roadmap stays sequenced by customer reach, not ambition. *(C7)*
10. **Shared memory ownership.** Decide the write/read rules for `hq_shared_memory`
    (who writes truth, who reads, retention, permissions) before employees depend
    on it. *(C6)*

---

## Appendix A — proposed canonical volume map

A minimal renumber that preserves every volume's content and fixes the
collisions. (Proposal, for CEO ratification — not yet adopted.)

| New | Title | Source in the provided canon |
|---|---|---|
| **0** | Constitution (promise · Golden Rule · 30% Rule · operating principles) | "Vision 2030" + "Philosophy" preludes + Vol I |
| **I** | Vision 2030 | "Vision 2030" / Vol I |
| **II** | Product (customer platform) | Vol II |
| **III** | CrewFlow HQ | Vol III |
| **IV** | Database Architecture | Vol V |
| **V** | API Architecture (Part 1 *to be written* + Part 2) | Vol VI (+ missing Part 1) |
| **VI** | Security Architecture | Vol VII-Security |
| **VII** | Design System | Vol VIII-Design |
| **VIII** | Engineering Standards | Vol IX |
| **IX** | Marketing | Vol X |
| **X** | Sales | Vol XI |
| **XI** | AI Workforce — Part 1 (Employees & Spec) | Vol IV + Vol VII-AI (merged) |
| **XI** | AI Workforce — Part 2 (Boardroom) | Vol VIII-Boardroom |
| **XI** | AI Workforce — Part 3 (Communication Protocol) | promised Vol IX-AI |
| **XII** | Master Roadmap | Vol XII (absorbs `docs/roadmap.md` as a sub-roadmap) |

---

## Appendix B — evidence census (raw)

Measured on `origin/main` @ Module-3 merge. Commands are reproducible from repo
root.

| Metric | Value |
|---|---|
| App pages (`page.tsx`) | 137 |
| Internal API route handlers (`app/api/**/route.ts`) | ~53 |
| Cron drains/pollers | 13 |
| Server services (`server/services/*.ts`) | ~50 |
| Pure `lib/*` domains | ~50 |
| Migrations | 92 (baseline) · **103** current |
| Tables created | 99 (baseline) |
| Migrations enabling RLS | 40 |
| Migrations declaring policies | 26 |
| Unit test files (`*.test.ts`) | 154 |
| `__tests__` domains | ~45 |
| Playwright e2e specs | 5 (pulse, qualification, research, sales, smoke) |
| CI gates | 6 (typecheck, lint, unit, integration-PG, security, e2e) |
| AI employees seeded | 13 (baseline) · **14** current (+`outreach-ai`) |
| AI employees executing | 2 (research-ai, lead-qualification) |
| `components/ui` primitives | 2 (button, skeleton) |
| Integrations wired | Stripe, Twilio, Resend, Anthropic, OpenAI, PostHog, Sentry |
| `inngest` | installed, **0 usages** |
| Public/versioned API | none (`/api/v1`, `/api/public` absent) |
| Realtime push | none (state routes are pollers; Spine Realtime pending) |
| Shared memory wired into runners | no |

---

*This is a study, not a plan of record. No code, schema, or configuration was
changed in producing it. Implementation awaits an explicit CEO directive, per the
adoption brief.*
