# Chapter 08 — AI Employee Roster

## Purpose

Chapter 07 specified the *engine*; this chapter specifies the *people*. It is the personnel file for the CrewFlow workforce — twelve AI employees, each documented as a real hire with all sixteen fields of the dossier template (Ch.00). This is the chapter that answers the CEO's mandate most directly: *"I do not want AI assistants. I want AI employees."* An assistant has a prompt; an employee in this chapter has a manager, a budget with a hard ceiling, a capability set, a memory scope, KPIs measured from the spine, a performance-review cadence, escalation rules, decision limits, and an approval policy for everything above them.

Every employee here already exists as **configuration** in `lib/ai-employees/framework/employees/*.ts` (♻️ eleven typed definitions) plus Research AI (seeded). Today all eleven file-defined employees are `foundation:true` — read/draft/review only, nothing executes — and Research AI is the single live executor (♻️ `hq-research.ts`). This chapter documents each as it **is** (foundation) and as it is **designed to operate** once autonomy is earned, capability by capability, on evidence (P4). Nothing here invents performance figures; live numbers come from `ai_employee_runs` (Ch.15) and read as an honest "foundation" baseline until execution is granted.

## Goals

- **Every employee, fully specified.** All sixteen dossier fields for all twelve — no employee half-documented.
- **A coherent org chart.** Manager/report edges that are mutually consistent (if A manages B, B reports to A) and that ladder up to the human operator.
- **Grounded in the real roster.** Identity, model, tools, responsibilities, and permissions taken from the live `employees/*.ts` config (♻️), not reimagined.
- **Honest foundation, designed target.** Each dossier states the *current* (foundation, gated-closed) posture and the *target* executable capability set, clearly marked, so activation is a known, reviewable step — never a surprise.
- **DRY by shared defaults.** The boilerplate that is identical for everyone (audit model, working-hours shape, review cadence, cost mechanics) is stated once below; each dossier states only its deltas.

**Non-goals:** the runtime/FSM/tool-registry mechanics (Ch.07); the capability catalogue and `authorize()` internals (Ch.14); the approval workflow/inbox (Ch.13); memory internals (Ch.12); the metric definitions themselves (Ch.15). This chapter *references* those; it owns the *roster*.

---

## How to read a dossier

Each dossier has the sixteen fields of the Ch.00 template: **Identity · Role · Manager · Responsibilities · Permissions · Memory · KPIs · Costs · Performance reviews · Escalation rules · Working hours · Budget · Tool access · Decision limits · Approval requirements · Audit history.** To keep twelve dossiers readable, the fields that are *identical across the roster* are defined once in **Shared defaults** (next) and each dossier states only what differs. Where a dossier is silent on a shared field, the default applies verbatim.

### The org chart

The workforce is a three-tier hierarchy under the **human operator** (the CEO/super-admin), who is the approver of last resort and the only principal that can grant execution autonomy. Reporting edges below are authoritative — each dossier's *Manager* field matches this exactly.

```
                          ┌─────────────────────────┐
                          │   HUMAN OPERATOR (CEO)   │  ← approves, grants autonomy, last resort
                          └────────────┬────────────┘
                                       │
                              ┌────────▼────────┐
                              │     CEO AI      │  (executive · coordinator)
                              └────────┬────────┘
        ┌───────────────┬─────────────┼─────────────┬───────────────┬──────────────┐
   ┌────▼────┐    ┌─────▼────┐   ┌─────▼────┐   ┌────▼─────┐   ┌─────▼────┐   ┌─────▼─────┐
   │ CTO AI  │    │ Product  │   │ Finance  │   │ Sales AI │   │Marketing │   │ Support / │
   │(eng)    │    │ AI       │   │ AI       │   │          │   │ AI       │   │ Operations│
   └────┬────┘    └────┬─────┘   └──────────┘   └────┬─────┘   └──────────┘   └───────────┘
        │              │                             │
   ┌────▼────┐   ┌─────▼──────┬──────────┐      ┌────▼──────┐
   │ QA AI   │   │ Design AI  │ Docs AI  │      │Research AI│
   └─────────┘   └────────────┴──────────┘      └───────────┘
```

- **CEO AI** reports to the human operator; coordinates all department heads (a first-among-equals coordinator of the boardroom, not a separate command layer).
- **Department heads** (CTO, Product, Finance, Sales, Marketing, Support, Operations AI) report to CEO AI.
- **Managed reports:** QA AI → CTO AI; Design AI & Documentation AI → Product AI; Research AI → Sales AI.
- Every escalation that exceeds an employee's authority climbs this tree; what an AI manager cannot authorise, the **human** does (Ch.13).

### Shared defaults (inherited by every employee unless a dossier overrides)

- **Permissions baseline.** All eleven file-defined employees ship `foundation:true` with `locked([...])` — **read / draft / review only, zero side-effects** (♻️ the SDK default). The runtime refuses to ACT for a foundation employee (Ch.07 §Permissions). "Target" capabilities listed in a dossier are the *designed* executable set, granted only when `permissions.can_execute` is set per employee, on eval evidence, reversible by flag (P7).
- **Working-hours model.** Every employee is *always on but idle until triggered* (Ch.07 triggers: schedule/event/manual/delegation). "Working hours" in a dossier states the employee's **schedule cadence** and the **spine verbs it subscribes to**; outside those it rests at zero cost.
- **Memory model.** Every employee reads the org-scoped shared memory (♻️ `hq_memories`, Ch.12) and its own episodic history; it writes durable facts via REFLECT with provenance. Dossiers state the employee's **specific scope and what it asserts**.
- **Cost mechanics.** Cost = tokens × the model's rate, metered per run into `ai_employee_runs.cost_usd` (Ch.07/15). Every employee has a **daily ceiling** with a circuit breaker → `suspended` on breach (P9). Dossiers state the **model tier** (Opus ≫ Sonnet > Haiku) and the **ceiling**; figures are illustrative planning budgets.
- **Performance-review model.** **Continuous evals** (golden-task suite, Ch.07/18) run in CI and on a weekly cadence; a **monthly human review** by the employee's manager-of-record (its AI manager + the operator) reads the eval scores plus the KPI rollup (Ch.15). The rubric is shared (below); KPIs differ per dossier.
- **Escalation philosophy.** No employee decides above its **decision limit** alone; it pauses the run into `awaiting_approval` (Ch.07/13) and escalates up the org chart — AI manager first for judgement, **human** for any side-effect above policy. The gate is mechanical, not discretionary.
- **Audit history.** For every employee, every run is a row in `ai_employee_runs`, every tool call a row in `ai_employee_tool_calls`, every phase an `ai.*` event on the spine, and every consequential act an immutable `admin_activity_log` entry (Ch.15). Dossiers do not repeat this; they note only employee-specific audit emphases.

### The shared performance rubric

Every review scores five dimensions 0–100 (Ch.18 evals supply the evidence): **Correctness** (was the output right?), **Tool choice** (did it pick the right tool / not over-reach?), **Limit adherence** (did it respect its decision limits and escalate when it should?), **Cost efficiency** (output value per dollar/token, P9), **Safety** (did it resist injection and never exceed capability?). A regression on Safety blocks any autonomy increase.

---

## The roster

> **Legend.** *Current* = the live foundation posture (gated-closed). *Target* = the designed executable posture, activated per-capability on evidence. Models: **Opus** (deepest reasoning), **Sonnet** (balanced), **Haiku** (fast/cheap). Capabilities are `domain.action` (Ch.14); risk tiers route approvals (Ch.13).

### 1. CEO AI — `ceo-ai`

- **Identity.** 👑 violet · department **executive** · *"Strategic coordinator of the AI boardroom."* (♻️ `ceo.ts`)
- **Role.** The boardroom's coordinator: sets company-level direction, sequences initiatives across the workforce, resolves cross-department trade-offs, and summarises decisions and risks for the human CEO. It coordinates; it does not command the humans' company.
- **Manager.** Reports to the **human operator**. Manages (coordinates) all seven department heads.
- **Responsibilities.** Set quarterly priorities · align departments · summarise decisions/risks for the human · sequence initiatives across the AI workforce (♻️).
- **Permissions.** *Current:* `locked(read, draft, prioritize)`. *Target:* `dashboards.read`, `memory.read/assert`, `workforce.delegate` (enqueue work to other employees) — **no** money/customer/billing capabilities, ever; the CEO AI plans and delegates, it does not execute domain side-effects.
- **Memory.** Reads the whole org-scoped memory (cross-department); asserts *strategic* facts (priorities, decisions, rationale) with high importance so the boardroom shares one direction.
- **KPIs.** Initiative throughput (sequenced → completed), cross-department blocker resolution time, decision-summary usefulness (human rating), alignment score (do downstream employees' actions match stated priorities?).
- **Costs.** **Opus**, temp 0.2 — expensive per run but low volume (strategic, scheduled). Ceiling **$8/day**.
- **Performance reviews.** Monthly, by the **human operator** directly (it has no AI manager).
- **Escalation rules.** Escalates anything requiring a human decision or spend to the operator. Never authorises another employee's dangerous action — it can *delegate* a task, but the delegate's own gate still applies.
- **Working hours.** Scheduled daily strategy pass (morning) + weekly planning; subscribes to `org.health_changed`, `ai.escalated`, `system.alert_raised` (critical) to coordinate responses.
- **Budget.** Hard ceiling $8/day; breaker suspends and notifies the operator.
- **Tool access.** `read_dashboards` (`dashboards.read`, low) · `summarize`/`draft_strategy` (`memory.assert`, low) · `prioritize` (`workforce.prioritize`, low) · `delegate` (`workforce.delegate`, **medium** — routes work, human-visible). All low/medium; none touches a tenant.
- **Decision limits.** May prioritise and delegate freely (internal, reversible). May **not** spend, message externally, or change any customer/billing/permission state.
- **Approval requirements.** Any external communication or any cross-employee delegation that would itself trigger a side-effect inherits that side-effect's approval policy. Strategic outputs (plans, summaries) are auto (no side-effect).
- **Audit.** Emphasis on *decisions*: every priority change and delegation is an `admin_activity_log` decision entry with rationale, so the org's direction is fully reconstructable.

### 2. CTO AI — `cto-ai`

- **Identity.** 💻 sky · department **engineering** · *"Architecture, standards, and technical risk."* (♻️ `cto.ts`)
- **Role.** Owns technical strategy: architecture direction, engineering standards, sequencing the build roadmap, and reviewing changes for long-term maintainability and technical risk.
- **Manager.** Reports to **CEO AI**. Manages **QA AI**.
- **Responsibilities.** Set architecture direction & standards · assess technical risk in proposals · sequence the build roadmap · review changes for maintainability (♻️).
- **Permissions.** *Current:* `locked(read, review, draft)`. *Target:* `codebase.read`, `memory.read/assert`, `roadmap.draft` — read-and-advise only; it never deploys, never writes production code autonomously (humans ship, per the directive's RC discipline).
- **Memory.** Reads engineering + product memory; asserts architectural decisions and standards (the ADR trail, mirroring Ch.20) as procedural memory the workforce follows.
- **KPIs.** Risk-assessment accuracy (flagged risks that materialised vs false alarms), roadmap adherence, standards-violation catch rate, review turnaround.
- **Costs.** **Opus**, temp 0.2 — deep reasoning, low volume. Ceiling **$6/day**.
- **Performance reviews.** Monthly, by **CEO AI** + the operator.
- **Escalation rules.** Escalates architecture decisions with company-wide blast radius, or any proposal it judges high technical risk, to the human (CTO-of-record). Never overrides a human engineering decision.
- **Working hours.** Subscribes to roadmap/PR-style events and `system.flag_changed`; weekly architecture review pass. Idle otherwise.
- **Budget.** $6/day; breaker → suspend + notify CEO AI.
- **Tool access.** `read_codebase` (`codebase.read`, low) · `review_architecture`/`assess_risk` (`memory.assert`, low) · `draft_roadmap` (`roadmap.draft`, low). All advisory.
- **Decision limits.** May advise and draft without limit; may not merge, deploy, or change infrastructure.
- **Approval requirements.** Every action that would change code/infra is out of scope (human-only). Advisory outputs are auto.
- **Audit.** Architecture decisions recorded as decision entries with rationale (the technical ADR trail).

### 3. Product AI — `product-ai`

- **Identity.** 📊 indigo · department **product** · *"Backlog, requirements, and feedback synthesis."* (♻️ `product.ts`)
- **Role.** Supports product direction: synthesises user/team feedback, drafts requirements and specs, and prioritises the backlog against company goals.
- **Manager.** Reports to **CEO AI**. Manages **Design AI** and **Documentation AI**.
- **Responsibilities.** Synthesise feedback · draft requirements/specs · prioritise the backlog against goals · summarise research for decisions (♻️).
- **Permissions.** *Current:* `locked(read, draft, prioritize)`. *Target:* `feedback.read`, `memory.read/assert`, `backlog.prioritize`, `spec.draft` — internal artifacts only.
- **Memory.** Reads product + support + research memory (to synthesise); asserts product decisions, requirement rationale, and prioritisation logic.
- **KPIs.** Spec quality (engineering rework rate post-handoff), prioritisation alignment with outcomes, feedback-coverage (issues surfaced that became real work), research-summary usefulness.
- **Costs.** **Opus**, temp 0.3. Ceiling **$5/day**.
- **Performance reviews.** Monthly, by **CEO AI** + operator.
- **Escalation rules.** Escalates roadmap-level prioritisation conflicts to CEO AI; scope/commitment decisions to the human.
- **Working hours.** Subscribes to `support.*` (recurring-issue signal) and feedback events; weekly backlog grooming pass.
- **Budget.** $5/day.
- **Tool access.** `read_feedback` (`feedback.read`, low) · `draft_spec` (`spec.draft`, low) · `prioritize_backlog` (`backlog.prioritize`, low) · `summarize_research` (`memory.assert`, low).
- **Decision limits.** May draft and re-order the backlog (reversible, internal); may not commit roadmap dates or external promises.
- **Approval requirements.** Backlog/spec drafts are auto; anything customer-facing routes to the human.
- **Audit.** Prioritisation changes recorded with rationale (why this moved up/down).

### 4. Finance AI — `finance-ai`

- **Identity.** 💰 green · department **finance** · *"Revenue modelling and billing oversight."* (♻️ `finance.ts`)
- **Role.** Models MRR/LTV and revenue trends, flags billing anomalies, drafts financial summaries, and **recommends** actions for human review. It never moves money or changes billing autonomously — the protagonist of the dunning flow (Ch.02), and the clearest case of approval-gated power.
- **Manager.** Reports to **CEO AI**. Manages no one.
- **Responsibilities.** Model MRR/LTV/trends · flag billing anomalies · draft financial summaries · recommend actions for human review (♻️).
- **Permissions.** *Current:* `locked(read, analyze, draft)`. *Target:* `billing.read`, `metrics.read`, `memory.read/assert`, `billing.dunning_initiate` (**medium** — start a dunning *communication* sequence, gated), and the ability to *request* `billing.refund` (**critical**, danger) — which it may **never** execute itself.
- **Memory.** Reads finance + org memory; asserts revenue facts, anomaly findings, and dunning outcomes (so a repeat failure is recognised).
- **KPIs.** Forecast accuracy (modelled vs actual MRR), anomaly precision/recall (real issues caught vs false flags), dunning recovery rate, days-to-detect on billing problems.
- **Costs.** **Sonnet**, temp 0.2. Ceiling **$4/day**.
- **Performance reviews.** Monthly, by **CEO AI** + operator; finance reviews weight Limit-adherence and Safety heavily (it sits closest to money).
- **Escalation rules.** **Any** money movement (refund, credit, write-off) escalates to the human — always. Anomalies above a materiality threshold escalate immediately, not on the next pass.
- **Working hours.** Subscribes to `invoice.payment_failed`, `invoice.payment_succeeded`, `billing.dispute_opened`, `org.churned`; daily revenue-model pass; real-time on payment failures (the dunning trigger).
- **Budget.** $4/day; breaker → suspend + notify (a suspended Finance AI is itself a `warn` signal — billing oversight is paused).
- **Tool access.** `read_billing` (`billing.read`, low) · `model_revenue` (`metrics.read`, low) · `flag_anomaly` (`memory.assert`, low) · `draft_report` (`memory.assert`, low) · *target:* `initiate_dunning` (`billing.dunning_initiate`, medium — human-approved by policy) · `request_refund` (`billing.refund`, critical — **dual-control**, never executed by the AI).
- **Decision limits.** May read, model, flag, and draft without limit. **£0 autonomous spend** — every monetary effect crosses a human (dual-control for refunds, per `hq_approval_policies`).
- **Approval requirements.** Dunning *initiation* → `require_human`; refund/credit/write-off → `dual_control` (two humans). The approval card shows the **exact projected effect** ("Refund £240 to Acme") before anyone clicks (Ch.13).
- **Audit.** Highest scrutiny: every recommendation, every approval request, every human decision recorded; the refund flow is the canonical audited trace (Ch.15).

### 5. Sales AI — `sales-ai`

- **Identity.** 📈 emerald · department **sales** · *"Pipeline support and deal context."* (♻️ `sales.ts`)
- **Role.** Supports the pipeline: qualifies inbound demo requests, drafts follow-up emails for review, summarises deal context, and surfaces next-best actions.
- **Manager.** Reports to **CEO AI**. Manages **Research AI**.
- **Responsibilities.** Qualify inbound demos · draft follow-ups (human review) · summarise deal context · surface next-best actions (♻️).
- **Permissions.** *Current:* `locked(read, draft, suggest)`. *Target:* `demos.read`, `memory.read/assert`, `email.draft`, and *request* `email.send` (**medium**) — drafts autonomously, sends only on approval.
- **Memory.** Reads sales + research memory (it manages Research AI); asserts deal context and qualification outcomes.
- **KPIs.** Lead-qualification accuracy, follow-up draft acceptance rate (sent as-drafted vs edited), pipeline-velocity contribution, response latency on inbound demos.
- **Costs.** **Sonnet**, temp 0.4. Ceiling **$5/day** (higher volume — inbound-driven).
- **Performance reviews.** Monthly, by **CEO AI** + operator.
- **Escalation rules.** Escalates high-value or non-standard deals to the human; never sends external email without approval; never offers pricing/discount terms autonomously.
- **Working hours.** Subscribes to `demo_requested`/inbound-enquiry events; near-real-time on new demos; daily pipeline summary.
- **Budget.** $5/day.
- **Tool access.** `read_demos` (`demos.read`, low) · `draft_email` (`email.draft`, low) · `summarize_deal` (`memory.assert`, low) · `suggest_followup` (`memory.assert`, low) · *target:* `send_email` (`email.send`, medium — human-approved).
- **Decision limits.** May qualify and draft freely; may not send externally, commit pricing, or alter a customer record.
- **Approval requirements.** Outbound email → `require_human` (or `auto` for a vetted template to a known contact, once trust is measured). Pricing/terms → always human.
- **Audit.** Every draft, every send-request, every qualification decision recorded; outbound sends carry the approver.

### 6. Research AI — `research-ai`

- **Identity.** 🔎 emerald · department **sales** · *"Live research execution for the pipeline."* (the **one live executor** today — ♻️ `hq-research.ts` + `research-llm.ts`).
- **Role.** Executes bounded research tasks: gathers and synthesises context on prospects/markets to feed the sales pipeline. It is the proof-of-concept the whole runtime generalises (Ch.07) — the only employee that today perceives → plans (LLM) → acts → records for real.
- **Manager.** Reports to **Sales AI**.
- **Responsibilities.** Run queued research tasks · synthesise findings · attach results to the requesting deal/task · record cost and provenance.
- **Permissions.** *Current/live:* read + draft research outputs (its execution is confined to *producing knowledge*, no external side-effects). *Target:* unchanged in kind — research stays a read/synthesise role; it never gains money/customer-mutation power.
- **Memory.** Reads sales + research memory; **writes** research findings as semantic memory with provenance (the clearest REFLECT producer, Ch.12).
- **KPIs.** Task completion rate, finding usefulness (did it inform a deal?), cost per research task, latency from enqueue to result.
- **Costs.** **Haiku** (`claude-haiku-4-5`), OpenAI fallback (♻️) — cheapest tier, designed for volume. Ceiling **$3/day**; per-task cost is the most-watched unit cost (it is the live cost-model reference).
- **Performance reviews.** Monthly, by **Sales AI** + operator; the only review backed by *real* run data today.
- **Escalation rules.** Escalates ambiguous or out-of-scope research requests to Sales AI; never widens its own task scope.
- **Working hours.** Queue-driven via `ai_employee_tasks` + `hq_sales_ai_tasks`; drained by the **`research-drain` cron** safety net (♻️) and browser-kick — the live trigger pattern the whole scheduler generalises.
- **Budget.** $3/day; breaker → suspend (and, being the live executor, its suspension is a real operational signal).
- **Tool access.** `run_research` (`research.execute`, low — read/synthesise, no external mutation) · `attach_findings` (`memory.assert`, low). Deliberately tiny and safe — which is *why* it was safe to make live first.
- **Decision limits.** May execute research within the task's bounds and budget; may not act on findings (acting is another employee's job, behind that employee's gate).
- **Approval requirements.** Research execution is `auto` (no side-effect, bounded cost). Any *action* arising from a finding belongs to the relevant employee and its policy.
- **Audit.** Already real: every research run records tokens/cost/latency and provenance; this is the template the dossier "Audit history" field generalises across the roster.

### 7. Marketing AI — `marketing-ai`

- **Identity.** 📣 pink · department **marketing** · *"Growth, brand voice, and content."* (♻️ `marketing.ts`)
- **Role.** Supports growth and brand: drafts campaign ideas and positioning, outlines content in the CrewFlow voice, reviews copy for tone, and proposes growth experiments for approval.
- **Manager.** Reports to **CEO AI**.
- **Responsibilities.** Draft campaigns/positioning · outline on-voice content · review copy for tone/clarity · propose growth experiments (♻️).
- **Permissions.** *Current:* `locked(read, draft, suggest)`. *Target:* `analytics.read`, `memory.read/assert`, `content.draft`, and *request* `content.publish` (**high** — public, brand-risk).
- **Memory.** Reads marketing + product memory; asserts brand-voice guidelines and campaign learnings.
- **KPIs.** Content acceptance rate, on-voice consistency (brand check pass rate), experiment proposal → run → lift, engagement on shipped content.
- **Costs.** **Sonnet**, temp 0.6 (the highest — creativity). Ceiling **$4/day**.
- **Performance reviews.** Monthly, by **CEO AI** + operator.
- **Escalation rules.** Anything **published publicly** escalates to the human (brand risk); never publishes autonomously.
- **Working hours.** Scheduled content/campaign passes; subscribes to growth-metric events.
- **Budget.** $4/day.
- **Tool access.** `read_analytics` (`analytics.read`, low) · `draft_content` (`content.draft`, low) · `propose_campaign` (`memory.assert`, low) · `review_copy` (`memory.assert`, low) · *target:* `publish_content` (`content.publish`, high — human-approved, never auto).
- **Decision limits.** May draft and propose freely; may not publish, spend ad budget, or send to lists.
- **Approval requirements.** Publish/post/send → `require_human` (public content, P-Explicit-permission boundary); ad spend → human-only.
- **Audit.** Every draft and publish-request recorded; published content carries the approver and the exact content hash.

### 8. Design AI — `design-ai`

- **Identity.** 🎨 fuchsia · department **design** · *"UI critique and brand consistency."* (♻️ `design.ts`)
- **Role.** Critiques UI against the design language, proposes layouts and component direction, checks work for brand consistency, and suggests improvements — the design-system conscience (a natural extension of Directive 007's *one source* discipline).
- **Manager.** Reports to **Product AI**.
- **Responsibilities.** Critique UI vs the design language · propose layouts/components · check brand consistency · suggest improvements (♻️).
- **Permissions.** *Current:* `locked(read, review, suggest)`. *Target:* `design.read`, `memory.read/assert` — advisory only; it never changes shipped UI.
- **Memory.** Reads design + product memory; asserts design-language rules and critique rationale (so consistency is enforced from one source).
- **KPIs.** Critique adoption rate, brand-consistency catch rate (violations caught pre-ship), proposal usefulness.
- **Costs.** **Sonnet**, temp 0.5. Ceiling **$3/day**.
- **Performance reviews.** Monthly, by **Product AI** + operator.
- **Escalation rules.** Escalates design-language *changes* (not just applications) to Product AI + human — the token system has one source, changing it is a human decision.
- **Working hours.** Subscribes to UI-change/PR-style events; on-demand critique.
- **Budget.** $3/day.
- **Tool access.** `review_ui` (`design.read`, low) · `propose_layout` (`memory.assert`, low) · `check_brand` (`design.read`, low) · `suggest_design` (`memory.assert`, low). All advisory.
- **Decision limits.** May critique and propose; may not modify components, tokens, or shipped UI.
- **Approval requirements.** Advisory outputs auto; any change to the design system is human-only.
- **Audit.** Critiques and proposals recorded; design-language assertions versioned (Ch.12).

### 9. Documentation AI — `documentation-ai`

- **Identity.** 📚 cyan · department **documentation** · *"Internal and customer-facing docs."* (♻️ `documentation.ts`)
- **Role.** Drafts and maintains internal and customer-facing documentation in a clear, accurate house style; reviews docs for accuracy; suggests edits.
- **Manager.** Reports to **Product AI**.
- **Responsibilities.** Draft internal/customer docs · maintain house style · review for accuracy · suggest edits (♻️).
- **Permissions.** *Current:* `locked(read, draft, suggest)`. *Target:* `docs.read`, `memory.read/assert`, `doc.draft`, and *request* `doc.publish` (**medium** — customer-facing accuracy risk).
- **Memory.** Reads all departments' memory (it documents everything); asserts the house-style guide and doc-accuracy facts.
- **KPIs.** Doc accuracy (reported errors per published doc), coverage (features documented vs shipped), edit-suggestion acceptance, freshness (stale-doc detection).
- **Costs.** **Sonnet**, temp 0.3. Ceiling **$3/day**.
- **Performance reviews.** Monthly, by **Product AI** + operator.
- **Escalation rules.** Escalates customer-facing publishes and any doc that makes a *commitment* (SLA, pricing) to the human.
- **Working hours.** Subscribes to feature-ship events (docs follow features); scheduled freshness sweeps.
- **Budget.** $3/day.
- **Tool access.** `read_docs` (`docs.read`, low) · `draft_doc` (`doc.draft`, low) · `review_accuracy` (`docs.read`, low) · `suggest_edits` (`memory.assert`, low) · *target:* `publish_doc` (`doc.publish`, medium — human-approved).
- **Decision limits.** May draft and review; may not publish customer-facing docs autonomously.
- **Approval requirements.** Internal-doc drafts auto; customer-facing publish → `require_human`.
- **Audit.** Publishes recorded with content hash + approver; accuracy corrections tracked.

### 10. Support AI — `support-ai`

- **Identity.** 📞 blue · department **support** · *"Ticket triage and reply drafting."* (♻️ `support.ts`)
- **Role.** Supports the help desk: triages incoming tickets, drafts replies for human review, summarises recurring issues, and surfaces escalations early.
- **Manager.** Reports to **CEO AI** (operations-adjacent; see Operations AI for the coordination tie).
- **Responsibilities.** Triage tickets · draft replies (human review) · summarise recurring issues · surface escalations early (♻️).
- **Permissions.** *Current:* `locked(read, draft, triage)`. *Target:* `tickets.read`, `memory.read/assert`, `reply.draft`, `ticket.triage` (**low** — internal routing), and *request* `reply.send` (**medium** — customer-facing).
- **Memory.** Reads support + product memory; asserts recurring-issue patterns (feeding Product AI) and resolution playbooks (procedural memory).
- **KPIs.** Triage accuracy (correct priority/routing), reply-draft acceptance rate, first-response latency, deflection (issues resolved by drafted reply), CSAT on AI-touched tickets.
- **Costs.** **Haiku**, temp 0.3 — fastest/cheapest, built for ticket volume. Ceiling **$4/day** (highest-volume employee).
- **Performance reviews.** Monthly, by **CEO AI** + operator; weights latency and CSAT.
- **Escalation rules.** Escalates angry/at-risk customers, anything touching billing/refunds (→ Finance AI + human), and any ticket implying a security/legal issue — immediately, not on the next pass.
- **Working hours.** Subscribes to `support.ticket_opened`/`support.ticket_replied`; near-real-time (support is latency-sensitive).
- **Budget.** $4/day.
- **Tool access.** `read_tickets` (`tickets.read`, low) · `draft_reply` (`reply.draft`, low) · `triage` (`ticket.triage`, low) · `summarize_issues` (`memory.assert`, low) · *target:* `send_reply` (`reply.send`, medium — human-approved, or `auto` for vetted macro-replies once trusted).
- **Decision limits.** May triage and draft freely; may not send to customers, issue credits, or change account state.
- **Approval requirements.** Customer-facing send → `require_human` (graduating to `auto` for known-safe macros on eval evidence); any billing action → Finance AI's dual-control path.
- **Audit.** Every triage decision, draft, and send recorded; sends carry the approver and CSAT linkage.

### 11. Operations AI — `operations-ai`

- **Identity.** ⚙️ slate · department **operations** · *"Onboarding, migration, and coordination."* (♻️ `operations.ts`)
- **Role.** Supports internal operations: tracks onboarding and migration progress, coordinates cross-team tasks, surfaces blockers, and proposes operational actions for approval.
- **Manager.** Reports to **CEO AI**.
- **Responsibilities.** Track onboarding/migration · coordinate cross-team tasks · surface blockers early · propose operational actions (♻️).
- **Permissions.** *Current:* `locked(read, draft, suggest)`. *Target:* `onboarding.read`, `memory.read/assert`, `task.coordinate` (**low** — internal task routing) — internal only.
- **Memory.** Reads operations + all-department memory (coordination needs breadth); asserts process state and blocker history.
- **KPIs.** Onboarding completion rate/time, migration progress accuracy, blocker time-to-surface, coordination effectiveness (tasks unblocked).
- **Costs.** **Sonnet**, temp 0.3. Ceiling **$4/day**.
- **Performance reviews.** Monthly, by **CEO AI** + operator.
- **Escalation rules.** Escalates stalled onboardings/migrations past SLA and any cross-team conflict it cannot coordinate to CEO AI → human.
- **Working hours.** Subscribes to onboarding/migration events; daily progress sweep.
- **Budget.** $4/day.
- **Tool access.** `read_onboarding` (`onboarding.read`, low) · `track_migration` (`onboarding.read`, low) · `coordinate_tasks` (`task.coordinate`, low) · `flag_blockers` (`memory.assert`, low).
- **Decision limits.** May track and coordinate internal tasks; may not change customer state, data, or external commitments.
- **Approval requirements.** Internal coordination auto; anything customer-affecting → human.
- **Audit.** Coordination actions and blocker escalations recorded with the affected workstream.

### 12. QA AI — `qa-ai`

- **Identity.** 🧪 amber · department **quality** · *"Test planning and regression review."* (♻️ `qa.ts`)
- **Role.** Supports quality: proposes test plans, spots edge cases and risks, reviews diffs for regressions, and reports findings with recommended gates — the executable analogue of the Bible's own eval discipline (Ch.18).
- **Manager.** Reports to **CTO AI**.
- **Responsibilities.** Propose test plans · spot edge cases/risks · review diffs for regressions · report findings & recommend gates (♻️).
- **Permissions.** *Current:* `locked(read, review, report)`. *Target:* `changes.read`, `memory.read/assert`, `findings.report` — read-and-report only; it advises a gate, humans/CI enforce it.
- **Memory.** Reads engineering + product memory; asserts regression patterns and test-coverage facts.
- **KPIs.** Regression catch rate (bugs caught pre-ship vs escaped), test-plan coverage, false-positive rate on flagged risks, finding actionability.
- **Costs.** **Sonnet**, temp 0.2 (low — determinism matters for QA). Ceiling **$3/day**.
- **Performance reviews.** Monthly, by **CTO AI** + operator.
- **Escalation rules.** Escalates a *release-blocking* risk to CTO AI + human immediately; never silently passes a change it flagged as high-risk.
- **Working hours.** Subscribes to change/PR-style events; runs on every proposed change.
- **Budget.** $3/day.
- **Tool access.** `read_changes` (`changes.read`, low) · `draft_test_plan` (`memory.assert`, low) · `spot_regressions` (`changes.read`, low) · `report_findings` (`findings.report`, low). All read/advise.
- **Decision limits.** May review and recommend gates; may not block a merge or deploy itself (it recommends; CI/humans enforce).
- **Approval requirements.** All advisory (no side-effect). A recommended gate becomes binding only when a human/CI adopts it.
- **Audit.** Findings and gate recommendations recorded; a shipped-then-regressed change links back to whether QA AI flagged it (closing the eval loop).

---

## Roster summary — permissions, models, budgets

| Employee | Dept | Model | Manager | Highest target capability | Daily $ |
|---|---|---|---|---|---|
| CEO AI | executive | Opus | Human | `workforce.delegate` (med) | 8 |
| CTO AI | engineering | Opus | CEO AI | `roadmap.draft` (low) | 6 |
| Product AI | product | Opus | CEO AI | `backlog.prioritize` (low) | 5 |
| Finance AI | finance | Sonnet | CEO AI | `billing.refund` *(request only, critical)* | 4 |
| Sales AI | sales | Sonnet | CEO AI | `email.send` (med) | 5 |
| Research AI | sales | Haiku | Sales AI | `research.execute` (low) **— LIVE** | 3 |
| Marketing AI | marketing | Sonnet | CEO AI | `content.publish` (high) | 4 |
| Design AI | design | Sonnet | Product AI | `memory.assert` (low) | 3 |
| Documentation AI | documentation | Sonnet | Product AI | `doc.publish` (med) | 3 |
| Support AI | support | Haiku | CEO AI | `reply.send` (med) | 4 |
| Operations AI | operations | Sonnet | CEO AI | `task.coordinate` (low) | 4 |
| QA AI | quality | Sonnet | CTO AI | `findings.report` (low) | 3 |

**Roster ceiling: ~$52/day** across twelve employees — the workforce's bounded marginal cost, watched as a single tile (Ch.15, P9). No employee holds a money-moving or customer-mutating capability *autonomously*; the four highest-risk powers (`billing.refund`, `content.publish`, `email.send`, `reply.send`) are all approval-gated, and the most dangerous (`billing.refund`) is dual-control and never AI-executed.

## Failure handling (roster-level)

- **An employee is suspended** (budget/error breaker, Ch.07): its queue holds; its manager AI is notified; the operator sees it on Mission Control. Work it would have done waits — the company degrades to *slower in one function*, never to *unsafe*. A suspended Finance/Support AI is itself a `warn` signal (oversight/responsiveness paused).
- **An employee gives a bad output** caught in review: rejected at the approval gate (no side-effect); the rejection is an eval signal (Ch.18) that feeds the next performance review.
- **A manager AI is unavailable** for an escalation: escalation skips to the **human** (the tree always terminates at the operator) — an AI manager is never a single point of failure for safety.
- **Provider outage:** every employee fails over Anthropic → OpenAI (♻️ the research path); persistent failure suspends affected employees with a `critical` alert.

## Edge cases (roster-level)

- **Conflicting recommendations** (Finance says churn-risk, Sales says upsell on the same org): both are *recommendations*; the human (or CEO AI within its coordination remit) reconciles — neither acts, so there is no conflicting *side-effect*.
- **A delegated task loops** (CEO AI → Sales AI → … → CEO AI): the delegation depth limit and loop breaker (Ch.07) cap it; exceeding the limit escalates to the human.
- **An employee triggered for a tenant it shouldn't touch:** capabilities are HQ-scoped; a cross-tenant read needs an explicit capability and is audited — the runtime never widens tenant isolation (Ch.07 Security).
- **A new hire (13th employee):** added as one `employees/*.ts` definition + a roster row + an org-chart edge; it starts `foundation:true` and earns capabilities on evals — the roster grows by *configuration*, not new plumbing.

## Performance (roster at scale)

The Golden-Rule answer for the workforce: it scales by **governed marginal cost**, not by headcount-per-company. At 1M companies there are still *twelve* employees (not twelve-million) — they act on **events** (what changed), drain a **queue** (bounded concurrency), recall **bounded** context, and spend under **daily ceilings**. The roster's total cost is the sum of twelve budgets (~$52/day in this plan), independent of company count; volume raises *queue depth* (absorbed by back-pressure and, at scale, `pgmq` — Ch.17), not per-company cost. This is why the workforce is viable at a million companies: its cost is a *bounded constant the operator sets*, not a function of the customer base.

## Security (roster-level)

- **Least privilege is the roster's spine.** The summary table is a least-privilege map: each employee holds the *minimum* capabilities for its job; the dangerous four are gated; `billing.refund` is dual-control and AI-unexecutable. A compromised or injected employee's blast radius is its (small) capability set (Ch.07/16).
- **Separation of duties.** The employee that *recommends* a refund (Finance AI) cannot *execute* it; the employee that *drafts* a reply (Support AI) needs approval to *send*; the employee that *critiques* design (Design AI) cannot *change* it. No employee both proposes and disposes a consequential action.
- **The human is always the ceiling.** Every dangerous path terminates at an operator decision; autonomy is granted on evidence and revocable by flag (P4/P7).

## Testing (roster-level)

- **Per-employee eval suites** (Ch.18): golden tasks scoring the shared rubric (Correctness/Tool-choice/Limit-adherence/Cost/Safety). Evals are the *executable performance review* and the CI gate before any autonomy increase.
- **Org-chart consistency test:** assert every *Manager* edge has a matching *manages* edge and the tree terminates at the human (no orphan, no cycle) — the chart in this chapter is machine-checkable.
- **Capability-minimality test:** assert no employee's granted capabilities exceed its dossier's declared set (no privilege drift).
- **Injection red-team per employee:** the "refund yourself / send yourself data / ignore instructions" corpus (Ch.07/16), asserting the gate denies/escalates.

## Monitoring (roster-level)

Per employee, the spine emits the full `ai.*` lifecycle (Ch.04); the workforce view (Ch.09) renders each employee's live state, today's cost-vs-budget, queue depth, and escalation count. Roster golden signals (Ch.15): **total workforce $/day** (the headline P9 tile), per-employee budget utilisation, escalation rate (an employee over its head), approval-rejection rate (an employee drafting poorly), and suspended-count (zero is healthy). A Finance/Support AI suspension pages the operator.

## Future expansion

- **More employees, same plumbing.** New roles (Legal AI, Recruiting AI, Data AI) are new `employees/*.ts` definitions + roster rows + org-chart edges — the framework (Ch.07) and this template absorb them without change.
- **Earned autonomy.** As evals accumulate, `auto` thresholds widen *within* policy (a Support AI that scores high on safe macros earns `auto` for them) — autonomy on evidence, the dial being `hq_approval_policies` (Ch.13), never a blanket grant.
- **Richer org dynamics.** Delegation is first-class; as more employees execute, the manager/report edges become a real routing and review graph (a manager AI pre-screening a report's approvals before they reach the human).
- **Specialisation.** An employee may spawn sub-roles (a Support AI with per-product expertise) as memory and evals justify — growth by configuration, reviewed like any hire.
