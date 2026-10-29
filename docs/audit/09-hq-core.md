# CrewFlow HQ audit — 09 · HQ Core + Control Plane

Audit date 2026-10-28 · worktree `/Users/moetalibi/Code/web-main` · READ-ONLY (code + known prod state; no browser verification — authenticated multi-role prod access out of scope, per `docs/audit/CONVENTIONS.md`).

Domain = HQ CORE control plane: Home / Command centre / CEO board / Morning briefings / Overview / Pulse / What-needs-you / Approvals / Decision centre / Task queue / Workflow sagas / Launch checklist / Notifications / Internal notes / Cadence clock / Alerts / Automations / Settings.

## Super-admin gate (how `/admin` access is enforced server-side)

- **Mechanism: ENV allowlist → 404 (not 403).** The only gate is `requireHqPage()` for pages / `requireHqApi()` for route handlers, both reducing to `isSuperAdminEmail(user.email)`.
  - `server/auth/hq.ts:33` `requireHqPage()` — `requireUser()` (anonymous → `/login`), then `if (!isSuperAdminEmail(user.email)) notFound()` (`server/auth/hq.ts:35`).
  - `server/auth/hq.ts:52` `requireHqApi()` — returns a ready `404 Response` for anonymous or non-allowlisted (`server/auth/hq.ts:58`).
  - `server/auth/superadmin.ts:17` `isSuperAdminEmail()` reads `env.CREWFLOW_SUPERADMIN_EMAILS` (comma-separated, case-insensitive, trimmed). **Empty/unset ⇒ nobody is super-admin and `/admin` 404s for everyone** (`server/auth/superadmin.ts:19`). Not a DB role / not a JWT claim — cannot be an RLS policy, so it lives in the request path in exactly one place.
- **Applied once at the layout** (`app/admin/layout.tsx:46` `const user = await requireHqPage();`) so every child route inherits the 404-for-non-allowlisted rule; **most pages re-gate for defence-in-depth** and every mutating server action re-checks `isSuperAdminEmail` before calling its service (service checks a third time). One exception: `app/admin/overview/page.tsx:1389` calls only `requireUser()` (relies on the layout gate; no inline re-gate — still protected, but inconsistent with siblings).

## FEATURE_HQ_AUTONOMOUS_APPLY & the apply/execute kill-switches — all DARK

Declared for boot-time visibility only; each consumer requires the exact literal `"on"`; all unset in prod (`lib/env.ts:377-384`, pinned by `__tests__/security/autonomous-apply-dark.test.ts`).
- `FEATURE_HQ_AUTONOMOUS_APPLY` (`lib/env.ts:381`) — build-flag gating the completed-but-locked production apply authorities.
- `CREWFLOW_EXECUTOR_APPLY` (`lib/env.ts:382`) — `executorAutonomousApplyEnabled()` returns true only when `=== "on"` (`server/sdk/autonomous-apply.ts:80`); off ⇒ the runner wires the UNBOUND authority (`resolve: () => null`), never a bound/live one.
- `CREWFLOW_HQ_APPLY_ON_APPROVAL` (`lib/env.ts:383`) — the `/api/cron/hq-apply-drain` drain short-circuits with `enabled:false` before any read or apply when off (default) (`app/api/cron/hq-apply-drain/route.ts:21-22`).
- `CREWFLOW_EXECUTOR_SHADOW` (`lib/env.ts:384`) — shadow observations only; `Executor.apply/execute` are never called anywhere.
**Net: no HQ surface can autonomously execute. Every "Approve"/"decide"/"advance" only records state; the executor is dark.** Deny-by-default posture floor proven in `server/sdk/gate.ts`.

---

### Page: HQ Home — route `/admin` → `app/admin/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin. Server enforcement: layout `requireHqPage()` + inline `requireHqPage()` (`app/admin/page.tsx:44`).
- **Purpose:** attention-first executive front door (replaces the old `/admin → /command-centre` redirect); answers in ~10s: what needs me, what's active, what finished, CEO brief, system health.
- **Displays:** 5 streamed `<Suspense>` sections from `_components/hq-home` — NeedsYou, ActiveNow, RecentOutcomes, CeoBrief, SystemHealth; plus a "Deeper views" grid of 5 secondary links.
- **Feature inventory:** (1) Needs-your-attention panel; (2) Active-now; (3) Recent-outcomes; (4) CEO brief; (5) System-health; (6) 5 secondary-view link cards.
- **Buttons & controls:** no forms/mutations — navigation links only.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Deeper-view links ×5 | footer grid | navigate to command-centre / ceo / briefings / overview / pulse | — | read-only nav | n/a | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Command Centre — route `/admin/command-centre` → `app/admin/command-centre/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin (layout gate; no inline re-gate — relies on layout). Data `getExecutiveDashboard()`.
- **Purpose:** live company control centre — revenue, pipeline, conversion, outreach, AI workforce, research in one glance.
- **Displays:** ~27 animated metric cards in 6 sections; period-over-period trend badges; count-up counters (`_counter.tsx`, the only client JS); "Foundation" tag for no-source-yet channels (e.g. WhatsApp); `null` figures render em-dash (never a fabricated 0).
- **Feature inventory:** (1) section grid of exec cards; (2) count-up animated counters (framer-motion, respects reduced-motion); (3) trend badges; (4) Foundation tags; (5) live-snapshot timestamp; (6) header quick-links (CEO Board / Sales AI / AI Boardroom).
- **Buttons & controls:** navigation only (card `href` deep-links + header links).

### Page: CEO Dashboard — route `/admin/ceo` → `app/admin/ceo/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin (layout gate). Data `getCeoDashboard()`.
- **Purpose:** whole company on one departmental board — 5 vitals + one scorecard per department (Finance/Customers/Pipeline/Sales/Marketing/Research/AI/Learning/Support/Growth).
- **Displays:** vitals grid; department cards with headline figure, supporting stats, trend, drill-in link, honest health pill (healthy/steady/attention/foundation/insufficient — insufficient = read-failed, deliberately not green).
- **Feature inventory:** (1) company-vitals row; (2) department scorecards; (3) health legend; (4) drill-in links per dept; (5) honest "insufficient" read-failure state.
- **Buttons & controls:** navigation only.

### Page: Morning CEO briefings — route `/admin/ceo/briefings` → `app/admin/ceo/briefings/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (reader of cron-composed records; empty until the morning cron has run).
- **Access:** super-admin, inline `requireHqPage()` (`.../briefings/page.tsx:971`). Data `getCeoBriefingArchive()` / `selectBriefingByDate()` from `hq_ceo_briefings` (mig 20261128).
- **Purpose:** STRICTLY READ-ONLY reader for the deterministic daily briefing the cron composes — closes the "composed but never read back" gap.
- **Displays:** latest briefing + provenance (source, generated stamp, correlation id), vitals snapshot, departments grouped by health, competitor-intel notes, full narrative (`<pre>`), dated archive list with `?date=` drill-down.
- **Feature inventory:** (1) headline+provenance; (2) vitals; (3) departments-by-health; (4) competitor intelligence; (5) full narrative; (6) archive list drill-down; (7) honest empty-state.
- **Buttons & controls:** navigation only (archive date links). No writes, no re-compose. UNTRUSTED-SAFE: all fields React-escaped.

### Page: Overview — route `/admin/overview` → `app/admin/overview/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin — **inline uses only `requireUser()` (`:1389`), relies on the layout `requireHqPage()`** (inconsistent with siblings; still protected). Reads `public.users` + `buildHqSnapshot()` via `createAdminClient()` (service-role).
- **Purpose:** headline KPI tiles + 4 sparklines + morning-summary greeting — "know in 10s where to spend the next hour".
- **Displays:** morning-summary bullets; 8 KPI tiles (MRR, forecast MRR, setup fees, growth 30d, active, in-onboarding, pending demos, cancelled); 4 sparkline cards (revenue/MRR/customer-growth/cancellations, 12mo). MRR is `active × £500`; setup fee `paid_orgs × £1,000` (hardcoded pricing assumptions).
- **Feature inventory:** (1) morning summary; (2) KPI tiles; (3) sparklines; (4) pending-demos "Open" link → organizations; (5) legacy organisations link.
- **Buttons & controls:** navigation only.

### Page: The Pulse — route `/admin/pulse` → `app/admin/pulse/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin, inline `requireHqPage()` (`:47`); backing API `app/api/hq/pulse/route.ts` + `/[id]` gated by `requireHqApi()` (`:58`). `runtime=nodejs`.
- **Purpose:** full HQ event timeline — "feel like Linear/Stripe/Vercel", the company's entire history, live.
- **Displays:** SSR first page (50) + facets + deep-linked event; client `<PulseFeed>` polls `/api/hq/pulse` ~15s for live head (interval poll, not push). Reads ONLY the `hq_timeline` projection via SECURITY DEFINER RPCs (never `hq_events`); never-throw services degrade to empty, not 500.
- **Feature inventory:** (1) virtualised live feed; (2) filter state in URL (`?cat&sev&act&q&event`) — shareable; (3) facet filters (category/severity/actor/search); (4) event detail drawer; (5) 15s polling live head.
- **Buttons & controls:** client-side filters + search (read-only query params); no mutations.

### Page: What needs you (Executive Assistant AI) — route `/admin/executive-assistant-ai` → `app/admin/executive-assistant-ai/page.tsx`
- **Status:** PARTIALLY IMPLEMENTED — deterministic digest LIVE-coded; the narrative is DARK (no governor key wired until a model tier binds).
- **Access:** super-admin, inline `requireHqPage()` (`:869`). Data `loadExecutiveAssistantBoard()`.
- **Purpose:** single "what needs the human right now" cross-board projection (approvals + decisions + overdue/stalled tasks + alert load).
- **Displays:** prioritised digest list (deep-links to source surface); 4 load panels (approval/decision/task/alert) with honest "could not be read this cycle" states; metric grid labelled Fact/Derived/Insufficient; narrative panel (dark placeholder); DecisionStateLegend. Verdict never shows all-clear over a failed read.
- **Feature inventory:** (1) needs-human digest; (2) 4 load panels; (3) provenance-labelled metric grid; (4) narrative panel (DARK — states it populates once a tier is bound); (5) source-routing deep links.
- **Buttons & controls:** navigation only (digest rows → `/admin/approvals|decisions|tasks|alerts`).

### Page: Approval Console — route `/admin/approvals` → `app/admin/approvals/page.tsx` (+ `actions.ts`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. (Human decision surface of the Approval Engine; the executor is dark — approving only marks granted.)
- **Access:** super-admin, inline `requireHqPage()` (`:211`); every action re-checks `isSuperAdminEmail` → `redirect("/dashboard")` if not (`actions.ts:41`); service `hq-approvals` gates again; DB trigger is the unbypassable enforcer.
- **Purpose:** queue where AI-employee proposals (`hq_approvals`) wait for a human; pending/escalated as cards, decided/expired as history.
- **Displays:** Review-queue / Decided-&-expired tabs; cards with state pill, payload (React-escaped `<pre>` — UNTRUSTED data, never interpreted), reviewer/age/expiry meta.
- **Feature inventory:** (1) queue tab; (2) history tab; (3) approve; (4) reject w/ reason; (5) escalate; (6) edit-payload-before-deciding; (7) payload-untrusted display.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Approve | queue card | `approveApproval` → marks granted (executor DARK, nothing runs) | hidden `id` | state→approved | Terminal; audited (service+trigger+timeline) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Reject | queue card | `rejectApproval` | `id` + reason (required, 1–2000) | state→rejected | Terminal; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Escalate | queue card (when legal) | `escalateApproval` | `id` | state→escalated | Reversible via decision; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save edit (payload) | `<details>` | `editApproval` — tracked revision, original kept | `id` + `payload_json` (strict JSON ≤30k) | records reviewer revision | tracked; original on record; audited | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Decision Centre — route `/admin/decisions` (+ `/[id]`, `_status.tsx`, `actions.ts`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin, inline `requireHqPage()` (`:52`, detail `:313`); form only renders to allowlisted (`:146`); actions re-gate (`actions.ts:169`); service + DB trigger enforce the 4-outcome state machine.
- **Purpose:** strategic MOVES — rich human-authored proposals resolved with FOUR outcomes (approve/reject/delay/delegate). Engine records, never executes. Some rows are `source:"deterministic"` auto-proposed (`/api/cron/hq-decision-autopropose`).
- **Displays:** status-count pills; raise-a-proposal form; Awaiting / Decided sections; detail = full proposal fields, AI-debate panel (deterministic producer; generative tier DARK), decision actions or terminal summary, append-only immutable history.
- **Feature inventory:** (1) create proposal; (2) approve; (3) reject; (4) delay; (5) delegate; (6) generate deterministic debate; (7) immutable history; (8) auto-proposed badge.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Raise proposal | list form | `createDecision` | title (req) + 8 optional fields | new proposed row | new row; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Approve | detail | `decide(approve)` | id + optional note | status→approved (no execution) | Terminal; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Reject | detail | `decide(reject)` | id + reason (req) | status→rejected | Terminal; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delay | detail | `decide(delay)` | id + date (req) + reason (req) | status→delayed, revisit date | Terminal (re-raise to revisit); audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delegate | detail | `decide(delegate)` | id + delegate uuid (req) + reason (req) | status→delegated | Terminal; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generate debate | detail (proposed+empty) | `produceDecisionDebate` — deterministic from signals, first-write-wins | id | fills AI-debate slot; no model call | idempotent; audited | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: AI Task Queue — route `/admin/tasks` → `app/admin/tasks/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (read-only).
- **Access:** super-admin (layout gate; no inline re-gate). Data `getTaskQueueOverview()` — SELECTs `hq_ai_tasks` only.
- **Purpose:** unified operator read-model for the Generic Task Engine — the whole autonomous workforce on one shared queue.
- **Displays:** 6 engine-wide total tiles (total/queued/active/awaiting-approval/completed/failed); per-employee (task-type) breakdown over recent window; live feed of newest tasks speaking the ONE HQ decision language.
- **Feature inventory:** (1) totals tiles; (2) per-employee breakdown; (3) recent-task feed; (4) retry/origin/subject badges.
- **Buttons & controls:** none — pure read surface.

### Page: Workflow Sagas — route `/admin/workflow-sagas` (+ `/[id]`, `actions.ts`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin, inline `requireHqPage()` (`:680`, detail `:882`); create form renders only to allowlisted (`:761`); actions re-gate (`actions.ts:355`); service `hq-workflow` + Task-Engine authority own dispatch.
- **Purpose:** decompose a directive into an ordered dependency-linked task graph; each step maps to one `hq_ai_tasks` row. Progress reflects real step/task state.
- **Displays:** create form (title + template select incl. AI-assisted governed option); Active / Finished sections; detail = step graph w/ dependency edges, per-step status, linked task id, dispatch/re-sync + abandon controls.
- **Feature inventory:** (1) create saga from template; (2) AI-assisted decomposition (governed — can refuse `model_dark`/`budget_refused`/etc.); (3) dispatch step; (4) re-sync from task; (5) abandon saga; (6) dependency gating (disabled until dependency done).

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Plan the saga | list form | `createSaga` (deterministic template or AI-assisted governed) | title + template_key | new saga + step graph | audited; AI path governed+budgeted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Dispatch step / Re-sync | detail | `advanceStep` → Task-Engine create/sync | saga_id + step_id | step task dispatched/synced | refused if dependency not done; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Abandon saga | detail | `abandonSaga` | saga_id | saga→abandoned | Terminal; recorded in history | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Launch checklist — route `/admin/launch-checklist` → `app/admin/launch-checklist/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (read-only).
- **Access:** super-admin, inline `requireHqPage()` (`:1320`). Data `buildLaunchReadiness()`.
- **Purpose:** single-page traffic-light of readiness across every phase (Ops/Retention/Portal/Automation/AI/HQ/Security/Polish).
- **Displays:** overall GREEN/AMBER/RED banner; per-check rows with status pills; "Next checks" block with a copy-paste local e2e-lifecycle script (warns `--linked` = production). Links to `/admin/ops` and `/admin/automations`.
- **Buttons & controls:** navigation only; the script is display text, NOT an executable control.

### Page: Notifications — route `/admin/notifications` → `app/admin/notifications/page.tsx` (+ `actions.ts`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin — page body reads cross-tenant service-role; **page itself has no inline re-gate** (layout gate only); every action re-checks `isSuperAdminEmail` (`actions.ts:505`) and writes `admin_activity_log`.
- **Purpose:** cross-tenant ops feed — every notification with audience `hq`/`both` across all orgs; plus email-queue health.
- **Displays:** KPI tiles (unread/urgent/high/last-24h); email-queue stats (queued/sent/failed/skipped/permanent-fail) + recent failures; GET filter bar (search/state/category/priority/org); notification list with source deep-links.
- **Feature inventory:** (1) filters; (2) mark-all-read; (3) mark-read; (4) dismiss; (5) requeue-failed-email; (6) email-queue health; (7) open-source links.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Mark all read | header | `markAllReadHq` | — | all HQ notifs read | not reversed in UI; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Mark read | row | `markReadHq` | id | one read | audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Dismiss | row | `dismissHq` | id | dismissed | audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Requeue | email-failure row | `requeueFailedNotificationEmail` → next drain re-attempts | id | reset failed→queued (re-sends a real email ≤15min) | one-way; audited | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Internal notes — route `/admin/notes` → `app/admin/notes/page.tsx` (+ `actions.ts`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** super-admin — **no inline re-gate on the page** (layout only); actions re-check `isSuperAdminEmail` (`actions.ts:626`), route via service-role (RLS bypass by design — invisible to tenants), write `admin_activity_log`. Org picker paged (F-1, `fetchAllRows`).
- **Purpose:** cross-tenant customer-context library (sales nuance, risk flags, billing decisions) — internal only.
- **Displays:** KPI tiles; new-note form (customer/title/body/category/priority/pin); GET filter bar; note list with category/priority pills, customer link, author+timestamps.
- **Feature inventory:** (1) create note; (2) pin/unpin; (3) archive; (4) unarchive; (5) filters/sort; (6) URGENT → HQ notification fire.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Save note | form | `createInternalNote` (urgent → `notifyOnUrgentHqAlert`, audience forced `hq`) | org_id + body (req) + cat/pri/pin | new note (+HQ notif if urgent) | reversible via archive; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Pin / Unpin | row | `togglePinNoteAction` | id | toggles pin | reversible; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Archive / Unarchive | row | `archive`/`unarchiveInternalNote` | id | soft archive toggle | reversible; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| (`updateNoteAction` exists in actions, no edit button on this page — see orphaned actions) | — | edit note | id + fields | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Cadence Clock — route `/admin/hq-cadence` → `app/admin/hq-cadence/page.tsx` (+ `actions.ts`)
- **Status:** PARTIALLY IMPLEMENTED — registry + enable/pause LIVE-coded; **every cadence DARK by default** (the modelled tick is inert until opted in; legacy crons run regardless).
- **Access:** super-admin, inline `requireHqPage()` (`:1023`); action re-gates (`actions.ts:937`); service + audit.
- **Purpose:** one modelled clock over the hand-rolled HQ cron cadences; deterministic tick fires the enabled ones.
- **Displays:** Enabled / Dark sections; cards w/ cadence_key, cron_expr, description, next/last run; enable/pause toggle.
- **Feature inventory:** (1) registry view; (2) enable cadence; (3) pause cadence.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Enable cadence | dark card | `setCadenceEnabled(true)` — modelled tick starts firing it | cadence_key | cadence enabled (legacy cron unaffected) | reversible (pause); audited | FLAGGED OFF (dark by default) |
| Pause cadence | enabled card | `setCadenceEnabled(false)` | cadence_key | back to dark | reversible; audited | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Alerts (Action centre / AI COO) — route `/admin/alerts` → `app/admin/alerts/page.tsx` (+ `actions.ts`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Deterministic rules engine (no LLM; `pickActionCentre` reserved for a future reranker).
- **Access:** super-admin — **page has no inline re-gate** (layout only); actions re-check `isSuperAdminEmail` (`actions.ts:1057`), UPSERT `admin_alert_state`, write `admin_activity_log` (best-effort). Note: `admin_alert_state` accessed via an untyped `as never` cast (post-generated-types table).
- **Purpose:** every customer needing attention, from `lib/hq/alert-rules.ts`; AI-COO "today needs attention" top-3.
- **Displays:** AI-COO panel; KPI tiles; GET filter bar; alert cards w/ reason, suggestion, contact actions (Call/Email/WhatsApp `mailto:`/`tel:`/wa.me), lifecycle controls.
- **Feature inventory:** (1) COO panel; (2) resolve (confirm); (3) snooze (confirm, 1/3/7/30d); (4) mark-read; (5) reopen (confirm); (6) assign (`assignAlert` — action exists, no UI button → orphaned); (7) bulk-resolve shaped for future LLM; (8) contact deep-links.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Mark resolved | alert card (ClientConfirmForm) | `markAlertResolved` — auto-archives, clears notif dedup | rule_id+org_id (+note) | resolved, dedup cleared → future re-fire pings HQ | reversible (Reopen); audited ×2 (state+org) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Snooze | alert card (confirm) | `snoozeAlert` | rule_id+org_id+preset | hidden N days | reversible; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Reopen | resolved card (confirm) | `reopenAlert` | rule_id+org_id | back to active queue | reversible; audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Mark read | alert card | `markAlertRead` | rule_id+org_id | clears unread | audited | IMPLEMENTED, NOT LIVE-VERIFIED |
| Call / Email / WhatsApp | alert card | opens `tel:`/`mailto:`/`wa.me` to CUSTOMER owner | contact present | launches external app (no send on behalf) | n/a | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Automations — route `/admin/automations` → `app/admin/automations/page.tsx`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (read-only telemetry; deliberately not a Zapier clone).
- **Access:** super-admin, inline `requireHqPage()` (`:1435`). Data `readAutomationHealth()`.
- **Purpose:** list every built-in automation rule with enabled state, last-run, 7-day run/failure/dead-letter counts.
- **Displays:** 4 KPIs; rules table (rule/trigger/last-run/runs/fails/dead/status). Idempotent by `(rule_id, source)`.
- **Buttons & controls:** navigation only. **No toggle UI** — catalogue is hardcoded in `lib/automation/rules.ts`; disabling a rule requires an edit+ship (stated on-page).

### Page: Settings — route `/admin/settings` → `app/admin/settings/page.tsx` (+ `actions.ts`)
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (rebuilt 2026-10-19 "settings-truth": every writable control has a real consumer).
- **Access:** super-admin, inline `requireHqPage()` (`:1199`); `saveSection` re-gates (`actions.ts:1379`), UPSERTs, writes `admin_activity_log` with before/after diff.
- **Purpose:** platform config; 7 sections, each a server-action `<form>` (no client JS).
- **Displays:** General (timezone), Notifications (HQ recipients, quiet hours, urgent-override toggle), Alerts (critical CC email), Billing (default invoice due days), Support (default reply signature), Integrations (READ-ONLY provider-readiness panel from `lib/comms/readiness.ts` — Email/SMS/WhatsApp/Stripe + free-form notes), Feature flags (READ-ONLY notice: production flags are Vercel env, documented in `docs/launch/PRODUCTION-ACTIVATION-MATRIX.md`).
- **Feature inventory:** (1–5) five writable section saves; (6) read-only integrations readiness; (7) read-only feature-flags notice.

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Save general/notifications/alerts/billing/support | each section | `saveSection(id,…)` — validate+UPSERT | section fields | config change | reversible by re-save; audited w/ diff | IMPLEMENTED, NOT LIVE-VERIFIED |
| (Integrations / Feature-flags) | — | READ-ONLY panels (prior `*_connected`/JSONB toggles removed — they counterfeited state) | — | nothing to change here | n/a | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## DOMAIN SUMMARY

**Counts:** 18 primary pages (+2 detail sub-routes: `/decisions/[id]`, `/workflow-sagas/[id]`) · ~55 features · 28 interactive controls (23 state-mutating server actions + filter/nav controls across pages).

**Status tallies (pages):** LIVE & WORKING 0 · IMPLEMENTED/NOT LIVE-VERIFIED 15 · PARTIALLY IMPLEMENTED 2 (executive-assistant-ai narrative dark; hq-cadence dark-by-default) · BROKEN 0 · PLACEHOLDER 0. (No page browser-verified — authenticated prod access out of scope; classified from code + memory's known-prod-live state.)

**Super-admin gate:** ENV allowlist `CREWFLOW_SUPERADMIN_EMAILS` → `isSuperAdminEmail` → `notFound()`/`404`, single source in `server/auth/hq.ts` (`requireHqPage`/`requireHqApi`). Not RLS-expressible. Empty env ⇒ `/admin` 404s for everyone.

**Notable findings (dangerous/dark/gaps):**
1. **All autonomous-apply/execute kill-switches are DARK** (`FEATURE_HQ_AUTONOMOUS_APPLY`, `CREWFLOW_EXECUTOR_APPLY`, `CREWFLOW_HQ_APPLY_ON_APPROVAL`, `CREWFLOW_EXECUTOR_SHADOW` — all unset, each requires literal `"on"`; `lib/env.ts:377-384`). No HQ "Approve"/"Decide"/"Advance" control executes anything — they only record state; pinned dark by `__tests__/security/autonomous-apply-dark.test.ts`. This is the single highest-blast-radius flag family and it is off.
2. **Highest-blast-radius LIVE control = Alerts "Mark resolved"** — clears the notification dedup so a future re-fire re-pings HQ, and auto-archives; wrapped in `ClientConfirmForm` (native confirm), reversible via Reopen, double-audited. **Notifications "Requeue"** is the only control that triggers an outbound real email (resets failed→queued; one-way, no confirm dialog).
3. **AI/generative surfaces are deterministic or dark:** CEO briefings = deterministic cron compose, read-only; Decision AI-debate = deterministic producer (generative tier dark); Executive-assistant narrative = DARK (no governor key wired yet); Saga AI-assisted decomposition = governed+budgeted and can refuse (`model_dark`/`budget_refused`); Alerts AI-COO = deterministic rules, `pickActionCentre` reserved for a future LLM reranker.
4. **Inline re-gate inconsistency:** `/admin/overview`, `/admin/tasks`, `/admin/command-centre`, `/admin/ceo`, `/admin/notifications`, `/admin/notes`, `/admin/alerts` rely on the layout gate without an inline `requireHqPage()` (siblings re-gate for defence-in-depth). All mutating actions DO re-check. Low risk (layout still gates) but not uniform.
5. **Orphaned server actions (code exists, no UI button on the domain page):** `updateNoteAction` (`app/admin/notes/actions.ts:769` — edit-note; list page renders only create/pin/archive); `assignAlert` + `bulkMarkResolved`-shaped helper (`app/admin/alerts/actions.ts:1266` — assignee UPSERT with no assign button, explicitly "future-compat"). These are reachable only by crafting the action POST directly (still allowlist-gated).
6. **Cross-tenant service-role reads with RLS bypass by design:** `/admin/notes` and `/admin/notifications` read every org's rows via `createAdminClient()` (intended — internal-only, invisible to tenants). `admin_alert_state` is accessed through an untyped `as never` cast (post-generated-types table) in `alerts/actions.ts:1036` — functional but weakly typed.
7. **Dark-by-default modelled cadence:** `/admin/hq-cadence` tick is inert until a super-admin opts a cadence in; the legacy crons keep firing regardless, so enabling one risks double-execution of that cadence's work unless the legacy cron is separately retired (not enforced here).
8. **Hardcoded config exposed as read-only:** Automations catalogue (`lib/automation/rules.ts`) and production feature flags (Vercel env) are intentionally non-editable from HQ — the old false JSONB/`*_connected` toggles were removed to stop counterfeiting control state.
9. **Hardcoded pricing in Overview:** MRR = `active × £500`, setup = `paid_orgs × £1,000` (`overview/page.tsx:1445-1454`) — a derivation assumption, not a per-org read.
10. **Backing API handlers with UI:** `/api/hq/pulse` + `/api/hq/pulse/[id]` (gated `requireHqApi`, 15s poll for the Pulse feed). HQ-core cron handlers (no UI control, bearer/cron-gated): `hq-decision-autopropose`, `hq-apply-drain` (dark), `hq-cadence-tick`, `hq-ceo-briefing`, `hq-exec-tick`, `hq-runners-tick`, `hq-roster-workers-tick`.

**Orphaned routes:** none found — every HQ-core route in the task maps to a real `page.tsx`; `flatHqNav()` projection asserts each nav entry is a live page (no stubs).
