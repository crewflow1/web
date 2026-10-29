# HQ Growth + AI-Employee roster — Feature & Button Audit

Domain: CrewFlow HQ super-admin surface (`/admin`) — the **Growth** nav area (pre-customer) plus the **AI-employee cockpits** spread across Growth / Workforce / Systems / Customers / Governance. READ-ONLY audit (no controls operated). Browser verification NOT performed; classification is from code + known prod state (per `docs/audit/CONVENTIONS.md`).

Baseline: worktree `/Users/moetalibi/Code/web-main`.

---

## Cross-cutting architecture (applies to every page below)

**Access.** Every `/admin/*` page gates on `requireHqPage()` (`server/auth/hq.ts:30`) → `isSuperAdminEmail(user.email)`; non-allowlisted users get **404** (`hq.ts:32`), not 403. Super-admin is an ENV allowlist `CREWFLOW_SUPERADMIN_EMAILS` (`hq.ts:11`), not a DB role. Action files re-gate with `isSuperAdminEmail` / `requireSuperAdmin` / `requireAdmin` and `redirect("/dashboard")` on failure. So **Access = HQ super-admin (internal operator) only** for all pages; not stated again per-page.

**The AI cost governor** (`lib/ai/governor.ts:901` `invokeWithGovernor`). The one seam every AI call passes through. It refuses an unregistered feature key (closed set `AI_FEATURES`, `lib/ai/governor/registry.ts:358`), enforces the declared task class, and reserves→settles spend under a per-org advisory lock against a £100/mo ceiling.
- `TASK_CLASS_TIER` (`registry.ts:97`): deterministic→null, classification→cheap, drafting→mid, complex→high, embedding→embedding, transcription→transcription.
- `TIER_MODEL` (`registry.ts:173`): all five tiers are **ARMED in code** (cheap=haiku-4-5, mid=sonnet-5, high=opus-5, embedding=text-embedding-3-small, transcription=gpt-4o-mini-transcribe; dates 2026-09-10/11/13). A null binding = tier dark → `invokeWithGovernor` runs the caller's deterministic degraded path and records nothing (the "dark short-circuit").
- **Arming a tier in code is NOT activation.** Each feature additionally needs the vendor credential (`registry` readiness) AND, for several, a channel/DB/build flag or a standing CEO hold. So most generative legs still render **dark** on these surfaces even though the tier binding exists.

**The autonomous-apply lock** (`FEATURE_HQ_AUTONOMOUS_APPLY`). `featureHqAutonomousApplyEnabled` (`server/sdk/executor.ts:376`) is `true` only when the env var is exactly `"on"` — OFF in production today. It is the 3rd of three independent locks (posture floor `server/sdk/gate.ts`; kill-switches `CREWFLOW_EXECUTOR_APPLY` / `CREWFLOW_HQ_APPLY_ON_APPROVAL`). While off, `createGatedAutonomousApplyAuthority` (`server/sdk/autonomous-apply.ts:272`) and `createGatedApplyAuthority` resolve EVERY descriptor to `null` before any bound tool runs, recording a `refused` audit entry. Even when on, the gate is layered: mapped → plannable → **deterministic/reversible-only** (`autonomous-apply.ts:289`) — a generative/irreversible action is never autonomously applied.

**Net effect on this domain:** NO AI employee can act autonomously on production today. Every AI leg is either a drafting/proposal gated behind human review, or a deterministic read with the generative narrative dark. The surfaces below are overwhelmingly read dashboards + operator-driven CRM/config forms; the AI itself never pushes an irreversible change.

---

## Group A — The ten "narrative board" cockpits (pure read-only dashboards)

These share one pattern: `export const dynamic = "force-dynamic"`, `requireHqPage()`, a `load*Board` service that returns deterministic metrics each tagged Fact / Derived / **Insufficient data** (never a fabricated number), and a **DARK narrative leg** that only populates once a model tier is bound behind the governor. **Grep found NO `<form>`, `<button>`, `onClick`, `formAction`, or `"use server"` in any of these directories** — they are display-only.

### Page: Marketing AI — route `/admin/marketing-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: platform acquisition / top-of-funnel picture (demo-request volume, lead sources, demo→trial→paid funnel, growth). Scope is acquisition, not adoption.
- Displays: metric cards w/ Fact/Derived/Insufficient badges; unsourced signals (channel attribution, ad spend/CAC, SEO rank) render "Insufficient data" (`app/admin/marketing-ai/page.tsx:1-40`).
- Feature inventory: (1) metric board; (2) dark narrative placeholder (feature key `hq.marketing_narrative`).
- Autonomous? No — read-only, no AI write; narrative dark.
- Buttons & controls: **NONE.**

### Page: Product AI — route `/admin/product-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: voice-of-customer / product-signal picture (`app/admin/product-ai/page.tsx:1-27`). (1) metric board; (2) dark narrative (`hq.product_narrative`). Autonomous? No. Buttons: **NONE.**

### Page: Design AI — route `/admin/design-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: deterministic brand-token/consistency audit + design-review artifacts + run history over real `ai_employees` roster data (`app/admin/design-ai/page.tsx:1-21`). Generative UI critique dark (`hq.design_review`). Autonomous? No. Buttons: **NONE.**

### Page: Documentation AI — route `/admin/documentation-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: deterministic doc-drift scan + composed release-notes draft (from admin_activity_log + hq_events + hq_decisions) + run history (`app/admin/documentation-ai/page.tsx:1-25`). Generative prose dark (`hq.doc_draft`). Autonomous? No. Buttons: **NONE.**

### Page: Operations AI — route `/admin/operations-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: platform operations-health picture; unsourced SLA telemetry → Insufficient (`app/admin/operations-ai/page.tsx:1-27`). Narrative dark (`hq.operations_narrative`). Autonomous? No. Buttons: **NONE.**

### Page: QA AI — route `/admin/qa-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: AI-quality & reliability picture; browser/regression/a11y results + release approval → Insufficient (`app/admin/qa-ai/page.tsx:1-27`). Narrative dark (`hq.qa_narrative`). Autonomous? No. Buttons: **NONE.**

### Page: Customer Success AI — route `/admin/customer-success-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: retention/adoption picture (post-sale onboarding, trial→paid, 30-day activation, churn); NPS/CSAT → Insufficient (`app/admin/customer-success-ai/page.tsx:1-32`). Narrative dark (`hq.customer_success_narrative`). Autonomous? No. Buttons: **NONE.**

### Page: Support AI — route `/admin/support-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: support-queue triage picture; AI reply drafts dark (`app/admin/support-ai/page.tsx:1-27`, `hq.support_ai_narrative`). Autonomous? No. Buttons: **NONE.**

### Page: Sales Orchestrator AI — route `/admin/sales-orchestrator-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (narrative DARK)**
- Purpose: ONE cross-stage pipeline board unifying Research/Qualification/Outreach drains into a pipeline-health view (`app/admin/sales-orchestrator-ai/page.tsx:1-30`). Narrative dark (`hq.sales_orchestrator_narrative`). Autonomous? No. Buttons: **NONE.**

### Page: Executor Shadow — route `/admin/executor-shadow` — **Status: LIVE & WORKING (read-only observability)**
- Purpose: the reader for `hq_ai_executor_shadow_observations` — what the executor WOULD have done had execution been live (planned tool calls / refusals / errors). Evidence base for the CEO's live-execution decision (`app/admin/executor-shadow/page.tsx:11-26`).
- Displays: observation feed grouped by outcome (planned / refused / error), React-escaped (untrusted payloads never `dangerouslySetInnerHTML`).
- Autonomous? No — "STRICTLY READ-ONLY … Executor.apply/execute are never called anywhere" (`page.tsx:19-23`). Execution stays LOCKED.
- Buttons & controls: **NONE.**

---

## Group B — Action-bearing cockpits

### Page: Sales AI — route `/admin/sales` (+ `/companies`, `/activity`, `/analytics`, `/calling`, `/communications`, `/learning`, `/tasks`) — **Status: LIVE & WORKING (operator CRM; AI legs dark)**
- Purpose: the HQ outbound-sales CRM — companies, contacts, research notes, recommendations, interactions, locations, channels, call centre, AI-task queue. This is the Research/Qualification/Outreach pipeline's system of record.
- Displays: company lists & detail, pipeline status, activity timeline, analytics, a **calling centre** (scripts, playbooks, call logs, sentiment — `app/admin/sales/calling/page.tsx`; call *logging*, no live dialer/telephony), learning memory.
- Feature inventory: (1) company CRUD; (2) contacts add/delete; (3) research notes; (4) recommendations; (5) interaction logging; (6) research→company promotion; (7) locations; (8) channels add/delete; (9) AI-task enqueue; (10) outcome→Shared-Memory promotion; (11) company status transitions; (12) calling centre (read/log).
- Can it act autonomously? No. All 14 server actions (`app/admin/sales/actions.ts`) are operator-submitted forms. `enqueueAiTaskAction` (`actions.ts:815`) only *queues* an `hq_sales_ai_tasks` row for an AI employee; the worker that later runs it is governed and (for generative legs) dark.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Create / Update company | companies forms | insert/update `hq_sales_*` | name, fields | CRM row | Yes; `recordAdminActivity` | LIVE |
| Set company status | detail | status transition | id, status | pipeline move | Yes; audited | LIVE |
| Add/Delete contact | detail | insert/delete | company_id | contact row | Delete not reversible; audited | LIVE |
| Add research / recommendation / log interaction | detail | insert note/rec/event | text | timeline entry | Append; audited | LIVE |
| Promote research → company | detail | create company from candidate | id | new company | Audited | LIVE |
| Add/Delete channel, Add location | detail | insert/delete | fields | CRM rows | Delete irreversible; audited | LIVE |
| **Enqueue AI task** | detail/tasks | insert `hq_sales_ai_tasks` row for an AI employee | task_type, priority | queued task (worker governed; generative legs dark) | Task not run synchronously; audited (`actions.ts:851`) | LIVE (queue) / AI leg DARK |
| Promote outcome → Shared Memory | detail | opt-in memory write (idempotent) | event_id, company_id | memory row | Audited (Directive 002/003) | LIVE |

### Page: Research AI — route `/admin/research` (+ `/[taskId]`) — **Status: IMPLEMENTED, NOT LIVE-VERIFIED (model leg governed/dark-dependent)**
- Purpose: enqueue a `research_company` pipeline task and watch the live run (`app/admin/research/actions.ts:14-15`).
- Displays: single-button launcher (`_launcher.tsx` — one form, `useActionState`), run detail at `/[taskId]`.
- Can it act autonomously? No — operator presses the button. The run itself calls a model through `research-llm.ts:107` `invokeWithGovernor` under `research.*` keys (task class `complex`→high tier). It writes INTERNAL research artifacts + **DRAFT** outreach only (`hq-research.ts:16,1161`). If the tier/credential is unavailable the governor degrades; research.* legs produce nothing rather than fabricate.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Research a new company | `_launcher.tsx:109` | `researchCompanyAction` → enqueue `research_company`, redirect to run | company name/url | task + redirect | Audited (admin_activity_log); produces artifacts+drafts | IMPLEMENTED |
| Research existing company | company page | `researchExistingCompanyAction` → enqueue + redirect | company_id | same | Audited | IMPLEMENTED |

### Page: Qualification AI — route `/admin/qualification` (+ `/[taskId]`) — **Status: IMPLEMENTED, NOT LIVE-VERIFIED**
- Purpose: enqueue a `qualify_company` rubric task and watch the run (`app/admin/qualification/actions.ts:14-15`). Launcher mirrors Research. Autonomous? No (operator-triggered; governed run; draft/score output). Controls: `qualifyCompanyAction` (new) and `qualifyExistingCompanyAction` — both enqueue→redirect, audited.

### Page: Outreach AI — route `/admin/outreach` — **Status: FLAGGED/DARK — DRAFT-ONLY, no send scope**
- Purpose: generate cold-email **drafts** over the qualified pipeline. The page is explicit: "DRAFT-ONLY (no send scope)" (`app/admin/outreach/page.tsx:28-31`).
- Can it act autonomously / send? **No outbound send path exists in the action layer.** `draftOutreachAction` enqueues a `generate_email` task (`actions.ts:19-23`) that writes an immutable `hq_drafts` row for human review; governed under feature key `hq.draft` (task class drafting→mid). With no cost tier bound it returns a deterministic draft labelled as such (`hq-outreach.ts:24-29,410`). **No email is ever sent from here.**

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Draft outreach (new / for company) | outreach launcher | enqueue `generate_email` → draft in `hq_drafts`, drive queue once | company/url or company_id | approval-pending draft (no send) | Draft is immutable artifact; audited | DARK (draft-only) |

### Page: CTO AI — route `/admin/cto-ai` — **Status: IMPLEMENTED, NOT LIVE-VERIFIED**
- Purpose: queue a PR review for the CTO AI. Single action `queuePrReview` (`app/admin/cto-ai/actions.ts:26`) validates a PR number, enqueues via `enqueuePrReview`, drains once. Autonomous? No — operator enters a PR number; the review run is a governed narrative (`hq.cto_narrative`), advisory only, writes no code. Control: "Queue PR review" → enqueue+redirect, audited.

### Page: Demos — route `/admin/demos` — **Status: LIVE & WORKING — contains SENSITIVE live-provisioning + email sends**
- Purpose: demo-request Kanban (triage → schedule → promote to customer). Board/card/detail/filter components; 5 server actions.
- Can it act autonomously? No (operator-driven), BUT two actions have **real production side effects on humans**:
  - `promoteDemoToCustomer` (via `moveDemoToStatus` / `moveDemoToStatusJson`, `actions.ts:100,282`) **creates a Supabase auth user + org + membership + invite** ("Provisioning … runs BEFORE the status flip", `actions.ts:87`). Idempotent/retry-safe; halts the status move on failure.
  - Lifecycle **emails** sent via `demo-lifecycle.ts` → `lib/email/send.ts` (real Resend transport; degrades gracefully if `RESEND_API_KEY` unset).

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Move demo to status | board/detail | status change; on promote → provisions auth user+org+invite, may send email | demo_id, status | real account + real email | Account/email NOT reversible; audited; no extra 2nd-factor confirm beyond super-admin gate | LIVE (sensitive) |
| Move (JSON/optimistic) | board | same as above, returns JSON for optimistic UI | demo_id, status | same | same | LIVE (sensitive) |
| Add note | detail | append to `notes` | demo_id, text | note | Append; audited | LIVE |
| Schedule demo | detail | set scheduled time | demo_id, datetime | schedule | Yes; audited | LIVE |
| Log demo contact | detail | record contact attempt | demo_id | log entry | Append | LIVE |

### Page: AI Boardroom — route `/admin/ai-boardroom` (+ `/[slug]`) — **Status: LIVE roster config / FRAMEWORK ONLY (no execution)**
- Purpose: the AI-employee roster grid (CEO Directive 001 Phase 1). Grouped by department; each card = name, role, status, focus, last activity, approval rung, needs-approval. Page banner: **"FRAMEWORK ONLY — every card is configuration + logged history. No employee [acts]"** (`app/admin/ai-boardroom/page.tsx:47`), "a human always approves" (`page.tsx:126`). Roster source `listAiEmployees` (`server/services/ai-employees.ts`); the dark roster migration registered ~15 identities (`lib/hq/roster-runners.ts:4`).
- Displays: workforce KPIs (framework figures), per-department cards, approval-level badges; `/[slug]` = per-employee workspace (config, tasks, memory, capabilities, confidence/ETA/health).
- Can it act autonomously? No — these actions configure/retire employees and log tasks/memory; they do not run the employee. `authorAiEmployeeCapabilities` / `authorAiEmployeeMemoryScope` author the config a future activation would read.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Update employee config | `/[slug]` | update `ai_employees` row | slug, fields | config change | Yes; audited | LIVE |
| Retire employee | `/[slug]` | status→retired | slug | retire | Reversible via config; audited | LIVE |
| Add employee task | `/[slug]` | log a task row | slug, task | queued/logged task | Audited | LIVE |
| Add employee memory | `/[slug]` | write memory entry | slug, text | memory row | Audited | LIVE |
| Author capabilities | `/[slug]` | author capability config | slug, caps | config (inert until activation) | Audited | LIVE (config) |
| Author memory scope | `/[slug]` | author memory-scope config | slug | config | Audited | LIVE (config) |

### Page: Shared Memory — route `/admin/memory` (+ `/new`, `/[id]`, `/search`) — **Status: LIVE & WORKING (embedding query governed)**
- Purpose: the HQ shared-memory store that AI employees read/write (`hq_memories`). CRUD + pin + status + purge + semantic search.
- Can it act autonomously? No (operator CRUD). Search uses `memory.embedding_query` through `invokeWithGovernor` (`hq-memory.ts:1061-1075`, embedding tier armed → live when `OPENAI_API_KEY` present + worker flag); degrades to non-vector read otherwise.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Create memory | `/new` | insert `hq_memories` | title, body | memory | Yes; audited | LIVE |
| Update memory | `/[id]` | update row | id, fields | edit | Yes; audited | LIVE |
| Toggle pin | `/[id]` | set pinned | id | pin/unpin | Reversible; audited | LIVE |
| Set status | `/[id]` | set status | id, status | state change | Reversible; audited | LIVE |
| **Purge memory** | `/[id]` | removes memory | id | memory gone | **Irreversible delete**; audited (`hq_memory.purged`); super-admin gate only | LIVE (destructive) |
| Semantic search | `/search` | embedding query | query text | ranked results | Read; governed/ledgered | LIVE |

### Page: AI Receptionist — route `/admin/ai-receptionist` (+ `/[id]`, `/review`, `/review/[auditId]`, `/worklist`, `/worklist/[coordinationId]` + `/reassign`, `/deliveries`, `/deliveries/[auditId]`) — **Status: PARTIALLY IMPLEMENTED — channels/voice DARK; reply transport DARK; human-review gated**
- Purpose: configure the per-org receptionist (business phone, channels, preferred voice, test checklist), review held AI reply drafts, and run a coordination worklist (claim/release/reassign).
- **Telephony/voice — audit-prompt correction:** the prompt said "NO telephony/voice, no `phone_numbers` table." **A `phone_numbers` table now EXISTS** (migration `supabase/migrations/20261098000000_voice_telephony_phone_numbers.sql`) and `provisionPhoneNumber` (`app/admin/ai-receptionist/actions.ts:275`) inserts rows (`active:false`, provider twilio|vapi). **But voice is still effectively dark:** `NEXT_PUBLIC_FEATURE_VOICE_INBOUND` off + no telephony provider provisioned → `maybeGenerateVoiceTurn` unreachable; feature `receptionist.voice_turn` degrades to deterministic TwiML (`registry.ts` voice_turn entry). So: the schema/provisioning seam is built, the live spoken turn is not.
- **Outbound reply transport is DARK.** `sendReviewedReply` (`review/actions.ts:57`) → `resolveReviewSend` (`receptionist-review.ts:267`) → `dispatchHumanReviewedReply` → the transport seam, where `getWhatsAppProvider()` returns `null` today (`lib/comms/index.ts:197`; flag `NEXT_PUBLIC_FEATURE_WHATSAPP` + Meta creds absent). Policy is still evaluated on send (an absolute `block` is refused, audited, never transported). So a "send" records an audit/resolution and (if a booking was approved) fires the idempotent fulfilment engine, but no real message leaves while the channel is dark.
- Can it act autonomously? No. Reply drafts are **human-review gated** — `sendReviewedReply` is the sole path and requires an operator; AI never auto-sends.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Set receptionist status | `/[id]` | update setup status | id, status | state | Reversible; audited | LIVE (config) |
| Toggle test checklist | `/[id]` | flip checklist item | id | config | Reversible; audited | LIVE (config) |
| Update HQ notes | `/[id]` | set `hq_notes` | id, text | note | Reversible; audited | LIVE |
| Mark configured | `/[id]` | set configured + timestamps | id | config | Reversible; audited | LIVE |
| **Provision phone number** | `/[id]` | insert `phone_numbers` (active:false) | org_id, provider, E.164 | DB row (no live telephony) | Row stays inactive; audited (`voice.number_provisioned`) | IMPLEMENTED, voice DARK |
| Set phone number active | `/[id]` | toggle `active` | number id | flag flip (no transport wired) | Reversible; audited | DARK |
| **Send reviewed reply** | `/review/[auditId]` | human-approved reply → canonical pipeline → (dark) transport; fires booking fulfilment if applicable | reviewed text | audit + resolution; **no real send while channel dark** | Resolution durable; policy block refused; audited (`receptionist_review.send`) | DARK transport / human-gated |
| Dismiss reviewed reply | `/review/[auditId]` | record decision NOT to send | audit id | resolution | Audited; no transport | LIVE |
| Claim / Release conversation | `/review/[auditId]`, `/worklist/[id]` | set/clear ownership | audit/coordination id | ownership marker | Reversible; isolation preserved | LIVE |
| Reassign work item | `/worklist/[coordinationId]/reassign` | reassign ownership | coordination id, assignee | ownership change | Reversible; audited | LIVE |
| Deliveries | `/deliveries` | read sent/held delivery log | — | read | Read-only | LIVE |

---

## DOMAIN SUMMARY

**Page count:** 20 distinct routes audited (10 narrative boards + executor-shadow + 8 action-bearing cockpits + sales sub-routes).

**Status tallies (page-level):**
- LIVE & WORKING: 4 (Executor Shadow, Sales CRM, Demos, Shared Memory) + config legs of AI Boardroom / AI Receptionist.
- IMPLEMENTED, NOT LIVE-VERIFIED: 13 (10 narrative boards + Research + Qualification + CTO AI).
- FLAGGED OFF / DARK: Outreach (draft-only, no send), AI-Receptionist voice + reply transport.
- No BROKEN / no PLACEHOLDER-only pages found.

**AI employees — live vs dark (one-liner each):**
- Sales AI — LIVE as an operator CRM; AI task execution queued & governed, generative legs dark.
- Research AI — operator-triggered governed runs (high tier); writes internal artifacts + DRAFT outreach; no autonomy.
- Qualification AI — operator-triggered governed rubric; draft/score output; no autonomy.
- Outreach AI — **DRAFT-ONLY, DARK**; generates `hq_drafts`, zero send scope anywhere.
- Sales Orchestrator AI — read-only unified pipeline board; narrative dark.
- Marketing / Product / Design / Documentation / Operations / QA / Customer-Success / Support AI — read-only deterministic dashboards; every generative narrative DARK.
- CTO AI — operator queues PR review; advisory narrative; writes no code.
- AI Boardroom roster — **FRAMEWORK ONLY**; config + logged history; no employee executes.
- Shared Memory — LIVE store; semantic search governed (embedding tier armed).
- AI Receptionist — config + human-review surfaces LIVE; **voice DARK**, **outbound reply transport DARK**; never auto-sends.
- Executor Shadow — LIVE read-only; records what execution WOULD do; `Executor.apply/execute` never called.

**Governor / approval enforcement:** Single-seam governor (`invokeWithGovernor`) with a closed feature registry; all five tiers armed in code but gated by vendor credential + channel/DB/build flags + CEO holds, so most generative legs still render dark. Autonomous apply is triple-locked (`FEATURE_HQ_AUTONOMOUS_APPLY` off by default, deterministic-reversible-only even when on). Receptionist replies and outreach are human-review / draft-only by construction — AI cannot send or apply autonomously.

**Notable findings / bullets:**
1. **Audit-prompt correction:** `phone_numbers` table now EXISTS (mig `20261098…`) and `provisionPhoneNumber` inserts into it — but voice remains dark (flag off, no provider, deterministic TwiML fallback). The gap is live telephony, not the schema.
2. **Most sensitive control in the domain is on `/admin/demos`, not an AI employee:** promoting a demo **creates a real auth user + org + invite and sends real Resend email** with no confirmation beyond the super-admin gate. Reversibility is weak (account creation). Worth a 2nd-factor/confirm step.
3. **`/admin/memory` purge** is an irreversible hard-delete of shared memory, super-admin-gated, audited — no confirmation modal verified in code.
4. Outbound receptionist "send" is architecturally safe: transport seam returns `null` today, policy block still refused even on manual send; a durable resolution + idempotent booking fulfilment are recorded but no message leaves.
5. The 10 narrative boards are genuinely honest-by-construction: unsourced signals render "Insufficient data" with a reason rather than fabricating numbers — no false-green.
6. Research/Outreach/Qualification pages only ENQUEUE tasks; the governed worker runs separately, so a page load never triggers a model call (event-driven doctrine respected).
7. Every action file re-gates auth inline (defence-in-depth) and writes `recordAdminActivity` — audit trail coverage is consistent across the domain.
8. **Orphaned routes / server-actions-with-no-UI:** none found in the audited set — the nav model (`hq-nav-model.ts`) lists every surface and `flatHqNav()` is pinned by reachability tests. Receptionist `/deliveries/[auditId]` and `/worklist/[coordinationId]` detail pages are reachable via cards/links per the nav-model comments.
9. Many `server/services/hq-*-exec-runner.ts` + `*-runner.ts` files exist (CFO, COO, HR, legal-compliance, security, devops, lead-sourcing, memory-manager, etc.) that have **no dedicated `/admin` page** — they are dark roster runners (`lib/hq/roster-runners.ts:4` notes ~15 identities registered with no runner) backing the Boardroom roster, invoked only by cron/governed pipelines, not operable from a UI.
10. No control in this domain can bypass the governor or the apply-lock from the UI; the architecture is "built dark, activate by config flip," consistent with the standing CEO roadmap-completion mandate.

**Limitation:** browser/authenticated multi-role verification was out of scope; LIVE/DARK classification is from code + migrations + known prod state per `CONVENTIONS.md`.
