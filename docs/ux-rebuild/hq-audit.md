# CrewFlow HQ — surface inventory & IA-rebuild audit

READ-ONLY audit of the internal super-admin surface. Worktree
`/Users/moetalibi/Code/web-product-ux`, branch `product/ux-rebuild`.
Nothing in this file was changed in the codebase; this document is the only output.

HQ is the founder/CEO's internal operating system — governance, the AI workforce,
approvals, strategic decisions, automation, product/eng ops, and company
intelligence. It is entirely separate from the customer product (which lives under
`app/(app)`, `app/customer-portal`, `app/worker-portal`). HQ lives under `app/admin/*`.

---

## 1. Summary

| Metric | Value |
|---|---|
| HQ page routes (`app/admin/**/page.tsx`) | **76** |
| HQ route handlers (`app/admin/**/route.ts`) | 1 (`/admin/switch-to-customer`) |
| HQ API endpoints (`app/api/admin/**/route.ts`) | 8 |
| Flat sidebar nav destinations | **46** (single ungrouped list) |
| Unbuilt nav stubs (`shipsIn`) | 0 — every nav item is a live page |
| AI employees in the roster (`ai_employees` table) | **32** |
| Approval-engine states | 5 (`pending, escalated → approved, rejected, expired`) |
| Decision-engine states | 4 (`proposed → approved, rejected, delayed`; `delegate` is an action) |
| AI-task-engine states | 9 (`pending, claimed, running, waiting_approval, verifying, blocked, completed, failed, cancelled`) |
| AI-employee status vocabulary | 6 (`idle, working, waiting_approval, blocked, error, disabled`) |

### How HQ is role-gated

One predicate, one place. `app/admin/layout.tsx` calls `requireHqPage()`
(`server/auth/hq.ts`), which every child route inherits; several pages
(`organizations`, `decisions`, `approvals`, `workflow-sagas`, `hq-cadence`) re-call
it for defence-in-depth. The gate reduces to `isSuperAdminEmail()`
(`server/auth/superadmin.ts`), a **case-insensitive ENV allowlist**
(`CREWFLOW_SUPERADMIN_EMAILS`) — not a DB role or JWT claim, so it cannot be an RLS
policy and must live in the request path. Non-allowlisted users get **404, never
403** (an HQ surface never announces its existence); anonymous users go to `/login`.
API handlers use the sibling `requireHqApi()` which returns a 404 `Response` instead
of redirecting. Data reads use the service-role admin client (`lib/supabase/admin`)
because most HQ tables have RLS enabled with **no policies** (invisible to any
customer/staff JWT).

### The current nav — and its problems

The nav is `HQ_NAV` in `app/admin/layout.tsx`: **one flat, emoji-prefixed list of 46
links** rendered in a `w-56` sidebar (mobile: a hamburger drawer, `_nav-mobile.tsx`).
`/admin` redirects to `/admin/command-centre`. Problems for a CEO operating tool:

1. **No hierarchy.** 46 peers in one scroll — 14 AI-worker pages, 5 rival
   dashboards, decision/approval surfaces, a whole sales sub-app, and platform
   settings all sit at the same level with no grouping.
2. **Five competing "home" pages.** `command-centre`, `overview`, `ceo`,
   `ceo/briefings`, and `pulse` all answer "how is the company doing right now?"
   with overlapping data. There is no single front door.
3. **The roster is split across two mental models.** 32 AI employees live in
   `ai-boardroom`, but ~14 of them ALSO have a bespoke top-level `*-ai` page, while
   ~18 (COO, CFO, HR, Legal, Security, DevOps, Database, API, Monitoring,
   Orchestrator, Memory-Manager, Workflow, Notification, Design, Documentation,
   Onboarding, Eng-Manager) appear only as a boardroom card. Inconsistent.
4. **Sub-apps are hidden.** Sales AI is really an 8-page CRM/cockpit and the AI
   Receptionist is a 7-page ops console, but each shows as a single nav line (with a
   couple of `↳` indented children), so their depth is invisible.
5. **Governance is scattered.** The kernel surfaces (approvals, decisions,
   workflow-sagas, cadence clock, executor-shadow, AI-cost governance, automations)
   are interleaved with CRM and settings links rather than reading as one system.
6. **Frequency is ignored.** Daily surfaces (approvals, command-centre) and
   rare/dark ones (executor-shadow, cadence clock, launch-checklist) get equal
   visual weight.

### Proposed top-level IA (detail in §6)

Collapse 46 flat links into **6 stable areas**: **Home · Decisions · Workforce ·
Operations · Governance · Systems**. This broadly follows the CEO's hint
(Home/Decisions/People/Work/Governance/Systems) but is derived from the real
product: "People" = the AI Workforce, "Work" = Operations (the growth + customer
engines), and the five rival dashboards collapse into one Home.

---

## 2. AI workforce roster (32 employees)

Source of truth: table `public.ai_employees` (RLS-on, no-policies; service-role reads
only), seeded/extended across 8 migrations. Read via
`server/services/ai-employees.ts` → `listAiEmployees()`; vocabulary in
`lib/ai-employees/model.ts`; per-employee stats in `server/services/ai-employee-stats.ts`.

**Framework posture (critical for UX honesty):** every employee sits at the
**default-deny floor** — `can_execute=false`, `requires_approval=true`. No employee
executes autonomously; they read, reason, and **draft** for human approval. The
Boardroom banner states this explicitly. Model wiring (`model_provider`/`model_name`)
is largely inert planning metadata; the operational employees run off the Task Engine
and produce drafts.

Statuses (`lib/ai-employees/model.ts`): `idle · working · waiting_approval · blocked ·
error · disabled`. Departments (the DB CHECK set): `executive, engineering, sales,
marketing, design, quality, documentation, product, finance, support, operations`.

### Roster as seeded (name · slug · department · role summary)

**Executive**
- CEO AI · `ceo-ai` · executive · strategy & cross-department coordination
- COO AI · `coo-ai` · executive · operational cadence & cross-functional coordination
- Orchestrator AI · `orchestrator-ai` · executive · cross-employee task routing (traffic controller of the workforce)
- Executive Assistant AI · `exec-assistant-ai` · executive · cross-queue triage of "what needs the human now"

**Engineering / Platform**
- CTO AI · `cto-ai` · engineering · architecture, standards, technical risk
- Eng Manager AI · `eng-manager-ai` · engineering · engineering delivery/coordination
- Security AI · `security-ai` · engineering · security posture
- DevOps AI · `devops-ai` · engineering · CI/CD, releases, infra
- Database AI · `database-ai` · engineering · schema, migrations, integrity
- API AI · `api-ai` · engineering · API surface, contracts, integrations
- Memory Manager AI · `memory-manager-ai` · engineering · shared-memory curation & retention
- QA AI · `qa-ai` · quality · test planning & regression review
- Documentation AI · `documentation-ai` · documentation · internal & customer docs
- Design AI · `design-ai` · design · UI critique & brand consistency

**Growth / Sales**
- Sales AI · `sales-ai` · sales · pipeline support & deal context
- Research AI · `research-ai` · sales · autonomous company intelligence & deal prep (first operational employee)
- Lead Qualification AI · `lead-qualification` · sales · deterministic qualify/disqualify verdict
- Outreach AI · `outreach-ai` · sales · human-approved cold-outreach drafting (drafts only)
- Marketing AI · `marketing-ai` · marketing · growth, brand voice, content

**Customer / Support**
- Support AI · `support-ai` · support · ticket triage & reply drafting
- Onboarding AI · `onboarding-ai` · support · activation & time-to-value
- Customer Success AI · `customer-success-ai` · support · retention & adoption
- Voice Receptionist AI · `voice-receptionist-ai` · (reception) · inbound call handling, capture & routing (first customer-facing employee; captures/routes, never commits/quotes/books)

**Finance / Product / Ops**
- Finance AI · `finance-ai` · finance · revenue modelling & billing oversight
- CFO AI · `cfo-ai` · finance · financial strategy, controls, cash discipline
- Product AI · `product-ai` · product · backlog, requirements, feedback synthesis
- Operations AI · `operations-ai` · operations · onboarding/migration/coordination
- HR AI ("People & HR") · `hr-ai` · operations · workforce & people-ops
- Legal & Compliance AI · `legal-compliance-ai` · operations · legal/regulatory oversight
- Monitoring & Incident AI · `monitoring-incident-ai` · operations · observability & incident response
- Workflow AI · `workflow-ai` · operations · multi-step workflow decomposition
- Notification AI · `notification-ai` · operations · notification routing & delivery

Seed provenance: `20260712000100_ai_employees_seed.sql` (initial 11);
`20260718…research`, `20260721…lead_qualification`, `20260729…outreach`,
`20260814…voice_receptionist` (4 operational); `20261128…roster_completion` (14);
`20261158…roster_runners` (customer-success, eng-manager); `20261198…exec_assistant_identity` (1).

### Where status / last-run / current-task / output / approval / audit live

- **Roster grid & per-status counts:** `/admin/ai-boardroom` (`ai_employees` +
  `getAiWorkforceStats` + boardroom cards from `hq-task-pipeline`).
- **Per-employee detail** (profile · role · system prompt · allowed tools ·
  permissions · current task · task history · memory · activity):
  `/admin/ai-boardroom/[slug]` via `loadAiEmployeeBySlug()`.
- **Live task load / last-run / current-task across the whole workforce:**
  `/admin/tasks` — the unified read model over the Generic Task Engine
  (`hq_ai_tasks`, service `server/services/hq-tasks.ts`).
- **Output & approval of an employee's work:** the standard output envelope
  (`server/sdk/output.ts`: `summary · reasoning · confidence · evidence[] ·
  alternatives[] · approvalRequired · actions[]`) → the Approval Console
  (`/admin/approvals`) for anything that would act.
- **Audit trail:** `/admin/pulse` (the `hq_timeline` projection) and per-employee
  activity on the detail page (`listAdminActivity`).
- **Approval posture (1–5 level):** derived read-only from the Capability Registry
  via `resolveApprovalLevelsByEmployeeId` (`lib/ai-employees/approval-levels.ts`).

### Employees with a bespoke top-level cockpit vs. boardroom-only

Bespoke `*-ai` (or operational) page **exists** for: sales, research, qualification,
finance, support-ai, cto-ai, qa-ai, operations-ai, product-ai, marketing-ai,
customer-success-ai, executive-assistant-ai, ai-receptionist — plus the composite
**Sales-Orchestrator AI** page (which is a pipeline *view*, **not** a roster row:
there is no `sales-orchestrator` slug in any migration). Task-Engine exec-runners
exist for 13 roles (`server/services/hq-{ceo,cfo,coo,cto,customer-success,
executive-assistant,finance,marketing,operations,product,qa,sales,support}-exec-runner.ts`).
**Boardroom-only (no dedicated page):** coo, cfo, hr, legal-compliance, security,
devops, database, api, monitoring-incident, orchestrator, memory-manager, workflow,
notification, onboarding, eng-manager, design, documentation. → An IA rebuild should
give every employee ONE consistent home, not two inconsistent ones.

---

## 3. Decisions / approvals + governance kernel

### Human-judgement surfaces & their states

| Surface | Route | Engine / table | States |
|---|---|---|---|
| Approval Console | `/admin/approvals` | Approval Engine, `hq_approvals` (`server/services/hq-approvals.ts`, states `lib/approvals/state.ts`) | `pending, escalated` (active) → `approved, rejected, expired` (terminal, frozen). DB trigger enforces the machine. |
| Decision Centre | `/admin/decisions`, `/admin/decisions/[id]` | Decision Engine, `hq_decisions` (`server/services/hq-decisions.ts`) | `proposed → approved / rejected / delayed`; actions = approve, reject, delay, **delegate**. Engine never executes — approving only *records* the decision. |
| Workflow Sagas | `/admin/workflow-sagas`, `/[id]` | saga graph over `hq_ai_tasks` | a directive decomposed into an ordered, dependency-linked step graph; each step dispatched through Task-Engine authority on the detail page. |
| Cadence Clock | `/admin/hq-cadence` | schedule registry over HQ crons | cadences bound to existing authority; **DARK by default** — enabling is an explicit opt-in; legacy crons fire regardless. |
| Executor Shadow | `/admin/executor-shadow` | `hq_ai_executor_shadow_observations` | READ-ONLY evidence: what the executor *would* have applied (`planned / refused / error`). Execution stays **LOCKED**. |
| Exec-Assistant digest | `/admin/executive-assistant-ai` | cross-board projection | "what needs the human now" — composes open approvals + pending/delayed decisions + overdue/stalled tasks + open alerts. The natural front page of Decisions. |

### Governance kernel entry points (`server/sdk/*` — describe only, do not change)

The kernel is a strict **policy vs. mechanism** separation:

- **Authority resolution — `server/sdk/registry-resolver.ts`** (+ `registry-parity.ts`,
  `registry-confidence.ts`, `registry-authoring.ts`). The Capability Registry:
  declarative authority composed over nested scopes `global ⊇ organization ⊇
  department ⊇ employee` — tokens UNION, `can_execute` DENY-WINS, `requires_approval`
  ratchets up, budget = strict minimum. Absence → **default-deny floor**. This is
  what makes every employee non-executing today.
- **The gate — `server/sdk/gate.ts`** ("the doorman"). PURE function: every proposed
  action → `{ decision, reasons }` (permitted / needs_approval / denied). No I/O, no
  approval request, no event — policy only.
- **The executor — `server/sdk/executor.ts`.** Mechanism only: applies an
  already-cleared verdict via a registered tool; never re-classifies, never widens a
  capability, refuses anything the gate did not clear.
- **Apply-on-approval — `server/sdk/application.ts`** + `server/services/hq-apply-drain.ts`.
  Idempotent "applied" marker (`ApplicationRecord`, deterministic idempotency key) —
  applies a human-granted action **exactly once**; a separate record, NOT a 6th
  approval state.
- **Autonomous apply — `server/sdk/autonomous-apply.ts`.** DARK behind **three
  independent gates**: the posture floor (structural), the `CREWFLOW_EXECUTOR_APPLY`
  kill-switch, and the deterministic-only path.
- **Shadow — `server/sdk/shadow.ts`.** Durable, explicitly-labelled shadow
  observations; structurally impossible to confuse with a real apply.
- **Audit / spine — the `hq_timeline` projection** surfaced at `/admin/pulse`;
  output envelope + evidence drain in `server/sdk/output.ts`; runner in
  `server/sdk/tasks.ts`.
- **Rollback / reversibility** is expressed as *refusal to cross the line* (executor
  refuses uncleared actions; irreversible acts like sending/booking are always held
  for human approval) rather than an undo of applied effects.

### Dark / gated vs. live

| Dark / execution-locked | Live |
|---|---|
| Autonomous apply (3 gates; `CREWFLOW_EXECUTOR_APPLY`) | Approval Console, Decision Centre, Task Queue |
| Executor shadow (execution LOCKED; read-only evidence) | AI Boardroom (framework/config, read) |
| Cadence Clock (DARK by default) | Pulse audit feed, Command Centre, CEO board |
| Apply-on-approval (`CREWFLOW_HQ_APPLY_ON_APPROVAL`) | All employee cockpits (advisory / draft-only) |
| AI-cost activation ("can anything spend money right now?" = dark) | AI-cost *reporting* (spend vs £100/org ceiling) |
| Whole AI workforce runs at default-deny (draft-only, `can_execute=false`) | Sales/Research/Qualification/Receptionist drains (produce drafts) |

---

## 4. Full HQ surface inventory (grouped)

Columns: **Route · Purpose · Primary user · Frequency (inferred) · Key dependency ·
Related**. Frequency inferred from role (a CEO's daily triage vs. rare
config/evidence surfaces).

### A. Executive dashboards ("home" — currently 5 rival pages)

| Route | Purpose | User | Freq | Key dependency | Related |
|---|---|---|---|---|---|
| `/admin/command-centre` | Live company control centre (~27 animated cards over 6 sections: revenue, pipeline, conversion, outreach, workforce, research) | CEO | Daily | All HQ read services | overview, ceo, pulse |
| `/admin/pulse` | Live, virtualised, polling activity feed | CEO / governance | Daily | `hq_timeline` projection (SECURITY DEFINER RPCs) | command-centre |
| `/admin/ceo` | Departmental company board — 5 vitals + per-department scorecards with honest health signals | CEO | Daily | Department read services | overview, briefings |
| `/admin/ceo/briefings` | Morning CEO-briefing reader + archive | CEO | Daily | `hq_ceo_briefings` (cron-composed) | ceo |
| `/admin/overview` | KPI tiles + sparklines + "morning summary" greeting | CEO | Daily | KPI reads | command-centre, ceo |
| `/admin` | Redirect → `/admin/command-centre` | — | — | — | — |

### B. AI workforce

| Route | Purpose | User | Freq | Key dependency | Related |
|---|---|---|---|---|---|
| `/admin/ai-boardroom` | Roster grid of 32 employees (status, dept/status filters, search, approval level) | CEO / governance | Occasional | `ai_employees`, workforce stats, task pipeline | [slug], tasks |
| `/admin/ai-boardroom/[slug]` | Employee detail: profile, prompt, tools, permissions, current task, history, memory, activity | Governance | Occasional | `loadAiEmployeeBySlug` (tasks+memory+audit) | boardroom |
| `/admin/tasks` | Unified AI Task Queue read model (engine totals, per-employee load, live feed) | Eng-ops / CEO | Daily | `hq_ai_tasks` | boardroom, workflow-sagas |
| `/admin/memory` (+`/[id]`,`/[id]/edit`,`/new`,`/search`) | Shared memory / "company brain": totals, growth, contributors, pin/search/CRUD | Governance | Occasional | shared-memory service | boardroom |
| `/admin/finance` | Finance AI cockpit — board-level money picture (Fact/Derived/Insufficient badges) | CEO / finance | Occasional | billing/revenue reads | analytics, billing |
| `/admin/support-ai` | Support AI cockpit — triage picture | Support-ops | Occasional | tickets reads | support queue |
| `/admin/cto-ai` | CTO AI cockpit — platform/eng-health | Eng-ops | Occasional | platform signals | ops, health |
| `/admin/qa-ai` | QA AI cockpit — AI-quality & reliability | Eng-ops | Rare | quality signals | cto-ai |
| `/admin/operations-ai` | Operations AI cockpit — ops-health | Ops | Occasional | ops signals | ops |
| `/admin/product-ai` | Product AI cockpit — voice-of-customer / product signal | Product | Occasional | feedback signals | analytics |
| `/admin/marketing-ai` | Marketing AI cockpit — acquisition / top-of-funnel | Marketing | Occasional | funnel signals | analytics |
| `/admin/customer-success-ai` | Customer-Success AI cockpit — retention / adoption | CS-ops | Occasional | retention signals | health |
| `/admin/executive-assistant-ai` | "What needs the human now" cross-board digest | CEO | Daily | approvals+decisions+tasks+alerts | approvals, decisions |
| `/admin/sales-orchestrator-ai` | Composite pipeline board unifying Research+Qualification+Outreach (view, not a roster employee) | Sales-ops | Occasional | 3 sales drains | sales, research |

### C. Decisions & approvals (governance kernel front-ends)

| Route | Purpose | User | Freq | Key dependency | Related |
|---|---|---|---|---|---|
| `/admin/approvals` | Human decision surface of the Approval Engine (pending/escalated cards + decided history) | CEO / governance | Daily | `hq_approvals` | decisions, exec-assistant |
| `/admin/decisions` (+`/[id]`) | Strategic Decision Centre — approve/reject/delay/delegate; immutable history | CEO | Occasional | `hq_decisions` | approvals |
| `/admin/workflow-sagas` (+`/[id]`) | Cross-department task-graph board + step dispatch | Eng-ops / governance | Occasional | saga graph over `hq_ai_tasks` | tasks |
| `/admin/hq-cadence` | Cadence-clock schedule registry (enable/pause; DARK) | Governance | Rare | cadence registry | automations |
| `/admin/executor-shadow` | Read-only evidence of what the executor would apply (LOCKED) | Governance / eng-ops | Rare | `hq_ai_executor_shadow_observations` | approvals |

### D. Growth engine (Sales / Research / Qualification / Demos)

| Route | Purpose | User | Freq | Key dependency | Related |
|---|---|---|---|---|---|
| `/admin/sales` | Sales pipeline at a glance (status counts, funnel, AI productivity, value) | Sales-ops / CEO | Daily | sales services | all sales/* |
| `/admin/sales/activity` | Global chronological activity feed | Sales-ops | Daily | `hq_sales_sources` | sales |
| `/admin/sales/analytics` | Pipeline funnel + conversion analytics | Sales-ops | Occasional | sales analytics | sales |
| `/admin/sales/calling` | AI Calling Centre — live call queue + per-call | Sales-ops | Occasional | calling service | communications |
| `/admin/sales/communications` | AI Communication Centre — every messaging touch | Sales-ops | Occasional | comms timeline | calling |
| `/admin/sales/companies` (+`/[id]`,`/[id]/edit`,`/new`) | Company Intelligence search + CRUD | Sales-ops | Daily | company intelligence | research |
| `/admin/sales/learning` | Learning Engine — compounding win patterns | Sales-ops | Occasional | learning store | analytics |
| `/admin/sales/tasks` | Sales AI task queue | Sales-ops | Occasional | task engine | tasks |
| `/admin/research` (+`/[taskId]`) | Research AI: run a company research task + live metrics | Sales-ops | Daily | research drain, task engine | qualification, companies |
| `/admin/qualification` (+`/[taskId]`) | Lead Qualification AI: qualify/disqualify verdicts | Sales-ops | Daily | qualification drain | research |
| `/admin/demos` | Demos CRM (filters + kanban + detail) | Sales-ops | Daily | `demo_requests` | organizations, customers |

### E. AI Receptionist (customer-facing voice ops sub-app)

| Route | Purpose | User | Freq | Key dependency | Related |
|---|---|---|---|---|---|
| `/admin/ai-receptionist` (+`/[id]`) | White-glove receptionist onboarding queue + per-setup drive (test checklist) | Ops | Occasional | receptionist setups | worklist |
| `/admin/ai-receptionist/worklist` (+`/[coordinationId]`, `/reassign`, `/attention`, `/my-claims`) | Conversation worklist operator surface (claim/reassign/attention) | Ops | Daily | conversation worklist spine | review |
| `/admin/ai-receptionist/review` (+`/[auditId]`) | Reply review inbox (human-approves drafted replies) | Ops | Daily | `ai_reply_*` audit | deliveries |
| `/admin/ai-receptionist/deliveries` (+`/[auditId]`) | Reply-delivery monitor (read-only) | Ops | Occasional | `ai_reply_lifecycle` view | review |

### F. Customers & revenue ops

| Route | Purpose | User | Freq | Key dependency | Related |
|---|---|---|---|---|---|
| `/admin/organizations` | CEO approval dashboard — demo_requests + signup-gating intake | CEO | Daily | `demo_requests`, `organizations` | demos, customers |
| `/admin/customers` (+`/[id]`) | Customers OS — one row per org (MRR, LTV, status) + detail | CEO / CS-ops | Daily | org financials/health | billing, health |
| `/admin/onboarding` | Cross-tenant onboarding/migration progress | Ops | Occasional | migration/import data | customers |
| `/admin/billing` | Billing OS — per-customer revenue (subscription, setup fee, MRR, failed payments) | CEO / finance | Occasional | Stripe/billing | finance, analytics |
| `/admin/support` (+`/[id]`) | Cross-tenant support queue + thread/status | Support-ops | Daily | tickets (service-role) | support-ai, notes |
| `/admin/health` | Customer Health deep dive — score + trend, churn/upsell triage | CS-ops | Occasional | cached health scores | customers, analytics |
| `/admin/notifications` | Cross-tenant notifications centre (audience hq/both) | Ops | Occasional | notifications service | alerts |
| `/admin/alerts` | Alerts + AI COO — deterministic rules over customer data (no LLM) | Ops / CEO | Daily | `lib/hq/alert-rules.ts` | health, notifications |
| `/admin/analytics` | Revenue + Health engine (MRR/ARR/churn/forecast + sparklines) | CEO | Occasional | analytics services | finance, health |
| `/admin/notes` | Cross-tenant internal notes (invisible to customers) | Ops | Occasional | notes (service-role) | customers, support |
| `/admin/impersonation` | Impersonation centre — active sessions, force-end, start session | Support-ops | Occasional | impersonation sessions | switch-to-customer |
| `/admin/switch-to-customer` (route) | Drop from HQ into the customer view | Any HQ user | Occasional | session | impersonation |

### G. Systems / platform ops

| Route | Purpose | User | Freq | Key dependency | Related |
|---|---|---|---|---|---|
| `/admin/ops` | System-status dashboard ("is the plumbing healthy?" — traffic-light) | Eng-ops | Occasional | health probes | cto-ai, health |
| `/admin/ai-costs` | AI spend governance — activation state (dark) + spend vs £100/org ceiling | Governance / finance | Occasional | AI cost ledger | finance |
| `/admin/automations` | Built-in automation rules (enabled state, last-run, run/failure counts) | Ops / governance | Occasional | automation registry | hq-cadence |
| `/admin/launch-checklist` | Readiness traffic-lights across every prior phase | CEO / eng-ops | Rare | phase readiness | ops |
| `/admin/settings` | HQ settings — 8 sections, server-action forms | CEO / ops | Rare | settings store | — |

---

## 5. Notable structural findings for the rebuild

- **Depth is hidden by a flat list.** Sales AI (8 pages) and AI Receptionist
  (7 pages) are full sub-apps shown as single nav lines; the 32-strong workforce is
  split between `ai-boardroom` and 14 bespoke cockpits.
- **Five overlapping home pages** should become one.
- **Everything is honest-by-construction:** cockpits badge each figure
  Fact/Derived/Insufficient-data and never fabricate zeros; the workforce is
  draft-only at the default-deny floor. The rebuild must preserve this honesty
  language (badges, "Foundation"/"Insufficient data" states, the framework banner).
- **The governance kernel is a coherent system** (`server/sdk/*`) but its UI
  entry-points are scattered; grouping them reads as one control plane.
- **Frequency spread is wide** — daily triage (approvals, command-centre, demos,
  worklist) vs. rare/dark (executor-shadow, cadence, launch-checklist). Nav weight
  should reflect it.

---

## 6. Proposed HQ top-level IA

A small, stable **6-area** primary nav. Each area has a default landing surface and a
short set of sub-destinations. This keeps the CEO's Home/Decisions/People/Work/
Governance/Systems shape but names areas from the real product.

### 1. Home — one executive front door
*Rationale: replace the 5 rival dashboards with a single "how is the company doing
now" surface + a live activity rail.*
Merges → `command-centre`, `overview`, `ceo`, `ceo/briefings`, `pulse`.
(Command-Centre's card grid as the body; the morning briefing as a "Today" panel;
Pulse as the live rail / an "Activity" tab.)

### 2. Decisions — the human-judgement inbox
*Rationale: the CEO's scarcest resource is judgement; give it one inbox.*
Landing = the Exec-Assistant "what needs you now" digest. Contains →
`approvals` (act-level), `decisions` (strategic, approve/reject/delay/delegate),
`executive-assistant-ai` (as the digest). Workflow-Sagas can surface here as
"decisions that spawn work", or live under Governance (see below).

### 3. Workforce ("People") — the 32 AI employees as one org
*Rationale: employees deserve ONE consistent home, not a boardroom card for some and
a bespoke page for others.*
Landing = `ai-boardroom` (roster). Contains → employee detail `ai-boardroom/[slug]`
(absorb the 14 bespoke `*-ai` cockpits as the employee's own tabbed page),
`tasks` (shared queue), `memory` (company brain). Group the roster by department
(Executive / Engineering-Platform / Growth / Customer / Finance-Product-Ops) exactly
as the seed data already implies.

### 4. Operations ("Work") — the business getting done
*Rationale: group by customer lifecycle, not by which AI produced the work.*
Two lanes:
- **Growth (pre-customer):** `sales` (+ its 8 sub-pages), `research`,
  `qualification`, `sales-orchestrator-ai` (pipeline view), `demos`,
  `organizations` (intake), `ai-receptionist` (+ worklist/review/deliveries).
- **Customers (post-sale):** `customers`, `onboarding`, `billing`, `support`,
  `health`, `notifications`, `alerts`, `notes`, `impersonation` / `switch-to-customer`.

### 5. Governance — the control plane of the kernel
*Rationale: the `server/sdk/*` kernel is one system; its surfaces should read as one.*
Contains → capability/authority posture (surfaced today via boardroom approval
levels), `executor-shadow` (execution evidence, LOCKED), `hq-cadence` (schedule
registry, DARK), `automations`, `ai-costs` (spend governance), the full `pulse` audit
log, and `workflow-sagas` if not placed under Decisions. This is where "can anything
execute / spend?" is answered.

### 6. Systems — platform health & configuration
*Rationale: keep rare config/health surfaces out of the daily path.*
Contains → `ops` (system status), `launch-checklist`, `settings`, and the
platform-facing employee cockpits (`cto-ai`, `qa-ai`, `operations-ai`) if not folded
into the Workforce employee pages, plus `analytics` (or analytics can sit in Home as
the "numbers" tab).

### Current-surface → proposed-area map (quick reference)

| Proposed area | Current surfaces absorbed |
|---|---|
| **Home** | command-centre, overview, ceo, ceo/briefings, pulse(rail) |
| **Decisions** | approvals, decisions(+[id]), executive-assistant-ai, (workflow-sagas) |
| **Workforce** | ai-boardroom(+[slug]), tasks, memory, + the 14 bespoke `*-ai` cockpits as employee tabs |
| **Operations · Growth** | sales(+8), research(+[taskId]), qualification(+[taskId]), sales-orchestrator-ai, demos, organizations, ai-receptionist(+worklist/review/deliveries) |
| **Operations · Customers** | customers(+[id]), onboarding, billing, support(+[id]), health, notifications, alerts, notes, impersonation, switch-to-customer |
| **Governance** | executor-shadow, hq-cadence, automations, ai-costs, pulse(full log), workflow-sagas |
| **Systems** | ops, launch-checklist, settings, analytics, (cto-ai/qa-ai/operations-ai) |

*Note: a few surfaces (workflow-sagas, analytics, the platform cockpits) are
legitimately placeable in two areas; pick one primary home and cross-link rather than
duplicating in the nav.*
