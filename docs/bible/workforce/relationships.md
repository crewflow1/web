# The CrewFlow AI Workforce — Relationships & Org Design

> **Layer 4 (AI Workforce) · the systems view.** Architecture only, under CEO
> Directive #007. This is the **companion** to `README.md` (the AI Employee
> Design Standard) and the 42 specs in `employees/`. The README defines *each*
> employee in isolation; the 42 specs pin *each* one's configuration; **this
> document defines how the 42 interrelate** — the org chart, reporting lines,
> communication graph, event graph, task-delegation graph, approval hierarchy,
> shared-memory ownership, capability matrix, cross-department workflows and
> collaboration patterns.
>
> **Inheritance note:** nothing here re-implements the substrate. Every line that
> follows is two or more employees interacting **through** Communication (IX),
> the Event Bus (XI), the Task Engine (XII), Shared Memory (X) and the AI SDK
> (XIII) — defined once, configured per employee. This file does not add a new
> mechanism; it draws the map of the company those mechanisms already make
> possible. The goal of the directive: this should read like **the org chart of
> a Fortune-500 construction-tech firm**, not a collection of agents.

---

## 0. How to read this document

- **Numbers** `(NN)` are employee ids — the same `#` used across the roster and
  every spec; the slug is the `actor_id` on every event, message and task that
  employee emits.
- **Verbs** in `code` are XI event verbs (past tense, `domain.thing.happened`),
  registered in `hq_event_verbs` (README §6.2). Substrate verbs (`task.*`,
  `ai.message.*`, `memory.*`, `approval.*`, `api.called`, `tool.invoked`) are
  inherited and omitted from the domain graph for clarity.
- **Tiers** `T0–T4` are the autonomy postures (README §5): T0 Executive,
  T1 Director, T2 Specialist, T3 Channel, T4 Platform. The tier sets the default
  approval gate (§6 below).
- Every interaction is **substrate-mediated**: a message is an IX envelope, an
  event is an XI row, a delegation is an XII task, a hand-off is an X memory
  reference, an action is a P5 doorman call. No employee touches another
  employee's state directly.
- **Single source of truth:** where this document and a spec appear to differ on
  a fact, the **roster in `README.md` §7 is canonical** and the spec is the
  authority on that employee's internals. This file may not invent a reporting
  line, a zone, or a verb that those do not already establish.

---

## 1. The organisation chart

Eight divisions under the Office of the CEO, the human owner/board at the apex.
Five executive lines (the four C-suite AIs plus the Boardroom Orchestrator)
report to the CEO AI; everyone else rolls up through a division head into one of
the three functional executives (COO / CTO / CFO).

```
                          ┌─────────────────────────────────┐
                          │     Human Owner / Board (you)     │  ultimate authority
                          └─────────────────┬─────────────────┘
                                            │
                                     ┌──────▼──────┐
                                     │   CEO AI 01 │  apex orchestrator  (T0)
                                     └──────┬──────┘
        ┌──────────────────┬───────────────┼───────────────┬──────────────────────┐
   ┌────▼────┐        ┌────▼────┐      ┌────▼────┐    ┌─────▼─────┐         ┌────────▼────────┐
   │ COO 02  │        │ CTO 03  │      │ CFO 04  │    │ Boardroom │         │  (board arm:    │
   │  (T0)   │        │  (T0)   │      │  (T0)   │    │  Orch. 42 │ ······· │  no division)   │
   └────┬────┘        └────┬────┘      └────┬────┘    └───────────┘         └─────────────────┘
        │                  │                │
   ┌────┴─────────────┐    ├──────────┐     └───────────────┐
   │ │ │ │            │    │          │                     │
 Revenue Customer Operations People&Comp  Technology   AI Platform        Finance
 (COO)   (COO)    (COO)    (COO)         (CTO)         (CTO)              (CFO)
   │      │         │       │             │             │                  │
  Sales  CustSucc  Ops 23  HR 24        Product 5     Intelligence 37    Finance 21
   16←┐  18         Sched29 Legal&Comp25 EngMgr 6      Memory Mgr 38      Analytics 22
   ├ Research 13   Support  SiteMgr 34   BizCoach 33   QA 7              Quote Writer 30
   ├ Qualif.  14    19      Blueprint 35               Security 8        Cashflow 31
   ├ Outreach 15   Onboard  Procure. 36                DevOps 9          Payroll 32
   └ Marketing 17   20                                 Docs 10
                  Voice 26                              Database 11
                  WhatsApp 27                           API 12
                  Email 28
```

### Divisions (canonical — README §4)

| # | Division | Executive | Members |
|---|----------|-----------|---------|
| I | **Executive Office** | Human board | CEO (1), COO (2), CTO (3), CFO (4), Boardroom Orchestrator (42) |
| II | **Technology** | CTO (3) | Product (5), Engineering Manager (6), QA (7), Security (8), DevOps (9), Documentation (10), Database (11), API (12) |
| III | **AI Platform** (substrate ops) | CTO (3) | Intelligence (37), Memory Manager (38), Workflow (39), Notification (40), Monitoring & Incident (41) |
| IV | **Revenue** | COO (2) — acting CRO | Research (13), Qualification (14), Outreach (15), Sales (16), Marketing (17) |
| V | **Customer** | COO (2) | Customer Success (18), Support (19), Onboarding (20), Voice Receptionist (26), WhatsApp (27), Email (28) |
| VI | **Finance** | CFO (4) | Finance (21), Analytics (22), Quote Writer (30), Cashflow (31), Payroll (32) |
| VII | **Operations** | COO (2) | Operations (23), Scheduler (29), Site Manager (34), Blueprint (35), Procurement (36) |
| VIII | **People & Compliance** | COO (2) | HR (24), Legal & Compliance (25), Business Coach (33) |

The **Boardroom Orchestrator (42)** commands no division: it is the CEO AI's
operational arm (convene → decompose → route → track), and it executes nothing
itself — it *consumes* Workflow (39) and the substrate (§5, §9.4).

---

## 2. Reporting lines (the management spine)

Each employee has exactly one line manager. `manages` is the inverse. This table
is the roster's "Reports to" column made bidirectional; it is the canonical
management graph.

| # | Employee | Tier | Reports to | Manages |
|---|----------|------|-----------|---------|
| 1 | CEO AI | T0 | Human board | COO (2), CTO (3), CFO (4), Boardroom Orch. (42) |
| 2 | COO AI | T0 | CEO (1) | Sales (16), Marketing (17), Customer Success (18), Operations (23), HR (24), Legal & Compliance (25) |
| 3 | CTO AI | T0 | CEO (1) | Product (5), Eng Manager (6), Security (8), + AI Platform 37–41 |
| 4 | CFO AI | T0 | CEO (1) | Finance (21), Analytics (22) |
| 5 | Product AI | T1 | CTO (3) | — |
| 6 | Engineering Manager AI | T1 | CTO (3) | QA (7), DevOps (9), Documentation (10), Database (11), API (12) |
| 7 | QA AI | T1 | Engineering Manager (6) | — |
| 8 | Security AI | T1 | **CTO (3) directly** (independence from the delivery line it polices) | — |
| 9 | DevOps AI | T2 | Engineering Manager (6) | — |
| 10 | Documentation AI | T2 | Engineering Manager (6) | — |
| 11 | Database AI | T2 | Engineering Manager (6) | — |
| 12 | API AI | T2 | Engineering Manager (6) | — |
| 13 | Research AI | T2 | Sales (16) | — |
| 14 | Qualification AI | T2 | Sales (16) | — |
| 15 | Outreach AI | T2 | Sales (16) | — |
| 16 | Sales AI | T1 | COO (2) | Research (13), Qualification (14), Outreach (15) |
| 17 | Marketing AI | T1 | COO (2) | — |
| 18 | Customer Success AI | T1 | COO (2) | Support (19), Onboarding (20) |
| 19 | Support AI | T3 | Customer Success (18) | Voice Receptionist (26), WhatsApp (27), Email (28) |
| 20 | Onboarding AI | T2 | Customer Success (18) | — |
| 21 | Finance AI | T1 | CFO (4) | Quote Writer (30), Cashflow (31), Payroll (32) |
| 22 | Analytics AI | T2 | CFO (4) | — |
| 23 | Operations AI | T1 | COO (2) | Scheduler (29), Site Manager (34), Procurement (36) |
| 24 | HR AI | T1 | COO (2) | — |
| 25 | Legal & Compliance AI | T1 | COO (2) | — |
| 26 | Voice Receptionist AI | T3 | Support (19) | — |
| 27 | WhatsApp AI | T3 | Support (19) | — |
| 28 | Email AI | T3 | Support (19) | — |
| 29 | Scheduler AI | T2 | Operations (23) | — |
| 30 | Quote Writer AI | T2 | Finance (21) | — |
| 31 | Cashflow AI | T2 | Finance (21) | — |
| 32 | Payroll AI | T2 | Finance (21) | — |
| 33 | Business Coach AI | T2 | COO (2) | — |
| 34 | Site Manager AI | T2 | Operations (23) | Blueprint (35) |
| 35 | Blueprint AI | T2 | Site Manager (34) | — |
| 36 | Procurement AI | T2 | Operations (23) | — |
| 37 | Intelligence AI | T4 | CTO (3) | — |
| 38 | Memory Manager AI | T4 | CTO (3) | — |
| 39 | Workflow AI | T4 | CTO (3) | — |
| 40 | Notification AI | T4 | CTO (3) | — |
| 41 | Monitoring & Incident AI | T4 | CTO (3) | — |
| 42 | AI Boardroom Orchestrator | T0 | CEO (1) | — (orchestrates; commands no division) |

**Span of control.** The COO (2) is the broadest executive (6 direct reports
across four divisions, acting CRO); the CTO (3) owns Technology + AI Platform
(13 employees through the Engineering Manager and direct platform/security
lines); the CFO (4) owns Finance through Finance AI (21). Three director-level
hubs concentrate the lower tiers: **Sales (16)** (the revenue funnel),
**Customer Success (18)** (the customer lifecycle), **Finance (21)** (the money
functions), plus **Operations (23)** for the construction-operations cluster and
**Support (19)** for the inbound channels.

---

## 3. The communication graph (IX — who talks to whom)

Communication is the IX protocol: typed envelopes (`kind ∈ {request, inform,
propose, escalate}`), threaded by `correlation_id`, with deadlines and SLA
sweeps. An employee talks **down** its management line (delegation), **up** it
(status/escalation), and **across** to a bounded set of peers it has a standing
working relationship with. No employee broadcasts to all 42; lateral edges are
deliberate and listed in each spec's §9.

### 3.1 Primary lateral channels (peer-to-peer working relationships)

| Edge | Direction & purpose |
|------|--------------------|
| Research (13) ↔ Qualification (14) | hand-off of the intelligence record for scoring |
| Qualification (14) ↔ Outreach (15)/Sales (16) | qualified lead → pursuit |
| Sales (16) ↔ Quote Writer (30) | quote request ↔ quote draft |
| Quote Writer (30) ↔ Blueprint (35), Procurement (36), Legal (25) | take-off, supplier pricing, compliance for the build-up |
| Quote Writer (30) ↔ Finance (21) | shared Pricing/cost-book zone; margin sign-off |
| Sales (16) → Onboarding (20) → Customer Success (18) | won deal → setup → account ownership |
| Customer Success (18) ↔ Support (19) | account health ↔ ticket history |
| Support (19) ↔ Voice (26)/WhatsApp (27)/Email (28) | channel intake ↔ triage/draft |
| Site Manager (34) ↔ Blueprint (35), Procurement (36), Legal (25) | progress, materials, regs |
| Finance (21) ↔ Cashflow (31), Payroll (32), Analytics (22) | ledgers ↔ forecast/pay/KPI |
| Legal & Compliance (25) → *all* construction & finance employees | regs zone is a mandatory dependency |
| Intelligence (37) → CEO (1), COO (2), Sales (16) | synthesised company/market intelligence |
| Monitoring (41) → DevOps (9), CTO (3), Notification (40) | incident signal → responders |
| Boardroom Orch. (42) ↔ COO (2)/CTO (3)/CFO (4), Workflow (39) | convene executives; delegate the DAG |

### 3.2 Vertical channels (management line)

Every employee↔manager pair in §2 is a standing channel: `inform` (status
roll-ups, P3 reports), `request` (delegation down), `escalate` (up the rungs in
§6). The executives roll up to the CEO (1); the CEO and the human board converse
through the Boardroom Orchestrator (42) and Notification (40).

### 3.3 Notification fan-out (40)

**Notification AI (40)** is the single egress for *human-facing* alerts: any
employee that needs a human's attention (an approval request, a breach, an
incident, a directive decision) sends through 40, which owns channel choice,
batching, deduplication and quiet-hours. No employee notifies a human directly —
this keeps one throttle and one audit trail on human attention.

---

## 4. The event graph (XI — publish/subscribe)

Events decouple producers from consumers: an employee publishes a past-tense
fact to `hq_events`; any number subscribe by verb. This is the company's nervous
system — the same envelope (P1) carries `correlation_id` (the saga) and
`causation_id` (the parent event) so any flow is reconstructable with
`WHERE correlation_id = X ORDER BY id`.

| Domain verb | Publisher | Principal subscribers |
|-------------|-----------|----------------------|
| `company.researched` | Research (13) | Qualification (14), Intelligence (37) |
| `lead.qualified` / `lead.disqualified` | Qualification (14) | Outreach (15), Sales (16), Marketing (17) |
| `outreach.sent` | Outreach (15) | Sales (16) |
| `deal.progressed` | Sales (16) | CFO (4), Finance (21), Customer Success (18) |
| `quote.drafted` | Quote Writer (30) | Sales (16), Finance (21) |
| `quote.approved` | Sales (16)/human | Quote Writer (30), Finance (21), Onboarding (20) |
| `blueprint.analysed` | Blueprint (35) | Quote Writer (30), Site Manager (34) |
| `site.progressed` | Site Manager (34) | Operations (23), Quote Writer (30), Finance (21) |
| `order.drafted` | Procurement (36) | Finance (21), human approver |
| `invoice.reconciled` | Finance (21) | Cashflow (31), Analytics (22) |
| `expense.categorised` | Finance (21) | Cashflow (31), Analytics (22) |
| `cashflow.forecasted` | Cashflow (31) | CFO (4), Quote Writer (30), CEO (1) |
| `payroll.calculated` | Payroll (32) | Finance (21), CFO (4) |
| `onboarding.completed` | Onboarding (20) | Customer Success (18), Sales (16) |
| `ticket.triaged` / `ticket.resolved` | Support (19) | Customer Success (18), Analytics (22) |
| `appointment.scheduled` | Scheduler (29) | the requesting employee, Notification (40) |
| `content.published` | Marketing (17) | Sales (16), Analytics (22) |
| `compliance.flagged` | Legal & Compliance (25) | every affected employee (Site, Quote, Payroll, Finance, CEO) |
| `intelligence.synthesised` | Intelligence (37) | CEO (1), COO (2), Sales (16), Marketing (17) |
| `incident.opened` / `incident.resolved` | Monitoring & Incident (41) | DevOps (9), CTO (3), Notification (40), Boardroom (42) |
| `memory.consolidated` / `memory.expired` | Memory Manager (38) | (telemetry) Monitoring (41), CTO (3) |
| `directive.accepted` / `directive.routed` | Boardroom Orch. (42) | COO (2), CTO (3), CFO (4), the routed departments |
| `board.convened` | Boardroom Orch. (42) | the executive group |

**Publishers vs. subscribers, at a glance.** The **revenue funnel** (13→14→15→16)
is a chain of publishers each feeding the next; the **Finance cluster**
(21/30/31/32) is densely interlinked; **Intelligence (37)** and **Monitoring
(41)** are the two big fan-out broadcasters (one for business intelligence, one
for system health); **Boardroom (42)** is the executive fan-out. New verbs follow
the `domain.thing.happened` convention and are registered as data in
`hq_event_verbs` (no schema change) — the graph is extensible without touching the
substrate.

---

## 5. The task-delegation graph (XII — who routes work to whom)

Work is delegated as **tasks routed by capability**, not addressed to employees
by name (C1: capability-as-data). A delegator raises a task with a required
capability; the Task Engine routes it to a registered, healthy holder. Three
delegation shapes dominate:

### 5.1 Executive decomposition (top-down)

```
Human / CEO (1)  ──directive──▶  Boardroom Orchestrator (42)
                                      │  convenes COO (2) / CTO (3) / CFO (4)
                                      │  ── delegates DAG composition ──▶  Workflow (39)
                                      ▼
                          Workflow (39) builds the cross-department saga (XII)
                                      │ routes sub-tasks by capability
        ┌─────────────┬──────────────┼──────────────┬─────────────────┐
     Revenue       Customer        Technology     Finance          Operations
   (16→13/14/15)  (18→19/20)     (6→9/10/11/12)  (21→30/31/32)    (23→29/34/36)
```

The Boardroom Orchestrator (42) **never builds the DAG itself** — it asks
Workflow (39) to compose and sequence it, then routes by capability. Workflow is
the *general* saga operator; the Boardroom is the *executive directive* decomposer
that consumes it.

### 5.2 Director hubs (department fan-out)

Each T1 director decomposes department goals into tasks for its T2/T3 reports:

- **Sales (16)** → Research (13) `research.company`, Qualification (14)
  `qualify.lead`, Outreach (15) `outreach.draft`; requests Quote Writer (30)
  `quote.build`.
- **Engineering Manager (6)** → DevOps (9), Documentation (10), Database (11),
  API (12), QA (7) by engineering capability.
- **Finance (21)** → Quote Writer (30) `quote.build`, Cashflow (31)
  `cashflow.forecast`, Payroll (32) `payroll.run`.
- **Operations (23)** → Scheduler (29) `schedule.appointment`, Site Manager (34)
  `site.report`, Procurement (36) `procure.compare`.
- **Customer Success (18)** → Support (19) `ticket.triage`, Onboarding (20)
  `onboarding.run`.

### 5.3 Platform substrate (delegated-to by everyone)

The AI Platform (37–41) are **operated, not commanded** — every other employee
*uses* them through the substrate surfaces, without a management edge:

| Platform employee | Consumed by | Through |
|-------------------|-------------|---------|
| Workflow (39) | Boardroom (42) + any multi-step saga | XII task DAGs / compensation |
| Memory Manager (38) | every zone owner (housekeeping) | X consolidation/expiry |
| Intelligence (37) | CEO/COO/Sales/Marketing | X intelligence zone + synthesis |
| Notification (40) | every employee needing a human | the single human-egress |
| Monitoring & Incident (41) | the whole workforce (watches it) | XI golden signals + `incident.*` |

---

## 6. The approval hierarchy (the escalation ladder + the gates)

Two orthogonal structures govern "who may do what without a human":

### 6.1 The tier gate (default posture — README §5, P4 autonomy test)

| Tier | Members | Autonomous for | Always needs approval |
|------|---------|----------------|----------------------|
| **T0** | CEO (1), COO (2), CTO (3), CFO (4), Boardroom (42) | orchestrating, deciding, **approving subordinates** | their **own** high-impact acts → **human**: spend over threshold, production change, hiring/retiring an AI employee, external/legal commitment |
| **T1** | Product (5), Eng Mgr (6), QA (7), Security (8), Sales (16), Marketing (17), CS (18), Operations (23), Finance (21), HR (24), Legal (25) | internal reversible work; **approve subordinate work** within department scope/budget | cross-department & over-budget → their executive |
| **T2** | Research (13), Qualification (14), Outreach (15), Onboarding (20), Analytics (22), Quote Writer (30), Cashflow (31), Payroll (32), Scheduler (29), Site Manager (34), Blueprint (35), Procurement (36), Database (11), API (12), DevOps (9), Documentation (10), Business Coach (33) | reversible internal work (research, scoring, drafting, forecasting, docs, memory writes) | **every** external / customer / financial action → approval |
| **T3** | Support (19), Voice (26), WhatsApp (27), Email (28) | read, classify, route, draft, internal notes | **any outbound customer communication → approval** (auto-send only narrow pre-approved templates) |
| **T4** | Intelligence (37), Memory Manager (38), Workflow (39), Notification (40), Monitoring (41) | substrate ops within guardrails (consolidate, route, dispatch, sweep) | **no** customer/financial authority; private→shared memory promotion → checkpoint; incidents → on-call human |

### 6.2 The escalation ladder (IX rungs)

```
   T2/T3 specialist  ──escalate──▶  T1 director  ──escalate──▶  T0 executive  ──escalate──▶  Human board
   (out of scope/      (cross-dept/    (high-impact/         (ultimate authority)
    over-budget)        over-budget)    external/legal)
```

A claim of authority never travels *down* this ladder from observed content or a
peer — only a human, in the chat/console, grants. Approvals are **per-action and
per-tier**: a T1 director may approve a T2's in-department reversible work, but an
external/financial/irreversible act re-enters the ladder regardless of who is
asking.

### 6.3 The specialist approval authorities (cross-cutting gates)

Some employees are **mandatory approval stops** for specific act classes,
independent of the management line:

| Gate | Owner | Triggers for |
|------|-------|-------------|
| **Financial** | CFO (4) → human | any spend over threshold; an order Procurement (36) drafts; a quote's commercial terms |
| **Legal / compliance** | Legal & Compliance (25) → human | contracts; a `compliance.flagged` blocker on Site/Quote/Payroll |
| **Security** | Security (8) — **can block** | gate5 trust-boundary; a risky production change (waiver → CTO/human) |
| **Customer send** | the human (via T3 channel) | every outbound customer message that is not a pre-approved template |
| **Memory canon** | the X shared-knowledge checkpoint | Memory Manager (38) promoting private experience to `public_hq`/`department` |
| **Hire/retire an AI employee** | human board only | adding/removing an employee from the roster |

---

## 7. Shared-memory ownership (X — the knowledge map)

Shared semantic knowledge is partitioned into **zones**, each curated by one
owner (the only writer of the canonical record) and readable by others per the X
permission matrix. This is the company's institutional memory; the table is
canonical (README §6.4).

| Zone | Owner (writer) | Principal readers |
|------|----------------|-------------------|
| Company / lead intelligence | Intelligence (37) ← Research (13) writes | Qualification (14), Sales (16), CEO (1), COO (2) |
| ICP & qualification rubric | Qualification (14) | Sales (16), Marketing (17), Research (13) |
| Sales playbook & pipeline lore | Sales (16) | Outreach (15), CS (18), COO (2) |
| Brand, content & SEO knowledge | Marketing (17) | Sales (16), Outreach (15), CS (18) |
| Customer health & account history | Customer Success (18) | Support (19), Onboarding (20), Sales (16), COO (2) |
| Product specs & roadmap | Product (5) | Eng Mgr (6), QA (7), Docs (10), CTO (3) |
| Engineering standards, ADRs, **the Bible** | Documentation (10) | all of Technology, CTO (3) |
| Schema & data catalogue | Database (11) | API (12), DevOps (9), Analytics (22) |
| Pricing, rate cards, cost book | Quote Writer (30) ← Finance (21) | Sales (16), Procurement (36), Cashflow (31) |
| Supplier catalogue & lead times | Procurement (36) | Quote Writer (30), Site Manager (34), Operations (23) |
| Compliance & UK construction regs (CDM 2015, CIS, Building Safety Act, Part L) | Legal & Compliance (25) | **all**; mandatory for Site (34), Quote (30), Payroll (32) |
| Financial ledgers & forecasts | Finance (21) / Cashflow (31) | CFO (4), Analytics (22), Quote Writer (30) |
| The memory substrate itself (consolidation, expiry, dedupe) | Memory Manager (38) | — operational owner |

**The ownership doctrine.** One writer per zone keeps company knowledge
single-source; readers consume **by reference** (recall the memory id into
`evidence[]`), never by copy — so when an owner updates the canon, every reader
sees the update. A private experience becomes shared canon only through the X
checkpoint (§6.3). Memory Manager (38) operates the *housekeeping* of all zones
but owns the *content* of none.

---

## 8. The capability matrix (employee × what it may do)

Capabilities are data (`hq_ai_capabilities`, XIII §4): each employee holds a
narrow set with a confidence, scopes, an approval flag and a cost ceiling. The
matrix below is the **shape** of the workforce's authority — the columns are the
tool/action families from README §6.3; ●=core grant, ○=read/assist only, blank=
not granted. (Each spec's §5/§7 is authoritative for the exact grant.)

| # | Employee | db.read | db.write | crm | comms¹ | calendar | money² | site³ | reports | external⁴ |
|---|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | CEO | ● | ○ | | | | | | ● | |
| 2 | COO | ● | ○ | ○ | | | | ○ | ● | |
| 3 | CTO | ● | ○ | | | | | | ● | |
| 4 | CFO | ● | ○ | | | | ○ | | ● | |
| 5 | Product | ● | ○ | | | | | | ● | |
| 6 | Eng Manager | ● | ○ | | | | | | ● | |
| 7 | QA | ● | | | | | | | ● | |
| 8 | Security | ● | | | | | | | ● | ○ |
| 9 | DevOps | ● | ● | | | | | | ● | ○ |
| 10 | Documentation | ● | ● | | | | | | ● | |
| 11 | Database | ● | ● | | | | | | ● | |
| 12 | API | ● | ● | | | | | | ● | ● |
| 13 | Research | ● | ○ | ○ | | | | | ● | ● |
| 14 | Qualification | ● | ○ | ○ | | | | | ● | |
| 15 | Outreach | ● | ○ | ● | ○ | | | | ● | |
| 16 | Sales | ● | ● | ● | ○ | ○ | | | ● | |
| 17 | Marketing | ● | ● | ○ | ○ | | | | ● | ● |
| 18 | Customer Success | ● | ● | ● | ○ | | | | ● | |
| 19 | Support | ● | ● | ○ | ○ | | | | ● | |
| 20 | Onboarding | ● | ● | ● | ○ | ○ | | | ● | |
| 21 | Finance | ● | ● | | | | ● | | ● | ○ |
| 22 | Analytics | ● | ○ | | | | | | ● | |
| 23 | Operations | ● | ● | ○ | | ○ | | ○ | ● | |
| 24 | HR | ● | ● | | | | ○ | | ● | |
| 25 | Legal & Compliance | ● | ● | | | | | | ● | ○ |
| 26 | Voice Receptionist | ● | ○ | ○ | ●phone | ○ | | | ○ | |
| 27 | WhatsApp | ● | ○ | ○ | ●wa | ○ | | | ○ | |
| 28 | Email | ● | ○ | ○ | ●email | ○ | | | ○ | |
| 29 | Scheduler | ● | ● | ○ | ○ | ● | | | ○ | |
| 30 | Quote Writer | ● | ● | ○ | | | ○ | ○ | ● | |
| 31 | Cashflow | ● | ● | | | | ○ | | ● | ○ |
| 32 | Payroll | ● | ● | | | | ● | | ● | ○ |
| 33 | Business Coach | ● | ○ | ○ | | | | | ● | |
| 34 | Site Manager | ● | ● | ○ | ○ | ○ | | ● | ● | |
| 35 | Blueprint | ● | ● | | | | | ●ocr | ● | |
| 36 | Procurement | ● | ● | | ○ | | ○ | ● | ● | ● |
| 37 | Intelligence | ● | ○ | | | | | | ● | ● |
| 38 | Memory Manager | ● | ●mem | | | | | | ● | ○embed |
| 39 | Workflow | ● | ○ | | | | | | ● | |
| 40 | Notification | ● | ○ | | ●all | | | | ○ | |
| 41 | Monitoring & Incident | ● | ○ | | ○ | | | | ● | |
| 42 | Boardroom Orchestrator | ● | ○ | | | | | | ● | |

¹ comms = email/whatsapp/sms/phone (channel employees hold one each; Notification holds all, for human egress).
² money = payroll/financial-ledger write or spend authority (always human-gated to *enact*).
³ site = blueprint_viewer / ocr / maps / weather (construction-operations tools).
⁴ external = `browser`, `companies_house`, `maps`, embedding/LLM providers — always via the API gateway (XIII §13), never direct.

**Reading the matrix.** Authority is concentrated where accountability is: the
executives are broad-read / narrow-write / no-external (they orchestrate, they
don't act on the world); the **channel employees (26–28)** hold exactly one comms
tool each and may not write business state; the **money writers (21, 30, 31, 32)**
can compute and draft but every *enacting* act is human-gated; **external reach**
is rare and always gateway-mediated. No employee holds `db.write` to a business
table it does not own, and no employee holds the keys to an external provider
(P5: the doorman and the gateway hold them).

---

## 9. Cross-department workflows (the end-to-end sagas)

These are the company's value streams — each a single `correlation_id` threaded
across many employees, composed by Workflow (39), every step an XII task, every
fact an XI event, every hand-off an X reference, every external/financial/
customer act an approval checkpoint. They are what make the 42 a *company*.

### 9.1 Lead-to-Cash (the revenue engine)

```
Research (13) ──company.researched──▶ Qualification (14) ──lead.qualified──▶ Outreach (15)
   └─writes Intelligence zone            └─scores vs ICP rubric                 └─drafts; HUMAN sends
                                                                                    │ outreach.sent
                                                                                    ▼
        Sales (16) runs the deal ──deal.progressed──▶ requests Quote Writer (30)  [→ §9.2]
                                                                                    │ quote.approved (human)
                                                                                    ▼
        deal won ──▶ Onboarding (20) ──onboarding.completed──▶ Customer Success (18) owns account
                                          │
        Finance (21) raises invoice ──invoice.reconciled──▶ Cashflow (31) updates forecast
```

Owners: **Sales (16)** owns the deal; **Finance (21)** owns the cash; **CS (18)**
owns the post-sale account. Every customer-facing send and the final quote are
human-gated (T2/T3 + financial gate).

### 9.2 Quote-to-Job (UK construction estimating)

```
enquiry ─▶ Blueprint (35) ──blueprint.analysed──▶ structured take-off (NRM2/SMM7)
                                   │
        Procurement (36) prices materials (Supplier zone) ─┐
        Legal & Compliance (25) checks CDM/Part L/regs ────┼─▶ Quote Writer (30) builds up the estimate
        Finance (21) confirms rates/margin (Pricing zone) ─┘        │ quote.drafted
                                                                     ▼
                                            Sales (16) reviews ─▶ HUMAN signs & sends  (quote.approved)
```

Owners: **Quote Writer (30)** assembles but **never sends, commits or discounts**;
**Blueprint (35)** measures but **approves no design**; the human sends. Legal's
regs zone is a *mandatory* read — a `compliance.flagged` blocks the quote.

### 9.3 Directive decomposition (executive orchestration)

```
Human / CEO (1) ─directive─▶ Boardroom Orchestrator (42)
   convenes COO (2)/CTO (3)/CFO (4)  ─delegates DAG─▶  Workflow (39) composes saga
        directive.routed ─▶ departments execute ─▶ task.* roll-ups ─▶ 42 tracks ─▶ CEO (1) status
```

Owners: **CEO (1)** sets strategy; **Boardroom (42)** decomposes and routes (sets
no strategy, executes nothing); **Workflow (39)** owns the DAG mechanics. Spend or
external commitment a directive implies routes to CFO (4)/human — never enacted by
the orchestrator.

### 9.4 Incident response (platform reliability)

```
Monitoring (41) detects breach ──incident.opened──▶ Notification (40) ─▶ DevOps (9) + on-call human
        DevOps (9) remediates (gate-checked change) ─▶ Security (8) reviews if trust-boundary
        ──incident.resolved──▶ post-mortem ─▶ Memory Manager (38) consolidates the lesson
```

Owners: **Monitoring (41)** detects and coordinates; **DevOps (9)** remediates;
**CTO (3)** is accountable; production changes remain human/Security-gated even
under incident.

### 9.5 Inbound customer support (channel → resolution)

```
Voice (26)/WhatsApp (27)/Email (28) intake ─▶ Support (19) triages ──ticket.triaged──▶
        resolve from knowledge (draft) ─▶ HUMAN approves send ──ticket.resolved──▶
        escalate account risk ─▶ Customer Success (18) (health zone)  [churn risk ─▶ Sales (16)]
```

Owners: **Support (19)** triages and drafts; the **channel employee** carries the
reply but a human approves any non-templated send (T3); **CS (18)** owns the
account relationship.

### 9.6 Payroll & CIS run (construction finance)

```
timesheets ─▶ Payroll (32) computes PAYE/RTI + CIS deductions (20/30/gross) ──payroll.calculated──▶
        Finance (21) reconciles ─▶ CFO (4) approves ─▶ HUMAN submits RTI/CIS to HMRC
```

Owners: **Payroll (32)** computes but never *submits*; **Legal (25)** regs zone
governs CIS status; submission is human-gated (financial + external).

**Common shape.** Every saga: one initiator, a chain of capability-routed tasks,
domain events at each milestone, a clear single owner per stage, and a human gate
at every irreversible/external/financial/customer boundary. Partial failures are
compensated by Workflow (39) (XII saga compensation), not improvised.

---

## 10. AI collaboration patterns (the recurring shapes)

The whole workforce is built from a small set of substrate-given patterns. Naming
them keeps every future employee consistent — a new hire reuses a pattern, it does
not invent one.

| Pattern | Mechanism | Where it shows up |
|---------|-----------|-------------------|
| **Orchestrator–worker** | XII task DAG + capability routing | Boardroom (42)→Workflow (39)→departments; Sales (16)→13/14/15; Finance (21)→30/31/32 |
| **Request–response** | IX `request` envelope + deadline | Sales (16) asks Quote Writer (30) for a quote; CS (18) asks Support (19) to triage |
| **Publish–subscribe** | XI events, decoupled | the revenue funnel verbs; `compliance.flagged` fan-out; `intelligence.synthesised` |
| **Shared-memory hand-off** | X zone: one writes canon, others read by reference | Research (13)→Qualification (14) via the intelligence zone; Quote Writer (30)↔Finance (21) pricing zone |
| **Escalation ladder** | IX `escalate` up the rungs | T2→T1→T0→human; out-of-scope, over-budget, external/legal |
| **Approval checkpoint** | P4 autonomy test + §15 framework | every customer send, every spend, every irreversible act |
| **Saga with compensation** | XII multi-step task + compensating actions | Lead-to-Cash, Quote-to-Job, Directive decomposition |
| **Doorman-mediated action** | P5 service-role doorman | every business-state write; the AI requests, the doorman checks rules, opens one door, writes it down |
| **Gateway-metered external call** | XIII §13 API gateway | every `companies_house`/`browser`/LLM/embedding call — metered, budgeted, audited |
| **Single human egress** | Notification (40) | every human-facing alert, throttled and deduplicated |
| **Substrate operator** | T4 consume-not-reimplement | Intelligence/Memory/Workflow/Notification/Monitoring *run* the substrate they never re-build |

**Why these and only these.** Each pattern maps to exactly one substrate
subsystem (IX/X/XI/XII/XIII) — so "how do two employees collaborate?" always has a
substrate answer, never a bespoke one. This is the directive's "one architecture,
one source of truth" expressed as behaviour: the 42 employees differ in *what*
they know and decide, and are identical in *how* they talk, remember, delegate,
escalate, act and are audited.

---

## 11. The company, in one paragraph

A human board owns a CEO AI (1) that orchestrates three functional executives —
COO (2), CTO (3), CFO (4) — and an operational arm, the Boardroom Orchestrator
(42), across eight divisions and forty-two employees. Revenue is a funnel
(Research → Qualification → Outreach → Sales → Quote) that hands won work to a
Customer lifecycle (Onboarding → Customer Success → Support, fed by three I/O
channels) and a Finance engine (Finance → Quote Writer / Cashflow / Payroll /
Analytics). Operations runs the construction reality (Site Manager → Blueprint,
Procurement, Scheduler) on a foundation of Legal & Compliance regs and HR. A
Technology division builds and guards the product; an AI Platform division
*operates the substrate* every other employee runs on. They share one nervous
system (events), one memory (zoned, single-writer), one delegation engine
(capability-routed tasks), one escalation ladder ending at a human, and one audit
log. That is not a collection of agents. It is a company.

---

*The relationships document of the CrewFlow AI Workforce (Layer 4). Architecture
only — no code, no production change, no migration, no PR. Every interaction
described inherits the AI SDK (Volume XIII) and the substrate (Volumes IX–XII);
this file maps the organisation those mechanisms create, and re-implements
nothing. Companion to `README.md` and the 42 specifications in `employees/`.*
