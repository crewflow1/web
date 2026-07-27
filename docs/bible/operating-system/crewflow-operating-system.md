# CrewFlow Operating System

> **The capstone of the CrewFlow Bible — the definitive, end-to-end blueprint.**
> Constitutional design work under **CEO Directive #008 — "AI Workforce
> Architecture, Phase 2"** (2026-06-21). This single document synthesises the
> three architectural layers — the **AI Substrate** (Volumes IX–XIII), the **AI
> Workforce** (Layer 4, the 42 employees), and the **Operating Model** (Volumes
> XIV–XVIII) — into one description of *how the AI company thinks, communicates,
> learns, decides, improves, scales, serves customers, manages itself, and
> evolves over decades.*
>
> **This is architecture, not a build order.** Per the directive: *no code, no
> implementation, no production change, no PR, no prototype, no migration.*
> Nothing here is implemented until a future CEO Directive explicitly instructs
> it. This document **inherits and composes** the three layers; it re-implements
> none of them. Where a detail lives in a volume, this document **cites it by
> name and weaves it into the whole** — it never restates the mechanism.
>
> **Read order.** This is the document to read *first* for the whole picture, and
> *last* to see how the parts compose. For any single subject, it points you to
> the one volume that owns it.

---

## 0. What CrewFlow is

CrewFlow is the operating software for a UK construction business — and it is run
by an **AI company**: forty-two AI employees, organised into eight divisions
under five tiers of authority, that research and win customers, write quotes,
answer the phone, price materials, run payroll, close the books, ship the
platform, and serve the builder — continuously, on the clock, under human
command.

This document describes that company. Not the product it sells, but the
**organisation that runs it**: an organisation whose every worker is an AI
process, whose every decision is owned and auditable, whose memory learns, whose
measurement is a single source of truth, and whose structure can grow from
forty-two employees to four hundred without a rewrite. It is, as the directive
frames it, *the world's first truly AI-native company for the construction
industry* — and this is its blueprint.

The thesis is one sentence: **a substrate is a kernel, a workforce is a roster,
and a company is what emerges when that roster runs on that kernel — in time,
under authority, learning as it goes, measuring itself, and changing without
breaking.** The first two layers were designed in the volumes that precede this
one. This document is the third thing: the **company itself.**

---

## 1. The architecture in one view

CrewFlow is a **four-tier stack**, and every higher tier **inherits the tiers
below and re-implements none of them.** This is the prime law of the whole
Bible — *inherit, never re-implement* — and it is what keeps a company of this
ambition coherent.

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  THE OPERATING MODEL — Volumes XIV–XVIII   (how the roster runs as a company)│
   │  XIV TIME · XV AUTHORITY · XVI LEARNING · XVII MEASUREMENT · XVIII CHANGE   │
   │  composes the two layers below into a running company — adds NO mechanism  │
   └───────────────────────────────────┬────────────────────────────────────────┘
                                        │ configures (never re-implements)
   ┌───────────────────────────────────▼────────────────────────────────────────┐
   │  LAYER 4 — THE AI WORKFORCE   42 employees · 8 divisions · 5 tiers (T0–T4)  │
   │  each a 16-section spec; relationships.md = the org/comms/memory graphs     │
   └───────────────────────────────────┬────────────────────────────────────────┘
                                        │ runs on (configures, never re-implements)
   ┌───────────────────────────────────▼────────────────────────────────────────┐
   │  THE AI SUBSTRATE — Volumes IX–XIII   (the kernel every employee shares)    │
   │  IX Comms · X Memory · XI Event Bus · XII Task Engine · XIII AI SDK         │
   └───────────────────────────────────┬────────────────────────────────────────┘
                                        │ rests on
   ┌───────────────────────────────────▼────────────────────────────────────────┐
   │  Postgres (Supabase) · RLS:hq schema · the service-role doorman (P5)        │
   └──────────────────────────────────────────────────────────────────────────────┘
```

**The substrate (IX–XIII)** is the kernel: one communication protocol, one
memory architecture, one event bus, one task engine, one SDK. Every employee
inherits identity, memory, messaging, events, tasks, permissions, cost-metering
and audit from it — written once, reused by all.

**The workforce (Layer 4)** is the roster: forty-two employees, each a
16-section specification that *configures* the substrate (a prompt, a set of
capabilities, a tier, a manager) and *invents no machinery*. Their relationships
— who reports to whom, who messages whom, who owns which slice of memory — are
the graphs in `relationships.md`.

**The operating model (XIV–XVIII)** is the company: the clock the roster runs
on, the constitution it decides under, the memory it learns through, the
scoreboard it measures itself by, and the genome by which it evolves. It adds no
new mechanism — it is the *composition* of the two layers below into a company
that operates from midnight to midnight and scales for a decade.

### The two sets of primitives

The whole company rests on two short lists. The first is the substrate's seven
**platform primitives (P1–P7)** — the laws of the kernel:

| | Primitive | What it guarantees |
|---|-----------|--------------------|
| **P1** | The canonical event envelope | `hq_events` is the **append-only system of record** — one log, no `UPDATE`/`DELETE`, the single truth |
| **P2** | The correlation model | every saga is one trace: `correlation_id` / `causation_id` stitch cause to effect across the whole company |
| **P3** | The standard AI output envelope | every AI claim carries `summary`, `reasoning`, `confidence`, `evidence[]`, `alternatives` — thought is structured and auditable |
| **P4** | The autonomy test | the **one rule** that decides *act vs. ask* for any proposed action (reversible ∧ bounded ∧ typed ∧ in-scope ∧ in-budget) |
| **P5** | The service-role doorman | the AI holds **no keys**; it makes audited requests through validated entry points — "AI never bypasses security" is *true*, not aspirational |
| **P6** | Naming, RLS & migration conventions | every structural change is **additive, idempotent, versioned** — never a breaking rewrite |
| **P7** | The reuse ledger | what already exists is reused, not rebuilt — the discipline that keeps one architecture, one source of truth |

The second is the operating model's six **operating primitives (O1–O6)** — the
laws of the company, defined once in `./README.md` (the keystone) and only
*referenced* by the volumes:

| | Primitive | What it guarantees |
|---|-----------|--------------------|
| **O1** | The operating clock | every cadence is a scheduled Task — minute to year — **nothing polls** |
| **O2** | One decision, one owner | every decision has exactly one accountable owner; no decision is ownerless or by committee |
| **O3** | The learning loop | experience → reflection → lesson → consolidation → canon → recall → improved action, flowing one way, never evaporating |
| **O4** | Measurement is projection | every metric is a **read-projection of `hq_events`** — never a parallel, drift-prone counter |
| **O5** | Change is data or additive migration | everything that varies as the company evolves is a row or an additive versioned migration — never a breaking rewrite |
| **O6** | Human supremacy & one audit spine | a human can always inspect, pause, override or reverse any AI decision; everything is an event on the one log |

Everything that follows — the nine questions the directive poses — is these
thirteen laws, composed. When you read "how it decides," you are reading P4 + O2
made into a constitution. When you read "how it measures," you are reading P1 +
O4 made into a scoreboard. The company is not a pile of features; it is a small
set of laws, applied uniformly.

### The one non-negotiable: human supremacy

Above every tier, every primitive, and every AI authority sits the **human
board.** O6 is absolute: the board is the apex of every escalation ladder, the
only body that can halt the entire company, and the only body that can amend the
constitution itself. **The CEO AI orchestrates; the board governs.** No chain of
AI authority is ever closed — every one terminates at a human. This single fact
is what makes an autonomous AI company *safe to run*, and it is wired into every
section below.

### Where every subject lives — the map of the Bible

This document is the index of indexes. For the authoritative detail on any
subject, go to the volume that owns it:

| Subject | Owned by |
|---------|----------|
| How employees message, hand off, coordinate | **IX — Communication Protocol** + `relationships.md` |
| How the company remembers and retrieves | **X — Shared Memory Architecture** + Memory Manager (#38) |
| The single event log / system of record | **XI — Event Bus** (`hq_events`) |
| How work is scheduled, claimed, approved, verified | **XII — Task Engine** |
| The kernel every employee runs on | **XIII — AI SDK** |
| The 42 employees, divisions, tiers, capabilities | **Layer 4 — Workforce** (`workforce/`) |
| The operating clock & lifecycles (TIME) | **XIV — Company Operations** |
| The constitution & authority (AUTHORITY) | **XV — Decision Framework** |
| The organisational learning loop (LEARNING) | **XVI — Company Memory** |
| The KPI tree & dashboards (MEASUREMENT) | **XVII — Company Intelligence** |
| Growth, retirement, versioning (CHANGE) | **XVIII — Company Evolution** |

---

## 2. How the company thinks

A company "thinks" when its people reason from evidence, commit to judgements,
and can say *why*. CrewFlow thinks at two scales — the employee and the whole
organisation — and both are auditable by construction.

**At the scale of one employee**, thinking is the **SDK run-loop** (Task Engine):
*claim a ready task → assemble context from memory (X) → reason → propose actions
→ checkpoint → verify → complete*, heart-beating throughout. An AI employee *is*
that loop. The employee's author writes only the handler; everything around it —
the context assembly, the reasoning surface, the proposal gate — is inherited
from the one SDK. This is why a new employee is cheap (§7): it does not bring its
own brain, it configures the shared one.

**Every thought is structured and grounded.** Each output an employee produces
carries the **P3 envelope**: a `summary`, the `reasoning` that led to it, a
calibrated `confidence`, the `evidence[]` it rests on, and the `alternatives` it
weighed. CrewFlow does not deal in bare assertions — a qualification verdict, a
cashflow forecast, a security finding all arrive *with their reasoning and their
confidence attached.* A claim the company cannot ground is, by its own
constitution, a failure: Intelligence (#37) calls an ungrounded forecast "a
hallucinated connection," and the remedy is always the same — lower the
confidence, label it partial, show the thin evidence. **The company would rather
be honestly uncertain than confidently wrong.**

**Thought is grounded in memory, not improvised.** Before an employee reasons, the
retrieval pipeline (X) serves the relevant institutional knowledge into its
working context — the company's lessons, playbooks, account history and
construction-domain canon. So an employee does not think alone from a blank page;
it thinks *with the company's accumulated experience in front of it* (the
learning loop closes here — §4). The recalled knowledge's identifier becomes part
of the new output's `evidence[]`, so every conclusion is traceable to what
informed it.

**At the scale of the company**, thinking is **collective and orchestrated.** A
question too large for one employee is decomposed by the **Boardroom Orchestrator
(#42)** — the CEO AI's operational arm — which convenes the executives, shapes
the problem, and asks **Workflow (#39)** to compose a cross-department task graph.
The executives (COO #2, CTO #3, CFO #4) arbitrate within their functions; the CEO
AI sets the frame; the human board holds the apex. Crucially, **the company never
thinks by committee vote** — every decomposed unit lands at exactly one owner (O2)
who reasons and commits, and the orchestrator routes rather than decides.

The deepest property of the company's thinking is that **it is reconstructable.**
Because every reasoning step is an event on the one spine (P1) under one
correlation (P2), the question *"why did the company conclude this?"* is always
answerable: `WHERE correlation_id = X ORDER BY id` replays the exact chain of
evidence, reasoning, confidence and decision that produced any outcome. A company
that can always show its work is a company you can trust to run itself.

---

## 3. How the company communicates

CrewFlow communicates in two registers — **structured messages** between
employees, and **events** as the ambient nervous system — and it speaks to humans
through exactly one disciplined gateway.

**Internally, employees exchange typed envelopes** (the Communication Protocol,
IX): a `request` that expects a reply, an `inform` that broadcasts a fact, a
`propose` that invites a decision, and their kin — each a structured message with
a sender, a recipient, a deadline where one applies, and the P3 reasoning that
justifies it. Who may message whom is not ad-hoc: it is the **communication graph
in `relationships.md`**, with standing channels up each management line and across
each value stream. No employee messages all forty-one others; coordination is
**the org graph in motion**, not a group chat.

**Events are the company's second, ambient register.** Every meaningful thing that
happens is a `domain.thing.happened` fact on the **Event Bus** (XI) —
`lead.qualified`, `quote.approved`, `incident.opened`, `payroll.calculated`. An
employee stays in sync with the rest of the company not by asking but by
**subscribing to the verbs it cares about.** This is why the company has no
pollers (O1/C3): a division learns that a deal advanced because it *consumes*
`deal.progressed`, not because it loops asking "anything new?" The morning brief,
the end-of-day rollup, the cross-division hand-off — all are reads of the event
stream, assembled on the clock.

**Coordination across the eight divisions** is therefore a rhythm, not a meeting.
A "stand-up" is the morning briefing (Boardroom #42 assembling the overnight event
window) and the end-of-day division rollups; a cross-division hand-off is a saga
that travels as capability-routed tasks and domain events under one
`correlation_id`. **COO (#2) conducts the tempo** — steering capacity at the
midday checkpoint, resolving contention a single director cannot — without
re-deciding what each division owns. (The cadences of all this are owned by the
TIME axis, Volume XIV.)

**To humans, the company speaks through one door.** All human-facing output — a
notification, an approval request, an alert — egresses through **Notification
(#40)**, the single human gateway, which owns channel choice, batching, dedupe
and **quiet hours.** This matters for a construction customer: an outbound that
would reach a builder at an unsociable hour is *held* and released when the window
opens. The substrate keeps running at all hours (the night shift is platform
work), but the **human-facing edge is throttled to civilised times** by #40. One
gateway means one place to govern tone, timing and volume — and one place a human
can audit everything the company ever said.

Every message and every event is, again, **on the record** (P1/O6): the company's
entire communication history — internal and external — is reconstructable by
correlation. CrewFlow never says anything it cannot later show it said.

---

## 4. How the company learns

CrewFlow's memory is not a filing cabinet; it is **cognition that improves.** The
LEARNING axis (Volume XVI) runs one loop, forever, on top of the Shared Memory
engine (X) and the Memory Manager (#38) — and it is what turns a roster of capable
employees into a company that gets measurably better at being itself.

**The loop (O3):** *experience → reflection → lesson → consolidation → canon →
recall → improved action* — and back to experience. An employee does something
and observes the result (episodic experience, sourced from `hq_events`). On a
reflection cadence it asks *"what does this mean for next time?"* and names a
pattern. A pattern that clears a salience bar becomes a **lesson**; a lesson that
proves out is **consolidated into durable canon**; canon is **recalled at the
point of need** by the retrieval pipeline; and the recall makes the next decision
better — which is the next experience. Knowledge flows one way and **never
evaporates.** The headline health metric of the whole company is therefore
**lesson-reuse rate**: a lesson nobody recalls is mere storage; learning only
counts when canon reaches the point of need.

**Mistakes become permanent guardrails, never blame.** When something fails — a
reversed decision, a missed SLA, an incident — a **blameless post-mortem** records
*what happened, why, and what we change*, grounded in the incident timeline (XIV)
and the decision record (XV). Its output is not a report filed away but **two
permanent memories**: a "do-not-repeat" lesson, and a **procedural update** so the
next employee facing the same situation *recalls the guardrail at the point of
need* and does not repeat it. A lesson that does not change a procedure is one
that will be re-learned the hard way.

**One employee's discovery becomes everyone's capability.** A private method that
proves out is **promoted into a shared memory zone** (`relationships.md` §7) — and
because each zone has **one writer and many readers by reference**, the instant the
owner updates the canon, every relevant employee sees the new version. One write,
company-wide effect. A sales objection one employee handled brilliantly today
becomes the *company's* objection-handling playbook in six months — recalled by
every revenue employee, long after the originating employee version has been
retired.

**The workforce ratchets its own autonomy on proven reliability.** Every output's
P3 `confidence` is compared against the realised outcome — did the 0.9-confidence
call actually succeed nine times in ten? That **calibration** is itself a lesson,
and proven calibration is the evidence that lets the decision framework (XV)
**raise an employee's autonomy threshold** — letting it *act* where it once had to
*ask*. It is a ratchet, not a free dial: a calibration regression tightens it
again. **Improvement literally widens what the company is trusted to do alone.**

**And nothing the company learns is ever lost.** Canon is permanent because of the
substrate's **no-hard-delete** rule (X): knowledge is archived and versioned,
never destroyed. Institutional knowledge therefore **outlives any single employee
version, any directive, any model upgrade** — when an employee is retired its
durable lessons have already been consolidated into a zone that survives it (§9).
The one narrow exception — GDPR erasure of specific customer-derived memory — is
human-gated, routed through Legal & Compliance (#25), and fully audited. The
company brain is the one asset that compounds for the life of the company.

Every promotion of private experience into shared canon is **gated by the decision
framework (XV)** — the company brain cannot be silently rewritten, not even by the
employee that tidies it. Learning is owned, approved, and on the record like
everything else.

---

## 5. How the company decides

Every decision in CrewFlow lands at **exactly one accountable owner** (O2), and
the chain of ownership **always terminates at a human** (O6). The AUTHORITY axis
(Volume XV) is the company's **constitution** — the single, canonical settlement
of *who may decide what, how far, and exactly when a human must be in the loop.*

It is built from one atom. The substrate's **autonomy test (P4)** decides, for any
single proposed action, whether it is safe to take alone: *reversible ∧ bounded ∧
type-checked ∧ in-capability-scope ∧ in-budget.* The constitution organises the
outcomes of that atom into a graded ladder and a single matrix:

- **The autonomy ladder A0–A4.** *A0* fully autonomous (P4 passes outright); *A1*
  autonomous with notice; *A2* peer/manager approval; *A3* executive approval; *A4*
  a human is required, always. The cheap, reversible, internal majority of company
  work is **A0** — which is exactly why a lead-qualification verdict ships without
  a human. The irreversible, external, money-, customer-, production-, legal- and
  roster-touching minority is **A4** — a human, by construction, because P4 fails
  and no AI authority may clear it.
- **The decision hierarchy L0–L5.** From the substrate-autonomous floor (L0),
  through specialist (L1), director (L2), executive (L3) and CEO AI (L4), to the
  **human board (L5)** — the apex of every ladder. A decision enters at its owner's
  level and **rises only when it exceeds that owner's authority** — never sideways,
  never downward from observed content.
- **The one approval matrix.** A single table the whole company shares: for each
  act-class (internal work, customer comms, spend, production change, contract,
  hiring, memory-canon promotion) at each value/risk band, *who* must approve.
  Reading any cell answers the only question the constitution exists to answer:
  *whose decision is this?*

**The limits make authority concrete**, and they are grounded in the company's
real domain:

- **Financial** — *AI may know the number to the penny; only a human may move the
  money.* Every money-writer (Finance #21, Quote Writer #30, Cashflow #31, Payroll
  #32) computes, drafts and reconciles; a human *enacts* — banded by tier, gated by
  the CFO (#4), terminating at the board. CIS deductions, VAT reverse-charge, and
  retention releases are computed by AI and **submitted by a human.**
- **Customer-impact** — *the company may think about a customer freely and act
  toward one only with a human's word.* Every non-templated outbound message is A4
  (§6).
- **Security** — Security (#8) is the **one authority that may block its own
  company**, and a block stands until a *human* waives it. Nothing reaches
  production without a human (the doorman, P5).
- **Legal** — AI flags, reviews, and checks compliance against the UK construction
  regs (CDM 2015, the Building Safety Act, CIS status); a `compliance.flagged`
  event **blocks** the dependent work; a human signs, advises as counsel, and
  commits to a regulator.
- **Ethical** — five **absolute prohibitions** no authority can grant, not even an
  A4 human approval within the system: no deceiving a customer, no fabricating a
  compliance or safety record, no discriminatory decision, no concealing an
  incident, no acting outside capability scope. An employee that finds its action
  implicating one of these does not escalate — it **refuses and halts.** A limit
  band asks *how far?*; an ethical prohibition answers *never.*

**Above all of it sits the emergency override** — the operational form of human
supremacy. A human may **pause one employee, halt a department, or halt the entire
company**, instantly, flowing *down* from a human to any level without passing
through the AI hierarchy. No AI can refuse, delay, or escalate around it. Stopping
is instant and unilateral; **restarting is considered and recorded** — a paused
employee never auto-resumes on a timer. The whole override is composed from
substrate states and **audited as events** — it builds no new machinery, and it is
absolute.

And every decision — autonomous, noticed, approved, refused, or overridden — is an
**event in the one log** carrying its owner, level, P4 outcome, approver, P3
reasoning and confidence. The company's entire decision history is a projection of
`hq_events` (O4): *"show me every decision in this saga, who made it, on what
evidence, and whether a human cleared it"* is one query. The constitution is
auditable by construction.

---

## 6. How the company serves customers

This is where the AI company meets the builder. Serving customers is a value
stream that opens with a stranger and, if all goes well, never closes — and **every
point at which it touches the customer is human-gated.**

**Winning the customer — the sales lifecycle** (XIV §9.2, measured by XVII §6).
The revenue funnel turns continuously through the operating day: **Research (#13)**
investigates a lead and emits `company.researched`; **Qualification (#14)** scores
it against the ideal-customer rubric and emits `lead.qualified` — *autonomously*,
the canonical instance of the company acting alone on reversible internal work;
**Outreach (#15)** drafts the approach, but **the send is A4 — a human approves it,
and Notification (#40) respects quiet hours**; **Sales (#16)** owns the deal as it
progresses; **Quote Writer (#30)** builds the quote — applying the **VAT domestic
reverse charge** and pricing against the cost book — and **a human signs it**
before it reaches the customer. Thinking about a customer is free; every commitment
*to* one is a human's.

**Answering the customer — the channels.** **Voice Receptionist (#26), WhatsApp
(#27), Email (#28)** and **Support (#19)** take inbound all day. They may read,
classify, route, draft a reply, and write an internal account note autonomously —
but **any outbound customer message that is not a narrow, pre-approved template is
A4** (the customer-send authority). A price, a date, a promise — these are
commitments, and the company makes none of them to a customer without a human's
word. The allow-list of safe templates ships *empty* and grows one ratified
template at a time.

**Keeping the customer — the customer lifecycle** (XIV §9.1, measured by XVII §8).
A won deal crosses into **Onboarding (#20)** (`onboarding.completed`), then
**Customer Success (#18)** owns the account's health for its life — surfacing
health-zone changes in the daily brief, catching an at-risk drop at the midday
checkpoint, steering the save on the weekly review. Support tickets are triaged and
resolved; satisfaction is surveyed; retention is read by cohort on the monthly
review.

**The construction reality runs underneath all of it.** **Scheduler (#29)** books
appointments; **Site Manager (#34)** and **Blueprint (#35)** process site progress
and take-offs; **Procurement (#36)** prices materials against supplier catalogues
and lead times; **Finance (#21)** reconciles as money lands. The company is not a
generic SaaS funnel bolted onto construction — its **memory carries the
domain** (CDM 2015, CIS, the Building Safety Act, NRM take-off, retentions, the
applications-for-payment cycle), its KPIs are the ones a builder lives or dies by
(job-margin erosion, retention held, the AfP cycle, the CIS/VAT positions), and its
calendar bends to the construction year's seasonality.

The promise to the customer is therefore precise: **a company that works on your
behalf around the clock, that knows your trade to the regulation, that never makes
a commitment in your name without a human approving it, and whose every word to you
is on the record.**

---

## 7. How the company scales

CrewFlow is designed to grow from forty-two employees to four hundred — and to
absorb a whole new vertical — **without a rewrite.** The argument (Volume XVIII §12)
has four legs, each a direct consequence of the architecture, not a hope.

1. **The roster is data, so every employee scales the same way (C1, O5).** Adding
   the 43rd, the 100th, the 420th employee is the *identical* operation: a roster
   `INSERT`, capability `INSERT`s, one handler, and the nine-stage hiring pipeline
   (§9). Because callers name **capabilities, never employees** (`qualify.lead`,
   not "employee #14"), the routing fabric does not change shape as the workforce
   grows. **Scale is a row count, not a re-architecture.**

2. **One substrate, so the marginal employee is cheap.** Every employee inherits
   identity, memory, comms, events, tasks, permissions, cost and audit from the
   *one* SDK. The substrate does not fork per employee; the 420th reuses exactly
   what the 1st did. The cost of a new employee is **its config and its handler** —
   so complexity grows *linearly with capability*, not combinatorially with
   headcount.

3. **Additive migrations, so the schema never seizes (P6).** Structural change is
   always additive-with-a-path: ten years of evolution accretes new tables,
   columns and lookup rows, and the live tables a runner depends on are **never
   mutated in place.** There is no "big migration" that stops the company. The
   canonical pattern — a fixed enum graduating to a data-driven lookup table,
   additively, with readers migrated on their own schedule — is how *every*
   structural change is done.

4. **Construction-specifics are configuration, so a new vertical reuses the OS.**
   The substrate and the operating model carry **no construction logic** — it all
   lives in data (capability rows, memory zones, lookup values, employee specs).
   So a different trade, a different jurisdiction, or a different industry entirely
   is **a new dataset on the same operating system**, not a new platform. The same
   fact makes CrewFlow multi-tenant (a tenant is an actor type and a visibility
   scope on the spine) and multi-domain (the domain *is* the data).

The failures that *would* arrive at scale — duplicated per-employee plumbing,
roster conflicts, schema-rewrite freezes, a breaking SDK upgrade taking down the
whole workforce, measurement fracturing into rival truths, knowledge lost to
turnover, directives accumulating into contradiction — are each **prevented by a
named law**: the inheritance contract, C1, P6, pinned-versions-and-rolling-upgrades,
O4, no-hard-delete, and directive sequencing (C8). The company scales cleanly
*because growth, retirement and re-versioning are all the same two operations —
write a row, or run an additive migration with a path — applied uniformly from the
first employee to the four-hundredth.*

---

## 8. How the company manages itself

CrewFlow runs itself on a **clock** and steers itself by a **scoreboard**, with
humans at the apex of both. This is the TIME axis (XIV) and the MEASUREMENT axis
(XVII), composed into a company that operates from midnight to midnight and knows,
at every moment, how it is doing.

### The operating day, midnight to midnight

The company runs on a **nested hierarchy of cadences** — minute, hour, day, week,
month, quarter, year — each a scheduled Task on the single tick (O1), never a
poller (C3). One operating day:

```
 00:00 ─────────────────────────────────────────────────────────────────────── 00:00
   │ overnight housekeeping │ morning briefing │ continuous work loop │ EOD review │
   ▼ (night shift)          ▼ ~07:00           ▼ ~08:00 → ~17:00      ▼ ~17:30     ▼
 Memory Manager (#38)     Boardroom (#42)    employees claim &      division     back to
 consolidates;           assembles the      run tasks event-by-    rollups;     the night
 Analytics (#22)         brief from the     event; the funnel,     Analytics    shift
 snapshots KPIs          overnight events   channels, ops, finance snapshots
                                            all turn                KPIs
```

- **00:00 — the night shift.** No customer-facing work runs. The day boundary
  becomes a fact on the spine; **Memory Manager (#38) consolidates** the day's
  experience toward canon; **Analytics (#22) snapshots the day's KPIs** as a
  projection of `hq_events` (O4); the substrate grooms itself (partitions,
  reapers, sweeps).
- **~07:00 — the morning briefing.** The company wakes: **Boardroom Orchestrator
  (#42)** assembles the executive brief from the overnight event window — incidents
  and their stand-down state, the close-of-day KPIs, the open deals and at-risk
  accounts, the cash position, and any approvals that ripened overnight needing a
  human. Each division head gets its slice. The brief is **assembled, not decided**:
  it surfaces what needs a decision and routes it to the owner.
- **~08:00 → ~17:00 — the continuous work loop.** The building at work. Employees
  claim ready tasks and run their loops; the revenue funnel turns; the channels
  answer; operations books and prices; finance reconciles. The loop is
  **event-driven, not clock-driven** — a completed task emits a fact that unblocks
  the next; the clock only *seeds* recurring work and *marks* the day.
  Backpressure (concurrency caps, priority-with-ageing, lane-ordered drain) keeps
  any one stream from starving the rest, and **Notification (#40) throttles the
  human edge to civilised hours.**
- **~12:30 — the midday checkpoint.** COO (#2) takes the company's temperature — are
  SLAs holding, is any queue backing up, is any lifecycle stalled past its expected
  dwell-time? — and *reallocates* capacity rather than calling a meeting.
- **~17:30 — the end-of-day review.** Each division rolls up what completed,
  carried over, and escalated; the executives consolidate; Analytics snapshots the
  day's final numbers; **carry-over is explicit** — unfinished work stays in the
  queue and ages to the front of tomorrow. Nothing falls through the day boundary
  silently.

**The planning ladder** nests the cadences into one structure read *down* for
direction and *up* for evidence: the end-of-day rollup builds the weekly plan, ~4
weeks build the month, 3 months build the quarter, 4 quarters build the year. The
**human board owns the year** and sits at the apex of the quarter; the CEO AI and
Boardroom own the quarter; the COO/CFO own the month; directors own the day. Every
executive meeting is **data, not air** — its agenda and minutes are envelopes, its
convening an event, and any decision taken in it is owned and gated exactly as any
other (a meeting confers no special authority).

**When something breaks**, the company runs an incident with a tempo: **Monitoring
& Incident (#41)** detects on the minute/hour pulse; `incident.opened` pages
**DevOps (#9)** and the on-call human at once, *bypassing quiet hours*; the
operating clock **yields** — routine cadences defer to the incident — while
remediation runs (production change stays human/Security-gated even under
incident); `incident.resolved` stands the company down; and a **next-day blameless
post-mortem** feeds the lesson (§4). Detection thresholds and MTTR are measured by
XVII; the override authority is XV's; the lesson is XVI's; the *rhythm* is XIV's.

### The scoreboard — how the company sees itself

A company that cannot see itself cannot be run. CrewFlow turns its event stream
into **executive sight**, and the discipline is absolute: **every metric is a
read-projection of `hq_events`** (O4) — a named query, not a maintained counter.
There is no second source of truth, so a number can never *drift* from reality; if
a figure looks wrong, the events are wrong (a producer bug), and fixing them fixes
every view.

The measurement is **one KPI tree**: six **Tier-0 north stars** the board watches —
*ARR, gross margin, cash runway, NRR, CAC:LTV, and AI Autonomy Rate* — rolling up
from division KPIs, rolling up from the per-employee KPIs each spec already
defines. Beneath the north stars sit the families: **operational** (cadence
adherence, throughput, MTTR), **sales** (funnel conversion, win rate, sales cycle),
**engineering** (DORA-style: six-gate pass rate, deploy frequency, change-fail
rate), **customer** (health, churn, NRR, ticket resolution), **financial** (ground
in construction reality: DSO, retention held, the AfP cycle, CIS/VAT, job-margin
erosion), and the family no conventional company has —

**AI-performance KPIs: every AI employee is held accountable like staff.** Accuracy,
confidence calibration, approval rate, autonomy rate, escalation rate,
cost-per-outcome, ROI, quality score, uptime — *"are you accurate, calibrated,
trusted, autonomous, worth your cost, and well-regarded by those you serve?"* —
each a projection of `WHERE actor_id = <slug>`. **AI Autonomy Rate** is a north
star: the single number answering *"how much of the company runs without a human in
the loop?"* — the measure of the AI-native thesis itself, which rises only as
employees *earn* it and is bounded by the constitution (XV).

The company sees this through **four executive dashboards** (CEO/COO/CTO/CFO
cockpits, each a standing query set), through **trends** (including the
construction year's seasonality, so a February dip reads as seasonal not alarming),
through **predictions** (cashflow, churn-risk, pipeline, demand — every one
labelled a forecast with its P3 confidence, *never sold as fact*), and through
**board reports** assembled on the planning cadence (weekly to annual), every
figure carrying its `evidence[]` so the board can always ask *"where did this number
come from?"* and get a query. Sight follows accountability: **no dashboard exposes a
number its owner has no authority to act on.**

The cortex watches itself, too: a stale dashboard is a missed cadence; a silent
producer is a high-severity blind spot ("all green on missing data" is forbidden);
a dead Analytics or a blind Monitoring is the loudest alarm in the company — because
a company that cannot see itself is operating blind.

---

## 9. How the company evolves over decades

A company that cannot change cannot survive; a company that changes carelessly
cannot be trusted. CrewFlow's CHANGE axis (Volume XVIII) is the **genome and the
developmental plan** — how the organism changes shape over a decade-plus *without
ever stopping its heart.*

**The principle (O5):** *every change to CrewFlow is one of exactly two things —
data, or a versioned, additive, idempotent migration with a path. There is no
third, breaking kind.* A new employee is rows. A new cadence, KPI, decision-limit,
event-verb or memory-zone is a row. A new structural capability is an additive
migration alongside the live shape a runner depends on, never an in-place mutation.
A repurposed employee is a **new version activated beside the old**, not an
overwrite. The company evolves the way a genome does — by additive expression and
versioned variants — so **no change in flight ever produces a half-broken company.**

- **Hiring** is a nine-stage governed pipeline: a directive authorises the role →
  Documentation (#10) writes the 16-section spec → capabilities are registered as
  rows (confidence seeded low, approval required) → the roster `INSERT` (a human-
  gated T0 act) → register & configure → a **shadow/probation** period where every
  high-impact act stays human-gated regardless of role → **calibration** against
  realised outcomes (the learning loop and the KPI tree supply the evidence) →
  **activation**, where a *human* raises the autonomy threshold (never a self-grant)
  → steady state. An employee earns its autonomy; it is not granted it on arrival.
- **Retirement** is the mirror: a fully reversible, fully audited decommission that
  leaves **no orphaned zone and no orphaned capability and loses no knowledge.** The
  employee stops claiming, its capabilities are *deprecated* (still resolvable, so
  callers re-route to peers), its owned memory zones are reassigned to named
  successors, its memory is **archived not deleted**, and a closing `employee.retired`
  event records the reason, the successor, and the last version that ran. Re-hiring
  is re-activating a version — a row update, not a rebuild.
- **Capabilities evolve** as versioned rows: confidence recalibrated from outcomes,
  scope widened or narrowed (each a gated decision), autonomy ratcheted one notch at
  a time on evidence, and old capabilities **deprecated additively** — never deleted
  out from under a caller.
- **The SDK evolves as a contract.** SemVer governs it: MINOR/PATCH never break a
  running employee; a MAJOR change preserves the old surface through a published
  **deprecation window** and rolls out as a new version *live alongside the old*,
  with employees migrating one at a time on their own schedule. **There is never a
  flag-day** where all forty-two must upgrade at once.
- **The operating system and the Bible evolve under the same discipline they
  preach.** A new cadence, limit, KPI or learning-policy is data hung on the
  existing machinery. The six operating primitives O1–O6 are amended **only by CEO
  Directive, only additively or by supersession**, recorded in an Architecture
  Decision Record that captures the old text, the new text, the directive that
  authorised it, and the reasoning. The Bible is **append-corrected, never
  overwritten**: a superseded decision is marked and linked to its replacement, so
  the canon accumulates correction without losing its history.

**The directive→change pipeline** is the spine of the whole axis — and the proof
that this very document is part of the system it describes. A CEO Directive (like
#008) is minted as a **root-cause event** with a fresh `correlation_id` and
`actor_type=human`. The **Boardroom Orchestrator (#42)** intakes it, convenes the
executives, and **decomposes it** into a cross-department task graph by consuming
**Workflow (#39)** — fanning out into employee specs, capability rows, ADRs,
additive migrations and KPI/cadence/limit rows. Every unit **inherits the
directive's `correlation_id`**, so a decade of directives is a traceable, ordered
constitution: *"what did the board direct, how did it change the platform, and was
it delivered?"* is one query. Directives are **numbered and sequenced** (C8) — each
takes the next number, cites what it builds on, and **never silently contradicts** a
predecessor; supersession is explicit and ADR-recorded.

The result the directive asks for: **CrewFlow still scales cleanly ten years from
now because every change — a new hire, a retirement, a re-version, a new vertical,
even an amendment to its own constitution — is the same two operations, applied
uniformly, audited on the one spine, and reversible by a human.**

---

## 10. A day in the life — one lead, end to end

Architecture is only as real as the path that runs through it. Here is one customer
journey, traced through every layer and axis as a single saga under one
`correlation_id` — the proof that the laws compose.

```
 A regional builder's enquiry arrives ──────────────────────────────────────────────┐
 │                                                                                    │
 1. Research (#13) investigates the company.        A0 autonomous · emits company.researched
 2. Qualification (#14) scores it vs the ICP rubric. A0 autonomous · emits lead.qualified
        └─ grounded in the ICP zone (X recall); P3 reasoning + confidence attached
        └─ the canonical C2 instance: the company acts alone on reversible internal work
 3. Outreach (#15) drafts the approach.              draft A0 · SEND is A4 (human approves)
        └─ Notification (#40) holds the send to respect the builder's quiet hours
 4. The builder replies → Sales (#16) owns the deal. emits deal.progressed (stage→pursuit)
 5. Quote Writer (#30) builds the quote.             draft A0 · applies VAT reverse charge,
        └─ prices against the cost-book zone;        prices vs cost book; SIGN is A4 (human)
           commercial terms cross the CFO (#4) gate
 6. The human signs → quote sent.                    emits quote.approved · deal won
 7. Onboarding (#20) stands the account up.          emits onboarding.completed
 8. Customer Success (#18) owns health for its life. health zone updated; surfaced in the brief
 9. Channels (Voice #26 / WhatsApp #27 / Support #19) serve.  read/route A0 · every SEND A4
 10. Finance (#21) reconciles; Cashflow (#31) forecasts.      emits invoice.reconciled, etc.
 │                                                                                    │
 └──▶ throughout: Analytics (#22) projects the funnel KPIs from these very events (O4) ◀┘
      overnight: Memory Manager (#38) consolidates; a won-pattern reflected → a LESSON
      promoted (gated by XV) into the Sales playbook zone → recalled by every revenue
      employee next time (O3). The whole saga = WHERE correlation_id = X ORDER BY id (O6).
```

Count the laws that fired in one journey: **P1** (every step an event), **P2** (one
correlation across the whole saga), **P3** (reasoning + confidence on every AI
output), **P4** (the act-vs-ask test at each step), **P5** (no employee ever touched
a key — Finance computed, a human enacted), **O1** (the work rode the clock and the
event-driven loop, no poller), **O2** (each stage had exactly one owner), **O3** (the
outcome became a lesson and improved the next lead), **O4** (the funnel KPIs were
projections, not counters), **O6** (a human gated every commitment, and the whole
thing is reconstructable). Eight employees across four divisions cooperated without a
single meeting, made no commitment to the customer without a human's word, and left
the company *measurably smarter* than it started the day. **That is CrewFlow
operating.**

---

## 11. The invariants — the laws that never change

Strip everything else away and a handful of laws hold for the life of the company.
A future directive may add employees, cadences, KPIs and capabilities without limit;
it may not violate these without ceasing to be CrewFlow.

1. **Human supremacy is absolute (O6).** A human can always inspect, pause,
   override or reverse any AI decision; the board is the apex of every ladder and
   the only body that may halt the company or amend the constitution. The CEO AI
   orchestrates; the board governs.
2. **One source of truth (P1 / O4).** `hq_events` is the single append-only system
   of record. Every metric, dashboard, decision log and audit trail is a *projection*
   of it. There is never a second copy of the truth.
3. **One decision, one owner (O2).** Every decision is owned by exactly one
   accountable actor; no decision is ownerless or made by committee; every chain of
   ownership ends at a human.
4. **Inherit, never re-implement.** Every layer composes the layers below and adds
   only what is genuinely new. One substrate, one SDK, one set of graphs — reused by
   all, forked by none.
5. **Nothing polls (O1 / C3).** Every cadence is a scheduled Task; every reaction is
   an event subscription. There is one clock and one bus, not thirteen pollers.
6. **Change is data or an additive migration (O5 / P6).** The company grows,
   retires and re-versions by writing rows or running additive migrations — never a
   breaking rewrite. No flag-day; no half-broken company.
7. **Nothing is forgotten, nothing is hidden (no-hard-delete / O6).** Institutional
   knowledge is archived and versioned, never destroyed; every action, decision,
   lesson and change is on the record and reconstructable by correlation.
8. **AI knows; humans enact the irreversible.** AI may research, score, draft,
   forecast and compute to the penny, autonomously — but money moves, customers are
   committed to, production changes, contracts are signed, and employees are hired or
   retired **only by a human.** And five ethical prohibitions bind every tier with no
   override.

These eight are the constitution beneath the constitution. Everything in the eleven
volumes is an elaboration of them.

---

## 12. Why this is the definitive blueprint

The directive set out to design *"the world's first truly AI-native company for the
construction industry."* This document, and the eleven volumes beneath it, is that
design — complete enough to build from, and disciplined enough to build from
*safely.*

It is **definitive** because it is *closed*: every cross-cutting concept has exactly
one owning volume, every operating rule reduces to one of thirteen named laws, every
number is a projection of one log, and every chain of authority ends at one human.
There is no orphaned mechanism, no parallel truth, no ownerless decision, and no
change that is a rewrite. The adoption analysis catalogued the contradictions that
afflict a system grown without a constitution — conflicting rosters, parallel audit
logs, pollers fighting a scheduler, memory as a dead table, autonomy at war with
human control — and each is closed here by construction: **C1** (roster is data),
**C2** (autonomy constitutionalised), **C3** (nothing polls), **C5** (one source of
truth), **C6** (memory is the substrate the company learns through), **C8** (directives
sequenced).

It is a **blueprint for decades** because its growth, its learning, its measurement
and its evolution are all the *same shape*, applied uniformly from the first employee
to the four-hundredth and from the construction vertical to the next: a row, an
additive migration, a projection, an event. The company can therefore become far
larger and far more capable than it is today **without becoming a different kind of
thing** — and a human can always see exactly what it is doing, and stop it.

When implementation is authorised by a future CEO Directive, this is the document the
company is built to satisfy — and, once running, the document by which it is
**operated, audited, and trusted.** The architecture phase, with these volumes, is
substantially complete. What remains is to build, on a foundation that already knows
how the company must think, communicate, learn, decide, improve, scale, serve, manage
itself, and evolve.

---

*The capstone of the CrewFlow Bible — the Operating Model layer (Volumes XIV–XVIII),
synthesising the AI Substrate (IX–XIII) and the AI Workforce (Layer 4). Design work
under CEO Directive #008 (2026-06-21). Architecture only — no code, no production
change, no migration, no PR. This document composes the three layers; it
re-implements none of them. No implementation proceeds from it until an explicit
future CEO Directive instructs it.*
