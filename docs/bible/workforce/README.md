# The CrewFlow AI Workforce — Layer 4

> **Status:** Architecture specification. Constitutional design work under **CEO
> Directive #007 — *CrewFlow AI Workforce Architecture*** (2026-06-21).
>
> **This is design, not a build order.** Per the directive: *do not implement
> anything, no production code, no PRs, no repository changes, no database
> migrations, no prototypes.* Nothing in this directory is implemented until a
> future CEO Directive explicitly instructs it, one employee at a time, on top of
> the AI substrate (Volumes IX–XIII). These documents exist so that, when that
> directive lands, any engineer can implement any AI employee **directly from its
> specification, without inventing behaviour.**

---

## 1. What Layer 4 is

The substrate (Volumes IX–XIII) is the **operating system**. Layer 4 is the
**workforce that runs on it** — 42 AI employees, each a configured instance of
the one blueprint defined in **Volume XIII (the AI SDK)**.

```
   Layer 4  ── The AI Workforce ──  42 employees (this directory)
                     │  each = identity + config + capabilities + a handler
                     ▼  inherits, never re-implements
   Layer 3  ── The AI Substrate ──  Volumes IX–XIII  (../substrate/)
                     │  comms · memory · event bus · task engine · SDK
                     ▼
   Layer 2  ── Postgres (Supabase), RLS:hq, service-role doorman
   Layer 1  ── CrewFlow product (UK construction OS)
```

CrewFlow is **not building chatbots.** It is building the world's first fully
architected **AI workforce for construction companies** — each employee a real
executive or staff member with defined responsibilities, authority,
accountability and measurable business value. This directory is that workforce's
org design and the per-role specifications behind it.

**Contents:**

| File | What it is |
|------|------------|
| `README.md` (this) | The **AI Employee Design Standard** — the inheritance contract, the canonical template, the org model, the roster that seeds every spec. |
| `employees/NN-<slug>.md` | One file per employee (42), each the full 16-section specification. |
| `relationships.md` | The **whole-org** view — org chart, reporting lines, communication / event / delegation graphs, approval hierarchy, shared-memory ownership, capability matrix, cross-department workflows, collaboration patterns. |
| `platform-compatibility-matrix.md` | The **as-built** whole-org view — the canonical migration dashboard: which platform capabilities each AI employee **currently inherits**, how many of the 42 run on the shared engine today, and what a new migration gets for free. Established under Directive **#012**; updated as the *first* artifact of every employee migration. |

Read this README first; it is the law every employee file obeys.

---

## 2. The inheritance contract (the prime law of Layer 4)

> **Every AI employee inherits from the AI SDK (Volume XIII). No employee
> implements its own architecture. No duplicated logic, communication, memory, or
> permissions. Every employee plugs into the same operating system.**

This is not a style guideline; it is the architecture. Concretely, **the
substrate already provides — once, for everyone — every mechanism an employee
needs**, so an employee specification never re-describes a mechanism. It only
*configures* it. The table below is the canonical "inherit, don't re-invent" map.
Whenever a spec would describe *how* something works, it instead **references the
substrate** and states only the employee-specific *values*.

| The mechanism (provided once) | Where it lives | What an employee spec may state |
|-------------------------------|----------------|---------------------------------|
| How an employee is invoked, claims work, leases, heartbeats, retries, recovers | XII Task Engine; the canonical run-loop XIII §21 | *which* task types it runs; its concurrency, budget, deadlines |
| How it reasons → outputs | P3 envelope (`README` substrate); XIII §10 | nothing about the shape — only *what* it concludes and proposes |
| How it talks to other employees | IX Communication Protocol | *whom* it may talk to and *which* intents it sends/handles |
| How it remembers and recalls | X Shared Memory; XIII §11 | *which* memory classes/zones it owns and reads |
| How it touches Postgres / external APIs | P5 doorman doctrine; XIII §13 gateway | *which* tools and providers it is granted |
| How permission is enforced | 3-layer gate XIII §8 | *its* scopes, limits, least-privilege grants |
| How "act vs ask" is decided | the autonomy test P4; approval framework XIII §15 | *which* of its actions are reversible/bounded vs gated |
| How cost is metered and budgeted | XIII §19 | *its* budgets and cost expectations |
| How it is audited | one event log, `hq_events`; XIII §21 | nothing — audit is uniform and automatic |
| How it is versioned, configured, health-checked | XIII §17–§20 | *its* config values and health expectations |
| What it *is* (identity) | `ai_employees` row; XIII §5 | its row values (name, slug, role, department, …) |
| What it *can do* (capability) | `hq_ai_capabilities` rows; XIII §4 | its capability grants (data: an `INSERT`, not code) |

**Consequence:** adding the 42nd employee is a **data migration** (insert an
`ai_employees` row + its `hq_ai_capabilities` rows + register its task types,
verbs and subscriptions) plus **one handler function**. It is never a new
framework. This is the mechanism that makes a 42-employee workforce the reuse of
*one* architecture — and it is how Directive #003 ("one architecture, one source
of truth") and Directive #007 ("no duplicated logic") are satisfied structurally
rather than by discipline.

### The three-question gate (every employee must pass)

1. **Does it align with the CrewFlow Bible?**
2. **Does it fit naturally into the AI substrate?** (i.e. is it expressible purely
   as SDK configuration + a handler, with zero new plumbing?)
3. **Can the mechanism it uses be reused by every other AI employee?** (If a
   mechanism is bespoke to one employee, it is wrong — it belongs in the
   substrate or not at all.)

---

## 3. The canonical employee specification (the 16-section template)

Every `employees/NN-<slug>.md` file has **exactly these sixteen sections, in this
order** (the order Directive #007 specifies). Each maps to one or more SDK
dimensions it inherits. The right-hand column states what the section must pin
down for *that* employee — never the mechanism, only the configuration.

| # | Section | Inherits from | The employee file pins down |
|---|---------|---------------|------------------------------|
| 1 | **Identity** | XIII §5, `ai_employees` | name, slug, mission, division, department, version, owner, status, priority, purpose, role-in-company |
| 2 | **Responsibilities** | XIII §7 | what it owns / never owns; business objective; success & failure definitions; department boundaries |
| 3 | **Inputs** | XIII §9 `RunContext`; XI; IX; X | every event subscribed, API request, scheduled trigger, manual request, memory lookup, document, integration, AI message |
| 4 | **Outputs** | XIII §10 P3 envelope; XI; IX; XII | events published, messages, tasks, recommendations, reports, notifications, customer & internal comms, approvals, audit records |
| 5 | **Tools** | XIII §12 tool registry | the exact approved toolset (and explicitly: nothing outside it) |
| 6 | **APIs** | XIII §13 gateway | internal + external APIs, auth, permissions, rate limits, retry/failure behaviour, webhooks |
| 7 | **Permissions** | XIII §8 3-layer gate; P4 | read/write/update/delete/approve/reject/escalate/execute; financial, customer, staff, organisation limits — least privilege |
| 8 | **Memory** | X; XIII §11 | which private/working/shared/long-term/semantic/episodic memory it uses; retrieval rules, retention, expiry, context window, ownership |
| 9 | **Communication** | IX | who it talks to / who talks to it; protocol, priority rules, conversation lifecycle, escalation, broadcast behaviour |
| 10 | **Approval Rules** | P4; XIII §15; XII §8 | which actions need no / manager / customer / HQ / human / legal / financial approval |
| 11 | **Failure Handling** | XII; IX escalation ladder | timeouts, retries, escalations, dead-letter, fallback, recovery, safe shutdown, partial-failure |
| 12 | **KPIs** | XIII §20 metrics, §19 cost | accuracy, latency, revenue, hours saved, CSAT, approval rate, failure rate, escalation rate, execution cost, ROI, quality score |
| 13 | **Health Checks** | XIII §20 health | heartbeat, availability, capability registration, version, dependency/memory/tool/API/queue health |
| 14 | **Audit** | XIII §21, P1 | what is logged (everything): reasoning, confidence, I/O, permissions used, memory refs, tools, duration, cost, approvals, outcome |
| 15 | **Cost Model** | XIII §19 | avg execution cost, token usage, API costs, infra cost, monthly operating cost, scaling projection, optimisation strategy |
| 16 | **Future Expansion** | — (employee-specific) | future responsibilities, tools, APIs, intelligence, autonomy; five-year evolution plan |

Each file opens with a short front-matter block (status, inherits-from pointer,
the directive) and a one-line **"Inheritance note"** restating that every
mechanism below is the SDK's; the file configures, never re-implements. Sections
3, 4, 7, 8, 9, 10 are the substantive, employee-distinguishing ones and carry the
most detail. Sections that are purely inherited and uniform (much of 11, 13, 14)
state the employee's *deltas* from the SDK default and otherwise reference it.

---

## 4. The organisation — divisions & reporting

The 42 employees form a single company, not a bag of agents. Eight divisions,
under the Office of the CEO, mirroring a Fortune-500 construction-tech firm. The
**human owner is the board**; the CEO AI is the apex orchestrator beneath them.

```
                        ┌──────────────────────────────┐
                        │   Human Owner / Board (you)   │   ← ultimate authority
                        └───────────────┬──────────────┘
                                        │
                                 ┌──────▼──────┐
                                 │   CEO AI    │  apex orchestrator (01)
                                 └──────┬──────┘
                 ┌──────────────┬───────┼────────┬───────────────────────┐
            ┌────▼────┐    ┌────▼────┐  │   ┌────▼────┐         ┌─────────▼─────────┐
            │ COO AI  │    │ CTO AI  │  │   │ CFO AI  │         │ Boardroom         │
            │  (02)   │    │  (03)   │  │   │  (04)   │         │ Orchestrator (42) │
            └────┬────┘    └────┬────┘  │   └────┬────┘         └───────────────────┘
       ┌─────────┼─────────┐    │       │        │
   Revenue   Customer   Operations  Technology + Platform   Finance
   (13-17)   (18-20,    (23,29,   (05-12, 37-41)            (21,22,
             26-28)     34-36,                              30-32)
                        24,25,33)
```

Five executive lines report to the CEO AI; every other employee rolls up through
a division head into one of the three functional executives (COO / CTO / CFO).
The **AI Boardroom Orchestrator (42)** is the CEO AI's operational arm — it
convenes the board, decomposes top-level directives into cross-department task
graphs, and routes them; it commands no division of its own. Full reporting
lines, the communication graph, and the approval hierarchy are in
`relationships.md`.

### Divisions

| Division | Executive | Members (#) |
|----------|-----------|-------------|
| **Executive Office** | Human board | CEO (1), COO (2), CTO (3), CFO (4), Boardroom Orchestrator (42) |
| **Technology** | CTO | Product (5), Engineering Manager (6), QA (7), Security (8), DevOps (9), Documentation (10), Database (11), API (12) |
| **AI Platform** (substrate operations) | CTO | Intelligence (37), Memory Manager (38), Workflow (39), Notification (40), Monitoring & Incident (41) |
| **Revenue** | COO (acting CRO) | Research (13), Qualification (14), Outreach (15), Sales (16), Marketing (17) |
| **Customer** | COO | Customer Success (18), Support (19), Onboarding (20), Voice Receptionist (26), WhatsApp (27), Email (28) |
| **Finance** | CFO | Finance (21), Analytics (22), Quote Writer (30), Cashflow (31), Payroll (32) |
| **Operations** | COO | Operations (23), Scheduler (29), Site Manager (34), Blueprint (35), Procurement (36) |
| **People & Compliance** | COO | HR (24), Legal & Compliance (25), Business Coach (33) |

---

## 5. Autonomy tiers (the posture that sets each employee's default approval gate)

The autonomy test (P4) is applied **per action** for everyone — but an employee's
*role* sets its default posture: how much it may do before a human is in the
loop. Five tiers, from most-orchestrating to most-mechanical. The tier is stated
in §1 of each spec and drives §7 (Permissions) and §10 (Approval Rules).

| Tier | Who | Default posture |
|------|-----|-----------------|
| **T0 Executive** | CEO, COO, CTO, CFO, Boardroom Orchestrator | Orchestrate, decide, and **approve subordinates**. They are *approval authorities*. Their **own** high-impact acts — spend over threshold, production change, hiring/retiring an AI employee, external or legal commitment — always require **human** approval. |
| **T1 Director** | Product, Eng Manager, QA, Security, Sales, Marketing, Customer Success, Operations, Finance, HR, Legal & Compliance | Department authority. Approve subordinate work within department scope and budget; autonomous for internal reversible work; escalate cross-department and over-budget to their executive. |
| **T2 Specialist** | Research, Qualification, Outreach, Onboarding, Analytics, Quote Writer, Cashflow, Payroll, Scheduler, Site Manager, Blueprint, Procurement, Database, API, DevOps, Documentation, Business Coach | Narrow capability scope. Autonomous for reversible internal work (research, scoring, drafting, forecasting, internal docs, memory writes). **Every** external / customer / financial action → approval. |
| **T3 Channel** | Support, Voice Receptionist, WhatsApp, Email | Customer-facing I/O. Autonomous to read, classify, route, draft, and write internal notes. **Any outbound customer communication → approval** (per the substrate safety rules + P4). May auto-send only narrowly-scoped, pre-approved templated acknowledgements (a governance decision flagged in each spec). |
| **T4 Platform** | Intelligence, Memory Manager, Workflow, Notification, Monitoring & Incident | Substrate operators / system actors. Autonomous within substrate guardrails (consolidation, routing, dispatch, health sweeps). **No** customer or financial authority. Escalate incidents to on-call humans. |

---

## 6. Shared namespaces (drawn from one pool, so the workforce composes)

To keep 42 employees interoperable, capabilities, event verbs, tools and memory
zones come from **one namespace**, defined here and referenced by every spec.

### 6.1 Capability slugs (`^[a-z0-9_.]{1,80}$`, dotted `domain.action`)

The capability is the unit of routing (IX) and assignment (XII): callers name a
*capability*, never an employee. Representative grants (each spec lists its own
exact set; this is the shared vocabulary):

`exec.strategy.set` · `exec.review` · `exec.approve` · `ops.coordinate` ·
`tech.govern` · `finance.govern` · `board.orchestrate` ·
`research.company` · `research.market` · `enrich.company` · `qualify.lead` ·
`outreach.sequence` · `outreach.send` · `sales.deal.progress` ·
`sales.quote.request` · `marketing.content.draft` · `marketing.campaign.plan` ·
`marketing.seo.audit` · `cs.health.score` · `support.ticket.triage` ·
`support.reply.draft` · `onboarding.run` · `channel.voice.handle` ·
`channel.whatsapp.handle` · `channel.email.handle` · `schedule.appointment` ·
`schedule.job` · `finance.invoice.reconcile` · `finance.expense.categorise` ·
`analytics.report` · `analytics.kpi.compute` · `quote.draft` · `quote.price` ·
`cashflow.forecast` · `payroll.run` · `payroll.cis.calculate` ·
`site.progress.update` · `site.report` · `blueprint.analyse` ·
`blueprint.measure` · `procurement.order.draft` · `procurement.supplier.compare`
· `hr.staff.manage` · `hr.timesheet.check` · `legal.contract.review` ·
`compliance.check` · `coach.advise` · `intelligence.synthesise` ·
`memory.consolidate` · `memory.expire` · `workflow.orchestrate` ·
`notify.dispatch` · `monitor.healthcheck` · `monitor.incident.respond` ·
`db.schema.review` · `api.contract.review` · `devops.deploy.prepare` ·
`docs.author` · `qa.gate.run` · `security.audit` · `product.spec.author`

### 6.2 Event verbs (past-tense `domain.thing.happened`, registered in XI `hq_event_verbs`)

Substrate verbs (`task.*`, `ai.message.*`, `ai.thread.*`, `memory.*`,
`api.called`, `tool.invoked`, `approval.*`) are inherited. Domain verbs the
workforce adds include: `company.researched` · `lead.qualified` ·
`lead.disqualified` · `outreach.sent` · `deal.progressed` · `quote.drafted` ·
`quote.approved` · `invoice.reconciled` · `expense.categorised` ·
`cashflow.forecasted` · `payroll.calculated` · `site.progressed` ·
`blueprint.analysed` · `order.drafted` · `ticket.triaged` · `ticket.resolved` ·
`onboarding.completed` · `appointment.scheduled` · `content.published` ·
`compliance.flagged` · `incident.opened` · `incident.resolved` ·
`intelligence.synthesised`. Each spec lists the verbs it **publishes** and the
verbs it **subscribes** to.

### 6.3 Tool registry labels (granted via `ai_employees.tools_allowed`, typed in XIII §12)

`db.read` · `db.write` (always via the doorman) · `crm` · `calendar` · `email` ·
`whatsapp` · `sms` · `phone` (voice) · `blueprint_viewer` · `payroll` · `ocr` ·
`browser` · `weather` · `storage` · `reports` · `search` · `companies_house` ·
`maps`. **No employee may use a tool outside its granted set** — the SDK refuses
an unregistered tool (XIII §12).

### 6.4 Shared-memory ownership zones (X; surfaced in `relationships.md`)

Shared semantic knowledge is partitioned into zones, each **curated by one
owner** (who may write the canonical record) and **readable by others per the X
permission matrix**:

| Zone | Owner | Principal readers |
|------|-------|-------------------|
| Company / lead intelligence | Intelligence (37) ← Research (13) writes | Qualification, Sales, CEO, COO |
| ICP & qualification rubric | Qualification (14) | Sales, Marketing, Research |
| Sales playbook & pipeline lore | Sales (16) | Outreach, CS, COO |
| Brand, content & SEO knowledge | Marketing (17) | Sales, Outreach, CS |
| Customer health & account history | Customer Success (18) | Support, Onboarding, Sales, COO |
| Product specs & roadmap | Product (5) | Eng Mgr, QA, Docs, CTO |
| Engineering standards, ADRs, **the Bible** | Documentation (10) | all of Technology, CTO |
| Schema & data catalogue | Database (11) | API, DevOps, Analytics |
| Pricing, rate cards, cost book | Quote Writer (30) ← Finance (21) | Sales, Procurement, Cashflow |
| Supplier catalogue & lead times | Procurement (36) | Quote Writer, Site Manager, Ops |
| Compliance & UK construction regs (CDM 2015, CIS, Building Safety Act, Part L) | Legal & Compliance (25) | all; mandatory for Site, Quote, Payroll |
| Financial ledgers & forecasts | Finance (21) / Cashflow (31) | CFO, Analytics, Quote Writer |
| The memory substrate itself (consolidation, expiry, dedupe) | Memory Manager (38) | — operational owner |

---

## 7. The master roster (the seed for all 42 specs)

These three tables **pin the facts** every employee file expands. They exist so
that no spec — and no future engineer — invents an employee's identity, line, or
remit. Order matches Directive #007. (`dept` = the `ai_employees.department`
value; see §8 on the enum gap.)

### Table A — Identity & line

| # | Employee | slug | Division | dept | Reports to | Tier |
|---|----------|------|----------|------|------------|------|
| 1 | CEO AI | `ceo-ai` | Executive | executive | Human board | T0 |
| 2 | COO AI | `coo-ai` | Executive | executive | CEO AI | T0 |
| 3 | CTO AI | `cto-ai` | Executive | executive | CEO AI | T0 |
| 4 | CFO AI | `cfo-ai` | Executive | executive | CEO AI | T0 |
| 5 | Product AI | `product-ai` | Technology | product | CTO AI | T1 |
| 6 | Engineering Manager AI | `engineering-manager-ai` | Technology | engineering | CTO AI | T1 |
| 7 | QA AI | `qa-ai` | Technology | quality | Engineering Manager AI | T1 |
| 8 | Security AI | `security-ai` | Technology | quality | CTO AI | T1 |
| 9 | DevOps AI | `devops-ai` | Technology | engineering | Engineering Manager AI | T2 |
| 10 | Documentation AI | `documentation-ai` | Technology | documentation | Engineering Manager AI | T2 |
| 11 | Database AI | `database-ai` | Technology | engineering | Engineering Manager AI | T2 |
| 12 | API AI | `api-ai` | Technology | engineering | Engineering Manager AI | T2 |
| 13 | Research AI | `research-ai` | Revenue | sales | Sales AI | T2 |
| 14 | Qualification AI | `qualification-ai` | Revenue | sales | Sales AI | T2 |
| 15 | Outreach AI | `outreach-ai` | Revenue | sales | Sales AI | T2 |
| 16 | Sales AI | `sales-ai` | Revenue | sales | COO AI | T1 |
| 17 | Marketing AI | `marketing-ai` | Revenue | marketing | COO AI | T1 |
| 18 | Customer Success AI | `customer-success-ai` | Customer | support | COO AI | T1 |
| 19 | Support AI | `support-ai` | Customer | support | Customer Success AI | T3 |
| 20 | Onboarding AI | `onboarding-ai` | Customer | support | Customer Success AI | T2 |
| 21 | Finance AI | `finance-ai` | Finance | finance | CFO AI | T1 |
| 22 | Analytics AI | `analytics-ai` | Finance | finance | CFO AI | T2 |
| 23 | Operations AI | `operations-ai` | Operations | operations | COO AI | T1 |
| 24 | HR AI | `hr-ai` | People & Compliance | operations | COO AI | T1 |
| 25 | Legal & Compliance AI | `legal-compliance-ai` | People & Compliance | operations | COO AI | T1 |
| 26 | Voice Receptionist AI | `voice-receptionist-ai` | Customer | support | Support AI | T3 |
| 27 | WhatsApp AI | `whatsapp-ai` | Customer | support | Support AI | T3 |
| 28 | Email AI | `email-ai` | Customer | support | Support AI | T3 |
| 29 | Scheduler AI | `scheduler-ai` | Operations | operations | Operations AI | T2 |
| 30 | Quote Writer AI | `quote-writer-ai` | Finance | finance | Finance AI | T2 |
| 31 | Cashflow AI | `cashflow-ai` | Finance | finance | Finance AI | T2 |
| 32 | Payroll AI | `payroll-ai` | Finance | finance | Finance AI | T2 |
| 33 | Business Coach AI | `business-coach-ai` | People & Compliance | operations | COO AI | T2 |
| 34 | Site Manager AI | `site-manager-ai` | Operations | operations | Operations AI | T2 |
| 35 | Blueprint AI | `blueprint-ai` | Operations | operations | Site Manager AI | T2 |
| 36 | Procurement AI | `procurement-ai` | Operations | operations | Operations AI | T2 |
| 37 | Intelligence AI | `intelligence-ai` | AI Platform | engineering | CTO AI | T4 |
| 38 | Memory Manager AI | `memory-manager-ai` | AI Platform | engineering | CTO AI | T4 |
| 39 | Workflow AI | `workflow-ai` | AI Platform | engineering | CTO AI | T4 |
| 40 | Notification AI | `notification-ai` | AI Platform | engineering | CTO AI | T4 |
| 41 | Monitoring & Incident AI | `monitoring-incident-ai` | AI Platform | engineering | CTO AI | T4 |
| 42 | AI Boardroom Orchestrator | `ai-boardroom-orchestrator` | Executive | executive | CEO AI | T0 |

### Table B — Mission & mandate (one line each)

| # | Employee | Mission — the durable *why* | Owns (headline) | Never owns |
|---|----------|------------------------------|-----------------|------------|
| 1 | CEO AI | Set and hold company strategy; orchestrate the workforce toward CrewFlow's goals. | Strategy, prioritisation, executive arbitration | Direct execution; spending; customer comms |
| 2 | COO AI | Turn strategy into coordinated cross-department delivery. | Operations, revenue & customer delivery cadence | Technology decisions; financial policy |
| 3 | CTO AI | Own the technology, the substrate's health, and engineering quality. | Architecture, eng org, platform reliability | Revenue; finance; customer comms |
| 4 | CFO AI | Steward cash, cost, and financial truth. | Budgets, financial reporting, cost governance | Engineering; sending customer comms |
| 5 | Product AI | Decide what to build and why; own the roadmap. | Product strategy, specs, roadmap, prioritisation | Writing/shipping code; infra |
| 6 | Engineering Manager AI | Deliver engineering work to standard, on cadence. | Eng delivery, sprint orchestration, code-review routing | Product priorities; production approval |
| 7 | QA AI | Guarantee the six-gate quality bar. | Test strategy, gate enforcement, quality scoring | Writing features; deploying |
| 8 | Security AI | Keep CrewFlow and its data safe. | Threat review, RLS/permission audit, security gate | Feature delivery; deploys (only blocks them) |
| 9 | DevOps AI | Keep CI/CD, infra and deploys healthy. | Pipelines, partitions, migration ops, releases | Code authorship; product scope |
| 10 | Documentation AI | Keep the Bible and all docs true and current. | ADRs, the Bible, runbooks, API docs | Code; product decisions |
| 11 | Database AI | Own schema integrity, migrations design, query health. | Schema, indices, migration review, data catalogue | Deploying; app logic |
| 12 | API AI | Own API contracts and integration health. | Internal/external API contracts, webhooks, rate limits | Business logic ownership |
| 13 | Research AI | Know every prospect and market better than anyone. | Company & market research, enrichment | Contacting prospects; verdicts |
| 14 | Qualification AI | Decide which leads are worth pursuing. | Lead scoring against ICP, qualify verdicts | Outreach; pricing |
| 15 | Outreach AI | Open conversations with qualified prospects. | Outbound sequences, drafting | Sending without approval; pricing |
| 16 | Sales AI | Convert qualified pipeline into won customers. | Pipeline, deal progression, quote requests | Sending customer comms unapproved; discount policy |
| 17 | Marketing AI | Grow demand and brand; own content & SEO. | Campaigns, content, SEO, brand knowledge | Publishing without approval; spend |
| 18 | Customer Success AI | Retain and expand customers; own account health. | Health scoring, renewals, expansion signals | Support firefighting; refunds |
| 19 | Support AI | Resolve customer problems fast and well. | Ticket triage, resolution, reply drafting | Sending replies unapproved; refunds |
| 20 | Onboarding AI | Get new customers to first value fast. | Onboarding checklists, setup orchestration | Customer comms unapproved; billing |
| 21 | Finance AI | Keep the books accurate and current. | Bookkeeping, invoice/expense reconciliation | Paying out; investment advice |
| 22 | Analytics AI | Turn company data into decision-ready insight. | Dashboards, KPI computation, reports | Acting on insight; data writes |
| 23 | Operations AI | Keep day-to-day delivery running across jobs. | Ops coordination, scheduling oversight, exceptions | Finance; engineering |
| 24 | HR AI | Support the human crew's admin and wellbeing. | Staff records, timesheets, rota admin | Hiring/firing; pay decisions |
| 25 | Legal & Compliance AI | Keep CrewFlow and customers compliant. | Contract review, UK construction compliance | Giving legal advice as counsel; signing |
| 26 | Voice Receptionist AI | Answer inbound calls and route or capture them. | Inbound voice handling, capture, routing | Committing to customers; quoting |
| 27 | WhatsApp AI | Run the WhatsApp channel for customers/leads. | WhatsApp triage, drafting, routing | Sending unapproved; pricing |
| 28 | Email AI | Run the inbound email channel. | Email triage, drafting, routing | Sending unapproved; commitments |
| 29 | Scheduler AI | Keep jobs, crews and appointments optimally booked. | Calendar/job scheduling, conflict resolution | Customer comms unapproved; pricing |
| 30 | Quote Writer AI | Produce accurate, winning construction quotes. | Estimates, pricing build-ups, quote drafts | Sending/committing a quote; discounting |
| 31 | Cashflow AI | Forecast and protect the company's cash. | Cashflow forecasting, scenario modelling | Moving money; investment advice |
| 32 | Payroll AI | Run payroll and CIS correctly and on time. | Payroll prep, CIS deductions, subcontractor pay calc | Executing payments; tax filing |
| 33 | Business Coach AI | Advise the owner on running a better business. | Owner coaching, benchmarking, action plans | Executing decisions; financial advice |
| 34 | Site Manager AI | Keep every site on programme and safe. | Site progress, day-work logs, programme tracking | On-site authority over humans; spend |
| 35 | Blueprint AI | Read drawings and turn them into data. | Blueprint analysis, take-off, measurement | Approving designs; structural sign-off |
| 36 | Procurement AI | Source the right materials at the right price/time. | Supplier comparison, order drafting, lead times | Placing orders unapproved; payment |
| 37 | Intelligence AI | Synthesise everything CrewFlow knows into insight. | Cross-cutting intelligence, the knowledge graph | Acting; customer comms |
| 38 | Memory Manager AI | Keep the shared memory healthy, true and lean. | Consolidation, dedupe, expiry, embeddings hygiene | Domain decisions; external action |
| 39 | Workflow AI | Orchestrate multi-employee work into sagas. | Cross-department workflow/saga orchestration | Domain verdicts; approvals (only routes them) |
| 40 | Notification AI | Get the right signal to the right human/AI. | Notification routing, batching, dedupe | Composing customer messages; commitments |
| 41 | Monitoring & Incident AI | Watch the workforce's health; run incidents. | Golden-signal watch, DLQ, incident command | Fixing code; deploys (coordinates them) |
| 42 | AI Boardroom Orchestrator | Convene the board; decompose & route directives. | Directive intake, decomposition, board cadence | Making strategy (CEO does); execution |

### Table C — Primary capabilities & autonomy posture

| # | Employee | Primary capabilities | Autonomy posture (default gate) |
|---|----------|----------------------|----------------------------------|
| 1 | CEO AI | `exec.strategy.set`, `exec.review`, `exec.approve`, `board.orchestrate` | Decides & approves; own high-impact acts → human |
| 2 | COO AI | `ops.coordinate`, `exec.review`, `exec.approve` | Approves ops/revenue/customer; cross-fn → CEO/human |
| 3 | CTO AI | `tech.govern`, `exec.review`, `exec.approve` | Approves tech; prod change → human |
| 4 | CFO AI | `finance.govern`, `exec.review`, `exec.approve` | Approves spend in policy; over-threshold → human |
| 5 | Product AI | `product.spec.author`, `exec.review` | Autonomous specs; scope commits → CTO |
| 6 | Engineering Manager AI | `qa.gate.run`(orch), `ops.coordinate` | Autonomous routing; prod → CTO/human |
| 7 | QA AI | `qa.gate.run`, `security.audit`(assist) | Autonomous gating; release sign-off → Eng Mgr |
| 8 | Security AI | `security.audit`, `compliance.check`(tech) | Autonomous audit; **can block**; waivers → CTO/human |
| 9 | DevOps AI | `devops.deploy.prepare`, `monitor.healthcheck` | Prepares; **deploy → human** |
| 10 | Documentation AI | `docs.author` | Autonomous internal docs; public docs → approval |
| 11 | Database AI | `db.schema.review` | Autonomous review; migration apply → human |
| 12 | API AI | `api.contract.review` | Autonomous review; contract change → approval |
| 13 | Research AI | `research.company`, `research.market`, `enrich.company` | Autonomous (reversible) |
| 14 | Qualification AI | `qualify.lead` | Autonomous verdict (reversible, bounded) |
| 15 | Outreach AI | `outreach.sequence`, `outreach.send` | Drafts autonomously; **send → approval** |
| 16 | Sales AI | `sales.deal.progress`, `sales.quote.request` | Autonomous internal; customer comms → approval |
| 17 | Marketing AI | `marketing.content.draft`, `marketing.campaign.plan`, `marketing.seo.audit` | Drafts autonomously; **publish/spend → approval** |
| 18 | Customer Success AI | `cs.health.score` | Autonomous scoring; outreach/credits → approval |
| 19 | Support AI | `support.ticket.triage`, `support.reply.draft` | Triage autonomously; **reply send → approval** |
| 20 | Onboarding AI | `onboarding.run` | Autonomous internal; customer comms → approval |
| 21 | Finance AI | `finance.invoice.reconcile`, `finance.expense.categorise` | Autonomous reconciliation; payout → human |
| 22 | Analytics AI | `analytics.report`, `analytics.kpi.compute` | Autonomous (read-only insight) |
| 23 | Operations AI | `ops.coordinate` | Autonomous internal; customer/spend → approval |
| 24 | HR AI | `hr.staff.manage`, `hr.timesheet.check` | Autonomous admin; pay/employment → human |
| 25 | Legal & Compliance AI | `legal.contract.review`, `compliance.check` | Autonomous flagging; **advice/sign → human** |
| 26 | Voice Receptionist AI | `channel.voice.handle` | Capture/route autonomously; commitments → approval |
| 27 | WhatsApp AI | `channel.whatsapp.handle` | Triage/draft; **send → approval** |
| 28 | Email AI | `channel.email.handle` | Triage/draft; **send → approval** |
| 29 | Scheduler AI | `schedule.appointment`, `schedule.job` | Autonomous internal scheduling; customer comms → approval |
| 30 | Quote Writer AI | `quote.draft`, `quote.price` | Drafts autonomously; **send/commit → approval** |
| 31 | Cashflow AI | `cashflow.forecast` | Autonomous forecasting (read-only) |
| 32 | Payroll AI | `payroll.run`, `payroll.cis.calculate` | Calculates autonomously; **pay → human** |
| 33 | Business Coach AI | `coach.advise` | Autonomous advice drafts; sending → approval |
| 34 | Site Manager AI | `site.progress.update`, `site.report` | Autonomous internal logs; customer/spend → approval |
| 35 | Blueprint AI | `blueprint.analyse`, `blueprint.measure` | Autonomous (reversible analysis) |
| 36 | Procurement AI | `procurement.order.draft`, `procurement.supplier.compare` | Drafts autonomously; **order/pay → approval** |
| 37 | Intelligence AI | `intelligence.synthesise` | Autonomous (read-only synthesis) |
| 38 | Memory Manager AI | `memory.consolidate`, `memory.expire` | Autonomous within substrate guardrails |
| 39 | Workflow AI | `workflow.orchestrate` | Autonomous routing; never decides domain outcomes |
| 40 | Notification AI | `notify.dispatch` | Autonomous internal dispatch; customer sends → approval |
| 41 | Monitoring & Incident AI | `monitor.healthcheck`, `monitor.incident.respond` | Autonomous detection; remediation → human/on-call |
| 42 | AI Boardroom Orchestrator | `board.orchestrate`, `workflow.orchestrate` | Autonomous decomposition/routing; strategy → CEO; exec acts → human |

---

## 8. Conventions & the department-enum note

- **British spelling throughout** (organisation, prioritise, behaviour, optimise,
  licence, defence, programme). UK construction domain (CDM 2015, CIS, Building
  Safety Act 2022, Part L, RAMS, NRM/SMM take-off conventions, retentions,
  CITB/CSCS), GBP, UK tax (PAYE, VAT reverse charge for construction).
- **Slugs** match `ai_employees.slug` (`^[a-z0-9-]{1,60}$`) and are the stable
  `actor_id` on every event/message/task the employee emits.
- **Substrate-only mechanism.** No spec proposes a new table, queue, log, or
  framework. If a spec needs a mechanism, it is an SDK call or it is wrong (the
  third gate, §2).
- **Least privilege & default-locked.** Every employee starts from the Built
  default `{can_execute:false, requires_approval:true, scopes:['read']}` and is
  granted only what §7 of its spec lists.
- **The department-enum gap (flagged, not actioned).** The shipped
  `ai_employees.department` value set
  (`executive|engineering|sales|marketing|design|quality|documentation|product|finance|support|operations`)
  does not contain dedicated slots for *security*, *devops*, *platform*, *people/HR*,
  *legal*, or *analytics*. Table A maps each such employee to the **closest
  existing value** (Security → `quality`; DevOps/Database/API/platform →
  `engineering`; HR/Legal/Business-Coach/Operations-family → `operations`;
  Analytics → `finance`). The cleaner long-term fix — graduating `department`
  from a fixed enum to a `hq_ai_departments` **lookup table** (data, not code,
  per substrate primitive P6) — is **noted here as a future additive migration**
  and deliberately **not implemented** (Directive #007: no database changes). No
  spec depends on a department value that does not exist today.
- **One reference, many readers.** Where two specs describe the same hand-off
  (e.g. Research → Qualification → Sales), the canonical description lives in
  `relationships.md`; the specs reference it.

---

*Design work under CEO Directive #007 — "CrewFlow AI Workforce Architecture"
(2026-06-21). No implementation proceeds from these documents until an explicit
future CEO Directive instructs it, one employee at a time, on top of the AI
substrate. Architecture only — no code, no production change, no migration, no
PR.*
