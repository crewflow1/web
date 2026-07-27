# Volume XIV — Company Operations

> **Operating Model layer, document 1 of 5 (the TIME axis).** Architecture only,
> under **CEO Directive #008**. *No code, no implementation, no production change,
> no PR, no prototype, no migration.* This volume **inherits the AI Substrate
> (IX–XIII) and the AI Workforce (Layer 4); it composes them on the clock, and
> re-implements neither.** Every cadence here is a Task-Engine schedule (XII); every
> lifecycle is a Workforce saga (`relationships.md` §9) placed in time. **Read
> `./README.md` (the keystone) first** — this volume uses the operating primitives
> O1–O6 and the concept-ownership map, and does not redefine them.

---

## 1. Purpose & scope

**The job, in one sentence:** be the company's **clock** — the nested hierarchy of
cadences (minute → hour → day → week → month → quarter → year) and the
long-running lifecycles that hang off them, so that forty-two AI employees act
*at the right time, in the right order, every day, out to the fiscal year.*

The other four axes answer *who decides* (XV), *how it learns* (XVI), *how it
sees itself* (XVII) and *how it evolves* (XVIII). This one answers the question
the directive frames bluntly:

> **How does an AI company operate from midnight to midnight?**

A substrate is a kernel; a workforce is a roster. A *company* is what emerges when
that roster runs on that kernel **in time** — when research happens before
qualification, when the books close on the last day of the month, when an incident
mobilises in minutes and a strategy refreshes once a year. That temporal spine is
what this volume owns, end to end. It realises operating primitive **O1 (the
operating clock)** and is the standing resolution of conflict **C3** ("nothing
polls"): *every* periodic behaviour in the company is a scheduled Task, never a
poller.

**In scope:** the operating clock (the cadence hierarchy); the daily cycle
midnight→midnight; the continuous work loop; department coordination rhythms;
executive-meeting cadences; the five business lifecycles (customer, sales,
development, marketing, financial) placed on the clock; the incident-response
*rhythm*; the planning ladder (end-of-day → weekly → monthly → quarterly →
annual).

**Out of scope (owned by a sibling axis — cited, never restated):** *who may
decide* and the emergency override (the decision framework, **Volume XV**); *what*
a lesson is and how it propagates (the learning loop, **Volume XVI**); the *content*
of every KPI, dashboard and board pack, including incident MTTR (the metric /
board report, **Volume XVII**); *how* a cadence, employee or version is added or
retired (the change process, **Volume XVIII**). And — critically — the *mechanism*
of scheduling itself: that is the **Task Engine (Volume XII)**. This volume
specifies *which* cadences exist, *who* runs them, and *what* they produce. It
designs no scheduler.

---

## 2. Where it sits

```
        ┌──────────────────────────────────────────────────────────────────┐
        │  THE OPERATING MODEL  —  XIV runs the clock the others hang off    │
        │   XIV TIME ─┬─▶ XV   decides (authority on every gated act)        │
        │             ├─▶ XVI  learns  (consolidation rides the night cadence)│
        │             ├─▶ XVII sees    (KPI snapshots ride the day/period cadence)│
        │             └─▶ XVIII evolves(version reviews ride the quarter cadence)│
        └───────────────────────────────┬──────────────────────────────────┘
                                         │ composes (adds no mechanism)
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  LAYER 4 — THE AI WORKFORCE  (../workforce/)                       │
        │  the §9 sagas ARE the lifecycles; the org graph IS the coordination│
        │  orchestrated by COO #2 (conductor) + Boardroom Orchestrator #42   │
        └───────────────────────────────┬──────────────────────────────────┘
                                         │ inherits (configures, never re-implements)
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  THE AI SUBSTRATE — Volumes IX–XIII                                │
        │  every cadence = an hq_ai_schedules row + the tick (XII)           │
        │  every saga step = a task (XII), a fact = an event (XI, P1)        │
        └───────────────────────────────────────────────────────────────────┘
```

- **Drives:** the Task Engine's recurring-task surface — **`hq_ai_schedules`**
  (XII §4.4) and the **schedule tick** (`hq_ai_schedule_tick`, XII §5.3). Every
  cadence in §4 is a row in that table; nothing here invents a timer.
- **Orchestrated by:** **COO #2** as the operational conductor of the eight
  divisions (Workforce §2: the broadest executive, acting CRO), and the
  **Boardroom Orchestrator #42** as the CEO AI's operational arm that convenes,
  decomposes and routes (`relationships.md` §5.1, §9.3). The clock *fires*;
  #2 and #42 *coordinate* what fires.
- **Reads:** the Workforce sagas (`relationships.md` §9 — lead-to-cash,
  quote-to-job, directive decomposition, incident response, support, payroll/CIS).
  The lifecycles in §9 of *this* volume are those exact sagas placed on the clock.
- **Must NOT re-implement:** the scheduler (XII owns it); the org graphs
  (`relationships.md` owns them); decision rights (Volume XV); KPI definitions
  (Volume XVII); the lesson pipeline (Volume XVI). When a section here is tempted
  to define a timer, a permission, a metric or a learning rule, it stops and
  references instead — the keystone's prime law.

---

## 3. Built vs. to-build (the honest ledger)

This volume is **organisational design over an existing mechanism**. The honest
split:

| Capability | State | Where it lives |
|------------|-------|----------------|
| A durable recurring-task table (`hq_ai_schedules`: slug, cron, payload, next_run_at) | **To build** | XII §4.4 — defined, not yet implemented |
| The schedule tick that materialises due schedules into tasks, idempotently | **To build** | XII §5.3, `hq_ai_schedule_tick` |
| The task lifecycle every cadence's work runs through (claim, approve, verify, retry) | **To build** | XII §5 (the FSM); generalises the shipped sales queue |
| The event spine every cadence emits onto / reads from | **Built** | `hq_events`, the spine (XI) |
| The five lifecycles as cross-department sagas (org graph, owners, hand-offs, events) | **Designed** | `relationships.md` §9 — the graphs already exist |
| **Which** cadences exist (the minute→year hierarchy), each as a schedule row | **New here (design)** | §4 of this volume |
| **What each cadence produces** (the daily-cycle content, the briefing, the rollups) | **New here (design)** | §§5–11 of this volume |
| The *placement* of the §9 sagas on the clock (cadence touch-points per stage) | **New here (design)** | §9 of this volume |
| The incident *rhythm* (detect→mobilise→resolve→stand-down→review tempo) | **New here (design)** | §10 of this volume |

**Net:** the *scheduler, the task FSM and the event spine* are the substrate's job
(mostly to-build per XII, the spine already shipped). The *sagas* already exist as
graphs in `relationships.md`. What is **new in this volume** is purely
organisational: the catalogue of cadences, the midnight→midnight narrative, and the
mapping of each saga onto the clock. This volume adds **no new mechanism** — it is
the composition that turns a scheduler and a roster into a *running day.*

---

## 4. The operating clock — the nested cadence hierarchy

This is the heart, and the realisation of **O1**. The company runs on a **nested
hierarchy of cadences**, each a loop with a trigger, an owner, participants,
inputs, outputs and emitted events. **Every cadence is a recurring Task — a row in
`hq_ai_schedules` materialised by the tick (XII) — never a poller** (C3). The
faster cadences are the heartbeat; the slower ones are the circadian and seasonal
rhythm. Each nests inside the next: a day is composed of its hours, a quarter of
its months, the year of its quarters.

```
   minute ──┐
            ├─ hour ──┐
            │         ├─ DAY (00:00→00:00, the centrepiece §5) ──┐
            │         │                                          ├─ week ──┐
            │         │                                          │         ├─ month ──┐
            │         │                                          │         │          ├─ quarter ──┐
            │         │                                          │         │          │            ├─ YEAR
   heartbeat│  steady │   the operating day                      │ planning│  the     │  strategic │ the
            │  pulse  │                                          │ rhythm  │  books    │  zoom-out  │ horizon
```

Each row below is a cadence. `Owner` is the single accountable employee (operating
primitive **O2**, one owner per decision); `Emits` names the `domain.thing.happened`
verbs (XI) that mark the cadence, registered as data in `hq_event_verbs`. The
**clock cadences themselves** emit a small family of `clock.*` verbs (new, by the
`domain.thing.happened` convention) so that the passage of operating time is itself
a fact of record on the one audit spine (**O6**).

### 4.1 The minute cadence — the heartbeat

| | |
|---|---|
| **Trigger** | the schedule tick, ~every minute (`cron: * * * * *`) |
| **Owner** | the substrate platform (no business owner — it is the pulse) |
| **Participants** | the Task Engine tick; the event-bus drain (XI §6.3); the lease reaper and SLA sweep (XII §10.2, §8.4) |
| **Inputs** | due schedules; the event log tail; expired leases; breached deadlines |
| **Outputs** | newly-materialised tasks; drained projections; reclaimed crashed tasks; fired SLA escalations |
| **Emits** | `clock.minute.ticked` (low-severity, sampled — not one per minute to the timeline); the downstream `task.*` of whatever it materialised |

The minute is the **company's pulse**: it is the one tick that drives every
sweep, drain and reaper in the building — *one* scheduler, not thirteen pollers.
Nothing in the company "checks for work in a loop"; it all rides this single tick
(C3, settled in §15).

### 4.2 The hour cadence — the steady pulse

| | |
|---|---|
| **Trigger** | `cron: 0 * * * *` |
| **Owner** | COO #2 (operations) for the business pulse; CTO #3 for the platform pulse |
| **Participants** | the channel employees (Voice #26, WhatsApp #27, Email #28) flushing intake; Monitoring & Incident #41 sampling golden signals; Cashflow #31 refreshing the rolling position when activity warrants |
| **Inputs** | the last hour's events; channel backlogs; golden-signal samples |
| **Outputs** | hourly health sample; channel-backlog status; any threshold-breach escalation handed to the incident rhythm (§10) |
| **Emits** | `clock.hour.elapsed`; `intelligence.synthesised` when Intelligence #37 has an hourly pulse to publish |

The hour is the **operational pulse**: frequent enough that a building problem is
noticed within the hour, coarse enough not to drown the log.

### 4.3 The day cadence — the operating day

| | |
|---|---|
| **Trigger** | `cron: 0 0 * * *` (00:00, day rollover) plus the named intraday marks (briefing, midday, end-of-day) |
| **Owner** | COO #2 (conductor of the operating day); Boardroom Orchestrator #42 (assembles the morning brief) |
| **Participants** | **all eight divisions** — the day is when the company actually operates (full narrative in §5) |
| **Inputs** | the overnight event window; yesterday's unfinished tasks; today's scheduled work; the open lifecycles |
| **Outputs** | the morning briefing; the day's work; the end-of-day division rollups; the close-of-day KPI snapshot |
| **Emits** | `clock.day.opened`, `clock.day.closed`; `briefing.assembled`; the division `*.rolled_up` verbs at end-of-day |

The day is the **circadian cadence** and the centrepiece of this volume (§5).

### 4.4 The week cadence — the planning rhythm

| | |
|---|---|
| **Trigger** | `cron: 0 7 * * 1` (Monday morning planning); `cron: 0 16 * * 5` (Friday retrospective) |
| **Owner** | COO #2 (operational weekly); each T1 director for their division's week |
| **Participants** | the executive group (COO #2, CTO #3, CFO #4) and the director hubs (Sales #16, Customer Success #18, Finance #21, Operations #23) |
| **Inputs** | the week's event rollup; lifecycle dwell-times; the prior week's commitments |
| **Outputs** | the weekly plan (priorities, capacity allocation); the weekly retrospective |
| **Emits** | `clock.week.planned`, `clock.week.closed`; `board.convened` for the weekly board (§8) |

### 4.5 The month cadence — the books and the review

| | |
|---|---|
| **Trigger** | `cron: 0 6 1 * *` (month-open review); `cron: 0 18 L * *` (last-day close — `L` materialised by the tick to the true month-end) |
| **Owner** | CFO #4 (the financial month-close); COO #2 (the operational monthly review) |
| **Participants** | the Finance cluster (Finance #21, Cashflow #31, Payroll #32, Analytics #22, Quote Writer #30); every division head for the operational review |
| **Inputs** | the month's ledgers, invoices, expenses, payroll runs; the month's KPI series |
| **Outputs** | the monthly close (reconciled books, the CIS return window opens, RTI submitted — §9.5); the monthly business review |
| **Emits** | `clock.month.opened`, `clock.month.closed`; `payroll.calculated`, `invoice.reconciled`, `cashflow.forecasted` at their month-end marks |

### 4.6 The quarter cadence — the strategic zoom-out

| | |
|---|---|
| **Trigger** | `cron: 0 9 1 1,4,7,10 *` (first day of each quarter) |
| **Owner** | CEO AI #1 (sets the strategic frame); Boardroom Orchestrator #42 (convenes & decomposes) |
| **Participants** | the full executive line (CEO #1, COO #2, CTO #3, CFO #4, Boardroom #42); the human board at the apex |
| **Inputs** | the quarter's KPI trends and forecasts (the board report, **Volume XVII**, assembled *on this cadence*); the prior quarter's objectives; the version-review backlog (the change process, **Volume XVIII**, whose version reviews ride this cadence) |
| **Outputs** | the quarterly plan (objectives, resourcing, directives); the assembled board pack |
| **Emits** | `clock.quarter.opened`; `directive.accepted` / `directive.routed` (Boardroom #42) for any directive the quarter sets |

### 4.7 The year cadence — the strategic horizon

| | |
|---|---|
| **Trigger** | `cron: 0 9 1 1 *` (financial-year open; the human board may anchor to the UK tax year, 6 April) |
| **Owner** | the **human board** (ultimate authority — the apex of every ladder, **O6**); CEO AI #1 proposes |
| **Participants** | the human board; the full executive line |
| **Inputs** | the year's KPI and financial history; the four quarterly plans; the market intelligence synthesis (Intelligence #37) |
| **Outputs** | the annual strategy (vision refresh, annual objectives, the budget envelope); the year's directive programme |
| **Emits** | `clock.year.opened`; the top-level `directive.accepted` for the annual programme |

> **The nesting law.** A coarser cadence's plan is the *frame* for the finer
> cadences inside it: the annual strategy frames the quarter; the quarterly plan
> frames the month; the month frames the week; the week frames the day; the day
> frames the hour and minute. Conversely, every zoom-out is built from the rollup
> of the finer cadence beneath it (§11, the planning ladder). The clock is read
> *down* for direction and *up* for evidence.

---

## 5. The daily cycle, midnight → midnight (the centrepiece)

This is the concrete answer to *"how does an AI company operate from midnight to
midnight?"* — a worked timeline of one operating day. Times are illustrative
anchors (the human board sets the canonical timezone — open question §16); each
mark is an `hq_ai_schedules` row, and everything that happens is a task (XII)
emitting events (XI) under one `correlation_id` per saga (P2).

```
 00:00 ──────────────────────────────────────────────────────────────────────── 00:00
   │ overnight housekeeping │ morning briefing │ continuous work loop │ EOD review │ overnight…
   ▼                        ▼                  ▼                      ▼            ▼
 ROLLOVER               ~07:00            ~08:00 → ~17:00          ~17:30      back to top
```

### 5.1 00:00 — day rollover & the overnight housekeeping window

The quiet hours, when no customer-facing work runs (quiet-hours are owned by
Notification #40, §6), are the company's **night shift** — reserved for the
platform's own maintenance so it does not compete with the operating day:

- **`clock.day.closed`** fires for the day just ended; **`clock.day.opened`** for
  the new one. The day boundary is now a fact on the spine.
- **Memory Manager #38** runs **consolidation**: the day's episodic experience is
  reviewed, deduplicated and consolidated toward canon. This is the *housekeeping
  of the store* (`relationships.md` §7: #38 owns the substrate's upkeep, not the
  content). The *organisational learning loop* that decides what becomes a lesson
  rides on top of this and is owned by the **learning loop (Volume XVI)** — this
  cadence is merely *when* the consolidation pass runs. Emits
  `memory.consolidated` / `memory.expired`.
- **Analytics #22** takes the **close-of-day KPI snapshot**: a read-projection of
  the day's `hq_events` into the day's numbers (operating primitive **O4** —
  measurement is projection, never a parallel truth). Analytics #22 *captures* the
  snapshot on this cadence; the *definition* of every KPI in it is the **metric
  tree (Volume XVII)**. This volume owns *when* the snapshot is taken; XVII owns
  *what* it contains.
- The substrate's own nightly upkeep runs here too — the partition-creator stays
  ~2 months ahead (XI §11), cold partitions detach on policy, the lease reaper and
  DLQ sweep run unobstructed.

The night shift ends with the store consolidated, the day's numbers captured, and
the platform groomed for the day ahead.

### 5.2 ~07:00 — the morning briefing

The company **wakes up** by assembling what happened overnight into a brief the
executives and division heads read before the work loop opens:

- The **Boardroom Orchestrator #42** gathers the overnight event window
  (`WHERE correlation_id` across the night, ordered by `id` — O6) and assembles
  the **executive brief**: overnight incidents and their stand-down state (§10),
  the close-of-day KPIs from #22, the lifecycle positions (open deals, at-risk
  accounts, the cash position), and any approvals that ripened overnight and need a
  human (routed via Notification #40, the single human egress). Emits
  `briefing.assembled`.
- **Each division head** receives a **division brief** — its slice of the
  overnight window: Sales #16 sees the funnel state, Customer Success #18 the
  account-health changes, Finance #21 the overnight reconciliations, Operations #23
  the site and schedule state. These are `inform` envelopes (IX) on each standing
  management channel (`relationships.md` §3.2), not a broadcast — no employee
  briefs all 42.
- The brief is **assembled, not decided**: it surfaces what needs a decision and
  routes it to the owner; the *authority* to act on anything in it is the
  **decision framework (Volume XV)**. The briefing is a read; the acts it triggers
  are gated where XV says they are.

By the end of the briefing window, every executive and director knows the state of
their world and the day's priorities (inherited from the weekly plan, §4.4).

### 5.3 ~08:00 → ~17:00 — the continuous work loop (by day)

This is the **operating day proper** — the building at work. The full mechanics
of the loop are §6; here is what it *does* across the day:

- **Employees claim tasks.** Each AI employee runs its SDK run-loop (XII §11.2):
  claim a ready task → assemble context from memory (X) → reason → propose actions
  (the engine applies the autonomy test, P4) → checkpoint → verify → complete,
  heart-beating throughout, every step a `task.*` event. Work flows to whoever
  holds the capability, not to a name (C1).
- **The revenue funnel runs.** Research #13 → Qualification #14 → Outreach #15 →
  Sales #16 → Quote Writer #30 turn the wheel of the lead-to-cash and quote-to-job
  sagas (§9.2, §9.3; `relationships.md` §9.1–9.2). New leads are researched and
  scored; qualified leads are drafted to and (human-approved) pursued; quotes are
  built up and sent for human signature.
- **The channels answer.** Voice #26, WhatsApp #27 and Email #28 take inbound all
  day; Support #19 triages and drafts; a human approves any non-templated customer
  send (T3 gate, **Volume XV**); Customer Success #18 absorbs the account-health
  signal (§9.1, the support saga).
- **Operations turns.** Scheduler #29 books appointments; Site Manager #34 and
  Blueprint #35 process site progress and take-offs; Procurement #36 prices
  materials — the construction reality running underneath the funnel.
- **Finance accrues.** Finance #21 reconciles invoices and expenses as they land;
  Cashflow #31 keeps the rolling forecast current; Quote Writer #30 prices on
  demand — the money functions ticking through the day.

The work loop is **event-driven, not clock-driven**: a completed task emits a fact
that unblocks the next (XII §6, the DAG); the clock only *seeds* recurring work and
*marks* the day. The funnel does not wait for an hourly poll — it advances the
instant `lead.qualified` fires.

### 5.4 ~12:30 — the midday checkpoint

A light, single mark — the company **takes its own temperature** at the day's
midpoint without stopping work:

- **COO #2** receives a midday operational pulse: are the SLAs holding, is any
  queue backing up (the Task Engine golden signals, XII §13), is any lifecycle
  stalled past its expected dwell-time (§14, measured by **Volume XVII**)?
- A backed-up queue or a stalled saga at midday triggers a **reallocation**, not a
  meeting: capacity shifts to the hot capability (XII §7 load-balancing), or an
  escalation opens (the escalation ladder, **Volume XV**). The checkpoint is a
  steering nudge, not a ceremony. Emits `clock.day.checkpoint`.

### 5.5 ~17:30 — the end-of-day review

The company **closes the day** by rolling up what each division did and capturing
the numbers — the mirror image of the morning briefing:

- **Each division rolls up.** Every T1 director assembles a day rollup for its
  division — what completed, what carried over, what escalated, what each
  lifecycle's position now is — as an `inform` envelope (IX) up its management line
  to its executive (`relationships.md` §3.2), and as a `*.rolled_up` event on the
  spine. Sales #16 rolls up the funnel, Finance #21 the day's money, Operations #23
  the sites, Customer Success #18 the accounts. The executives (COO #2, CTO #3,
  CFO #4) consolidate their divisions' rollups into an executive end-of-day picture.
- **Analytics #22 snapshots KPIs.** The day's final KPI snapshot is taken (the same
  projection mechanism as 00:00 §5.1, now with the full day's events) — feeding the
  weekly, monthly and quarterly rollups (§11). Again: #22 *captures*; **Volume
  XVII** *defines*.
- **Carry-over is explicit.** Unfinished tasks are not lost — they remain ready in
  the queue (XII) and lead tomorrow's work loop after ageing (XII §5.3, fairness),
  surfaced in tomorrow's briefing. Nothing falls through the day boundary silently;
  the queue *is* the memory of unfinished work.

Emits `clock.day.closed` is then re-asserted at 00:00 (§5.1) as the rollover, and
the cycle returns to the overnight window. The company has run a full day:
groomed overnight, briefed at dawn, worked through the day, checked at noon, rolled
up at dusk — and back to the night shift.

---

## 6. The continuous work loop in detail (the heartbeat)

Zooming into §5.3 — how an individual employee's run-loop sits *inside* the
operating day, and what governs its tempo.

- **The run-loop is the employee.** An AI employee *is* a process that claims and
  runs tasks (XII §11.2). Its loop — `claim → assemble context (X) → reason →
  propose (P4) → checkpoint → verify → complete`, heart-beating throughout — is the
  canonical AI-employee shape (XII §11.2). The employee author writes only the
  handler; the substrate owns everything around it. This volume adds *no* loop; it
  places the existing loop in the day.
- **The loop runs continuously, but politely.** The substrate runs at all hours
  (the night shift §5.1 is platform work); but **customer-facing** action obeys
  **quiet hours**, owned by **Notification #40** (`relationships.md` §3.3: #40 is
  the single human-facing egress and owns channel choice, batching, dedupe and
  **quiet-hours**). An outbound that would breach quiet hours is *held* by #40 and
  released when the window opens — the loop keeps running, but #40 throttles the
  *human-facing* edge. This volume specifies *that the day respects quiet hours*;
  the quiet-hours mechanism is #40's, not a new clock here.
- **Backpressure keeps the loop from drowning.** Three substrate guards, placed on
  the day:
  - **Per-employee concurrency caps** (XII §5.3) — one employee can't monopolise
    runners, so the funnel and the channels share the day fairly.
  - **Priority with ageing** (XII §5.3) — urgent work leads, but a flood of
    `urgent` can't starve `normal` forever; carried-over work ages to the front of
    tomorrow.
  - **Lane-ordered event drain** (XI §7) — a `critical` fact (a security alert, an
    escalation) is projected before a `bulk` backfill, so the loop stays responsive
    to what matters even under load.
- **When the loop stalls.** A claimed task whose runner dies stops heart-beating;
  the lease reaper (XII §10.2, a minute-cadence task) reclaims and retries it,
  at-least-once, idempotently. No work is lost to a crashed worker mid-day — the
  heartbeat is the day's safety net (failure handling, §13).

The heartbeat, then, is: the minute tick seeds and reaps; the employees' run-loops
churn through ready work event-by-event; #40 throttles the human edge to civilised
hours; backpressure keeps any one stream from starving the rest. That is the
company *working*, all day, without a single poller.

---

## 7. Department coordination (how the eight divisions sync)

A company is divisions acting in concert. The coordination is **not** new
machinery — it is the org graph (`relationships.md` §§2–5) exercised on the clock.

- **Stand-ups are event rollups, not meetings.** A division "stand-up" is the
  morning brief (§5.2) and end-of-day rollup (§5.5): each division head reads its
  slice of the overnight/day event window and issues an `inform` up its line. There
  is no synchronous all-hands — the *events are the stand-up*. A division stays in
  sync by subscribing to the verbs it cares about (XI §6), not by attending a call.
- **Cross-division hand-offs are the sagas.** When work crosses a division
  boundary it travels as a saga (`relationships.md` §9): a qualified lead crosses
  Revenue→Finance via `deal.progressed` → a quote request to Quote Writer #30; a
  won deal crosses Revenue→Customer via Onboarding #20 → Customer Success #18; a
  payroll run crosses Operations→Finance via the timesheet→`payroll.calculated`
  chain. Each hand-off is a capability-routed task (XII §7) and a domain event (XI),
  under one `correlation_id` — the company's value streams *are* its
  cross-division coordination, placed on the clock in §9.
- **COO #2 is the conductor.** The COO (Workforce §2: broadest executive, six
  direct reports across four divisions, acting CRO) holds the operational baton:
  reading the consolidated rollups, steering capacity at the midday checkpoint
  (§5.4), and resolving cross-division contention that a single director can't. The
  COO conducts the *tempo*; it does not re-decide what each division owns — that is
  the org graph. Where a cross-division act needs authority beyond a director's
  scope, it escalates on the ladder (**Volume XV**), not to the COO's discretion
  alone.
- **The Boardroom Orchestrator #42 coordinates the top.** For a directive that
  spans divisions, #42 convenes the executives and asks Workflow #39 to compose the
  cross-department DAG (`relationships.md` §5.1, §9.3) — the executive-level
  coordination ritual, on the directive's cadence (quarter or as-issued, §4.6).

The principle: **coordination is the org graph in motion, timed by the clock** —
the cadences say *when* divisions sync (dawn, dusk, the week), the sagas say *how*
work crosses between them, and #2/#42 conduct. No coordination mechanism is
invented here; only its rhythm.

---

## 8. Executive meetings (the board cadence)

The executive group meets on a cadence, and every meeting is **data**, not a
verbal event lost to air — its agenda and minutes are P3 output envelopes carried
as IX messages, and its convening is an XI event.

| Meeting | Cadence (§4) | Convener | Participants | Agenda source | Output |
|---------|--------------|----------|--------------|---------------|--------|
| **Daily exec sync** | day (§4.3, post-briefing) | Boardroom #42 | CEO #1, COO #2, CTO #3, CFO #4 | the morning brief (§5.2) | the day's executive priorities; any directive seeds |
| **Weekly board** | week (§4.4) | Boardroom #42 | the executive line | the weekly rollup + lifecycle dwell-times | the weekly plan; escalations for the human board |
| **Monthly review** | month (§4.5) | CFO #4 (financial) + COO #2 (operational) | executives + division heads | the monthly close + KPI series | the monthly business review |
| **Quarterly planning** | quarter (§4.6) | CEO #1 + Boardroom #42 | the executive line + the **human board** | the board pack (**Volume XVII**) | the quarterly plan + directive programme |
| **Annual strategy** | year (§4.7) | the **human board** | the board + executives | the annual review | the annual strategy |

- **Convening is an event.** Every executive meeting emits **`board.convened`**
  (`relationships.md` §4, Boardroom #42's verb) to the executive group — the
  meeting *happened* is a fact of record (O6).
- **Agenda and minutes are envelopes.** The agenda is a P3 envelope assembled by
  the convener; the minutes are a P3 envelope (`summary`/`reasoning`/`actions`)
  recorded back, with each action becoming a task (XII) under the meeting's
  `correlation_id`. A decision taken in a meeting is therefore *owned* (O2),
  *traceable* (P2), and *gated* by the decision framework (**Volume XV**) exactly
  as any other act — a meeting confers no special authority.
- **The board pack is assembled here, authored elsewhere.** This volume owns *when*
  the board pack is assembled — on the quarterly planning cadence (§4.6) — but its
  *content* (the KPIs, trends and forecasts) is the **board report (Volume XVII)**.
  The clock says "assemble it now"; XVII says "here is what it says". (Concept-
  ownership map: "the board report (XVII), on the cadence (XIV)".)

The human board sits at the apex of the meeting ladder (O6): it is a standing
participant at the quarter and the year, and the ultimate escalation target from
every meeting below.

---

## 9. The lifecycles (the long-running sagas on the clock)

A lifecycle is a **saga that outlives a single day** — a value stream that opens,
advances through stages over days, weeks or months, and closes. Each is one of the
`relationships.md` §9 sagas, here **placed on the clock**: the stages are the
saga's milestones; the *cadence touch-points* are where the clock advances,
reviews or sweeps the saga. This volume does **not** redefine the org graphs — it
references them and times them. Every stage's owner is the §9 owner; every external
/ financial / customer boundary is human-gated by the **decision framework (Volume
XV)**.

### 9.1 The customer lifecycle (`relationships.md` §9.1 post-sale + §9.5 support)

```
 WON ──onboarding──▶ ACTIVE ──────────────▶ HEALTHY/AT-RISK ───────────▶ RENEW / CHURN
  │   Onboarding #20   │  Customer Success #18 owns the account            │
  ▼   (days)           ▼  (ongoing — the daily channel/support loop §5.3)  ▼
 onboarding.completed  health-zone updates (X), ticket.* (Support #19)   renewal / save
```

| Stage | Owner | Cadence touch-points |
|-------|-------|---------------------|
| Onboarding | Onboarding #20 | the daily work loop (§5.3) until `onboarding.completed` |
| Active / health | Customer Success #18 | daily channel+support loop; health surfaced in the daily brief (§5.2) and weekly review (§4.4) |
| At-risk | CS #18 → Sales #16 (churn risk) | the midday checkpoint (§5.4) catches a health drop; the weekly review steers the save |
| Renew / churn | CS #18; Finance #21 (the renewal money) | monthly review (§4.5) reads cohort retention |

### 9.2 The sales lifecycle (`relationships.md` §9.1 lead-to-cash)

```
 LEAD ──▶ RESEARCHED ──▶ QUALIFIED ──▶ PURSUED ──▶ QUOTED ──▶ WON/LOST
   #13 researches   #14 scores vs ICP  #15 drafts;  #30 builds; human signs
   company.researched lead.qualified    HUMAN sends  quote.approved
```

| Stage | Owner | Cadence touch-points |
|-------|-------|---------------------|
| Research → Qualify | Research #13, Qualification #14 | the daily work loop (§5.3); the funnel turns continuously |
| Pursue | Outreach #15 → Sales #16 | daily loop; **outbound respects quiet hours (#40, §6)**; human send-gate (XV) |
| Quote | Quote Writer #30 (the quote-to-job saga, §9.3) | daily loop; quote sent on human signature (XV) |
| Win/Lose | Sales #16 owns the deal | the daily funnel rollup (§5.5); weekly pipeline review (§4.4) |

### 9.3 The development lifecycle (idea → spec → six-gate → ship → monitor)

The Technology division's value stream — the CTO line (`relationships.md` §2,
Technology + AI Platform) — placed on the clock:

```
 IDEA ──▶ SPEC ──▶ BUILD ──▶ SIX-GATE ──▶ SHIP ──▶ MONITOR
  Product #5  #5/#6   Eng line   QA #7 +     DevOps #9   Monitoring #41
  roadmap    spec     6/9/10/11/12 Security #8  (gated)    watches
```

| Stage | Owner | Cadence touch-points |
|-------|-------|---------------------|
| Idea / spec | Product #5 | quarterly planning seeds the roadmap (§4.6); weekly grooming (§4.4) |
| Build | Engineering Manager #6 → DevOps #9, Docs #10, Database #11, API #12 | the daily work loop (§5.3) |
| Six-gate | QA #7 + **Security #8 (can block)** | per-change; the gate is the quality bar, not a clock mark |
| Ship | DevOps #9 — **a production change is human/Security-gated** (XV) | a deliberate release window, not the ambient loop |
| Monitor | Monitoring & Incident #41 | the hourly pulse (§4.2) watches the shipped change; a regression opens the incident rhythm (§10) |

The six gates and the ship gate are **authority** boundaries (the decision
framework, **Volume XV**) and **measurement** points (the metric, **Volume XVII**)
— this lifecycle times the flow; it does not own the gates.

### 9.4 The marketing lifecycle (`relationships.md` §4 `content.published`)

```
 INSIGHT ──▶ PLAN ──▶ PRODUCE ──▶ PUBLISH ──▶ MEASURE ──▶ FEED THE FUNNEL
  Intelligence #37  Marketing #17   #17        content.published   Analytics #22 → Sales #16
```

| Stage | Owner | Cadence touch-points |
|-------|-------|---------------------|
| Insight | Intelligence #37 | the hourly/daily intelligence synthesis (§4.2); quarterly market read (§4.6) |
| Plan / produce | Marketing #17 | weekly content plan (§4.4); the daily loop produces |
| Publish | Marketing #17 — **customer-facing publish is human-gated** (XV) | a scheduled publish window; `content.published` |
| Measure | Analytics #22 → Marketing #17, Sales #16 | the daily KPI snapshot (§5.5); monthly campaign review (§4.5) |

Brand and content knowledge live in Marketing #17's memory zone (`relationships.md`
§7); the lifecycle reads and writes it by reference, never by copy.

### 9.5 The financial lifecycle (quote → invoice → reconcile → forecast → payroll → close)

The most cadence-bound lifecycle, and the one most grounded in **UK construction
reality** — the Finance cluster (`relationships.md` §9.6 payroll/CIS, §7 the
compliance zone) on the clock:

```
 QUOTE ──▶ INVOICE ──▶ RECONCILE ──▶ FORECAST ──▶ PAYROLL/CIS ──▶ MONTH-CLOSE ──▶ QUARTER-CLOSE
  #30      Finance #21  #21            Cashflow #31  Payroll #32     CFO #4          CFO #4 + board
  (daily)  (event-driven)             (rolling)     (monthly)       (monthly)       (quarterly)
```

| Stage | Owner | Cadence touch-points & UK construction specifics |
|-------|-------|-------------------------------------------------|
| Quote | Quote Writer #30 | daily loop; **VAT domestic reverse charge** applies on most B2B construction supplies — the quote states the customer accounts for the VAT, not CrewFlow's customer's supplier; Legal & Compliance #25's regs zone is a mandatory read |
| Invoice / reconcile | Finance #21 | event-driven on the daily loop; reverse-charge invoices carry the required wording; `invoice.reconciled` |
| Forecast | Cashflow #31 | the **rolling** forecast, refreshed through the day (§4.2) and at the daily snapshot; `cashflow.forecasted` to CFO #4 + CEO #1 |
| Payroll & CIS | Payroll #32 | **monthly** (§4.5): compute **PAYE/RTI** and **CIS deductions** at 20% (registered subcontractor), 30% (unverified) or 0% (gross status); `payroll.calculated`. **Payroll #32 computes but never submits** |
| CIS return | Payroll #32 → Finance #21 → CFO #4 | the **monthly CIS return** is due by the **19th** of the following tax month — a monthly-cadence schedule opens the return window at month-close; **a human submits to HMRC** (financial + external gate, XV) |
| RTI submission | Payroll #32 → human | **RTI** is filed **on or before** each payday (a per-pay-run cadence); **a human submits** |
| Month-close | CFO #4 | the month cadence (§4.5): reconcile, accrue, snapshot; the books close on the last day |
| Quarter-close | CFO #4 + the board | the quarter cadence (§4.6): the quarter's financial picture feeds the board pack (**Volume XVII**); **VAT returns** are typically quarterly |

Owners (from `relationships.md` §9.6): **Payroll #32** computes but never submits;
**Legal & Compliance #25**'s regs zone governs CIS verification status and the
reverse-charge rules; **CFO #4** approves and **a human submits** every HMRC
filing. The clock provides the deadlines (the 19th, the payday, the quarter); the
substrate provides the schedules; the authority to *submit* is the decision
framework's (**Volume XV**).

> **The common shape (`relationships.md` §9).** Every lifecycle: one initiator, a
> chain of capability-routed tasks, a domain event at each milestone, one owner per
> stage, a human gate at every irreversible/external/financial/customer boundary,
> and **a cadence touch-point that opens, advances, reviews or closes it.** The
> sagas are the org's; the *timing* is this volume's.

---

## 10. Incident response (the operational rhythm)

When something breaks, the company runs a **playbook with a tempo**. This volume
owns *only the rhythm* — the cadence of detect → mobilise → resolve → stand-down →
review. The other slices belong to siblings and are cited, never restated
(concept-ownership map: incident response is split four ways).

```
 DETECT ──▶ MOBILISE ──▶ RESOLVE ──▶ STAND-DOWN ──▶ REVIEW
  #41        #40 + on-call  #9 (gated)   #41 closes     blameless post-mortem
  (minutes)  (immediate)    (the clock    incident.resolved  (next-day window)
                             pauses for
                             the incident)
```

| Phase | Tempo (this volume's slice) | Owner | What it is *not* (the seam) |
|-------|-----------------------------|-------|------------------------------|
| **Detect** | the minute/hour pulse (§4.1–4.2): Monitoring #41 samples golden signals; a breach fires immediately | Monitoring #41 | the *thresholds* and incident KPIs (MTTR) are the **metric (Volume XVII)** |
| **Mobilise** | immediate — bypasses quiet hours: `incident.opened` → Notification #40 pages DevOps #9 + the on-call human at once | Monitoring #41 detects, #40 routes | the *override authority* to act outside normal limits is the **emergency override (Volume XV)** |
| **Resolve** | the operating clock **yields** — routine cadences defer to the incident; DevOps #9 remediates, Security #8 reviews if a trust boundary is touched | DevOps #9 remediates; CTO #3 accountable | a production change stays **human/Security-gated even under incident** (the decision framework, **Volume XV**) |
| **Stand-down** | `incident.resolved`; the clock resumes normal cadence; the briefing (§5.2) reports the closed incident | Monitoring #41 | — |
| **Review** | a **next-day** blameless post-mortem window (a day-cadence schedule), feeding the lesson | the review is convened on the clock | the *blameless post-mortem → lesson* pipeline is the **learning loop (Volume XVI)** |

The incident rhythm's one distinctive clock behaviour: **the operating clock
yields to an incident.** Routine cadences (the funnel, the daily review) continue,
but contention resolves in the incident's favour — capacity and attention flow to
mobilise and resolve until stand-down. After stand-down, the clock schedules the
review the next day; what that review *produces* (the lesson) and how it is
*measured* (MTTR) are the siblings' jobs (XVI, XVII), and the *authority* to
override during the incident is XV's. This volume owns only: *how fast, in what
order, and when does normal time resume.*

---

## 11. The planning ladder (the zoom-out hierarchy)

The cadences §4.3–4.7 are not five separate rituals — they are **one ladder**,
each rung built from the rollup of the rung below and framing the rung above. This
is the clock read *up* for evidence and *down* for direction (the nesting law,
§4).

```
   ANNUAL STRATEGY        human board ◀── the four quarterly plans
        ▲ frames │ feeds                        (the year is built from its quarters)
   QUARTERLY PLAN         CEO #1 + Boardroom #42 ◀── the three monthly reviews + board pack (XVII)
        ▲ frames │ feeds
   MONTHLY REVIEW         CFO #4 + COO #2 ◀── the ~4 weekly plans + the monthly close
        ▲ frames │ feeds
   WEEKLY PLAN            COO #2 + directors ◀── the ~5 daily rollups
        ▲ frames │ feeds
   END-OF-DAY REVIEW      each division head ◀── the day's task.* + KPI snapshot (#22)
```

| Rung | Owner | Inputs (from below) | Outputs (frames below) |
|------|-------|---------------------|------------------------|
| **End-of-day** (§5.5) | each T1 director | the day's `task.*`, the daily KPI snapshot (#22) | the day rollup; carry-over into tomorrow's loop |
| **Weekly plan** (§4.4) | COO #2 + directors | the week's daily rollups; lifecycle dwell-times | the week's priorities; capacity allocation for the daily loops |
| **Monthly review** (§4.5) | CFO #4 + COO #2 | the month's weekly plans; the monthly close (#21/#31/#32) | the month's operational and financial picture; the next month's frame |
| **Quarterly plan** (§4.6) | CEO #1 + Boardroom #42 | the quarter's monthly reviews; the **board pack (Volume XVII)** | the quarter's objectives; the directive programme |
| **Annual strategy** (§4.7) | the **human board** | the four quarterly plans; the year's history; market intelligence (#37) | the vision refresh; annual objectives; the budget envelope |

- **Each rung nests in the next.** A daily rollup is one of ~5 that compose a weekly
  plan; ~4 weeks compose a month; 3 months compose a quarter; 4 quarters compose
  the year. Evidence flows *up*; direction flows *down*. No rung is free-standing —
  the annual strategy is only as real as the quarters that build it, and a day is
  only as directed as the week that frames it.
- **Ownership climbs the management spine.** Directors own the day and seed the
  week; the COO/CFO own the month; the CEO + Boardroom own the quarter; the **human
  board** owns the year (O6 — the board is the apex). Each rung's owner is the
  natural escalation target for the rung below.
- **What the ladder produces vs. what siblings own.** The ladder produces *plans
  and reviews* — the temporal containers. The **content** of the board pack at the
  quarter is the **board report (Volume XVII)**; a directive the plan issues runs
  through the **change process (Volume XVIII)** and is decomposed by Boardroom #42
  (`relationships.md` §9.3); the *authority* to commit budget or external
  commitment at any rung is the **decision framework (Volume XV)**. This volume owns
  *when each plan is made and how the rungs nest* — not the decisions, metrics or
  changes inside them.

---

## 12. Cross-axis seams (where TIME touches the other four)

The clock is orthogonal to the other axes by design (keystone), but it *touches*
each at precise seams. Each seam names which side owns what — per the
concept-ownership map.

| Seam | TIME (XIV) owns… | The other axis owns… |
|------|------------------|----------------------|
| **Authority (XV)** | *when* a gated act is attempted (the cadence, the lifecycle stage, the incident phase) | *whether* it may proceed — the autonomy test, the approval matrix, every limit, and the **emergency override** (Volume XV). Every human-gate in §§5–10 is XV's; the clock only schedules the attempt. |
| **Learning (XVI)** | *when* consolidation runs (the night shift §5.1) and *when* the post-mortem is convened (next-day §10) | *what* becomes a lesson and *how* it propagates — the **lesson-capture / learning loop** (Volume XVI). The clock provides the window; XVI fills it. |
| **Measurement (XVII)** | *when* a snapshot is taken (§5.1, §5.5) and *when* the board pack is assembled (§4.6) | *what* every KPI, dashboard and board report *contains*, including **cadence adherence and lifecycle dwell-time** (§14) and incident **MTTR** (§10) — the **metric / board report** (Volume XVII). The clock is the trigger; XVII is the content. |
| **Change (XVIII)** | *when* a version review runs (the quarter cadence §4.6) and *when* a directive is issued (the planning ladder §11) | *how* an employee, capability, cadence, KPI or version is **added, retired or re-versioned** — the **change/evolution process** (Volume XVIII). Adding a *new cadence* is itself a change governed by XVIII (a new `hq_ai_schedules` row, O5); this volume owns the *catalogue* of cadences, XVIII owns the *governance* of changing it. |

> **The seam rule, stated once:** the clock says **when**; the siblings say
> **whether (XV)**, **what-is-learned (XVI)**, **what-is-measured (XVII)** and
> **what-changes (XVIII)**. Wherever this volume names a human gate, a lesson, a
> metric or a version, it is *pointing at a seam*, not claiming the territory.

---

## 13. Failure & recovery

How the temporal model breaks, and how it self-heals — every recovery riding a
substrate mechanism, never a new one.

- **A missed cadence.** A schedule that fails to fire (a tick miss, a crash during
  materialisation) is detected by the **idempotent tick**: `hq_ai_schedule_tick`
  keys materialised tasks by `slug:bucket` (XII §5.3), so the next tick fills the
  gap without double-spawning. A cadence that *should* have produced its event and
  didn't is a visible absence on the spine (the expected `clock.*` verb is missing)
  — surfaced as a cadence-adherence signal (§14, measured by **Volume XVII**). A
  persistently-missed cadence escalates on the ladder (**Volume XV**). The books
  closing late, the briefing not assembling — these are *loud*, because the absence
  of a `clock.*` fact is itself observable.
- **A stalled lifecycle.** A saga stuck past its expected dwell-time (a deal frozen
  mid-funnel, a quote awaiting signature too long, a CIS return approaching the 19th
  unfiled) is caught by the **SLA sweep** (XII §8.4) — a recurring task reading the
  deadline index — and by the **midday/weekly review** dwell-time check (§5.4,
  §4.4). The stalled stage escalates: retry → reassign to a peer → escalate to the
  manager employee → open a human task (the ladder, **Volume XV**). A lifecycle
  never stalls *silently* — its dwell-time is measured (**Volume XVII**) and its
  deadline is swept.
- **Clock skew.** The company's notion of "now" is the database clock, not any
  employee's wall-clock — every schedule's `next_run_at` and every event's `id`
  (the total order, P1) are server-side, so two runners can't disagree about the
  day boundary. The timezone the cadences *anchor* to (when is "00:00"?) is a single
  operator setting (open question §16); a daylight-saving shift is absorbed because
  cron is evaluated against that one canonical zone, not per-employee.
- **A cadence storm.** A backlog (the tick was down, then recovers; many schedules
  come due at once) is bounded by the substrate's existing guards: **priority with
  ageing** and **per-employee concurrency caps** (XII §5.3) keep the storm from
  starving live work; **lane-ordered drain** (XI §7) keeps `critical` facts flowing
  ahead of `bulk` catch-up. The storm drains in priority order rather than
  thundering — the same backpressure that paces the daily loop (§6) paces the
  recovery. A storm is *slow*, never *destructive*.

In every case the recovery is a substrate guarantee (idempotent tick, SLA sweep,
ageing, lease reaper, lane drain) — this volume *relies on* them; it does not add a
recovery mechanism of its own.

---

## 14. Observability

How the health of the *clock itself* is seen — noting that, per **O4** and the
concept-ownership map, the **metric definitions and dashboards are owned by Volume
XVII**; this section names *what about TIME* is worth measuring, and points at the
owner.

- **Cadence adherence.** For each cadence (§4): did it fire on schedule, and did it
  emit its `clock.*` (and downstream) events? Measured as a projection of
  `hq_events` (the expected verb present, on time) — the same projection discipline
  as every metric (O4). A missed or late cadence is the signal (§13). *Owned as a
  metric by Volume XVII; produced by Analytics #22's snapshots (§5).*
- **Lifecycle stage dwell-time.** For each lifecycle (§9): how long does work sit in
  each stage (lead→qualified, quote→signed, invoice→reconciled, incident
  open→resolved)? Dwell-time is the projection that reveals a stalling saga (§13)
  and a bottleneck division. *Owned as a metric by Volume XVII; the dwell-time of
  the development lifecycle's gates and the incident's resolve phase are XVII's
  named series (including MTTR).*
- **The substrate's own golden signals.** The Task Engine's `hq_ai_task_golden_signals()`
  (XII §13) and the spine's `hq_spine_golden_signals()` (XI §14) already expose
  queue depth, the crash canary (stale heartbeats), approval backlog, deadline
  breaches and per-consumer lag — the raw telemetry the clock's health reads from.
  This volume consumes those signals (e.g. a deep queue at the midday checkpoint,
  §5.4); it does not define them.

The clock is observable **by construction (O6)**: because every cadence emits a
`clock.*` fact and every saga step a `task.*` / domain fact on the one log, the
company's entire temporal history — every day opened and closed, every lifecycle
stage entered, every incident's tempo — is reconstructable with
`WHERE correlation_id = X ORDER BY id`. The *views* over that history are Volume
XVII's; the *history* is the spine's; the *timing* is this volume's.

---

## 15. Conflicts resolved

**Resolves C3 ("nothing polls") — in detail.**

The adoption analysis flagged the contradiction: the Bible says *"nothing polls"*,
yet the codebase carried thirteen cron pollers and an unwired scheduler. The
substrate's standing resolution (XI, XII) is that the **bus is the event-driven
backbone** and the **Task Engine is the one scheduler**. This volume is where that
resolution becomes the *operating model*:

- **Every cadence in this volume is a scheduled Task, not a poller.** The minute,
  hour, day, week, month, quarter and year (§4) are each a row in
  **`hq_ai_schedules`**, materialised by the **single tick** (`hq_ai_schedule_tick`,
  XII §5.3). There is *one* timer in the company — the tick — and every periodic
  behaviour hangs off it. The morning briefing does not poll for overnight events;
  it is a scheduled task that reads the event window once and assembles. The SLA
  sweep does not loop; it is a recurring task reading the deadline index.
- **The work loop is event-driven, not clock-driven (§5.3, §6).** Inside the day,
  work advances when a task completes and emits a fact that unblocks the next (the
  DAG, XII §6) — not when a poll comes round. The clock only *seeds* recurring work
  and *marks* the day's structure; the funnel and the channels react to events. So
  the company is **push-shaped** even though the tick is a pull at the core (the
  same posture as the bus, XI §6.3).
- **Cadences are *consumers*, never pollers.** Where a cadence "watches" something
  (Monitoring #41 watching golden signals, §4.2), it does so by *subscribing to the
  signal's events* (XI §6) and being *scheduled to sample*, not by spinning a loop.
  The distinction is the whole of C3: a poller asks "is there anything yet?" on a
  loop; a scheduled consumer is *handed* its trigger by the one tick or the bus.

The thirteen pollers, in the operating model, are simply **thirteen rows in
`hq_ai_schedules`** (or consumers of the bus) — reclassified, not re-invented,
exactly as the substrate's incremental-migration discipline requires (C3, XII §16).
**This volume's entire cadence hierarchy is the proof that a company can run on
every timescale with zero pollers.**

---

## 16. Open questions (for a future directive)

1. **The canonical timezone of "now".** The daily cycle (§5) anchors to clock times
   (00:00, 07:00, …). For a UK construction company the natural anchor is UK local
   time, but the *financial* year may anchor to the UK tax year (6 April) and HMRC
   deadlines (the CIS 19th, RTI on payday) are UK-statutory. A single operator
   setting must pin the company's canonical operating timezone, and the schedules
   must evaluate cron against it (resolving daylight-saving cleanly, §13).
   *Recommendation: one canonical zone (Europe/London), all cadences anchored to
   it, financial deadlines derived from the UK tax calendar.*
2. **Cadence anchor times.** The illustrative marks (~07:00 brief, ~12:30
   checkpoint, ~17:30 review) need ratification against real customer rhythms — a
   construction customer's day starts early. *Recommendation: brief before the
   trade day opens; review after site close; tune from observed channel volume.*
3. **Incident clock-yield policy.** §10 states the operating clock *yields* to an
   incident. The precise policy — which routine cadences defer, and for how long
   before they are force-run on stand-down — needs a decision jointly with the
   **emergency override (Volume XV)** and incident **MTTR targets (Volume XVII)**.
   *Recommendation: defer non-financial routine cadences during a `critical`
   incident; never defer a statutory financial deadline (the 19th does not move).*
4. **Lifecycle dwell-time targets.** The expected dwell-time per stage (§9, §14)
   that turns "slow" into "stalled" is a target the **metric (Volume XVII)** must
   set; this volume only states that the sweep and the checkpoint read it.
   *Recommendation: XVII owns the targets; XIV consumes them at the checkpoints.*

---

*Volume XIV of the CrewFlow Bible — the Operating Model layer. Architecture only —
no code, no production change, no migration, no PR. Composes the AI Substrate
(IX–XIII) and the AI Workforce (Layer 4); re-implements neither.*
