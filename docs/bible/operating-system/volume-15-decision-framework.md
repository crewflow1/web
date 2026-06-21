# Volume XV — Decision Framework

> **Operating Model layer, document 2 of 5 (the AUTHORITY axis).** Constitutional
> design work under **CEO Directive #008 — "AI Workforce Architecture, Phase 2"**
> (2026-06-21).
>
> **This is architecture, not a build order.** Per the directive: *no code, no
> implementation, no production changes, no PRs, no prototypes, no migrations.*
> Nothing here is implemented until a future CEO Directive instructs it.
>
> **Inheritance.** This volume **inherits P4 (the autonomy test) and P5 (the
> service-role doorman) from the substrate, and the five autonomy tiers from the
> Workforce (§5 + `relationships.md` §6); it formalises the company's decision
> constitution on top of them and re-implements no gate.** P4 is the atom; the
> Task Engine's approval checkpoints are the enforcement; this volume is the
> *organisation of decision rights* between them. **Read `./README.md` first** —
> it pins the five axes, the operating primitives O1–O6, the concept-ownership
> map, and the cross-volume citation rule this document obeys.

---

## 1. Purpose & scope

**The job, in one sentence:** be CrewFlow's **constitution** — the single,
canonical definition of *who may decide what, how far, and exactly when a human
must be in the loop* — so that **every decision the company makes has exactly one
accountable owner** (the operating primitive **O2**).

A substrate decides *whether one action* is safe to take on its own (P4). A
workforce assigns each employee a *posture* (the tiers). Neither, alone, is a
**constitution** — a company-wide settlement of authority that says, for *every*
class of decision, who owns it, how far that ownership reaches, what limit caps
it, where it escalates when the cap is exceeded, and which human holds the final
word. That settlement is what this volume is. It is the AUTHORITY axis of the
operating model: the company asking, at every moment of choice, *whose decision
is this?* — and always getting exactly one answer.

This volume realises **O2** in full. Where the substrate gives the *mechanism*
(act vs. ask) and the workforce gives the *default posture* (the tier), this
volume gives the *settlement*: the decision hierarchy, the autonomy ladder, the
escalation paths, the one canonical approval matrix, the explicit limit bands
(financial, customer-impact, security, legal, ethical), and the emergency
override. Every other volume **defers to this one** on any question of "who may
decide / how far / when a human must approve."

**In scope:** the decision hierarchy; autonomy levels; escalation paths; the
approval matrix; financial limits; customer-impact limits; security limits; legal
limits; ethical limits; the emergency override; decision records as audit.

**Out of scope (owned elsewhere, cited never restated):** the *mechanism* of the
autonomy test (P4, substrate) and its *enforcement* as approval checkpoints (the
Task Engine, Volume XII); the *temporal* "when a decision is reviewed" — the
review cadence (Volume XIV); the *metrics* on decision quality — the approval-rate
and escalation-rate KPIs (Volume XVII); the *lessons* drawn from a bad decision —
the lesson-capture loop (Volume XVI); the *org chart and per-employee remit* (the
Workforce). This volume sets policy; it builds no machinery.

---

## 2. Where it sits

```
        ┌──────────────────────────────────────────────────────────────┐
        │  Volume XV — DECISION FRAMEWORK   (the constitution)          │
        │  decision hierarchy · autonomy ladder · escalation · the     │
        │  approval matrix · the limit bands · the emergency override  │
        └───────┬───────────────────────┬──────────────────────────────┘
       composes │                       │ defines the policy that…
                ▼                       ▼
   ┌──────────────────────┐   ┌────────────────────────────────────────┐
   │  Workforce §5 TIERS   │   │  Task Engine (XII) approval checkpoints │
   │  T0–T4 default posture│   │  …MECHANICALLY ENFORCES, per action     │
   │  relationships §6     │   │  (the home of the autonomy test, P4)    │
   └──────────┬───────────┘   └───────────────────┬────────────────────┘
              │ both built on…                     │ both rest on…
              ▼                                     ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  P4 the autonomy test  ·  P5 the service-role doorman (substrate) │
   └──────────────────────────────────────────────────────────────────┘
```

- **Built on:** **P4** (the one rule that decides act-vs-ask, per proposed
  action); **P5** (the doorman — the AI holds no keys, makes audited requests);
  the **Workforce tiers** T0–T4 (each employee's default posture); and the
  **approval hierarchy** (`relationships.md` §6 — the escalation ladder, the tier
  gate, the specialist approval authorities).
- **Enforced by:** the **Task Engine's approval checkpoints (Volume XII)** — the
  `waiting_approval` state, the `hq_ai_task_approvals` record, the approval SLA.
  This volume writes the *policy*; the Task Engine is where that policy *fires*.
  The engine applies P4 to every proposed action and parks the risky ones; this
  volume decides *what counts as risky for whom, and who may release the park*.
- **Deferred to by:** every other volume. The learning loop (Volume XVI) promotes
  a lesson to canon only through *this* volume's memory-canon gate; the change
  process (Volume XVIII) hires or retires an employee only through *this* volume's
  roster gate; the cadence (Volume XIV) schedules a board meeting whose *authority
  to decide* is defined here.

**What this volume must NOT re-implement** (the prime law of the layer —
inherit, never re-implement): the five conditions of the autonomy test (they are
P4, stated once); the approval-checkpoint state machine, the approvals table, or
the approval SLA escalation (they are the Task Engine's); the permission gate or
the capability registry (the SDK's); the event log (the bus's). If this document
finds itself specifying a table, an FSM, or a message format, it has crossed into
the substrate's job and must stop and reference instead. It specifies **bands and
owners**, not machinery.

---

## 3. Built vs. to-build

The honest ledger. Most of the *mechanism* already exists below; what is **new
here is the constitutional consolidation** — one matrix, explicit limit bands,
and the emergency override — that turns scattered postures into a single law.

| Capability | State | Where / note |
|------------|-------|--------------|
| The act-vs-ask rule (per proposed action) | **Built** | P4 autonomy test (substrate README). The atom — not re-derived here. |
| Mechanical enforcement (park risky actions for a human) | **Built** | Task Engine `waiting_approval` + `hq_ai_task_approvals` + approval SLA (Volume XII). |
| The AI-never-holds-keys guarantee | **Built** | P5 doorman; the SDK 3-layer permission gate. |
| Per-employee default posture | **Built** | Workforce §5 tiers T0–T4; each spec's §7/§10. |
| The escalation ladder (rungs T2→T1→T0→human) | **Built** | `relationships.md` §6.2. |
| The tier gate (autonomous-for / always-needs-approval) | **Built** | `relationships.md` §6.1. |
| The six specialist approval authorities | **Built** | `relationships.md` §6.3 (Financial, Legal, Security, Customer-send, Memory-canon, Hire/retire). |
| **The consolidated decision hierarchy** (every decision → one owner, T0–T4 + board) | **To formalise** | §4 — the single statement of O2. |
| **The autonomy ladder A0–A4** (named gradations built from the P4 atom) | **To formalise** | §5 — organises postures into one explicit ladder. |
| **The canonical approval matrix** (act-class × value/risk band → approver) | **To formalise** | §7 — the centrepiece; one table the whole company shares. |
| **The explicit limit bands** (financial £, customer-impact, security, legal, ethical) | **To formalise** | §8–§12 — the numbers and absolutes scattered grants imply. |
| **The emergency override** (break-glass: pause an employee / department / company) | **To formalise** | §13 — the operational form of human supremacy (O6). |

**Net:** the *mechanism* (P4 + checkpoints + tiers + the §6 hierarchy) is shipped
or designed. This volume **does not build a second gate.** It writes the
constitution that the existing gate enforces: it names the levels, draws the one
matrix, fixes the bands, and codifies the break-glass — so the company is
*governed*, not merely *gated*.

---

## 4. The decision hierarchy — every decision lands at exactly one owner (O2)

The hierarchy is the spine of the constitution. It maps the autonomy tiers
(Workforce §5) onto **six levels of authority**, from the substrate's autonomous
floor to the human board's apex. A decision enters at the level of its owner and
**rises only when it exceeds that owner's authority** — never sideways, never
down from observed content.

| Level | Authority | Who (tier) | Owns decisions about… | Rises to… |
|-------|-----------|------------|------------------------|-----------|
| **L0** | **Substrate-autonomous** | the SDK acting for any employee | reversible, bounded, in-scope, in-budget actions (P4 passes) — research, scoring, drafting, internal memory writes, HQ-only timeline entries | **L1** (the owning employee) when P4 fails |
| **L1** | **Specialist** | T2 / T3 / T4 | its own narrow capability scope; the *content* of its work-product (a score, a draft, a forecast, a route, a sweep) | its **L2** director, or a **specialist authority** (§7) for a cross-cutting act |
| **L2** | **Director** | T1 | a department's reversible work and budget; **approving subordinate (L1) work in scope** | its **L3** executive (cross-department, over-budget, high-impact) |
| **L3** | **Executive** | T0 (COO, CTO, CFO) | a function's strategy and arbitration; **approving director (L2) work in scope** | the **CEO** (cross-function) or **L5** (the executive's *own* high-impact act) |
| **L4** | **CEO** | T0 (CEO AI 01) | company strategy, prioritisation, cross-function arbitration | **L5** — every CEO act that commits the company externally, spends over threshold, changes production, or alters the roster |
| **L5** | **Human board** | the human owner | the apex of every ladder; the final word on *every* irreversible, external, financial, legal, roster, and ethical-boundary decision | — (terminal authority) |

Three rules make this a constitution rather than a diagram:

1. **One owner, never a committee (O2).** Every decision is owned by exactly one
   level-and-actor. Where several employees collaborate (a saga), each *stage*
   has a single owner; the saga as a whole is owned by its initiator. A "board
   decision" is the human board's single decision, informed by many — not a vote
   among AIs.
2. **Authority is bounded, and the bound is a limit (§8–§12).** An owner's
   authority ends precisely where a limit band ends. Exceeding the band is not a
   judgement call; it is an automatic rise to the next level.
3. **The ladder terminates at a human, always (O6).** No chain of AI authority is
   closed; L5 is the apex of every one. The CEO AI is the *apex orchestrator*, not
   the apex *authority* — the human board is.

**Worked owner-trace.** *Procurement (36) drafts a £4,000 materials order.* The
draft (reversible, internal) is owned and executed at **L0/L1**. *Placing* the
order is irreversible and spends money — it exceeds L1, so it rises: to the
**Financial authority** (CFO #4, §7) and, because it crosses the financial band
(§8), to a **human** (L5). Every step has exactly one owner; the order is never
ownerless and never placed by the orchestrator on its own.

---

## 5. Autonomy levels — the A0–A4 ladder (built from the P4 atom)

A tier is a *posture*; a decision needs a *gradation*. This volume names five
**autonomy levels** — the organised ladder of how much human involvement a given
act requires. Each level is a *consequence* of applying P4 (the atom) and the
limit bands (§8–§12) to an act; the levels do not re-derive P4, they **classify
its outcomes into a constitution**.

| Level | Name | Human involvement | When an act lands here |
|-------|------|-------------------|------------------------|
| **A0** | **Fully autonomous** | none | P4 passes outright — reversible ∧ low-blast-radius ∧ type-bounded ∧ in-capability-scope ∧ in-budget. Executes inline; recorded as a decision (§14). |
| **A1** | **Autonomous with notice** | informed, not gating | P4 passes, but the act is *notable* (a verdict that gates downstream work, a memory write to a shared zone, a forecast an executive consumes). Executes autonomously; a notice is dispatched (the human egress, `relationships.md` §3.3) so a human *could* intervene, but is not blocked on. |
| **A2** | **Peer/manager approval** | one approving AI authority | P4 fails on bound/scope but the act stays *inside* a band a manager owns — e.g. a director approving a subordinate's in-department reversible work, or a specialist authority clearing an in-policy act. Approver is an AI at the owning level (§4). |
| **A3** | **Executive approval** | a T0 executive | the act is high-impact but still inside the AI's delegated authority — cross-department coordination, in-policy spend at the CFO gate, a production-change *plan* (not the apply). |
| **A4** | **Human required** | the human board (or its delegate) | the act is irreversible/external/financial-over-band/legal/roster/ethical-boundary. **Always** a human checkpoint — by construction P4 fails and no AI level may clear it. |

**Tier → default autonomy level.** A tier sets the *default* level an employee's
acts fall to; the act's nature and band can push it higher (never lower).

| Tier | Default level | Always escalates to A4 for… |
|------|---------------|------------------------------|
| **T0 Executive** | A0/A1 for orchestration & decision; **A2/A3 as the *approver* for subordinates** | own spend over threshold, own production change, hiring/retiring an employee, external/legal commitment |
| **T1 Director** | A0/A1 for internal reversible work; **A2 as approver in department** | cross-department, over-budget, any external/financial/irreversible act |
| **T2 Specialist** | A0/A1 for reversible internal work (research, scoring, drafting, forecasting, docs, memory writes) | **every** external / customer / financial action |
| **T3 Channel** | A0/A1 for read, classify, route, draft, internal notes | **any outbound customer communication** (auto-send only narrow, pre-approved templates) |
| **T4 Platform** | A0/A1 for substrate ops within guardrails (consolidate, route, dispatch, sweep) | promoting private→shared memory canon (→ checkpoint); any customer/financial act (**none granted**); incidents → on-call human |

The ladder is the bridge from the substrate's binary atom (act/ask) to the
company's graded constitution. The atom decides *whether* a human is needed; the
ladder decides *which* human and *whether an AI authority is interposed first*.

---

## 6. Escalation paths — the rungs, triggers, and SLAs

Escalation is how a decision that exceeds its owner's authority *finds* the next
owner. This extends the escalation ladder (`relationships.md` §6.2) with explicit
triggers and timing. **An escalation always travels up; authority never travels
down** from observed content or a peer — only a human, in the console, grants
(the standing rule of `relationships.md` §6.2).

```
   L1 specialist  ──▶  L2 director  ──▶  L3 executive  ──▶  L4 CEO  ──▶  L5 human board
   (out of scope /     (cross-dept /     (high-impact /      (cross-      (ultimate
    over band)          over budget)      external/legal)     function)    authority)
```

### 6.1 What auto-escalates (the triggers)

| Trigger | From → to | Autonomy effect |
|---------|-----------|-----------------|
| P4 fails on an action | owner → its approver level | act parks at A2/A3/A4 (the matrix, §7) |
| A financial band is crossed (§8) | owner → CFO (#4) → human | A4 if over the human band |
| Any outbound customer comms (non-templated) (§9) | T3/owner → human | A4 |
| A security trust-boundary or risky production change (§10) | owner → Security (#8) → CTO/human | A3/A4; Security **can block** |
| A contract, regulatory commitment, or legal advice (§11) | owner → Legal & Compliance (#25) → human | A4 |
| An ethical prohibition is implicated (§12) | owner → **halt** → human | the act is refused, not merely escalated |
| Hiring/retiring an AI employee | owner → human board | A4 (board only) |
| Promoting private experience to shared canon | owner → the memory-canon checkpoint | A2/A4 (the learning loop, Volume XVI, gated here) |
| An unassignable decision (no capable owner) | engine → human task | A4 — surfaced, never silently stalled |

### 6.2 What times out to a human (the SLA)

A decision parked for approval must not rot. The **approval SLA is the Task
Engine's** (Volume XII) — this volume sets only the *policy* it enforces: an
unactioned approval **nudges**, then **escalates to the next owner up the ladder**,
and, if still unactioned past its window, **fails loudly with a `critical`
event** rather than silently expiring. The *timing values* (how long each rung
waits) are tuned on the review cadence (Volume XIV); the *escalation-rate and
time-to-decision metrics* are the dashboard's (Volume XVII). The constitutional
rule is simply: **no escalation is closed by neglect — it either reaches a human
or fails audibly.**

---

## 7. The approval matrix — the canonical table (the centrepiece)

This is the single table the whole company shares: for each **act-class**, at
each **value/risk band**, *who* is the required approver. It consolidates the
tier gate and the specialist authorities (`relationships.md` §6) into one law.
The Task Engine reads the *outcome* of this policy as an approval checkpoint
(Volume XII); this matrix *is* the policy. **A=autonomy level (§5)**; the
approver column names the authority that must clear the act before it applies.

| Act-class | Low / reversible / in-band | Medium / bounded | High / irreversible / over-band |
|-----------|----------------------------|------------------|----------------------------------|
| **Internal-reversible work** (research, scoring, drafting, forecasting, internal docs, HQ memory writes) | **A0** — owner, autonomous | **A1** — owner + notice if it gates downstream | A2 — owning director, if blast-radius rises |
| **Customer comms** (any outbound message to a customer/lead) | A1 — *only* a narrow pre-approved template (T3) | — | **A4 — human** (every non-templated send) §9 |
| **Spend / financial commitment** | A1 — within tier micro-budget, £0 direct for orchestrators | **A2/A3 — CFO (#4)** within policy band | **A4 — human** over the human band §8 |
| **Data / production change** (schema, migration, deploy, deletion) | A0 — review/draft only (reversible) | A3 — plan approved by CTO; **Security (#8) may block** | **A4 — human** to apply (deploy, migration, delete) §10 |
| **Contract / legal** (terms, regulatory commitment, advice-as-counsel) | A0 — flag/review only (Legal #25) | — | **A4 — human**; Legal (#25) is a mandatory stop §11 |
| **Hiring / retiring an AI employee** | — | — | **A4 — human board only** (no AI level clears it) |
| **Memory-canon promotion** (private experience → shared `public_hq`/`department`) | A0 — private/working memory writes | **A2 — the memory-canon checkpoint** | A4 — if the canon binds compliance/safety §12 |
| **Security waiver** (overriding a Security #8 block) | — | — | **A4 — CTO/human**; Security's block stands until a human waives it §10 |

### 7.1 The six specialist approval authorities (cross-cutting, independent of the line)

Some act-classes route to a *named* authority regardless of who initiated them —
the same act always meets the same gate (`relationships.md` §6.3, consolidated and
made canonical here):

| Authority | Owner → terminal | Mandatory for |
|-----------|------------------|---------------|
| **Financial** | CFO (#4) → human | any spend over threshold; an order Procurement (#36) drafts; a quote's commercial terms (§8) |
| **Legal / compliance** | Legal & Compliance (#25) → human | contracts; a `compliance.flagged` blocker on Site/Quote/Payroll; regulatory commitments (§11) |
| **Security** | Security (#8) — **can block** | the trust-boundary gate; a risky production change (waiver → CTO/human) (§10) |
| **Customer-send** | the human (via the T3 channel) | every outbound customer message that is not a pre-approved template (§9) |
| **Memory-canon** | the shared-knowledge checkpoint | promoting private experience to `public_hq`/`department` (gates the learning loop, Volume XVI) |
| **Hire/retire** | the human board only | adding or removing an employee from the roster (the change process, Volume XVIII) |

**How to read the matrix.** Authority is concentrated where accountability is.
The cheap, reversible, internal majority of company work is **A0** — autonomous,
by design, which is exactly why a lead-qualification verdict ships without a human
(P4). The irreversible, external, customer-, money-, production-, legal-, and
roster-touching minority is **A4** — a human, by construction, because P4 fails
and no AI authority may clear it. The middle is where the specialist authorities
and the director/executive approvers live. Reading any cell answers the only
question the constitution exists to answer: *whose decision is this?*

---

## 8. Financial limits — £ bands by tier, grounded in UK construction finance

Money is the sharpest limit because it is the least reversible. The financial
constitution: **no AI employee enacts a payment; AI computes, drafts, and
reconciles — a human enacts.** Spend authority is *banded* by tier, gated by the
CFO (#4), and terminates at the human board.

| Band | £ range (indicative; tuned on cadence, Volume XIV) | Who may *commit* | Autonomy |
|------|------|------------------|----------|
| **Zero direct spend** | £0 | T0 orchestrators (CEO/COO/CTO/CFO/Boardroom), all T4 platform | A0 to *plan*; **A4** to enact anything |
| **Micro / operational** | up to a small per-act ceiling (e.g. an API/tooling call within budget) | metered automatically per employee (the SDK cost budget) | A0 within budget; over → A2 |
| **Department** | a director's standing budget | T1 director, within department scope | A2 (director) → CFO if over band |
| **Policy** | above department, within CFO mandate | CFO (#4) | A3 (CFO) → human if over the human band |
| **Board** | any material commitment | the human board only | **A4** |

**Grounded in UK construction finance** (the company serves UK builders — its own
money discipline mirrors the domain it automates):

- **CIS (Construction Industry Scheme).** Payroll (#32) *calculates* subcontractor
  deductions (20% / 30% / gross status) and Finance (#21) reconciles; **submission
  of the CIS return to HMRC is human-enacted** (A4, external + financial — the
  Payroll & CIS saga, `relationships.md` §9.6). The deduction *status* is governed
  by Legal & Compliance (#25)'s regs zone, not chosen by the AI.
- **VAT domestic reverse charge for construction.** Quote Writer (#30) and Finance
  (#21) apply the reverse-charge treatment when computing a quote or invoice; the
  *commercial terms* of any quote (price, discount, margin) cross the **Financial
  authority** (CFO #4) and the human sends (A4 — the Quote-to-Job saga).
- **Retentions.** Holding and releasing retention on an application for payment is
  a *financial commitment*; the calculation is AI-drafted, the *release* is
  human-enacted.
- **Applications for payment / valuations.** Drafted by the relevant employee;
  the *submission* (an external, money-bearing act) is A4.

The standing rule: **AI may know the number to the penny; only a human may move
the money.** This is why every "money writer" in the capability matrix
(`relationships.md` §8 — Finance #21, Quote Writer #30, Cashflow #31, Payroll #32)
can compute and draft but every *enacting* act is human-gated.

---

## 9. Customer-impact limits — what may touch a customer

A customer is the most blast-radius-sensitive subject the company has: a wrong
internal score is reversible; a wrong message to a customer is not. The
constitutional rule is the T3 channel rule, raised to a company-wide limit:
**any outbound customer communication requires human approval (A4), with one
narrow exception.**

| Customer-touching act | Autonomy | Owner / gate |
|-----------------------|----------|--------------|
| Read, classify, route an inbound customer message | A0 | the channel employee (T3) |
| Draft a reply / write an internal account note | A0/A1 | the channel/support employee |
| Send a **pre-approved, narrowly-scoped templated acknowledgement** (e.g. "we've received your message") | A1 (template only) | the channel employee, within the template allow-list (a governance decision flagged in each T3 spec) |
| Send **any** non-templated customer message (email, WhatsApp, SMS, voice commitment) | **A4 — human** | the human, via the T3 channel; **the customer-send authority** (§7.1) |
| Make any **commitment** to a customer (a price, a date, a promise) | **A4 — human** | Voice/WhatsApp/Email/Scheduler never commit; the human does |
| Issue a refund / credit / goodwill gesture | **A4 — human** (financial + customer) | CFO gate (§8) + customer-send |

**Blast-radius thresholds.** The autonomy test's "low blast radius" condition (P4)
is interpreted for customers as: *bounded to a single, known account, with a
reversible internal effect.* A bulk action (a campaign send, a price change across
accounts, a mass notification) is *high* blast-radius by definition and lands at
A4 regardless of the per-message content. Marketing (#17) *drafts* a campaign
autonomously; **publishing or spending on it is A4** (the tier gate, §5).

The principle: **the company may think about a customer freely and act toward one
only with a human's word** — until a template is explicitly pre-approved as safe.

---

## 10. Security limits — the trust boundary and the block authority

Security is the limit that protects everything else, so it is the one limit an AI
may **enforce against its own company**: Security (#8) **can block** (the only
specialist authority with a veto), and a block stands until a *human* waives it.

| Security-bearing act | Autonomy | Gate |
|----------------------|----------|------|
| Threat review, RLS/permission audit, security scoring (read-only) | A0 | Security (#8), autonomous |
| **Blocking** a risky change at the trust-boundary gate | A0 to block; the block **holds** | Security (#8) — the veto; an AI may stop, never silently pass |
| Overriding (waiving) a Security block | **A4 — CTO/human** | the waiver is a human decision, fully recorded |
| Preparing a deployment / migration | A0/A3 (plan) | DevOps (#9), Database (#11) prepare |
| **Applying** a production change (deploy, migration apply, deletion) | **A4 — human** | production change is human-gated even under incident (`relationships.md` §9.4) |

The trust-boundary gate is the constitutional expression of **P5 (the doorman)**:
the AI holds no database keys and no service-role handle; it makes audited
requests through the SDK to validated entry points. Security's authority operates
*above* that doorman — it reviews and can block the *requests*, but the doorman
itself is the substrate's, not this volume's. **This volume does not re-implement
the permission gate; it names Security's standing to block and a human's sole
standing to waive.** Production stability is a limit: nothing reaches production
without a human, and a security objection is presumed correct until a human
overrules it.

---

## 11. Legal limits — contracts, advice, and UK regulatory commitments

The legal limit binds the company to the law of the jurisdiction it operates in —
UK construction — and to the contracts it is party to. The rule: **AI flags,
reviews, and checks compliance; it never gives advice as counsel, signs, or
commits the company to a regulator — a human does.**

| Legal-bearing act | Autonomy | Gate |
|-------------------|----------|------|
| Contract review; clause flagging | A0 | Legal & Compliance (#25), autonomous |
| Compliance check against the regs zone | A0 | Legal & Compliance (#25) — and a `compliance.flagged` event **blocks** the affected work (Site/Quote/Payroll) |
| Giving legal **advice as counsel** | **A4 — human** | the AI advises *internally*; counsel is human |
| **Signing** a contract / committing to terms | **A4 — human** | the customer-send + financial gates also apply |
| A **regulatory commitment** (a filing, a notification to a regulator) | **A4 — human** | external + legal, always |

**Grounded in UK construction law** (the regs zone, owned by Legal & Compliance
#25, is a *mandatory read* for Site #34, Quote #30, Payroll #32 —
`relationships.md` §7):

- **CDM 2015 (Construction (Design and Management) Regulations).** Duty-holder
  obligations, RAMS, and on-site safety governance are checked by Legal &
  Compliance (#25); a CDM non-conformance is a `compliance.flagged` blocker — it
  *stops* the dependent work (a quote, a site action) until cleared.
- **Building Safety Act 2022.** Gateway and higher-risk-building obligations are a
  compliance dependency; any commitment touching them is A4 (human) and Legal
  (#25) is a mandatory stop.
- **CIS status determination** (the legal side of §8's financial CIS): the
  *deduction status* is a compliance judgement (Legal #25's regs zone), not a
  Payroll choice.

A `compliance.flagged` event is the legal limit *operating*: a fact that
**blocks** rather than merely informs, fanning out to every affected employee
(`relationships.md` §4). The company may assess its legal position autonomously;
it may *act* on a legal question only through a human.

---

## 12. Ethical limits — the constitutional prohibitions no authority can grant

Every limit so far is a *band*: exceed it and you escalate. The ethical limits are
different in kind — they are **absolute prohibitions**. No tier, no approver, not
the CEO AI, not even an A4 human approval *within the system* can authorise them;
they bind every level including T0, and the only body that could ever revisit
them is the human board amending the constitution itself. An employee that finds
its proposed action implicating one of these does not escalate — it **refuses and
halts** (§6.1), surfacing to a human with the reason.

**The prohibitions (no authority within the company may grant these):**

1. **Deceiving a customer.** No employee may knowingly send a customer a false or
   materially misleading statement — about price, capability, timing, safety, or
   status. (This is why customer-send is A4 *and* truthful by constitution.)
2. **Fabricating a compliance or safety record.** No employee may create, alter,
   or backdate a CDM/Building-Safety/CIS/RAMS or any safety or compliance record
   to misrepresent reality. Compliance records are evidence, never narrative.
3. **A discriminatory decision.** No employee may make a hiring, pricing, service,
   or qualification decision on a protected characteristic. Qualification (#14)
   scores against the ICP rubric — never against a protected attribute.
4. **Concealing an incident.** No employee may suppress, delay past the SLA, or
   hide an incident, breach, or material error from the humans entitled to know.
   The incident playbook (Volume XIV) and the override (§13) assume full
   disclosure; concealment voids both.
5. **Acting outside capability scope.** No employee may take an action it holds no
   capability for, or impersonate an authority it does not have. This is the
   constitutional form of the SDK's least-privilege default — *default-locked*,
   and unbreakable by escalation.

These are stated here as policy, not mechanism. *Where* they are mechanically
caught is partly the substrate (an out-of-scope capability is refused by the SDK,
P5; a fabricated record fails verification, Volume XII) and partly human review.
The constitution's contribution is to declare them **non-negotiable**: a limit
band asks *how far?*; an ethical prohibition answers *never* — and that answer is
the same for every employee, at every tier, with no override.

---

## 13. The emergency override — break-glass and human supremacy (O6)

The override is the operational form of **O6(a)**: *a human can always inspect,
pause, override, or reverse any AI decision, and the board is the apex of every
escalation ladder.* It is the constitution's ultimate guarantee — the one power
that needs no AI's cooperation to exercise.

### 13.1 Scope of the break-glass

A human with override authority may, at three blast radii:

| Scope | Effect | Who may invoke |
|-------|--------|----------------|
| **Pause an employee** | a single employee stops claiming and running work; in-flight tasks park or compensate | any authorised human (typically via the relevant executive's surface) |
| **Halt a department** | every employee in a division stops; the division's sagas suspend | an executive-level human authorisation |
| **Halt the company** | the whole workforce stops claiming work; only the override and audit surfaces remain live | the human board |

The override is **deliberately the inverse of normal authority**: normal decisions
flow up to a human only when they exceed a band; the override flows *down* from a
human to *any* level instantly, without passing through the AI hierarchy. No AI
can refuse, delay, or escalate-around it.

### 13.2 The mechanics (policy, not new machinery)

The override is **not a new mechanism** — it composes the substrate. A pause is a
state on the affected employee(s) that the Task Engine respects (paused employees
do not claim; in-flight tasks park via the existing `waiting_approval`/cancel
paths, Volume XII); a halt is the same applied across a set. The invocation, the
scope, the reason, and the invoking human are **recorded as events** in the one
log (`hq_events`, P1) — the override is audited like everything else (O6(b)).
This volume specifies *who may invoke what, and that it is absolute*; it builds no
override engine.

### 13.3 Re-authorisation to resume

Resuming is itself a human decision, and a deliberate one — a paused employee or
halted department does **not** auto-resume on a timer. A human re-authorises:
the reason for the pause is reviewed, any required remediation is confirmed (the
incident lesson, Volume XVI, may gate it), and a recorded human action lifts the
pause. **The asymmetry is intentional:** stopping is instant and unilateral;
restarting is considered and recorded. The audit trail of an override —
invocation, scope, reason, remediation, re-authorisation — is reconstructable by
`correlation_id` like any other company history (O6(b)).

### 13.4 The absolute primacy of the human board

Above every override authority sits the human board. The board's word is terminal
and unappealable: it is the apex of L5, the only body that may halt the entire
company, and the only body that may amend the constitution itself (including the
ethical prohibitions, §12). **The CEO AI orchestrates; the board governs.** This
is the final settlement of the company's authority — and the reason every
escalation ladder, without exception, ends at a human.

---

## 14. Decision records — every decision is an auditable event (O6)

A constitution is only real if its decisions are *recorded*. Every decision in
this framework — autonomous (A0), noticed (A1), approved (A2/A3/A4), refused
(§12), or overridden (§13) — is an event in the one log (`hq_events`, P1),
carrying the standard AI output envelope's **reasoning and confidence** (P3). The
company's entire decision history is therefore reconstructable, by construction.

- **What is recorded.** The decision's owner (actor + level), the act-class and
  band, the autonomy level applied, the P4 outcome, the approver (if any) with
  *who/when/why*, the P3 `reasoning` and `confidence`, and the linked
  `evidence[]`. An approval carries its `hq_ai_task_approvals` reference (Volume
  XII); a refusal carries the prohibition it hit (§12); an override carries its
  scope and invoking human (§13).
- **The decision log is a projection, not a parallel truth (O4).** "Show me every
  decision in this saga" is `WHERE correlation_id = X ORDER BY id` over the event
  spine — the same trace that reconstructs everything else. There is no second
  decision database; the log is a *view* over `hq_events`, owned for *display* by
  the dashboard (Volume XVII), owned for *truth* by the bus (Volume XI).
- **Reconstructable by `correlation_id` (O6).** Because the autonomy decision, the
  approval, the human's note, the refusal, and any override all share the saga's
  `correlation_id`, the *why* behind any company action is always recoverable —
  which decision was made, by whom, at what level, on what evidence, with what
  confidence, and whether a human cleared it.

The *metrics* over these records — approval rate, escalation rate, time-to-
decision, override frequency — are not defined here; they are the decision-quality
KPIs (Volume XVII), projected from exactly this log.

---

## 15. Cross-axis seams — where AUTHORITY meets the other four

AUTHORITY is orthogonal to the other four axes but touches each at a defined seam;
each citation is by **volume + named concept** (never a sibling section number).

| Seam | This volume owns | The other volume owns |
|------|------------------|------------------------|
| **TIME** | the authority *to decide* in a meeting; the limit bands a periodic review may adjust | *when* a decision review happens — the planning/review cadence (Volume XIV); the incident-response rhythm |
| **LEARNING** | the **memory-canon gate** (§7.1) that promotion must pass; the authority to act on a lesson | the lesson-capture loop and best-practice propagation (Volume XVI); the blameless post-mortem |
| **MEASUREMENT** | the decisions and approvals that *generate* the records (§14) | the approval-rate, escalation-rate, and time-to-decision KPIs and dashboards (Volume XVII) — projected from the decision log |
| **CHANGE** | the **hire/retire gate** (§7.1, human board only) and the authority to apply a change | the add/retire and versioning *process* itself (Volume XVIII); the directive→change pipeline |
| **Incident response** | the **emergency override** (§13) — who may pause/halt | the incident playbook & rhythm (Volume XIV); incident KPIs/MTTR (Volume XVII); the incident lesson (Volume XVI) |

The rule of the seam: **this volume decides *who may decide and how far*; the
neighbour decides *when, how well, what was learned, and how it changes*.** Where
a neighbour needs an authority answer, it cites this volume; this volume never
restates a neighbour's mechanism.

---

## 16. Failure & recovery — when the constitution is breached

| Failure | Detection | Recovery |
|---------|-----------|----------|
| **An out-of-authority act** (an employee acts beyond its band, or a P4 misclassification lets an irreversible act through) | the event log (P1) shows an act without its required approval record; verification (Volume XII) or a human review catches it | **reverse** via the act's compensation (the saga's inverse actions, Volume XII — archive the memory, retract the message); record the breach; the lesson feeds the learning loop (Volume XVI); if it recurs, the band or the P4 classification is tightened on the review cadence (Volume XIV) |
| **A stuck escalation** (an approval parked and unactioned) | the approval SLA sweep (Volume XII) finds it past its window | nudge → escalate up the ladder → **fail loudly** with a `critical` event (§6.2) — never silent expiry; the human egress (`relationships.md` §3.3) surfaces it |
| **An abused override** (a pause invoked without cause, or a halt left in place too long) | every override is an audited event (§13.2); its scope, reason, and duration are visible | the override is reviewed against its recorded reason; re-authorisation (§13.3) is the controlled exit; a pattern of abuse is a board matter (the board governs the override itself, §13.4) |
| **An ownerless decision** (a decision with no capable owner) | the engine cannot route it (no capable employee, Volume XII assignment) | it **escalates to a human task** ("no owner for X") rather than stalling (§6.1) — O2 holds: every decision finds an owner, ultimately the human |
| **A refused ethical act** (§12) that is *also* business-critical | the refusal is recorded with its prohibition | the *act* stays refused (absolute); the *underlying need* escalates to a human to solve **a lawful, truthful way** — the prohibition is never traded away, the problem is re-solved |

The recovery doctrine: **a breach is reversed, recorded, and learned from; it is
never normalised.** Because every decision is an event (§14), every breach is
visible; because the override is absolute (§13), every breach is stoppable; and
because authority always terminates at a human (§4), every breach has someone
accountable to fix it.

---

## 17. Conflicts resolved — C2, generalised into a constitution

This volume is the **canonical resolution surface for conflict C2**: *"humans
always decide"* (one part of the Bible) versus a **shipped autonomous**
lead-qualification employee (another part). The substrate already resolved C2 *at
the level of a single action* with P4 — the autonomy test. **This volume resolves
it at the level of the whole company** by generalising P4 into a constitution:

- The Bible's *"humans always decide"* is true **for the class of decisions the
  constitution reserves to humans** — the A4 band: everything irreversible,
  external, financial-over-band, customer-facing, production-changing, legal,
  roster-altering, or ethically prohibited. For these, no AI authority exists; a
  human always decides. §7–§13 enumerate exactly this set.
- The **shipped autonomy** is true **for the class the constitution delegates** —
  the A0/A1 band: reversible, bounded, in-scope, in-budget, internal work. For
  these, an owner decides autonomously, recorded but not gated. §4–§5 define
  exactly this delegation, and Qualification (#14)'s autonomous verdict is its
  canonical instance.

The two statements were never in conflict; they were two ends of one ladder
without a ladder drawn between them. The substrate drew the **atom** (P4); the
workforce drew the **postures** (the tiers); this volume draws the **constitution**
— the named levels (§4), the autonomy ladder (§5), the one matrix (§7), the
explicit bands (§8–§12), and the override (§13) — that makes "humans always
decide *the things that matter*, and the company moves autonomously *on the things
that don't*" a precise, owned, auditable settlement rather than a slogan. **C2 is
not merely reconciled; it is constitutionalised.**

---

## 18. Open questions — for a future directive

1. **The exact financial band figures.** §8's £ ranges are indicative. The
   precise per-tier ceilings, the CFO policy band, and the board threshold are a
   business decision for the human board, to be set and then tuned on the review
   cadence (Volume XIV). *Recommendation: start conservative (low autonomous
   ceilings), widen as the approval-rate KPI (Volume XVII) shows the bands are
   too tight.*
2. **The pre-approved customer-template allow-list.** §9 permits A1 auto-send for
   *narrow* pre-approved templates. *Which* acknowledgements qualify is a
   governance decision the human board must ratify per channel (flagged in each
   T3 spec) before any auto-send is enabled. *Recommendation: ship with the
   allow-list empty (all sends A4) and add templates one at a time.*
3. **Override delegation.** §13 vests the company-halt in the human board.
   *Whether* (and to whom) the board delegates the narrower pause/department-halt
   authorities — and the on-call rota that holds them out of hours — is an
   operational decision a future directive must fix.
4. **Amending the ethical prohibitions.** §12 makes the prohibitions absolute and
   amendable only by the board. The *process* for such an amendment (how the board
   proposes, reviews, and ratifies a constitutional change) belongs to the change
   process (Volume XVIII) and is not yet specified.
5. **Multi-human approval for the largest acts.** Whether the very highest band
   (e.g. a board-level commitment) should require *more than one* human's
   approval, and how that is recorded, is an open governance question.

---

*Volume XV of the CrewFlow Bible — the Operating Model layer. Architecture only —
no code, no production change, no migration, no PR. Composes the AI Substrate
(IX–XIII) and the AI Workforce (Layer 4); re-implements neither.*
