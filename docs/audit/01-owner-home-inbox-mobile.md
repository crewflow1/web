# Domain 01 — Owner Home / Staff "My day" / Inbox & communications / Notifications / staff-mobile

Auditor: read-only product audit · 2026-10-28 · worktree `/Users/moetalibi/Code/web-main`.
Scope: `/dashboard`, `/me`, `/notifications`, `/inbox` (+ `/inbox/conversations`, `/inbox/review`, `/inbox/audit`), `/activity`, `/worker-portal/[token]`, `/offline`, `/access-pending`, plus the shell notification bell.
Status legend + role model per `docs/audit/CONVENTIONS.md`. Roles: owner, admin, staff (ADMIN_ROLES = owner+admin). Browser verification NOT performed — classification is from code + known prod state (per CONVENTIONS limitation).

---

### Page: Home (owner dashboard) — route `/dashboard`
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED (fully built; several component paths LIVE & WORKING per prod history).
**Roles:** owner + admin only. Nav area `home` is `ADMIN_ROLES` (`_nav/nav-model.ts`). A `staff` member hitting `/dashboard` is server-redirected to `/me` (`dashboard/page.tsx:142-145`).
**Purpose:** The owner's "what needs me today" command screen — attention feed, setup progress, retention/health, and every headline number (jobs, money in/out, VAT, receivables, labour, profitability, quotes, leads) derived from the org's real rows.
**What the user sees:** Header with 3 quick-action links · Daily Briefing (Suspense-streamed) · Setup checklist (until 100%) · Retention panel (milestones, next-best-action, company-health score, weekly summary, other nudges) · ~8 KPI grids (jobs/invoiced/outstanding/VAT; receivables; cashflow; field-ops/labour; profitability tables + two bar "charts"; approvals; quote analytics; lead pipeline + top sources) · Revenue-trend area chart · jobs-by-status / photos-missing / staff-workload cards · recent jobs/invoices/leads · Insights section · Activity feed with filter + Load more. First-run org with zero rows gets a 4-step welcome screen instead (`dashboard/page.tsx:454-462,1577`).

**Features:**
1. **Daily Briefing** — (1) surfaces ranked, deadline-aware attention items across money/safety/operations/sales. (2) read-only list, each item has View + optionally "Done for today". (3) reads ~50 signals via `buildDailyBriefing`; dismiss writes `briefing_dismissals`. (4) dismissed item hidden for the day (idempotent, returns tomorrow if condition holds). (5) side-effect: `dismissBriefingItem` server action → DB upsert + `revalidatePath`. Safety-critical keys are non-dismissible even via crafted POST (`briefing-actions.ts:22`). (6) deep-links into money/safety/ops/sales surfaces. (7) built; streams behind Suspense. (8) never throws — degrades to calm all-clear.
2. **Milestone-notification side effect** — on every load, `after()` fires `ensureMilestoneNotifications` (notifications + audit-log inserts), off critical path, idempotent via `onboarding_state.notified_milestones` (`dashboard/page.tsx:446`). Side-effect: notification rows.
3. **Setup checklist** — tracks 10 onboarding steps; progress bar; "Continue setup →" to `/onboarding/setup`; per-step CTA; optional steps have **Skip** (writes `organizations.onboarding_state.dismissed_steps[]` via `_dismiss-step.ts`, which uses the **admin client**). Hides at 100%.
4. **Retention panel** — milestones ("Got it" → `dismissMilestone`), top nudge (deep link), company-health score 0–100 with reasons+actions, weekly summary, "Also worth doing" nudges each dismissible ("✕" → `dismissNudge`). State in `organizations.onboarding_state.{celebrated_milestones,dismissed_nudges}`.
5. **KPI tiles** — all compute from paged (`fetchAllRows`, F-1-safe) RLS-scoped reads pinned to active org; money reads fail loud (`readFailure`). Each tile is a deep link (e.g. Outstanding → `/invoices?status=outstanding`, VAT → `/finances`). No mock data.
6. **Profitability** — per-job rollup incl. employer NI + pension + stock COGS; Top/Worst tables, 2 CSS-bar charts. Empty-state guidance when no job has revenue/costs.
7. **Activity feed** — client component; page-1 server-rendered, "Load more" via `GET /api/activity`, type-filter `<select>` resets to page 1.

**Buttons & controls:**
| Button / Control | Where | What happens when clicked | Required info | Result | Status |
|---|---|---|---|---|---|
| Add lead / Add job / Add staff | header | Link → `/leads/new` `/jobs/new` `/staff` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| View (briefing item) | Daily Briefing row | Link → item `href` | — | Navigate to source | IMPLEMENTED, NOT LIVE-VERIFIED |
| Done for today | Daily Briefing row (dismissible keys only) | `dismissBriefingItem` server action → upsert `briefing_dismissals`, revalidate | item_key (hidden) | Item hidden today | IMPLEMENTED, NOT LIVE-VERIFIED |
| Continue setup → | Setup checklist | Link → `/onboarding/setup` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Step CTA | checklist row | Link → step target | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Skip | optional checklist step | `dismissChecklistStep` (admin client) writes `dismissed_steps[]` | step_id | Row hidden | IMPLEMENTED, NOT LIVE-VERIFIED |
| Got it | milestone card | `dismissMilestone` → `celebrated_milestones[]` | milestone_id | Card stops resurfacing | IMPLEMENTED, NOT LIVE-VERIFIED |
| ✕ (dismiss nudge) | "Also worth doing" | `dismissNudge` → `dismissed_nudges[]` | nudge_id | Nudge hidden | IMPLEMENTED, NOT LIVE-VERIFIED |
| CTA → links (nudge/health/weekly) | retention panel | Link to relevant route | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| KPI tiles (≈40) | KPI grids | Link to deep-filtered route | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| View all → | section cards | Link to list route | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Filter activity type | activity feed `<select>` | `fetchPage(1,type,replace)` → `/api/activity` | — | List re-fetched | IMPLEMENTED, NOT LIVE-VERIFIED |
| Load more | activity feed | `fetchPage(page+1)` appends | — | More rows | IMPLEMENTED, NOT LIVE-VERIFIED |
| First-run step CTAs (4) | zero-data welcome | Links → customers/jobs/finances/invoices new | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

Mobile: KPI grids are `grid-cols-2` on phone, `lg:grid-cols-4`; all actions are links/forms (work on touch).

---

### Page: My day — route `/me`
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED (clock-in/out flow + My-jobs fix shipped to prod per memory).
**Roles:** staff land here (nav `myday`); owner/admin reach it via a dashboard tile and People→"My day". Page itself only needs any org member (`requireOrgContext`). All reads pinned to active org + `user_id` (dual-org safe).
**Purpose:** The field worker's home — big clock-in/out, today's/this-week's hours, own pay estimate, rota, assigned jobs, assigned tasks, upcoming leave.
**What the user sees:** Header (name · org) · error/saved banner · big clock in/out card (with job `<select>` + note when clocked out; break toggle + clock-out when in) · 4 tiles (Today, This week, Expected gross, Expected take-home) · timesheet history (this month) · today's rota · My jobs (own active assignments) · My tasks (open checklist items assigned to me, overdue flag) · Upcoming leave.

**Features:**
1. **Clock in** — (1) start a shift. (2) optionally pick a job + note, tap "Clock in". (3) inserts open `time_entries` row (org+user+job+note+optional GPS). (4) banner "Clocked in", card flips to live timer. (5) no comms; `revalidatePath`. Pre-checks: blocks if already open (also DB-unique), blocks if within approved leave (leave read fails loud, so it can't fail-open) (`me/actions.ts:34-72`). (6) feeds dashboard hours/labour tiles + payroll. (7) LIVE.
2. **Clock out** — closes open entry, auto-closes any open break (`actions.ts:77-108`).
3. **Start/End break** — pushes/closes a break on the open entry's `breaks[]`.
4. **Pay estimate** — own `hourly_pay` from `staff_compensation` (self-read RLS, no co-worker exposure); gross + refined take-home via own tax profile + pension enrolment. Degrades to £0 "set your rate" if comp read errors (non-fatal by design). Employer NI/pension deliberately excluded from the worker's own view.
5. **My jobs / My tasks / Rota / Leave** — read-only lists; jobs filtered to own active (not completed/cancelled), tasks paged + loud-read, deep links to `/jobs/[id]`, `/staff/leave`.

**Buttons & controls:**
| Button / Control | Where | What happens when clicked | Required info | Result | Status |
|---|---|---|---|---|---|
| Clock in | clock card (out state) | `clockIn` server action → insert `time_entries` | job (opt), note (opt), GPS (opt, hidden) | Shift started, `?saved=clocked_in` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Job `<select>` | clock-in form | Picks `job_id` for the shift | — | Sets form field | IMPLEMENTED, NOT LIVE-VERIFIED |
| Note input | clock-in form | Free text ≤500 | — | Stored on entry | IMPLEMENTED, NOT LIVE-VERIFIED |
| Clock out | clock card (in state) | `clockOut` → close entry, close breaks | — | `?saved=clocked_out` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Start break | clock card (in, not on break) | `startBreak` → append open break | — | `?saved=break_started` | IMPLEMENTED, NOT LIVE-VERIFIED |
| End break | clock card (on break) | `endBreak` → close break | — | `?saved=break_ended` | IMPLEMENTED, NOT LIVE-VERIFIED |
| All jobs → / Request leave → | section headers | Link → `/jobs`, `/staff/leave` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Job / task / rota-job links | lists | Link → `/jobs/[id]` (task → `#checklist`) | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

Note: GPS lat/lng are accepted by `clockIn` but the clock-in form renders **no geolocation capture** — `gps_lat`/`gps_lng` are never populated by the UI (server action supports them; no client control writes them). Flagged as an action param with no UI entry point.

---

### Page: Notifications — route `/notifications`
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED. `force-dynamic`.
**Roles:** ALL_ROLES (per-user centre; nav `inbox`→Notifications is `ALL_ROLES`). Scoped to active org + self + audience IN ('customer','both') via `getLatestNotificationsForCustomer`.
**Purpose:** The full, paginated per-user notification history (the bell only shows 15; this is the complete centre — previously orphaned, now nav-reachable).
**What the user sees:** Header with unread badge + "Mark all read" · banner (saved/error) · GET filter form (State / Category / Priority + Apply + Reset) · date-grouped list; each row: priority pill, category, title (links to `action_url` if present), body, timestamp, and per-row "Mark read" / "Dismiss".

**Features:**
1. **Mark all read** — `markAllRead` → `markAllNotificationsRead({audience:'customer',orgId})`; active-org pinned (header note records a past dual-org bug where it cleared both orgs). `?saved=all_read`.
2. **Mark read (single)** / **Dismiss (single)** — `markRead`/`dismiss` by uuid, audience+org pinned; `?saved=dismissed`.
3. **Filter** — GET form rewrites `?state=&category=&priority=`; pure read.

**Buttons & controls:**
| Button / Control | Where | What happens when clicked | Required info | Result | Status |
|---|---|---|---|---|---|
| Mark all read | header (if unread>0) | `markAllRead` server action | — | Badge clears, `?saved=all_read` | IMPLEMENTED, NOT LIVE-VERIFIED |
| State / Category / Priority `<select>` | filter form | Set GET params | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Apply | filter form | Submit GET | — | Re-render filtered | IMPLEMENTED, NOT LIVE-VERIFIED |
| Reset | filter form | Link → `/notifications` | — | Clear filters | IMPLEMENTED, NOT LIVE-VERIFIED |
| Title link | row (if action_url) | Link → action_url | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Mark read | unread row | `markRead` (id) | id | Row marked read | IMPLEMENTED, NOT LIVE-VERIFIED |
| Dismiss | row (not dismissed) | `dismiss` (id) | id | Row dismissed | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Shell control: Notifications bell (global header) — component `_components/notifications.tsx`
**Status:** LIVE & WORKING (ships in the app shell on every `(app)` page).
**Roles:** all authenticated members. Client dropdown of 15 most-recent `notifications`; red unread badge.
**Buttons & controls:**
| Button / Control | Where | What happens | Result | Status |
|---|---|---|---|---|
| 🔔 bell | header | Toggles dropdown; on open marks list read (`markNotificationsRead`, active-org+user pinned) | Badge clears | LIVE & WORKING |
| activity log → | dropdown header | Link → `/activity` | Navigate | LIVE & WORKING |
| notification row | dropdown | Link → `action_url`; `markOneNotificationRead(id)` | Navigate + mark read | LIVE & WORKING |
| View all notifications → | dropdown footer | Link → `/notifications` | Navigate | LIVE & WORKING |

---

### Page: Activity — route `/activity`
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
**Roles:** any org member (`requireOrgContext`). **NOT in `_nav/nav-model.ts`** — reachable only via the bell dropdown ("activity log →") and its own pagination links. Hard-to-discover / nav-orphaned.
**Purpose:** Full org audit trail with filters (date range, actor, type, target) and pagination (50/page). Active-org pinned, `id` tiebreaker for stable paging.
**What the user sees:** Header · GET filter form (From, To, Actor text, Type `<select>`, Target `<select>`, Apply, Clear, event count) · event list (icon, actor, description, target, timestamp) · Newer/Older pager.
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| From / To date | filter form | GET `?from&to` | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Actor text | filter form | `ilike actor_name` | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Type `<select>` | filter form | `like action '<prefix>%'` | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Target `<select>` | filter form | `eq target_table` | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Apply / Clear | filter form | Submit / Link `/activity` | — | Re-render | IMPLEMENTED, NOT LIVE-VERIFIED |
| ← Newer / Older → | pager | Link `?page=n` (disabled at ends) | — | Page change | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Inbox (Enquiries) — route `/inbox`
**Status:** PARTIALLY IMPLEMENTED — UI + operator actions live; **the inbound capture that populates it depends on DARK telephony/messaging providers** (AI receptionist). Enquiry rows arrive via `/api/receptionist/inbound` adapters.
**Roles:** nav entry is ADMIN_ROLES; **page has no role gate** — any member who navigates directly reads `inbound_enquiries` (caller numbers/transcripts). The actions.ts header states "RLS lets every org member read the table" (by-design readable), but nav hides it from staff; a staff member typing `/inbox` would still see enquiries. Active-org pinned.
**Purpose:** Every inbound enquiry the AI receptionist captured (phone/SMS/WhatsApp/IG/FB/manual) — AI summary, job_type/urgency/postcode, linked lead, status.
**What the user sees:** Inbox tab bar (Enquiries/Conversations/Review queue/Delivery audit) · header + "Conversations →" · status filter chips (All/New/Processed/Qualified/Ignored/Failed) · list cards (channel, urgency, status, AI confidence, caller, summary or raw-message `<details>`) · per-card actions.
**Features:** operator triage — mark qualified / mark spam (ignored); open linked lead. `markEnquiryStatus` is active-org pinned (header documents a past dual-org bug) and records admin activity.
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Inbox tabs (4) | tab bar | Links to the 4 inbox surfaces | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status filter chips | nav | Link `/inbox?status=` | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Conversations → | header | Link → `/inbox/conversations` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Show raw message | card `<details>` | Expands raw text | — | Reveal | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open lead → | card (if lead_id) | Link → `/leads/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Mark qualified | card (received/processed) | `markEnquiryStatus(id,'qualified')` | status (hidden) | Status set + audit | IMPLEMENTED, NOT LIVE-VERIFIED |
| Mark spam | card (received/processed) | `markEnquiryStatus(id,'ignored')` | status (hidden) | Status set + audit | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add an enquiry / Set up AI receptionist | empty state | Links → `/leads/new`, `/settings/ai-receptionist` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Conversations — route `/inbox/conversations`
**Status:** PARTIALLY IMPLEMENTED — thread UI + send pipeline built, but **outbound is dark-safe: with no configured provider (the state today) replies QUEUE, never send**. `force-dynamic`.
**Roles:** nav ADMIN_ROLES; page requires org member. Active-org scoped via `listInboxConversations`.
**Purpose:** Unified two-way comms inbox — one thread per customer per channel (email/sms/whatsapp/voice/chat); reply inline; start new outbound.
**What the user sees:** tab bar · header with awaiting-reply count + "New message" · view chips (Active/Archived/All) · conversation list (channel pill, awaiting-reply/archived flags, contact, last-preview with "You:" prefix).
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| New message | header | Link → `/inbox/conversations/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| View chips (Active/Archived/All) | nav | Link `?view=` | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Conversation row | list | Link → `/inbox/conversations/[id]` | — | Open thread | IMPLEMENTED, NOT LIVE-VERIFIED |
| New message / View enquiries | empty state | Links | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

#### Sub-page: Conversation thread — `/inbox/conversations/[id]`
Reply composer + Archive/Reactivate. `replyToConversation` resolves thread (loud, org-pinned), rides `sendInboxReply` (queues when provider dark), records outbound `messages` row with status sent/queued/failed, logs admin activity. voice/chat have no outbound transport — always queue (composer warns up-front).
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Archive / Reactivate | header | `setConversationStatus` (org-pinned) | status (hidden) | Thread archived/reactivated | IMPLEMENTED, NOT LIVE-VERIFIED |
| Send reply | composer | `replyToConversation` → send/queue + record message | body (≥1,≤10k) | `?sent=sent\|queued\|failed` | PARTIALLY IMPLEMENTED (queues while providers dark) |

#### Sub-page: New message — `/inbox/conversations/new`
Form: Channel `<select>`, To (contact), Contact name (opt), Subject (opt/email), Message. `startConversation` upserts thread on `(org,channel,contact_ref)`, sends/queues first message, records message + activity.
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Send | form | `startConversation` | channel, contact, body | Thread created, `?sent=` | PARTIALLY IMPLEMENTED (queues while providers dark) |
| Cancel | form | Link → conversations | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Review queue — route `/inbox/review`
**Status:** PARTIALLY IMPLEMENTED — review/convert UI built; it depends on the **WhatsApp assistant (dark)** filing `pending_review` rows. `force-dynamic`.
**Roles:** nav ADMIN_ROLES; page requires org member. Org-pinned reads via `listPendingAssistantActions`.
**Purpose:** Human sign-off queue for commitments the WhatsApp assistant captured (variation draft / task / note / photo) — nothing is auto-committed; convert hands off to the real session-bound writer via deep link, or dismiss.
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| View job | card (if job_id) | Link → `/jobs/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Dismiss | card | `resolveAssistantAction(id,'dismiss')` → status `dismissed` (only from pending_review), audit | decision (hidden) | Item resolved | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create variation / Convert | card (if convertible) | `resolveAssistantAction(id,'convert')` → status `converted`, redirect to real writer via `convertDestination` | decision (hidden) | Item converted + redirect | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Delivery audit — route `/inbox/audit`
**Status:** IMPLEMENTED, NOT LIVE-VERIFIED. `force-dynamic`. Read-only.
**Roles:** nav ADMIN_ROLES; page requires org member. Org-pinned via `listOutboundAudit`.
**Purpose:** Cross-channel outbound delivery record (inbox replies + receptionist SMS) with delivery/open/bounce status where the provider reports it; paged 50/page.
**What the user sees:** tab bar · header · table (When, Channel, Recipient, Status pill, Source [Assistant/You], Detail [error/Opened/Clicked]) · Previous/Next pager.
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Previous / Next | pager | Link `?page=` | — | Page change | IMPLEMENTED, NOT LIVE-VERIFIED |
| Go to conversations | empty state | Link | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

### Page: Worker portal (H&S sign-off) — route `/worker-portal/[token]`
**Status:** LIVE & WORKING (H&S / toolbox-talks shipped to prod per memory; public tokened route). Not in nav (external link, by design).
**Roles:** ANONYMOUS — no login/session/membership. Sole gate is `loadWorkerSession(token)` (bad/expired/revoked → `InvalidLinkPage`). All writes via service-role admin client; DB triggers re-derive org_id/job_id from the token (isolation is DB-side, not this layer).
**Purpose:** External/sub-contract worker reads and signs the job's RAMS/permits/toolbox talks before starting, and can flag out-of-scope work.
**What the user sees:** branded header (org logo/name, worker name, link expiry) · outstanding count · per-document cards (status pill; Signed state or sign form) · "Spotted extra work?" variation-request form · "Powered by CrewFlow".
**Features:**
1. **Acknowledge (sign)** — typed name (= signature) + optional drawn signature pad → `acknowledgeAsWorker`: rate-limited per token+IP, shape-validated, captures IP-hash + user-agent provenance, stores optional signature PNG, inserts append-only `worker_acknowledgements` (23505 = idempotent re-sign). Generic error only (no raw DB text to anon).
2. **Request variation** — title/details/urgency → `requestVariationAsWorker`: rate-limited, inserts `variation_requests` born `requested` with `requester_type:'worker_token'`, org+job from token.
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Sign & confirm | per-doc form | `acknowledgeAsWorker(token)` | signedName (req), signatureDataUrl (opt) | `?saved=signed`, card → Signed | LIVE & WORKING |
| Draw signature pad | sign form | Captures PNG data URL | — | Attached to ack | LIVE & WORKING |
| Send to <org> | variation form | `requestVariationAsWorker(token)` | title (req), details/urgency | `?saved=variation_requested` | LIVE & WORKING |

---

### Page: Offline shell — route `/offline`
**Status:** LIVE & WORKING (PWA offline shell shipped per memory). PUBLIC (no auth, so it renders with zero connectivity); `robots: noindex` via `offline/layout.tsx`.
**Roles:** anyone (public). Shows only device-local IndexedDB data (last active user+org), never server data.
**Purpose:** Service-worker fallback when launched/deep-linked offline — surfaces drawings downloaded to this device + an unsent-write count, opens the real blueprint viewer from local bytes.
**What the user sees:** CrewFlow brand · online/offline status · Continue/Retry button · unsent-entries banner (COUNT ONLY — deliberate security decision, no content) · "Drawings on this device" list (Open / Remove) · blueprint viewer modal.
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Continue to CrewFlow / Retry connection | card | Link → `/dashboard` | — | Navigate | LIVE & WORKING |
| Open | drawing row | Opens `BlueprintViewer` from local bytes | — | Viewer modal | LIVE & WORKING |
| Remove | drawing row | `remove()` from IndexedDB + refresh | — | Drawing deleted locally | LIVE & WORKING |

Note: offline mode is READ-ONLY by design (no authoring form on this public route — documented rationale: a write with no server session would mis-attribute on a shared tablet). Matches the known "offline is read-only, no queue/retry/conflict" limitation.

---

### Page: Access pending (lock screen) — route `/access-pending`
**Status:** LIVE & WORKING (gate screen reached from `requireOrgContext` on non-active orgs).
**Roles:** authenticated users whose org is pending/suspended/rejected/cancelled. Super-admin → redirected to `/admin/organizations`; active org → `/dashboard`; no org → `/onboarding/company`.
**Purpose:** Explains why the workspace is locked and what to do; gives the user something actionable (refresh / email / sign out).
**What the user sees:** status-specific headline+body, signed-in email + company + hours-since-submitted (pending only), action buttons.
**Buttons & controls:**
| Button / Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Refresh status | card (pending only) | `router.refresh()` re-runs the server gate; redirects onward if approved | — | Re-check; else "still pending" | LIVE & WORKING |
| Email CrewFlow | card | `mailto:hello@crewflow.uk` | — | Mail client | LIVE & WORKING |
| Sign out / switch account | card | Link → `/login` | — | Navigate | LIVE & WORKING |

---

## DOMAIN SUMMARY

**Counts**
- Pages/surfaces audited: **11 routes** (`/dashboard`, `/me`, `/notifications`, `/activity`, `/inbox`, `/inbox/conversations`, `/inbox/conversations/[id]`, `/inbox/conversations/new`, `/inbox/review`, `/inbox/audit`, `/worker-portal/[token]`, `/offline`, `/access-pending`) + **1 shell component** (notifications bell). (≈13 distinct screens.)
- Distinct features documented: **~30**.
- Buttons / interactive controls catalogued: **~70** (incl. ~40 dashboard KPI deep-link tiles, filter selects, server-action forms, tabs, pagers).

**Status tallies (by surface)**
- LIVE & WORKING: notifications bell, `/worker-portal`, `/offline`, `/access-pending` (4).
- IMPLEMENTED, NOT LIVE-VERIFIED: `/dashboard`, `/me`, `/notifications`, `/activity`, `/inbox/audit` (5).
- PARTIALLY IMPLEMENTED (built, gated by dark providers): `/inbox` (inbound capture dark), `/inbox/conversations` + thread + new (outbound queues while providers dark), `/inbox/review` (WhatsApp assistant dark) (≈4).
- No surface in this domain is a pure PLACEHOLDER or BROKEN on code evidence.

**Hard-to-discover / nav-orphaned**
- `/activity` is **not in `_nav/nav-model.ts`** — reachable only via the bell dropdown ("activity log →"). A whole audit-log page with rich filters has no sidebar/command-palette home.
- The staff clock-in form supports GPS (`gps_lat`/`gps_lng` accepted by `clockIn`) but **no UI captures it** — a server-action parameter with no UI entry point.

**Implemented-but-dark (product-truth)**
- The entire Inbox comms stack is engineered but **customer-facing sending is dark-safe/queued** (`sendInboxReply` queues when no provider) and **inbound enquiry capture + WhatsApp assistant depend on dark telephony/messaging providers**. Consistent with memory (voice receptionist has no telephony; WhatsApp inbound not production-proven). Nothing here falsely claims to send.

**Authorization observation (not a confirmed defect)**
- `/inbox`, `/inbox/conversations`, `/inbox/review`, `/inbox/audit` pages carry **no role gate** beyond `requireOrgContext` — nav hides them from staff (ADMIN_ROLES) but a staff member navigating directly would read customer-comms data (caller numbers, transcripts, threads). The inbox actions.ts explicitly treats `inbound_enquiries` as readable by every org member (RLS), so this appears by-design, but the nav/role-gate vs page-gate mismatch is worth confirming against intended policy.

**Server actions / API handlers with a UI entry point** — all accounted for: dashboard (`briefing-actions`, `_dismiss-step`, `_retention-actions`), `/me` (`clockIn/Out`, `startBreak/endBreak`), `/notifications` (`markRead`, `markAllRead`, `dismiss`), bell (`markNotificationsRead`, `markOneNotificationRead`), inbox (`markEnquiryStatus`, conversation reply/start/status, review resolve), worker-portal (`acknowledgeAsWorker`, `requestVariationAsWorker`), `/api/activity` (backs the activity feed Load-more). No orphaned server action found except the GPS params noted above.
