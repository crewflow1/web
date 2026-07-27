# Volume XVII — Company Intelligence

> **Status:** Architecture specification. Constitutional design work under **CEO
> Directive #008 — "AI Workforce Architecture, Phase 2"** (2026-06-21). The
> **Operating Model** layer (Volumes XIV–XVIII), the **MEASUREMENT** axis.
>
> **This is design, not a build order.** Per the directive: *no code, no
> implementation, no production changes, no PRs, no prototypes, no migrations.*
> This volume is one markdown file — the design of how CrewFlow sees itself.
>
> **Inheritance.** This volume **inherits the event spine (Volume XI) as the
> single source of truth** and **inherits the per-employee §12 KPIs and the SDK's
> cost/health metrics**; it **projects the company scoreboard on top, and
> maintains no parallel metric store.** Every figure in this document is a
> read-projection of `hq_events` (operating primitive **O4**, the standing
> resolution of conflict **C5**) — never a separately-kept counter. It composes
> the AI Substrate (IX–XIII) and the AI Workforce (Layer 4); it re-implements
> neither.
>
> **Read `../README.md` first** — the keystone pins the five axes, the operating
> primitives O1–O6, the concept-ownership map, and the cross-volume citation
> rule this volume obeys.

---

## 1. Purpose & scope

A company that cannot see itself cannot be run. CrewFlow is forty-two AI
employees acting thousands of times a day across eight divisions; without a
measurement layer, that activity is invisible motion. This volume is the
**sensory and analytic cortex** of the company: it turns the event stream into
**executive sight** — KPIs, dashboards, trends, predictions and board reports.

**The one-sentence job:** *define how CrewFlow measures itself — the company KPI
tree, the executive dashboards, the trend and predictive layer, and the
board-report content — entirely as views over the one event spine.*

This volume **realises operating primitive O4**: measurement is projection,
never a parallel truth. It owns the **MEASUREMENT** axis and nothing else. It
does not own *when* a report is assembled (that is the cadence, Volume XIV), nor
*who* may act on a breach (that is the decision framework, Volume XV), nor *how*
a metric becomes a lesson (that is the learning loop, Volume XVI). It owns the
**content** of the scoreboard; the siblings own its timing, its authority, and
its consequences.

**The golden rule of this volume, stated once and obeyed everywhere below:**
*every metric is a read-projection of `hq_events`.* There is no second number.

---

## 2. Where it sits

```
        ┌──────────────────────────────────────────────────────────────────┐
        │            THE COMPANY SCOREBOARD  (this volume — XVII)           │
        │   KPI tree · executive dashboards · trends · predictions · board │
        │                       ── all VIEWS, no store ──                  │
        └───────────────────────────────┬──────────────────────────────────┘
                                        │ projects from (never copies)
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  XI  EVENT BUS — hq_events (the system of record, P1)            │
        │  verb · actor · correlation_id · causation_id · severity · payload│
        │  + golden signals (XI/XII/X §14) + SDK cost/health (XIII §19/§20) │
        └───────────────────────────────┬──────────────────────────────────┘
                                        │ aggregates the per-employee KPIs
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  LAYER 4 — 42 employees, each with §12 KPIs already specified     │
        │  served by:  Analytics (22) · Monitoring (41) · Intelligence (37) │
        └──────────────────────────────────────────────────────────────────┘
```

**What it inherits (and never re-implements):**

| This volume needs… | …is already provided once by… | …so this volume only… |
|--------------------|-------------------------------|-----------------------|
| A record that something happened | **Event Bus (XI)** — `hq_events`, the append-only system of record (P1) | **projects** KPIs/dashboards/reports from it |
| The trace that stitches a saga | **Correlation (P2)** — `correlation_id` / `causation_id` | aggregates per-saga (funnel, incident, lifecycle) by it |
| Per-employee performance numbers | **each employee's §12 KPIs** (all 42 specs) | **aggregates and references** them — never re-lists all 42 |
| Per-call cost, per-employee health | **AI SDK §19 (cost roll-ups) / §20 (health & metrics)** | **rolls them up** into AI-performance KPIs |
| Golden signals (throughput, lag, DLQ, MTTD) | **XI/XII/X §14** + **Monitoring (41)** | **reads** them into operational KPIs |
| Synthesis & forecasting capability | **Intelligence (37)** + **Analytics (22)** + **Cashflow (31)** | **defines the company model** they compute against |

**Its three principal operators** (it defines the company model they serve; it is
not itself an employee):

- **Analytics AI (22)** — the metrics specialist (T2, read-only). Computes the
  KPIs, builds the dashboards, produces the report set. This volume specifies
  the **company KPI tree** Analytics computes; Analytics' §12 governs its own
  performance.
- **Monitoring & Incident AI (41)** — the golden-signals watcher (T4). Supplies
  the operational health signals (throughput, lag, DLQ, MTTD/MTTR) this volume's
  operational KPIs read.
- **Intelligence AI (37)** — the synthesis-and-prediction layer (T4, read-only).
  Connects the dots across zones and produces the **predictive intelligence**
  this volume frames (§13), always labelled as prediction.

**What it must NOT build — the hard line.** This volume must never design a
**second source of truth**: no parallel metric table, no "KPI warehouse" holding
authoritative counters, no number maintained by hand or incremented on the side.
If a figure cannot be derived from `hq_events` (optionally via the golden-signal
functions and SDK roll-ups, which are themselves derived), it is **not a CrewFlow
metric**. A KPI is a *query*, defined once, replayable forever. This is the whole
content of O4 and the resolution of C5, restated in §18.

---

## 3. Built vs. to-build

The honest ledger — what mechanism already exists (the substrate and the 42
specs) versus what *organisational design* is new in this volume.

| Capability | Status | Where it lives |
|------------|--------|----------------|
| The append-only event spine every metric reads | **Built** | `hq_events`, `hq_emit_event` (XI) |
| Golden signals (throughput, per-consumer lag, dead count, retry backlog) | **Built** | `hq_spine_golden_signals` (XI §14); task/memory signals (XII/X §14) |
| Per-task / per-employee / per-capability / per-day **cost** roll-ups | **Built (substrate)** | SDK §19 — gateway metering into `cost_micros` |
| Per-employee **health & task metrics** (tasks done, success rate, latency) | **Built (substrate)** | SDK §20 — `ai_employees.status`, `ai_employee_task_metrics` |
| **Per-employee KPIs** (accuracy, latency, approval/escalation, cost, ROI, quality) | **Specified** | each employee's §12 (all 42 specs) |
| The Pulse timeline (a projection of the spine) | **Built** | spine PR5 / `timeline` consumer |
| Analytics (22), Monitoring (41), Intelligence (37) as operators | **Specified** | their employee specs |
| **The company KPI TREE** (north-star → division → employee, every node a verb query) | **NEW — this volume** | §4 |
| **The five KPI families** (operational, sales, engineering, customer, financial) as company aggregates | **NEW — this volume** | §§5–9 |
| **AI-performance KPIs** (the differentiator — AI employees held accountable like staff) | **NEW — this volume** | §10 |
| **The executive dashboards** (CEO/COO/CTO/CFO read-projections) | **NEW — this volume** | §11 |
| **The trend layer** (windowed time-series; construction seasonality) | **NEW — this volume** | §12 |
| **The predictive layer** (forecast/risk, P3-confidence-labelled, never fact) | **NEW — this volume** | §13 |
| **The board-report CONTENT** (the periodic pack's metrics/trends/predictions) | **NEW — this volume** | §14 |

The verbs, the golden signals, and the per-employee metrics **already exist**.
This volume's job is to **compose** them into a company scoreboard — to define
the tree, the families, the dashboards, the trend windows, the prediction
discipline, and the board-pack content — without inventing a single new store.

---

## 4. The measurement model — the KPI tree

The company's measurement is **one tree**, rooted in a small set of north-star
KPIs and branching down to the per-employee KPIs already specified in §12 of each
spec. The tree has three tiers; **every node is sourced from event verbs** —
there is no node that is a hand-kept number.

```
                         ┌──────────────────────────────────────┐
   TIER 0  (north star)  │   ARR · Gross Margin · Cash Runway    │   the board's
                         │   NRR · CAC:LTV · AI Autonomy Rate     │   six numbers
                         └────────────────────┬─────────────────┘
                                             │ each rolls up from…
   TIER 1  (division)   ┌──────────┬──────────┼──────────┬──────────┬──────────┐
                      Revenue   Customer   Operations  Finance  Technology  AI-Platform
                      (funnel)  (health)   (cadence)   (money)  (DORA)      (autonomy)
                         │          │          │          │          │          │
   TIER 2  (employee)  each node = the per-employee §12 KPIs (Sales 16, CS 18, Ops 23,
                       Finance 21, Eng Mgr 6, Intelligence 37 …) — referenced, not re-listed
```

### 4.1 The projection discipline — how a KPI is *defined*

A company KPI is defined as a **named, version-pinned query over the spine**, not
as a stored counter. Every definition records four things, and nothing else:

| Element | Meaning |
|---------|---------|
| **Source verbs** | the `hq_events` verbs the KPI aggregates (e.g. `lead.qualified`, `deal.progressed`) |
| **Window** | the time window, by `ts`, with results ordered/keyed by `id` (the total order, P1) |
| **Aggregation** | count / ratio / sum / percentile / rate over the matching events |
| **Slice** | the `actor_id` / division / `correlation_id` / `payload` dimension it is grouped by |

> **The rule, mechanically.** *KPI := f(events WHERE verb ∈ V AND ts ∈ W) sliced
> by D.* The KPI **is** the function; the only durable state is `hq_events`. Two
> people computing the same KPI over the same window get the same answer, because
> they are reading the same log — this is the reproducibility guarantee Analytics
> (22) §12 calls "reconciles to source" and §14 calls "where did this number come
> from."

### 4.2 Why no counter is ever maintained

A maintained counter is a *second* truth that can drift from the first. Under O4,
that drift is designed out: the company never increments "deals won" on the side;
it *counts* `deal.progressed` events whose `payload.stage = won` in the window.
If the count looks wrong, the fix is in the **events** (a missing or mis-emitted
verb — a producer bug), never in a counter someone forgot to update. The spine's
append-only invariant (P1: no `UPDATE`/`DELETE`) makes every KPI **replayable**:
re-run the query, get the same number, for any window in history.

### 4.3 Definition ownership

KPI **definitions** are curated by Analytics (22) in its metric-definitions
library (its §8 long-term memory) — the single place the calculation of each
metric is pinned, so "consistency of metric definitions over time" (Analytics
§12) holds. A *new* KPI is a new definition row, not a deploy (it follows O5:
change is data). The **company tree** below — which KPIs exist at each tier and
how they roll up — is what *this volume* owns; Analytics owns the per-metric
formula and computes them.

---

## 5. Operational KPIs

**Question:** *is the company running on time and within its service levels?*
These measure the operating clock (the cadences, Volume XIV) and the platform's
health (golden signals, Monitoring 41). Source: the substrate `task.*` telemetry,
the golden-signal functions, and the cadence events.

| KPI | Definition (projection over the spine) | Source verbs / signals |
|-----|----------------------------------------|------------------------|
| **Cadence adherence** | % of scheduled cadence runs (Volume XIV) that fired and completed on time | `task.*` for the cadence schedules; missed-tick canary |
| **Task throughput** | completed tasks per hour/day, by division | `task.completed` count, windowed |
| **Task success rate** | `task.completed` ÷ (`task.completed` + `task.failed`) | `task.completed`, `task.failed` |
| **Queue depth / lag** | per-consumer `max(id) − offset`; task-queue backlog | golden signals (XI/XII §14), read by Monitoring (41) |
| **SLA attainment** | % of IX request threads answered within their deadline | `ai.message.*` RTT vs deadline (IX) |
| **DLQ depth** | count + age of dead-lettered events (a poison signal) | `dead_events` (XI §9) |
| **Incident MTTD** | mean time from breach to `incident.opened` | golden-signal breach → `incident.opened` |
| **Incident MTTR** | mean time from `incident.opened` to `incident.resolved` | `incident.opened` → `incident.resolved` (Monitoring 41 §12) |
| **Approval latency** | mean time a `waiting_approval` task waits for a human (a throughput tax) | `task` state transitions to/from `waiting_approval` |

MTTD/MTTR are Monitoring (41)'s own §12 KPIs; this volume **aggregates** them to
a company operational view rather than redefining them. Cadence adherence is the
direct measure of the operating clock (Volume XIV) doing its job.

---

## 6. Sales KPIs

**Question:** *is the revenue engine converting?* These measure the revenue funnel
(Research → Qualification → Outreach → Sales → Quote) — the value stream the
workforce calls **Lead-to-Cash** (Volume XIV owns its lifecycle; this volume
measures it). Source: the funnel verbs, traced by `correlation_id` so a lead is
followed stage to stage.

| KPI | Definition (projection over the spine) | Source verbs |
|-----|----------------------------------------|--------------|
| **Stage conversion** | for each funnel stage, % of `correlation_id`s that advance to the next | `company.researched` → `lead.qualified` → `outreach.sent` → `deal.progressed` → `quote.approved` |
| **Qualification rate** | `lead.qualified` ÷ (`lead.qualified` + `lead.disqualified`) | `lead.qualified`, `lead.disqualified` |
| **Pipeline value** | sum of `payload.value` over open deals (deals with `deal.progressed` but no terminal stage) | `deal.progressed` |
| **Win rate** | deals reaching `payload.stage = won` ÷ deals entering pursuit | `deal.progressed` |
| **Sales cycle time** | mean elapsed `ts` from first `company.researched` to `quote.approved`, per `correlation_id` | the funnel chain, P2 |
| **Quote conversion** | `quote.approved` ÷ `quote.drafted` | `quote.drafted`, `quote.approved` |
| **CAC** | sales+marketing cost (SDK §19 roll-up for the Revenue division) ÷ new customers won | cost roll-ups ÷ `onboarding.completed` |
| **Outreach response rate** | replies ÷ `outreach.sent` (where a reply is an inbound event on the thread) | `outreach.sent` + inbound channel events |

The per-employee numbers behind these live in Sales (16), Qualification (14),
Outreach (15) and Quote Writer (30) §12; this volume rolls them into the **funnel
shape** so the COO (acting CRO) sees conversion end to end.

---

## 7. Engineering KPIs

**Question:** *is the platform delivered safely and reliably?* DORA-style metrics
over the development lifecycle (Volume XIV owns the lifecycle; this volume measures
it), grounded in the six-gate bar the substrate already mandates. Source: the
`task.*` and deploy/incident verbs emitted by the Technology division (Eng Manager
6, DevOps 9, QA 7, Security 8).

| KPI | Definition (projection over the spine) | Source verbs |
|-----|----------------------------------------|--------------|
| **Six-gate pass rate** | % of changes whose six gates (typecheck/lint/unit/integration/security/e2e) all passed first time | gate-result events on the change's `correlation_id` |
| **Deploy frequency** | deploys per week | deploy-completed events |
| **Change-fail rate** | deploys that triggered an `incident.opened` within the window ÷ all deploys | deploy events ∩ `incident.opened` (by causation) |
| **MTTR (engineering)** | mean `incident.opened` → `incident.resolved` for platform incidents | `incident.*` (shared with §5, sliced to Technology) |
| **Lead time for change** | mean `ts` from work-started to deploy-completed, per change `correlation_id` | the change saga, P2 |
| **Security-gate block rate** | changes Security (8) blocked at gate-5 ÷ all changes (a trust-boundary signal) | Security gate events |
| **QA escape rate** | defects found post-deploy ÷ defects found pre-deploy | QA + incident verbs |

Change-fail rate and MTTR deliberately reuse the **same `incident.*` verbs** as
the operational family (§5), sliced to the Technology division — *one verb, many
read-models* (C5) in miniature: the company never double-counts incidents in two
stores; it slices one event stream two ways.

---

## 8. Customer KPIs

**Question:** *are customers healthy, served, and staying?* These measure the
customer lifecycle (Onboarding → Customer Success → Support; Volume XIV owns the
lifecycle). Source: the customer and support verbs, plus Customer Success (18)'s
health zone surfaced as events.

| KPI | Definition (projection over the spine) | Source verbs |
|-----|----------------------------------------|--------------|
| **Customer health score** | composite (usage, ticket trend, payment timeliness) per account, computed by CS (18) and emitted | CS health events; `ticket.*`; `invoice.reconciled` |
| **CSAT / NPS** | mean satisfaction / net-promoter from post-interaction survey events | survey-response events |
| **Churn rate** | accounts lost ÷ accounts at risk, in the window | account-closed events |
| **Net revenue retention (NRR)** | (expansion − contraction − churn) over starting MRR, per cohort | `deal.progressed` (expansion) + churn events vs MRR |
| **Onboarding time** | mean `ts` from `quote.approved` to `onboarding.completed` | `quote.approved` → `onboarding.completed` |
| **Ticket resolution time** | mean `ticket.triaged` → `ticket.resolved` | `ticket.triaged`, `ticket.resolved` |
| **First-contact resolution (FCR)** | tickets resolved on first touch ÷ all resolved | `ticket.resolved` with single-touch `payload` |
| **Ticket volume / backlog** | open tickets, windowed and trended | `ticket.triaged` − `ticket.resolved` |

Health score and churn risk are also the basis of a **prediction** (§13, churn-risk
via CS 18). Here they are measured as *fact* (what happened); there they are
*forecast* (what may happen) — and the two are never conflated.

---

## 9. Financial KPIs

**Question:** *is the company solvent, profitable, and liquid?* These measure the
financial lifecycle (Volume XIV owns the lifecycle), **grounded in the realities
of UK construction finance** — retentions, the applications-for-payment cycle, and
the CIS/VAT positions, not a generic SaaS P&L. Source: the finance cluster verbs
(Finance 21, Cashflow 31, Payroll 32, Quote Writer 30), traced to source for
reproducibility.

| KPI | Definition (projection over the spine) | Source verbs / grounding |
|-----|----------------------------------------|--------------------------|
| **MRR / ARR** | recurring revenue, monthly / annualised | `deal.progressed` (won, recurring) + `invoice.reconciled` |
| **Gross margin** | (revenue − direct job cost) ÷ revenue; per job and company-wide | `invoice.reconciled` vs job-cost from `site.progressed` / `quote.approved` |
| **Cashflow runway** | months of operating cost current cash covers | `cashflow.forecasted` (Cashflow 31) over cost roll-ups |
| **DSO (days sales outstanding)** | mean days from invoice raised to cash received | `invoice.reconciled` lifecycle, by `correlation_id` |
| **Retention held** | value of contract **retentions** outstanding (the construction-specific liability) | retention-tracking events on the job `correlation_id` |
| **Application-for-payment cycle** | mean days from application submitted to certified-and-paid (the construction payment rhythm) | application/valuation events |
| **CIS position** | CIS deductions withheld vs due, current period | `payroll.calculated` (CIS 20/30/gross, per relationships §9.6) |
| **VAT position** | output − input VAT for the period (incl. reverse-charge handling) | invoice/expense `payload` VAT fields |
| **Job-margin erosion** | budgeted vs actual margin per live job (an early-warning KPI) | `quote.approved` (budget) vs `site.progressed` + `expense.categorised` (actual) |

The construction grounding is the point: **retentions, applications-for-payment,
CIS and VAT** are first-class KPIs because they are where a UK construction firm's
cash actually lives. Job-margin erosion is the KPI a builder loses money without —
and it, too, is a projection (budget event vs actual events on the job's
`correlation_id`), never a maintained spreadsheet.

---

## 10. AI-performance KPIs — the differentiator

This is the family no conventional company has, and the one that makes CrewFlow's
claim real: **AI employees are held accountable like staff.** Every employee's
§12 already specifies its own performance KPIs; this volume **aggregates them into
a company AI-performance view** and rolls up the SDK's cost/health metrics (§19/§20)
behind them. The unit is **per employee**, summable to division and company.

| KPI | Definition (per employee, aggregated) | Source |
|-----|---------------------------------------|--------|
| **Accuracy** | correctness of the employee's output against ground truth / reconciliation | each §12 "Accuracy"; e.g. Analytics reconciles-to-source, Monitoring detection precision |
| **Confidence calibration** | how well the P3 `confidence` matches realised correctness (over/under-confidence) | P3 envelope `confidence` vs outcome events |
| **Approval rate** | share of an employee's proposed actions a human/manager approved | `approval.*` outcomes per `actor_id` |
| **Autonomy rate** | share of actions executed autonomously (passed P4) vs escalated | P4 outcomes — autonomous ÷ (autonomous + checkpointed) |
| **Escalation rate** | share of work the employee escalated up the ladder (Volume XV) | `escalate` events per `actor_id` |
| **Cost-per-outcome** | the employee's metered spend ÷ outcomes produced | SDK §19 cost roll-up ÷ outcome verbs |
| **ROI** | decision/revenue value enabled ÷ operating cost (the "is this employee worth it" number) | value attribution vs §19 cost |
| **Quality score** | the receiving executive's rating of the employee's output | quality-rating events (each §12 "Quality score") |
| **Health / uptime** | share of time the employee is healthy and claiming work | SDK §20 — `ai_employees.status`, heartbeats |

> **Autonomy Rate is a north-star (Tier 0).** It is the single number that answers
> *"how much of the company runs without a human in the loop?"* — the measure of
> the AI-native thesis itself. It rises only as employees earn it (their approval
> rate and accuracy prove out), and it is **bounded by Volume XV**: an action that
> fails the P4 autonomy test never counts toward autonomy regardless of the
> number, because authority — not the metric — decides what may run alone.

This family is where the company asks of each AI employee exactly what it would
ask of a member of staff: *are you accurate, calibrated, trusted, autonomous,
worth your cost, and well-regarded by those you serve?* Because every input is an
event (a proposal, an approval, a cost meter, a rating), the whole accountability
ledger is a projection — no AI employee's "performance review" is a hand-kept
opinion; it is `WHERE actor_id = <slug>` over the spine.

---

## 11. Executive dashboards

A dashboard is a **named read-projection of `hq_events`, scoped to one
executive's accountability** — the same spine, filtered and aggregated to the four
or five numbers that executive is answerable for. There is one cockpit per
C-suite AI. None of them is a store; each is a *standing query set* Analytics (22)
computes and refreshes on the cadence (Volume XIV).

| Dashboard | Owner | The numbers it shows (all projections) |
|-----------|-------|-----------------------------------------|
| **CEO Cockpit** | CEO AI (1) | the Tier-0 north stars: ARR, gross margin, cash runway, NRR, CAC:LTV, **AI autonomy rate**; top risks (from §13); the one-line state of each division |
| **COO Operations Board** | COO AI (2) | the funnel (§6) end to end; cadence adherence + queue depth (§5); customer health + churn (§8); the value-stream sagas' throughput |
| **CTO Platform-Health Board** | CTO AI (3) | golden signals (throughput, lag, DLQ); the engineering family (§7 — six-gate pass, deploy freq, change-fail, MTTR); AI-employee health/uptime (§10) |
| **CFO Finance Board** | CFO AI (4) | the financial family (§9 — MRR/ARR, margin, runway, DSO, retentions, CIS/VAT); cost roll-ups (§19) by division/employee; budget-vs-actual |

**Who sees what.** A dashboard inherits the X permission model and the executive's
remit: the CFO board surfaces finance and cost; the CTO board surfaces platform
health and AI-employee cost-to-run, not customer PII. The **human board** sees all
four, composed into the board pack (§14). No dashboard exposes a number its
executive has no authority to act on — sight follows accountability (O2: one
decision, one owner). The figures refresh from the spine on Analytics' refresh
tick; between refreshes, what is shown is a *snapshot of a query*, never a
divergent copy.

---

## 12. Trend analysis

A single number is a dot; a **trend** is the same projection computed across a
*sequence* of windows. Trends are how the company sees motion — improvement,
decay, and the shape of the construction year. Every trend is a **windowed
projection**: the KPI query of §4, re-run over rolling or bucketed windows by
`ts`, the results ordered by `id`.

| Trend type | How it is computed (windowed projection) | Reads |
|------------|------------------------------------------|-------|
| **Week-over-week / month-over-month** | the KPI re-run over consecutive equal windows; report the delta and direction | any §5–§10 KPI |
| **Cohort** | accounts grouped by `onboarding.completed` month, each cohort's NRR/retention tracked forward | §8 customer verbs by cohort |
| **Rolling average** | the KPI over a trailing N-day window, smoothing noise (e.g. 7-day task throughput) | `task.*`, funnel verbs |
| **Seasonality (the construction year)** | the KPI bucketed by season, exposing the trade's rhythm — **winter slow-down, spring/summer build surge, year-end retention releases, the pre-Christmas push** | finance + funnel + site verbs |
| **Run-rate** | annualise a windowed sum (e.g. MRR × 12 → ARR run-rate) | §9 finance verbs |

The **seasonality of the construction year** is not decoration: a UK construction
firm's pipeline, cashflow and site activity move with the weather and the
financial calendar, so a week-over-week dip in February may be *seasonal*, not a
problem. Trends are computed so an executive can tell the difference — and the
**predictive layer (§13) consumes them** (a forecast is a trend projected
forward). Because a trend is just the KPI over many windows, it inherits the same
reproducibility: re-run it on the same spine, get the same trend.

---

## 13. Predictive intelligence

The company does not only see where it has been; it **estimates where it is
going** — cashflow, churn risk, pipeline, capacity and demand. Predictions are
synthesised by **Intelligence (37)** (cross-zone synthesis) with specialist
forecasters, and **every one is labelled a prediction with a P3 `confidence`,
never presented as fact.**

| Prediction | Owner / forecaster | Basis (projection → forward estimate) |
|------------|-------------------|----------------------------------------|
| **Cashflow forecast** | **Cashflow AI (31)** | runway, inflows/outflows projected from `cashflow.forecasted`, the AfP cycle and DSO (§9) |
| **Churn-risk** | **Customer Success AI (18)** | health-score trend + ticket trend + payment timeliness → probability an account leaves (§8) |
| **Pipeline projection** | Sales (16) + Intelligence (37) | weighted pipeline value × stage-conversion trend (§6) → expected closes |
| **Capacity / demand** | Operations (23) + Intelligence (37) | site/job throughput trend × seasonality (§12) → labour & materials demand |
| **Cost trajectory** | Analytics (22) | §19 cost roll-up trend → projected spend vs budget |

> **The prediction discipline — non-negotiable.** A forecast is a *claim about the
> future*, and CrewFlow makes it the way it makes every AI claim: in the **P3
> envelope** (P3) — a `summary`, the `reasoning`, a calibrated `confidence`, the
> `evidence[]` it rests on, and the `alternatives` considered. A forecast is
> **always shown with its confidence and its assumptions**, never as a bare
> number, and never as fact. Intelligence (37) §2 calls a forecast it cannot
> ground "a hallucinated connection" — its cardinal failure; so a prediction with
> thin evidence is **labelled partial and its confidence lowered**, exactly as
> Analytics (22) and Intelligence (37) §11 require. A wrong forecast is handled in
> §16; the guard against it is that it was never sold as certainty.

Predictions are still projections at root: every input is an event or a trend over
events. The act of *projecting forward* adds a model and an uncertainty — and that
uncertainty is carried, visibly, all the way to the board (§14). Acting on a
prediction is governed by the decision framework (Volume XV); learning from a
missed one is the learning loop (Volume XVI). This volume only ensures the
forecast is **honest about being a forecast.**

---

## 14. Board reports

The board pack is the company's measurement, **composed for the human board**.
This volume owns its **content** — the metrics, trends and predictions assembled —
while *when* it is assembled is the planning cadence (Volume XIV) and it is
**assembled by Boardroom Orchestrator (42) + Analytics (22)** on that cadence. The
pack exists at four periods, each a wider lens, each entirely a projection.

| Pack | Cadence (Volume XIV owns timing) | Content (this volume owns) |
|------|----------------------------------|----------------------------|
| **Weekly** | weekly planning cadence | the four dashboards' headline numbers; week-over-week deltas (§12); open incidents (§5); this week's escalations (Volume XV) |
| **Monthly** | monthly cadence | the full KPI tree (§4) at all tiers; month-over-month + cohort trends; the AI-performance family (§10); cost roll-ups; near-term forecasts (§13) |
| **Quarterly** | quarterly cadence | seasonality view (§12); NRR/retention cohorts; the autonomy-rate trajectory; pipeline + cashflow projections (§13); learning-velocity from the loop (Volume XVI); evolution/version health (Volume XVIII) |
| **Annual** | annual cadence | the year against plan; full construction-year seasonality; multi-quarter trends; the AI workforce's accountability ledger (§10) year-on-year |

**The pack's spine.** Every figure in every pack carries its `evidence[]` — the
exact events/trends it was computed from — so the board can ask *"where did this
number come from?"* and get `WHERE correlation_id = X` or the KPI's source-verb
query (Analytics 22 §14). Predictions in the pack are labelled as such, with
confidence (§13). The board pack is therefore **not a document the company
maintains** — it is a *rendering of the scoreboard at a moment*, regenerable from
the spine for any past period. This is the concept-ownership split made concrete:
**"the board report (XVII), on the cadence (XIV)."**

---

## 15. Cross-axis seams

MEASUREMENT touches all four other axes. The seam rule (concept-ownership map):
this volume **measures**, the sibling **owns the thing measured**. Cited by volume
+ named concept, never a sibling section number.

| Seam | This volume (MEASUREMENT) does… | The other axis owns… |
|------|--------------------------------|----------------------|
| **× TIME (XIV)** | measures **cadence adherence** (§5); the board pack's content (§14) | the operating clock / the cadences / *when* the pack is assembled (the cadence/lifecycle, Volume XIV) |
| **× AUTHORITY (XV)** | measures **approval rate, autonomy rate, escalation rate** (§10) | who may decide what; *whether* an act may run alone; acting on a KPI breach (the decision rule / approval gate, Volume XV) |
| **× LEARNING (XVI)** | measures **learning velocity** (lessons captured, time-to-recall) and feeds metrics in as evidence | the post-mortem→lesson pipeline; turning a metric into canon (the lesson-capture / learning loop, Volume XVI) |
| **× CHANGE (XVIII)** | measures **version health / evolution** (deploy-fail by version, post-change KPI deltas) | adding/retiring employees; capability/SDK/OS versioning (the change/evolution process, Volume XVIII) |

The discipline at every seam is the same: this volume produces the *number*; the
sibling holds the *authority, the timing, the lesson, or the change*. A KPI breach
is **seen here** and **acted on under Volume XV**; a metric becomes a **lesson under
Volume XVI**; the board pack is **assembled on Volume XIV's cadence**. The
measurement layer informs; it never decides, schedules, remembers, or changes —
those are the other four axes, by construction.

---

## 16. Failure & recovery

The measurement layer can mislead in four ways. Each has a recovery that returns
the company to *one honest source of truth*.

| Failure | What it looks like | Recovery |
|---------|--------------------|----------|
| **A broken / misleading metric** | a KPI shows the wrong number (a producer mis-emits or omits a verb) | because the KPI is a projection, the fix is in the **events**, not a counter: correct the producer, **re-run the query** — every past window recomputes correctly (P1 append-only ⇒ replayable). Analytics (22) §11 "reconciles to source" catches the divergence. |
| **Metric gaming / Goodhart** | an employee optimises the *measure* not the *goal* (e.g. inflating `task.completed` with trivial tasks) | the spine makes gaming **visible**: the gamed verb's pattern is itself auditable, and **balancing KPIs** (e.g. quality score + cost-per-outcome alongside throughput) make the trade-off legible. A measure that becomes a target is paired, never trusted alone — the standing guard against Goodhart's law. |
| **A stale dashboard** | a dashboard shows old data (the refresh tick stalled) | a dashboard is a *query*, so staleness = a missed cadence (Volume XIV): Monitoring (41) detects the stalled refresh schedule as a cadence-adherence breach (§5); re-running the query is the whole fix — no data was lost, only un-refreshed. |
| **A wrong forecast** | a prediction (§13) did not come to pass | it was **never presented as fact** (the §13 discipline), so the recovery is honest by design: the miss is captured as a **lesson under the learning loop (Volume XVI)**, the forecaster's **confidence calibration (§10)** degrades and self-corrects, and the model's assumptions are revisited. A forecast is judged on calibration over time, not on any single call. |

The meta-recovery for all four: **there is only ever one truth to repair — the
event spine.** No failure here can corrupt a *second* store, because there is no
second store (O4/C5). A misleading metric is a *reading* error or a *producer*
error, never a *truth* that has drifted out of sync.

---

## 17. Observability — measuring the measurement system

The cortex must itself be visible. Per the skeleton, the health of *this model*
is — like everything else — projected from the spine and **watched by Monitoring
(41)**:

- **Freshness.** Each KPI/dashboard carries the `ts`/`id` of the latest event it
  reflects; a KPI not refreshed within its window is a **staleness** signal (a
  cadence breach, §5). Analytics (22) §13 health is "mostly about freshness and
  source availability" — exactly this.
- **Source availability.** A KPI whose source verbs stopped arriving (a silent
  producer) is flagged — "all green on missing data" is forbidden (Monitoring 41
  §11): a blind spot is a high-severity condition, not a pass.
- **Definition consistency.** Analytics (22) §12 tracks "consistency of metric
  definitions over time" — a metric whose formula changed is versioned (O5), so a
  trend is never silently computed two different ways across its history.
- **Reproducibility.** Every figure is reproducible from its `evidence[]`
  (Analytics §14) — the ultimate observability of a metric is that *anyone can
  re-derive it from the log.*
- **Calibration.** The forecasters' confidence calibration (§10) is itself a
  measured KPI — the measurement system watches whether its own predictions are
  honest.

A dead Analytics (22) or a blind Monitoring (41) is the loudest alarm in the
company (their §13: "blind executives are a decision risk… its absence is never
quiet"; "the watcher must itself be watched"), because a company that cannot see
itself is operating blind.

---

## 18. Conflicts resolved

**This volume closes conflict C5 in full** (per the keystone: XVII → C5).

> **C5 — three parallel audit logs / the temptation of a parallel metric store.**
> The adoption analysis found `activity_log`, the various `*_timeline_events`
> tables, and `hq_events` all claiming to record the truth. The substrate already
> resolved the *audit* form (P1: `hq_events` is the system of record; the others
> become projections). **This volume resolves the *measurement* form of the same
> conflict:** a company under pressure to "track its KPIs" will reach for a metric
> table — a warehouse of authoritative counters, incremented as things happen.
> That table would be a **second source of truth**, free to drift from the first.

**The resolution (O4):** *one system of record, many read-models.* Every KPI,
dashboard, trend, prediction and board figure is a **read-projection of
`hq_events`** — a query, not a counter. There is exactly one durable truth (the
append-only spine); the scoreboard is a set of *views* over it. The guarantees
that follow are the whole point:

- **No drift** — a view cannot disagree with its source; if a number looks wrong,
  the events are wrong (a producer bug), and fixing them fixes every view.
- **Replayable** — any KPI, for any past window, recomputes identically from the
  immutable log (P1).
- **Auditable** — every figure traces to its `evidence[]` and ultimately to
  `WHERE correlation_id = X ORDER BY id` (O6).
- **Cheap to extend** — a new KPI is a new *definition* (data, O5), not a new
  store and not a deploy.

The measurement layer owns the **views**; it never owns a **second copy of the
truth.** That sentence is C5's resolution, and the constitution of this volume.

---

## 19. Open questions

Matters a future CEO Directive must still decide before implementation:

1. **Materialisation strategy.** O4 forbids a parallel *truth*, not a *cache*.
   Which KPIs are computed live versus materialised/cached for speed (Analytics 22
   §15 proposes caching common KPIs), and how is a materialised view proven to
   still equal its source query? Where is the line between "a cache of a
   projection" (allowed) and "a second store" (forbidden)?
2. **Attribution model.** Several KPIs are "indirect — attributed with the
   deciders" (Analytics/Intelligence §12 Revenue/ROI). How is revenue and ROI
   attributed across the chain of employees that produced an outcome, without
   double-counting?
3. **North-star set.** Are the six Tier-0 KPIs (§4) the right six, and is **AI
   autonomy rate** weighted as the headline of the AI-native thesis — or does the
   board want a different apex number?
4. **Forecast horizon & accuracy bar.** How far forward may each prediction (§13)
   reach, and what calibration threshold must a forecaster clear before its
   forecasts are allowed into the board pack unflagged?
5. **Benchmark sourcing.** UK-construction external benchmarks (industry DSO,
   typical retention %, sector churn) would make KPIs comparable — but sourcing
   them is an external-data question (Research 13 territory) and out of this
   volume's read-only scope.
6. **Privacy of AI-performance KPIs.** The §10 ledger judges each AI employee like
   staff. What is shown to whom, and does any of it (e.g. a low quality score)
   need the same data-protection handling as human performance data (Legal 25)?

---

*Volume XVII of the CrewFlow Bible — the Operating Model layer. Architecture only
— no code, no production change, no migration, no PR. Composes the AI Substrate
(IX–XIII) and the AI Workforce (Layer 4); re-implements neither.*
