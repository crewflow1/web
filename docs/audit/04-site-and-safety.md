# CrewFlow Feature & Button Audit — 04 · Site & Safety

Scope: the "Site & safety" top-level nav area (`app/(app)/_nav/nav-model.ts` id `site-safety`). Read-only static audit (2026-10-28, main `128dc5aa`, worktree `web-main`). Browser verification was NOT performed — authenticated multi-role prod access is out of scope — so most items carry **IMPLEMENTED, NOT LIVE-VERIFIED** per the shared [CONVENTIONS.md](CONVENTIONS.md) legend. Every non-trivial claim cites `path:line`.

Nav roles for this area (from `nav-model.ts:138-160`): the area is `ALL_ROLES`. Children gated to **ADMIN_ROLES** (owner+admin) in nav: Health & safety, Permits, Site reports, Documents, Compliance library, Weather. Children visible to **all roles**: Toolbox talks, Site diary, Snagging, Works quality, Delays & EOT, Drawings, Site compliance.

> **Cross-cutting role-gating note (verified).** Every "admin" page in this domain enforces admin **only via nav visibility** — the page components call `requireOrgContext()` (any member), NOT `requireManagementContext()`/`requireManagementRole()` (verified: `health-safety/page.tsx:87`, `site-reports/page.tsx:66`, `compliance/page.tsx:60`; same pattern across the whole H&S subtree). The real security boundary is table RLS plus per-mutation owner/admin re-checks on the destructive/exposing actions. So "admin-only" here means *discoverability*, not hard route-gating: a staff member who types the URL is not redirected the way Money surfaces are. Whether staff can read the rows depends on RLS policies (not verified in this static pass). This is the single item worth escalating.

> **AI note (verified).** There is **no AI anywhere in this domain.** The Master-Plan "auto-generated RAMS" is a deterministic in-repo template catalogue (`lib/health-safety/rams-templates.ts`), not an LLM; toolbox talks, quality, delays, diary, snags, site-reports, compliance all grep-clean for `anthropic`/`governor`/`writer_draft`/`generateText`. No governor, no feature flag, no dark AI call site. The only "dark" surface is **Weather**.

---

## Health & Safety (RAMS)

### Page: Health & Safety register — route `/health-safety`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** Nav ADMIN_ROLES (`nav-model.ts:145`); page uses `requireOrgContext()` only (`page.tsx:87`) — no server role gate (see cross-cutting note). Tenant RLS scopes rows.
- **Purpose:** The RAMS register — one row per Risk Assessment & Method Statement, draft → issued → superseded/withdrawn.
- **What the user sees:** Title + intro, "+ New risk assessment" CTA, inline section sub-nav (Risk assessments / Permits to work / Worker sign-off links), a "Needs attention" signals panel, status filter pills with counts, a card list (reference, status pill, worst risk-band pill, title, activity, hazard count, location, created date), count footer.
- **Features:**
  1. **RAMS listing with worst-risk band.** One org-scoped read of `risk_assessments` + embedded `risk_assessment_hazards(count)` (`_data.ts:24-42`), then a single batched read of hazard scores for RAs with `hazard_count>0`, grouped in memory, `overallRiskBand()` per RA — never per-row (`page.tsx:108-147`). Read-only. Loud read: a failed hazard-band read throws rather than falsely rendering "No hazards" (`page.tsx:128`). Active-org pinned throughout. No side-effects.
  2. **"Needs attention" signals panel** (`_hs-signals.tsx` + `lib/health-safety/signals.ts`). Deterministic ranked cards (permits expired-but-open, active jobs with no current RAMS [danger]; permits expiring <24h, RAMS review overdue, critical residual, toolbox awaiting ack [warn]; draft RAMS [info]). No LLM, no notifications engine. Hidden when nothing outstanding. Some hrefs point at permits filters that the permits register does not read (see permits note).
  3. **Status filters** `all/draft/issued/archived` via `?status=` (`page.tsx:17-23,96-103`); counts in memory.
  4. **Flash banners** `?saved=`/`?error=` (`page.tsx:56-70`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New risk assessment | Header + empty state | → `/health-safety/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Section sub-nav (Risk assessments / Permits / Worker sign-off links) | Below header | → `/health-safety`, `/permits`, `/worker-links` | — | Navigate (ONLY entry point to worker-links) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Filter pills (All/Draft/Issued/Superseded-withdrawn) | Filter nav | Sets `?status=` | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Signal cards | Attention panel | Link to filtered register/permits/toolbox | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open draft / View | Each row | → `/health-safety/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: New risk assessment — route `/health-safety/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** `requireOrgContext()` (`new/page.tsx:35`); admin-nav-only.
- **Purpose:** Create a draft RAMS, from a curated template or manually.
- **What the user sees:** Breadcrumb; "Generate from a template" card (work-type select + Generate); "or draft manually" divider; manual form (title*, activity*, location, assessor, assessment/review dates, 6 PPE slots, method statement); Save draft / Cancel.
- **Features:**
  1. **Generate from template (DETERMINISTIC — NOT AI).** `generateRamsDraft` (`actions.ts:98-151`) validates `templateKey`, calls `buildRamsDraftFromTemplate()` (`lib/health-safety/rams-templates.ts`) — a pure catalogue of 6 work-types with standard hazards + default 5×5 scores + controls. Inserts a draft header (org-pinned, `created_by`) then bulk-inserts `risk_assessment_hazards` (org_id trigger-derived `tg_rah_derive_org`). Atomic-ish: deletes the header if hazard-insert fails (`actions.ts:141-146`). → redirect `/health-safety/[id]?saved=generated`. CRUD: INSERT `risk_assessments` + `risk_assessment_hazards`. No AI/email/jobs.
  2. **Manual create.** `createRiskAssessment` (`actions.ts:44-80`), validates `createRaSchema`, inserts draft header; PPE via `getAll("ppe")`. → `/health-safety/[id]?saved=created`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Work-type template select | Generate card | Chooses template key | required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generate draft from template | Generate card | POST `generateRamsDraft` | templateKey | New draft w/ hazards, `?saved=generated` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Title/Activity/Location/Assessor/dates/PPE×6/Method statement | Manual form | FormData | Title*, Activity* | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save draft | Manual form | POST `createRiskAssessment` | Title*, Activity* | New draft, `?saved=created` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Manual form | → `/health-safety` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: RAMS detail & sign-off — route `/health-safety/[id]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** `requireOrgContext()` (`[id]/page.tsx:100`); admin-nav-only. The operative sign-off form is genuinely any-member (RLS enforces `user_id = auth.uid()`, `signoff-actions.ts:15-18`). `notFound()` if RA not in active org (`_data.ts:50-68`).
- **Purpose:** View/edit one RAMS — a draft is fully editable; an issued one is a frozen legal record (Create-revision / Withdraw + operative acknowledgement).
- **What the user sees:** Back link; header (reference/"Draft (unissued)", status pill, Revision N pill, overall-risk pill, title, activity); frozen/superseded notices; revision-history rail (>1 revision); Assessment-details (edit on draft, read-only `<dl>` once issued); Hazards (desktop table / mobile cards with 5×5 initial+residual band pills, Remove on draft) + Add-hazard form on draft; Lifecycle section (Issue gate / Create-revision + Withdraw); Operative sign-off panel on issued.
- **Features:**
  1. **Edit draft header.** `updateRiskAssessment` (`actions.ts:153-184`) — `count:"exact"` update gated `.eq("status","draft")`; count 0 → `?error=not_editable`. `revalidatePath` + redirect.
  2. **Add/remove hazards (draft only).** `addHazard`/`deleteHazard` (`actions.ts:350-397`) INSERT/DELETE `risk_assessment_hazards`; residual-never-higher-than-initial enforced (`rams.ts:88` + DB). Count-gated.
  3. **Issue gate.** `canIssue()` (`rams.ts:119-133`) needs draft + title + activity + named assessor + ≥1 hazard; UI disables + lists reasons (`page.tsx:790-818`). `issueRiskAssessment` (`actions.ts:189-226`) re-reads/re-gates, allocates per-org reference via RPC `next_ra_number` (unique `(org_id,reference)` backstops races), UPDATE gated `.eq("status","draft")`, then best-effort `recordAdminActivity("risk_assessment.issued")` HQ audit.
  4. **Revisions (immutable series).** `createRamsRevision` (`actions.ts:252-313`) copies an issued snapshot into a new draft (root/revision_number/supersedes_id); one-draft-per-series partial-unique index → `revision_in_progress`. `issueRamsRevision` (`actions.ts:315-345`) calls RPC `issue_rams_revision` to atomically issue + supersede prior; audits `risk_assessment.revised`.
  5. **Withdraw / supersede.** `transition()` (`actions.ts:228-243`) gated `.eq("status","issued")`.
  6. **Operative sign-off panel** (issued). `listAcknowledgements` + `requiredOperatives(job_id)` (crew via `rota_entries`) + `priorRevisionSignoff` in parallel (`page.tsx:110-116`); re-ack prompt when worker signed an earlier revision.
  7. **PDF evidence** via `/api/health-safety/[id]/pdf` (see cross-cutting PDF note).
  - Side-effects: HQ admin-activity audit on issue/revise; signature PNG storage on sign-off; on-demand PDF. No email/SMS.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes | Details (draft) | POST `updateRiskAssessment` | Title*, Activity* | UPDATE, `?saved=updated`; count0→`not_editable` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Likelihood/Severity/Residual selects (1–5) | Add-hazard | Build hazard FormData | L*, S*, controls* | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add hazard | Hazards (draft) | POST `addHazard` | hazard*, L*, S*, controls* | INSERT, `?saved=hazard` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Remove (hazard) | Each hazard (draft), desktop+mobile | POST `deleteHazard` | hazard id | DELETE, `?saved=hazard_removed` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Issue risk assessment / Issue revision N | Lifecycle (draft) | POST `issueRiskAssessment`/`issueRamsRevision`; disabled until `canIssue` | RA id | Allocates ref, freezes, audit, `?saved=issued` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create revision | Lifecycle (issued) | POST `createRamsRevision` | RA id | New draft copy, `?saved=revision_created` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Withdraw | Lifecycle (issued) | POST `withdrawRiskAssessment` | RA id | `status=withdrawn`, `?saved=withdrawn` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Download PDF | Sign-off panel (issued) | Opens `/api/health-safety/[id]/pdf` | — | Inline PDF (409 if draft) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Type name + Draw signature + "I have read and understood — sign" | Sign-off panel | POST `acknowledgeSafetyDocument` | signedName (2–120) | Append-only ack row; `?saved=acknowledged` | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Permits register — route `/health-safety/permits`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** Nav ADMIN_ROLES (`nav-model.ts:146`); page `requireOrgContext()` (`permits/page.tsx:33`).
- **Purpose:** The Permit-to-Work register — one row per permit, newest first, showing *effective* status.
- **What the user sees:** Breadcrumb, header + intro, "+ New permit" CTA, flash banners, card list (reference/"Draft", effective-status pill, type pill, title, validity window, "X/Y required conditions confirmed", linked job), count footer. No status filter pills.
- **Features:**
  1. **Permit listing with effective status + condition progress.** `listPermits(org)` (`permits/_data.ts:22-39`) one org-pinned read of `permits_to_work` + embedded `permit_conditions(required,confirmed)`; `effectiveStatus()` derives Expired/Not-yet-valid from stored status + window (`permits.ts:82`). Read-only, loud. Active-org pinned.
  - **Caveat (minor):** dashboard signals link to `?filter=expired`/`?filter=expiring` (`signals.ts:47,67`) but this page reads no `filter` param (`permits/page.tsx:26`) — the link lands on the unfiltered register (harmless no-op).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New permit | Header + empty state | → `/health-safety/permits/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Breadcrumb "Health & safety" | Top | → `/health-safety` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open draft / View | Each row | → `/health-safety/permits/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| (signal) `?filter=expired/expiring` | From dashboard signals | No filter read here | — | Unfiltered list | PARTIALLY IMPLEMENTED |

### Page: New permit — route `/health-safety/permits/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** `requireOrgContext()` (`permits/new/page.tsx:28`); admin-nav-only.
- **Purpose:** Draft a new permit; conditions + issue happen on the detail page.
- **What the user sees:** Breadcrumb; one `<StateForm>` with shared `PermitFormFields` (type*, location, title*, scope*, valid-from/until datetime pickers, job, linked RAMS, responsible person, isolation details, emergency arrangements); Save draft / Cancel.
- **Features:**
  1. **Create permit draft.** `createPermit` (`permits/actions.ts:71-82`) validates `createPermitSchema`, INSERT `permits_to_work` (org-pinned, `created_by`). Returns `FormState` and navigates via `<StateForm>` `redirectTo` (full document load), NOT `redirect()` — deliberate, to dodge the Next 15.5 server-action redirect router race on `/health-safety/permits/*` (documented `actions.ts:23-35`). → `/health-safety/permits/[id]?saved=created`.
  2. **Datetime handling.** `PermitDateTimeField` (`_datetime-field.tsx`) — visible `datetime-local` + hidden sibling carrying offset-qualified ISO so Zod `.datetime({offset:true})` accepts it; avoids hydration mismatch.
  3. **Link preservation.** `withPreservedOption` so an existing RAMS/job link outside the fetched window isn't dropped (F-1).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Permit type/Title/Scope/window/Job/RAMS/responsible/isolation/emergency | Form | Shared fields | type*, title*, scope* | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save draft | Form | POST `createPermit` (StateForm) | type*, title*, scope* | INSERT, document-nav to `[id]?saved=created` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Form | → `/health-safety/permits` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Permit detail — route `/health-safety/permits/[id]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** `requireOrgContext()` (`permits/[id]/page.tsx:77`); admin-nav-only. Sign-off form any-member (RLS `user_id=auth.uid()`). `notFound()` if not in active org.
- **Purpose:** Manage one permit — edit while draft; operate (activate/suspend/close/cancel) once issued; capture operative sign-off.
- **What the user sees:** Back link; header (reference, effective-status pill, type pill, title, scope); expired/not-yet-valid/frozen notices; Permit details (edit on draft, read-only otherwise); Control conditions (Confirm/Unconfirm/Remove on draft, suggested-condition chips, Add-a-condition form); Status & lifecycle (Issue gate on draft; Activate/Suspend/Cancel + Close-out once issued/active/suspended); Operative sign-off panel when issued/active.
- **Features:**
  1. **Edit draft details.** `updatePermit` (`permits/actions.ts:84-96`) gated `.eq("status","draft")`.
  2. **Control conditions.** `addPermitCondition`/`deletePermitCondition`/`confirmPermitCondition` (`permits/actions.ts:98-142`) INSERT/DELETE/UPDATE `permit_conditions`; confirm stamps `confirmed_by/at`; suggested sets from `DEFAULT_CONDITIONS` (`permits.ts:142`). Count-gated, StateForm navigation.
  3. **Issue gate.** `canIssue()` (`permits.ts:102-118`) needs draft + type/title/scope + validity window + every required condition confirmed. `issuePermit` (`permits/actions.ts:144-169`) re-reads/re-gates, allocates reference via RPC `next_ptw_number`, then `recordAdminActivity("permit.issued")`.
  4. **Lifecycle transitions.** `transitionPermit` (`permits/actions.ts:172-188`) maps verb→status/stamp via `TRANSITION_STAMP`; `canTransition()` matrix mirrors DB `tg_permit_lifecycle`. Expired/Not-yet-valid derived, never stored (`permits.ts:58-93`).
  5. **Operative sign-off + PDF** — shared SignoffPanel (`pdfHref=/api/health-safety/permits/[id]/pdf`); permits have no revision series so `priorSignoff=null`.
  - Side-effects: HQ admin-activity audit on issue; signature storage + on-demand PDF. No email/SMS/AI.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes | Details (draft) | POST `updatePermit` | type*,title*,scope* | UPDATE, `?saved=updated` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Suggested condition chips | Conditions (draft) | POST `addPermitCondition` (required=on) | label | INSERT, `?saved=condition` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add condition (+ Required checkbox) | Conditions (draft) | POST `addPermitCondition` | label* | INSERT | IMPLEMENTED, NOT LIVE-VERIFIED |
| Confirm / Unconfirm | Each condition (draft) | POST `confirmPermitCondition` | condition id | UPDATE confirmed flag+stamp | IMPLEMENTED, NOT LIVE-VERIFIED |
| Remove | Each condition (draft) | POST `deletePermitCondition` | condition id | DELETE, `?saved=condition_removed` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Issue permit | Lifecycle (draft) | POST `issuePermit`; disabled until `canIssue` | permit id | Allocates ref, freeze, audit, `?saved=issued` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel this draft | Lifecycle (draft) | POST `transitionPermit` verb=cancel | permit id | `status=cancelled` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Activate / Resume work | Lifecycle (issued/suspended) | POST `transitionPermit` verb=activate | permit id | `status=active` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Suspend | Lifecycle (issued/active) | POST `transitionPermit` verb=suspend | permit id | `status=suspended` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel permit | Lifecycle (non-terminal) | POST `transitionPermit` verb=cancel | permit id | `status=cancelled` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Close permit (+ close-out notes) | Lifecycle (issued/active/suspended) | POST `transitionPermit` verb=close | permit id (notes optional) | `status=closed`, notes saved | IMPLEMENTED, NOT LIVE-VERIFIED |
| Download PDF | Sign-off panel | Opens `/api/health-safety/permits/[id]/pdf` | — | Inline PDF (409 if draft) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Sign (type name + optional draw) | Sign-off panel | POST `acknowledgeSafetyDocument` | signedName | Append-only ack row | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Worker sign-off links — route `/health-safety/worker-links`  *(IMPLEMENTED, NOT IN NAV)*
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED — **absent from the global nav model.** Confirmed: no entry in `nav-model.ts` (only `/health-safety` and `/permits` are listed). Reachable only via the register's inline sub-nav (`health-safety/page.tsx:191-196`).
- **Roles:** `requireOrgContext()` (`worker-links/page.tsx:33`); revoke relies on `.eq("org_id", ctx.org.id)` + `is_org_admin` RLS (`worker-links/actions.ts:104-109`).
- **Purpose:** Issue/revoke secure login-free links that let an external subcontractor read & sign ONE job's issued RAMS, permits and toolbox talks.
- **What the user sees:** Back link; intro; "Issue a new link" card (job*, expires-in-days, worker name*, company); an "Issued links" list (worker name, Live/Expired/Revoked pill, company · job, expiry/revoked date, signed count, last-opened), each live row with Revoke.
- **Features:**
  1. **Issue link (one-time secret).** `issueWorkerLink` (`worker-links/actions.ts:38-85`) re-reads the job pinned to active org, `mintWorkerToken()` → stores only the SHA-256 `token_hash`, inserts `worker_signoff_tokens` with `expires_at`. Returns the plaintext URL (`/worker-portal/{token}`) ONCE in `FormState.values` — never persisted in clear, never in a URL; `_issue-form.tsx` renders it inline with Copy + Done. `revalidatePath`.
  2. **Revoke link.** `revokeWorkerLink` (`actions.ts:88-118`) UPDATE `revoked_at/by` count-gated `.eq("org_id",...).is("revoked_at",null)`; count0 → no-op message. `?saved=revoked`.
  3. **Link listing.** `listWorkerLinks` (`worker-links/_data.ts:48-101`) — F-1 paginated via `fetchAllRows`; signed-count per link in ONE paged read of `worker_acknowledgements`.
  - Side-effects: token minting (crypto); no email — operator copies & sends manually. Consuming surface `/worker-portal/[token]` (outside this domain).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Job/Expires-in-days/Worker name/Company | Issue card | `useActionState` | job*, days (1–365)*, name* | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create link | Issue card (disabled if no jobs) | POST `issueWorkerLink` | job*, days*, name* | INSERT token (hash only), shows one-time URL | IMPLEMENTED, NOT LIVE-VERIFIED |
| Copy | Success card | `navigator.clipboard.writeText` | — | Copies URL | IMPLEMENTED, NOT LIVE-VERIFIED |
| Done | Success card | `window.location.reload()` | — | Reloads list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Revoke | Each live row | POST `revokeWorkerLink` | token id | `revoked_at` stamped; count0→no-op | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Toolbox talks

### Page: Toolbox talks register — route `/toolbox`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members (org-pinned read `page.tsx:76`). No per-role difference on the list.
- **Purpose:** The org's register of on-site safety briefings — topic, status (Draft/Delivered/Superseded/Withdrawn), reference, date, job, presenter, attendee count.
- **What the user sees:** Header + "+ Record a talk", optional banner, card list (topic + status pill + `TBT-NNNN` + date/job/presenter/attendee meta), or EmptyState, "{n} talks recorded" footer.
- **Features:**
  1. **Talk register list.** Org-pinned read of `toolbox_talks` ordered `talk_date desc, created_at desc`, `limit(500)` (`page.tsx:71-79`); job names in ONE batched `jobs`+`customers` lookup. Read-only. Limit: hard 500, no pagination (not F-1 paged, unlike the pickers).
  2. **Status/saved banners.** `?saved=created|deleted` / `?error=` (`page.tsx:28-38,96-97`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Record a talk | Header | → `/toolbox/new` | — | New draft form | IMPLEMENTED, NOT LIVE-VERIFIED |
| View | Each row | → `/toolbox/[id]` | — | Detail page | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record a talk (EmptyState) | Empty list | → `/toolbox/new` | — | New draft form | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Record a toolbox talk — route `/toolbox/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members — create is NOT manager-gated (deliberate: "a foreman delivers the day's briefing", `actions.ts:50-53`).
- **Purpose:** Create a toolbox talk as a DRAFT, delivered (frozen) later.
- **What the user sees:** Breadcrumb, explainer, shared `TalkForm`: Topic*, Date* (defaults today), Location/area, Key points briefed (required before deliver), Job/site, Delivered by, Linked RAMS (issued only), Linked permit (issued/active only), PPE, Number attended, Who attended, Notes; Save draft / Cancel.
- **Features:**
  1. **Create draft talk.** `createToolboxTalk` (`actions.ts:59`) → Zod `createToolboxTalkSchema` → `randomUUID()` → tenant INSERT `toolbox_talks` (status omitted — DB born-draft trigger), `created_by=user.id` (`actions.ts:82-101`). → `revalidatePath("/toolbox")` + redirect `/toolbox/{id}?saved=created`. Side-effect: best-effort `recordAdminActivity("toolbox_talk.created")` (`actions.ts:107-114`).
  2. **Picker options restricted to current controls.** RAMS/permit lists only issued/active (`_form-options.ts:46-57`); jobs ≤200 recent; org-pinned explicitly.
  3. **AI drafting: NOT PRESENT** (grep clean across the toolbox domain). Plain text entry only.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save draft | Footer | POST `createToolboxTalk` | Topic*, Date* | Draft created, redirect to detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Topic / Date | Form | Native-required | Topic, Date | Blocks empty submit | IMPLEMENTED, NOT LIVE-VERIFIED |
| Job/site select | Form | Sets `job_id`; preserve-injects out-of-list saved id (F-1) | — | Link stored | IMPLEMENTED, NOT LIVE-VERIFIED |
| Linked RAMS / Linked permit | Form | Sets link; only issued/active listed | — | Link stored | IMPLEMENTED, NOT LIVE-VERIFIED |
| PPE / attendee_count / attendees / notes | Form | Free text/number | — | Stored on draft | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Footer | → `/toolbox` | — | Back to register | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Toolbox talk detail — route `/toolbox/[id]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members read (org-pinned `page.tsx:107-110`; `notFound()` otherwise). First delivery (rev 1) any member; **deliver-revision / create-revision / withdraw / delete owner/admin only** (UI `isAdmin` `page.tsx:117` + server `isManager` `actions.ts:265,305,353,401`). Sign-off any authenticated member.
- **Purpose:** Full lifecycle view of one talk — deliver/freeze, Tier-A authenticated sign-off, Tier-B manual attendance + attachments, revision lineage, withdraw/delete, evidence PDF.
- **What the user sees:** Back link, topic + status pill + reference, date/job/presenter; banner; (drafts) "Ready to deliver?" panel with Edit + Deliver; read-only detail card; Operative sign-off panel (issued) with Download PDF; "Recorded attendance" + AttachmentsPanel (frozen once delivered); Revisions lineage; lifecycle buttons.
- **Features:**
  1. **Deliver (issue) a draft.** `canIssue` needs status=draft + topic + key_points (`toolbox-talks.ts:50-59`). `issueToolboxTalk` (rev 1) allocates per-org ref via RPC `next_tbt_number`, `assembleSnapshot` denormalises site/issuer/RAMS/permit into a frozen JSON snapshot, UPDATE `status=issued,...,snapshot` gated `.eq("status","draft")` count:"exact" (`actions.ts:219-240`). Side-effects: `recordAdminActivity("toolbox_talk.issued")`; duplicate-key → `numbering_clash` retry. Unique `(org_id,reference)` + immutability trigger backstop.
  2. **Operative sign-off (Tier A, authenticated).** Issued-only; `SignoffPanel` renders N-of-M, outstanding crew, typed-name + optional drawn-signature → `acknowledgeSafetyDocument`. Each revision is its own `subject_version` (no ack carry-forward).
  3. **Revisions (M3).** `createToolboxTalkRevision` inserts a new draft copy (`revision_number+1`, `supersedes_id`, shared `root_toolbox_talk_id`, `actions.ts:301-333`); `issueToolboxTalkRevision` → `TBT-NNNN-R0n` via atomic RPC `issue_toolbox_talk_revision` (`actions.ts:378-382`); one-draft-per-series → `revision_in_progress`.
  4. **Withdraw.** `withdrawToolboxTalk` → `transition(...,"withdrawn")` gated `.eq("status","issued")` (`actions.ts:260-291`).
  5. **Delete draft.** `deleteToolboxTalk(id)` deletes the DRAFT row first (status-guarded, count-checked) THEN cleans attachments (`actions.ts:398-428`) — ordered so a talk issued between render and POST never loses evidence.
  6. **Evidence PDF** `/api/health-safety/toolbox-talks/[id]/pdf` renders the FROZEN snapshot (`@react-pdf/renderer`); org-pinned; draft/no-snapshot → 409; `private, no-store`.
  7. **Manual attendance + attachments (Tier B).** Free-text "who attended" + AttachmentsPanel (`target_table="toolbox_talks"`), NOT counted as authenticated ack; panel `frozen` once delivered (append-only; DB freeze trigger).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Edit | Deliver panel (drafts) | → `/toolbox/[id]/edit` | — | Edit form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Deliver talk / Deliver revision | Deliver panel | POST `issueToolboxTalk`/`issueToolboxTalkRevision`; disabled until `canIssue` | topic + key_points | Frozen, referenced, issued | IMPLEMENTED, NOT LIVE-VERIFIED |
| Sign (I have read and understood) | Sign-off panel (issued) | POST `acknowledgeSafetyDocument` | Typed name (2–120); signature optional | Ack recorded | IMPLEMENTED, NOT LIVE-VERIFIED |
| Download PDF / Download evidence PDF | Sign-off panel / superseded-withdrawn | GET PDF route (new tab) | — | Inline PDF (409 if draft) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Upload (attachment) | Recorded attendance | Upload → tenant-attachments | File | File attached (append-only if frozen) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete (attachment) | Attachment row | Owner/admin only; hidden when frozen | — | File removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create revision | Lifecycle (current-issued, admin) | POST `createToolboxTalkRevision` | — | New draft revision | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete draft | Lifecycle (draft, admin) | POST `deleteToolboxTalk.bind(id)` | — | Draft + attachments deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Withdraw talk | Lifecycle (issued, admin) | POST `withdrawToolboxTalk` | — | Status→withdrawn, evidence kept | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open (revision) | Revisions list | → sibling `/toolbox/[id]` | — | That revision | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Edit draft toolbox talk — route `/toolbox/[id]/edit`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** Any member. Non-draft talks redirect to detail with `not_editable` before render (`edit/page.tsx:68`).
- **Purpose:** Edit a draft's fields before delivery; a delivered talk is frozen.
- **What the user sees:** Breadcrumb, "Edit draft", shared `TalkForm` pre-filled, Save changes / Cancel.
- **Features:**
  1. **Update draft.** `updateToolboxTalk` → Zod → UPDATE gated `.eq("status","draft")` count:"exact"; `!count` → `?error=not_editable` (`actions.ts:146-168`). Side-effect: audit `toolbox_talk.updated`. F-1 preserve-injection of out-of-list saved job/RAMS/permit (`_talk-form.tsx:46-71`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes | Footer | POST `updateToolboxTalk` (draft-guarded) | Topic*, Date* | Draft updated or `not_editable` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Footer | → `/toolbox/[id]` | — | Back to detail | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Site diary

### Page: Site diary register — route `/diary`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members read (org-pinned `page.tsx:70`). Delete admin-only (detail page).
- **Purpose:** Dated daily-log register — one row per logged day, most recent first, as progress/dispute evidence.
- **What the user sees:** Header + "+ New entry", banner, card list (date + job + weather + labour count + "Delay logged" pill + 2-line work-summary clamp), or EmptyState, "{n} entries shown" footer.
- **Features:**
  1. **Diary register list.** Org-pinned read of `site_diary_entries` order `entry_date desc, created_at desc`, `limit(500)` (`page.tsx:66-73`); batched job-name lookup. Read-only. Limit: hard 500, not paginated.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New entry | Header | → `/diary/new` | — | New entry form | IMPLEMENTED, NOT LIVE-VERIFIED |
| View | Each row | → `/diary/[id]` | — | Entry detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add today's entry (EmptyState) | Empty list | → `/diary/new` | — | New entry form | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: New diary entry — route `/diary/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (online + offline create). Weather auto-suggest: **FLAGGED OFF (dark)** — `isWeatherAvailable()` false, no provider bound.
- **Roles:** All members.
- **Purpose:** Log a day on site; the one offline-writable create in the product.
- **What the user sees:** Breadcrumb, connectivity notice (offline), `DiaryForm`: Date* (default today or `?date=`), Job/site, Weather (may pre-fill "Suggested…"), People on site, Work done today, Delays/issues, Notes; Save entry / Cancel.
- **Features:**
  1. **Create diary entry (shared write core).** `createDiaryEntry` → Zod → delegates to `createDiaryEntryRecord` (`server/services/offline-writes.ts`) — the SAME function the offline queue replays (shared validation, RLS, cross-org job guard, idempotency key, audit) (`actions.ts:83-116`). INSERT `site_diary_entries`. → redirect `/diary/{id}?saved=created`. `job_missing` rejection surfaced. Job picker F-1 PAGED via `fetchAllRows` (`_data.ts:44-63`).
  2. **Offline save (create).** Client intercepts submit only when `navigator.onLine` false + queue supported → `enqueue({kind:"site_diary.create"})` to IndexedDB → "Saved on this device", dispatches `crewflow:outbox-changed` (`_form.tsx:160-218`). Loud per-case enqueue errors; photos excluded offline.
  3. **Automatic weather suggestion (DARK).** `suggestDiaryWeather` short-circuits to `null` when no provider bound (`_data.ts:132` via `isWeatherAvailable()`); when live would pre-fill from cached `weather_readings` with CC-BY attribution, never fabricating.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save entry / Save on this device | Footer | Online POST `createDiaryEntry`; offline enqueue | Date* | Entry created or queued | IMPLEMENTED, NOT LIVE-VERIFIED |
| Job/site select | Form | Sets `job_id`; preserve-injects (F-1) | — | Link stored | IMPLEMENTED, NOT LIVE-VERIFIED |
| Weather / labour / work / delays / notes | Form | Free text/number; weather may carry dark suggestion | — | Stored | IMPLEMENTED, NOT LIVE-VERIFIED (weather-suggest dark) |
| Cancel | Footer | → `/diary` | — | Back to register | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Diary entry detail — route `/diary/[id]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members read (org-pinned `page.tsx:61`). **Delete owner/admin only** (UI `canDelete` `page.tsx:67` + server `actions.ts:177-179`).
- **Purpose:** Read one day's log, add site photos, and (admin) delete genuine mistakes.
- **What the user sees:** Back link, formatted date heading, job + author, Edit link; banner; a card (Weather / People / Logged; Work done / Delays / Notes); AttachmentsPanel (site photos); admin-only Delete entry.
- **Features:**
  1. **Entry detail read.** Org-pinned read (`page.tsx:54-62`); author via `listStaffForOrg`; job via org-scoped `loadJobForOrg`.
  2. **Site photos.** `AttachmentsPanel targetTable="site_diary_entries"` — not frozen; upload members, delete owner/admin.
  3. **Delete entry.** `deleteDiaryEntry(id)` admin re-check → deletes photos first then count-gated DELETE (`actions.ts:170-205`); audit `site_diary.deleted`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Edit | Header | → `/diary/[id]/edit` | — | Edit form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Upload (attachment) | Attachments | Upload to tenant-attachments | File | Photo attached | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete (attachment) | Attachment row | Owner/admin only | — | File removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete entry | Bottom (admin) | POST `deleteDiaryEntry.bind(id)` | — | Entry + photos deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Job link | Subheader | → `/jobs/[id]` | — | Job detail | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Edit diary entry — route `/diary/[id]/edit`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (incl. offline-edit)
- **Roles:** All members (no status lock on diary). Org-pinned read; `notFound()` if absent.
- **Purpose:** Edit a logged day; supports offline conflict-resolved edits.
- **What the user sees:** Breadcrumb, `DiaryForm` pre-filled `mode="update"` with `baseVersion=updated_at`; Save changes / Cancel.
- **Features:**
  1. **Update entry (online).** `updateDiaryEntry` → Zod → count-gated UPDATE `.eq("id").eq("org_id")`; `!count` → `/diary?error=not_found` (`actions.ts:118-168`). Audit `site_diary.updated`. Note: online path does NOT re-check `baseVersion` (last-write-wins); the 3-way merge applies only to the queued replay.
  2. **Offline edit (3-way merge).** `mode="update"` carries `baseVersion`+`baseValues`; offline save enqueues `site_diary.update` for server-side 3-way merge — concurrent different-field change survives, same-field clash surfaced in outbox (`_form.tsx:170-193`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes / Save on this device | Footer | Online POST `updateDiaryEntry`; offline enqueue merge | Date* | Updated / queued | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Footer | → `/diary/[id]` | — | Back to detail | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Snagging

### Page: Snagging register — route `/snags`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members read (org-pinned `page.tsx:116`). Delete admin-only (detail page).
- **Purpose:** Defect/punch-list register with status + priority filters; tracks each defect open→signed-off.
- **What the user sees:** Header + "+ Log a snag", banners, two filter navs (Status: All/Open/In progress/Fixed/Verified/Won't fix; Priority: Any/High/Medium/Low), card list (priority + status pills, Overdue pill, title, job/location/trade/assignee/due meta), or EmptyState, "{n} snags shown · {open} still open" footer.
- **Features:**
  1. **Filtered register.** Validated `?status=`/`?priority=` against `SNAG_STATUSES`/`SNAG_PRIORITIES` (`page.tsx:89-96`); org-pinned read of `snags` order `created_at desc`, `limit(500)`, composable `.eq` filters (`page.tsx:98-119`); batched job + staff maps. Overdue computed client-side for non-terminal statuses. Limit: hard 500, not paginated.
  2. **Filter links.** `FilterLink` preserves the other axis (`page.tsx:300-333`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Log a snag | Header | → `/snags/new` | — | New snag form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status filter chips | Status nav | `?status=`; preserves priority | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Priority filter chips | Priority nav | `?priority=`; preserves status | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| View | Each row | → `/snags/[id]` | — | Snag detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Log a snag (EmptyState) | Empty list | → `/snags/new` | — | New snag form | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Log a snag — route `/snags/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (incl. offline create)
- **Roles:** All members.
- **Purpose:** Log a defect; offline-writable; deep-linkable from a job with `?job=`.
- **What the user sees:** Breadcrumb, offline notice, `SnagForm`: Defect title*, Priority (default medium), Target fix date, Job/site, Assign to, Location, Trade, Details; Log snag / Cancel.
- **Features:**
  1. **Create snag (shared write core).** `createSnag` → Zod → delegates to `createSnagRecord` (same as offline replay) — pins `status='open'`, cross-org job + assignee guards, idempotency key, audit (`actions.ts:109-152`). INSERT `snags`. → `/snags/{id}?saved=created`. `job_missing`/`assignee_missing` surfaced. Job picker F-1 PAGED (`new/page.tsx:49-60`); `?job=` preset preserve-injected.
  2. **Offline create.** `enqueue({kind:"snag.create"})` on no-signal; photos excluded offline (`_form.tsx:149-195`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Log snag / Save on this device | Footer | Online POST `createSnag`; offline enqueue | Title* | Snag created (status=open) or queued | IMPLEMENTED, NOT LIVE-VERIFIED |
| Priority select | Form | Sets priority (default medium) | — | Stored | IMPLEMENTED, NOT LIVE-VERIFIED |
| Job/site select | Form | Sets `job_id`; preserve-injects (F-1) | — | Link stored or loudly rejected if bogus | IMPLEMENTED, NOT LIVE-VERIFIED |
| Assign to select | Form | Sets `assigned_to`; preserve-injects (F-1) | — | Assignment stored | IMPLEMENTED, NOT LIVE-VERIFIED |
| Target fix date / Location / Trade / Details | Form | Free text/date | — | Stored | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Footer | → `/snags` | — | Back to register | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Snag detail — route `/snags/[id]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members read (org-pinned `page.tsx:101`). **Status change, reassign, priority all open to any member** (actions only org-pin + validate, no manager gate — `actions.ts:241-372`). **Delete owner/admin only** (UI `canDelete` `page.tsx:109` + server `actions.ts:382-384`).
- **Purpose:** One defect's detail, status workflow, quick reassign/priority, photos, audit; admin hard-delete.
- **What the user sees:** Back link, title + priority/status/overdue pills, Edit; banners; detail card; a Status section (status buttons, current disabled; Reassign select+Update; Priority select+Update); AttachmentsPanel (photos); Audit card (Logged/Last updated/Resolved); admin-only Delete snag.
- **Features:**
  1. **Status workflow.** Each of 5 statuses is a mini-form POSTing `updateSnagStatus` (current disabled); derives `resolved_at` via `resolvedAtForTransition` (set on verified/wont_fix, cleared on reopen), count-gated UPDATE (`actions.ts:241-299`). Audit `snag.status_changed`.
  2. **Reassign.** `reassignSnag` → UPDATE `assigned_to` (may be null) count-gated (`actions.ts:301-335`); picker preserve-injects current assignee. Audit `snag.reassigned`. Note: no cross-org assignee guard on this quick action (unlike full edit).
  3. **Priority quick-set.** `setSnagPriority` → UPDATE count-gated (`actions.ts:337-372`); audit `snag.priority_changed`.
  4. **Photos.** `AttachmentsPanel targetTable="snags"` — not frozen; upload members, delete admin.
  5. **Delete snag.** Admin-only; deletes photos first then count-gated DELETE (`actions.ts:374-425`); audit `snag.deleted`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Edit | Header | → `/snags/[id]/edit` | — | Edit form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status buttons (Open/In progress/Fixed/Verified/Won't fix) | Status section | POST `updateSnagStatus`; current disabled | — | Status + resolved_at updated | IMPLEMENTED, NOT LIVE-VERIFIED |
| Reassign select + Update | Status section | POST `reassignSnag` | Assignee (or Unassigned) | Assignment changed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Priority select + Update | Status section | POST `setSnagPriority` | — | Priority changed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Upload (attachment) | Attachments | Upload to tenant-attachments | File (photo) | Photo attached | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete (attachment) | Attachment row | Owner/admin only | — | File removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete snag | Bottom (admin) | POST `deleteSnag.bind(id)` | — | Snag + photos deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Job link | Detail card | → `/jobs/[id]` | — | Job detail | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Edit snag — route `/snags/[id]/edit`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (incl. offline edit)
- **Roles:** All members; org-pinned read. Status lifecycle NOT edited here.
- **Purpose:** Edit a snag's free-text/scalar detail; offline-writable with 3-way merge.
- **What the user sees:** Breadcrumb, `SnagForm` pre-filled `mode="update"` with `baseVersion`; Save changes / Cancel.
- **Features:**
  1. **Update snag (online).** `updateSnag` → Zod → explicit cross-org job guard + assignee guard before count-gated UPDATE (`actions.ts:154-239`). Audit `snag.updated`. Status never written here (schema has no status field on edit).
  2. **Offline edit.** `enqueue({kind:"snag.update"})` with baseVersion/baseValues for 3-way merge; status lifecycle online-only by design (`_form.tsx:35-44,156-174`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save changes / Save on this device | Footer | Online POST `updateSnag` (cross-org guards); offline enqueue merge | Title* | Updated / queued / loud `job_missing`·`assignee_missing` | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Footer | → `/snags/[id]` | — | Back to detail | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Works quality (ITP / NCR)

### Page: Works Quality register — route `/quality`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members (`nav-model.ts:150` no `roles`; page `requireOrgContext()` `page.tsx:84`).
- **Purpose:** The Inspection & Test Plan (ITP) register — the "where are we blocked" view, leading with open hold points.
- **What the user sees:** Header with 3 nav buttons (Non-conformance / Templates / + New inspection plan); a red "N hold points outstanding across M plans" lead (or green all-clear); amber breach banner; filter pills (Open hold points / Current / Draft / Superseded-withdrawn / All with counts); a divided list of plans (reference, work package, status chip, checks-signed count + %, hold-point count, badges).
- **Features:**
  1. **Open-hold-point lead.** `listPlans` reads `inspection_test_plans` + read-model `works_quality_plan_status` (`_data.ts:75-104`); `matches(p,"open")` keeps issued plans with a non-null `openHoldItemNumber` (`page.tsx:68-80`). Read-only, loud. Each row → `/quality/[id]`.
  2. **Breach banner.** `holdPointBreaches>0` (sign-off recorded past an open hold point) (`page.tsx:93,176-190`).
  3. **Filters + list.** `<Link>`-based `?filter=`; completion % via `lib/quality/itp` helpers.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Non-conformance | Header | → `/quality/ncrs` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Templates | Header | → `/quality/templates` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| + New inspection plan | Header | → `/quality/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Filter pills ×5 | Nav | `?filter=` reload, `aria-current` | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Hold-point / Plan row links | Lead + list | → `/quality/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create the first plan | Empty state | → `/quality/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: New inspection plan — route `/quality/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members.
- **Purpose:** Draft an ITP header; job REQUIRED.
- **What the user sees:** Breadcrumb; amber "no jobs" block → `/jobs` when org empty; else form: Job* (F-1 paged + preserved-option so `?jobId=` always matches), Work package* (autofocus), Title*, Spec/drawing ref, Location, Prepared-by, Plan date, Notes; Create draft + Cancel.
- **Features:**
  1. **Create draft.** `createInspectionPlan` (`actions.ts:62-98`): zod `createPlanSchema`; inserts `inspection_test_plans` (`org_id`, `created_by`, randomUUID). → `revalidatePath("/quality")` + redirect `/quality/{id}?saved=created`. No email/AI/finances.
  2. **Picker completion (F-1).** `listJobOptions` paged (`_data.ts:274-293`); `withPreservedOption` injects the preset.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Job select | Form | Sets `jobId` | required | Bound to create | IMPLEMENTED, NOT LIVE-VERIFIED |
| Prepared-by select | Form | Optional author | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create draft | Form | `createInspectionPlan` → insert → redirect | job, work package, title | New draft plan | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Form | → `/quality` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create a job (link) | Empty block | → `/jobs` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Inspection plan detail — route `/quality/[id]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members. Sign-off/void/witness/revision controls gate on plan status, not role (DB triggers own the hard gates).
- **Purpose:** One ITP — hold-point warnings, ordered checks with sign-offs/evidence, witness invitations, document control (issue/withdraw/revise/PDF), metadata, draft-only editing.
- **What the user sees:** Breadcrumb; reference + status chip + "Revision N" + optional "All checks accepted"; the `HoldPointWarnings` seam; superseded/withdrawn notices; Progress stats; the ordered `ItemCard` list; Witness panel (issued); Add-item form (draft); Document control block; Plan details; Edit-header form (draft).
- **Features:**
  1. **ITP read.** `getPlan` loads plan + items + all sign-offs + progress read-model + prior reference, active-org pinned; `notFound()` on null (`page.tsx:102-103`). Sign-offs grouped into one live + voided history (partial-unique index guarantees ≤1 live).
  2. **Issue plan.** `issuePlan` (`actions.ts:142-184`): pre-check `canIssue` (title, work package, job, ≥1 item); RPC `issue_inspection_plan` allocates reference + atomically supersedes the prior current plan; `recordAdminActivity("inspection_plan.issued")`; revalidates. Button disabled when gate fails.
  3. **Add/remove item.** `addPlanItem` (`actions.ts:207-252`) / `deletePlanItem` (`actions.ts:254-271`); draft-only. Hold-point auto-forces `required=true`; duplicate item number → friendly error.
  4. **Record sign-off.** `recordSignoff` (`actions.ts:280-339`): re-reads plan, refuses if not issued (`not_issued`); inserts `inspection_signoffs` (`inspected_by`, `plan_version=plan.reference`); duplicate → `already_signed_off`. Hold-point breach is DB-stamped, never refused, only warned (`_item-card.tsx:74-75,235-240`). Evidence via `AttachmentsPanel targetTable="inspection_signoffs" frozen` (append-only, byte-immutable per migration 20261033).
  5. **Void sign-off.** `voidSignoff` (`actions.ts:497-537`): count-gated update of `voided_at/by/reason` only where null; immutable audit record kept; HQ audit.
  6. **Witness invitations (M2).** `WitnessPanel` for witness/approve control points on issued plans; `inviteWitness` + `recordWitnessOutcome` (`actions.ts:349-401`); sign-off can link an honoured invitation. Portal visibility deferred (migration 20261081). **Contacting the witness stays manual — no email sent.**
  7. **Start revision N+1.** `createPlanRevision` (`actions.ts:412-490`): copies issued plan + items into new draft (`root_plan_id`/`revision_number+1`); one-draft-per-series partial-unique; rolls back on item-copy failure; HQ audit.
  8. **Withdraw.** `withdrawPlan` (`actions.ts:186-202`) draft or issued → withdrawn.
  9. **Edit header.** `updateInspectionPlan` (`actions.ts:100-137`) draft-only; required job select F-1 paged + preserve-injected.
  10. **Raise NCR link** per item → `/quality/ncrs/new?itemId=…(&signoffId=…)` (`_item-card.tsx:400-411`).
  11. **Evidence PDF** `/api/quality/[id]/pdf`: on-demand, active-org pinned, 409 on draft, regenerated per request, `private, no-store`, active-org letterhead, includes live NCR register.
  - No finances, no AI on any path (`actions.ts:38-42`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Issue plan | Document control (draft) | `issuePlan` → RPC issue+supersede+ref, audit | gate: title/work pkg/job/≥1 item | Plan issued/frozen | IMPLEMENTED, NOT LIVE-VERIFIED |
| Withdraw draft/plan | Document control | `withdrawPlan` → withdrawn | — | Withdrawn | IMPLEMENTED, NOT LIVE-VERIFIED |
| Start revision N+1 | Document control (issued) | `createPlanRevision` → new draft w/ copied items | — | Revision draft | IMPLEMENTED, NOT LIVE-VERIFIED |
| Download evidence PDF | Document control (issued/superseded/withdrawn) | GET PDF route | — | PDF (409 if draft) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add item | Add-item form (draft) | `addPlanItem` insert | item no, title, acceptance, control point | Item added | IMPLEMENTED, NOT LIVE-VERIFIED |
| Hold point / Required checkboxes | Add-item form | hold point forces required=true | — | Flags set | IMPLEMENTED, NOT LIVE-VERIFIED |
| Remove item | Each item (draft) | `deletePlanItem` | — | Item removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record sign-off | Item card (issued, no live) | `recordSignoff` insert | result, signed-by, date | Sign-off recorded (breach warned not blocked) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Result radios (pass / pass w comment / fail) | Sign-off form | sets result | required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Honoured witness invitation select | Sign-off form (witness/approve) | links invitation permanently | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Attach photos/certs | Sign-off block | `AttachmentsPanel` frozen (append-only) | file | Immutable evidence | IMPLEMENTED, NOT LIVE-VERIFIED |
| Void this sign-off | Live sign-off | `voidSignoff` | void reason | Voided, audit kept | IMPLEMENTED, NOT LIVE-VERIFIED |
| Raise an NCR against this item | Each item (issued) | → `ncrs/new?itemId` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Invite a witness | Witness panel | `inviteWitness` insert | name, org | Invitation recorded (no email) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Attended / Did not attend / Cancel | Witness panel | `recordWitnessOutcome` | — | Outcome pinned | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save details | Edit form (draft) | `updateInspectionPlan` | job/work pkg/title | Saved | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Non-conformance register — route `/quality/ncrs`  *(IMPLEMENTED, NOT IN NAV)*
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Not in `nav-model.ts` — reachable via the "Non-conformance" header button on `/quality` and item links (the `nav.quality` keywords include "ncr").
- **Roles:** All members.
- **Purpose:** The NCR register (M2) — issued-plan checks that failed, each needing a verified corrective action; criticals lead.
- **What the user sees:** Breadcrumb; "snags belong in Snagging" guidance; red critical-live lead; filter pills (Live default / Open / In progress / Closed-cancelled / All with counts); severity+status-sorted list (reference, title, severity chip, status chip, plan+item label, due date).
- **Features:**
  1. **Register read.** `listNcrs` reads `non_conformance_reports` + item labels + plan references, active-org pinned, loud (`ncrs/_data.ts:48-99`). Severity critical→major→minor; live ahead of resolved.
  2. **Critical lead.** live + `severity==="critical"` (`page.tsx:95,120-145`). Read-only.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Filter pills ×5 | Nav | `?filter=` reload | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Critical / NCR row links | Lead + list | → `/quality/ncrs/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Go to the plans | Empty state | → `/quality` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Raise NCR — route `/quality/ncrs/new`  *(IMPLEMENTED, NOT IN NAV)*
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Reachable only with `?itemId=` from a plan item (`notFound()` without it, `new/page.tsx:29`).
- **Roles:** All members.
- **Purpose:** Raise an NCR against a specific plan item, optionally from a failed sign-off.
- **What the user sees:** Breadcrumb; "Against item N — title" context; optional "Raised from a failed sign-off" select (prefilled from `?signoffId=`); Title*, What-does-not-conform*, Severity* (default major), Responsible party (member select + subcontractor text), Corrective-action-due; Raise NCR.
- **Features:**
  1. **Raise.** `raiseNcr` (`ncrs/actions.ts:50-106`): zod `raiseNcrSchema`; inserts with placeholder `reference:"NCR-PENDING"` — **DB trigger allocates the real NCR-NNNN**, derives `org_id` from the item, pins `raised_by`; HQ audit (`non_conformance.raised`); redirect to the new NCR. Source candidates from `getRaiseContext` (failed sign-offs only). No email/AI/finances.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Source sign-off select | Form | sets `sourceSignoffId` | — | Links source | IMPLEMENTED, NOT LIVE-VERIFIED |
| Severity select | Form | sets severity | required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Member / Subcontractor | Form | responsible party | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Raise NCR | Form | `raiseNcr` → insert (DB allocates ref) | title, description, severity | New NCR | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: NCR detail — route `/quality/ncrs/[id]`  *(IMPLEMENTED, NOT IN NAV)*
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members view/edit-open/propose/complete/cancel; **accept/reject a corrective action and verify-close are admin-gated by the DB** (`actions.ts:196-197`, `steps.canDecide` in `lib/quality/ncr`). The page renders decide/close forms per `nextSteps(status)`; the DB is the authority.
- **Purpose:** One NCR — lifecycle position + next steps, corrective-action record (propose → decide → complete), closure verification, edit-while-open, cancel. Middle statuses are DB-DERIVED from corrective-action rows; never offered as buttons.
- **What the user sees:** Breadcrumb; reference + status + severity chips; title + "against item/plan"; description + metadata; NCR evidence AttachmentsPanel (not frozen); corrective-actions list with inline forms; Propose form (open, no pending); Verify-and-close block (accepted action completed); Edit NCR (open only); Cancel block.
- **Features:**
  1. **Load.** `getNcr` reads NCR + corrective actions + item + plan + source sign-off, active-org pinned, `notFound()` on null (`[id]/page.tsx:75-77`).
  2. **Propose corrective action.** `proposeCorrectiveAction` (`actions.ts:149-180`) inserts `ncr_corrective_actions`; AFTER trigger cascades NCR → `corrective_action_proposed`; duplicate pending → `proposal_already_pending`.
  3. **Decide (accept/reject).** `decideCorrectiveAction` (`actions.ts:182-225`): write-once (`.is("decision",null)`); `decided_by/at` re-pinned by trigger; admin gate DB-enforced; reject requires reason; HQ audit.
  4. **Complete.** `completeCorrectiveAction` (`actions.ts:227-258`) on an accepted, not-completed action; `completed_at` server-pinned.
  5. **Close with verification.** `closeNcr` (`actions.ts:263-305`) only from `completed`; `verified_by/at` re-pinned; HQ audit.
  6. **Edit while open.** `updateNcr` (`actions.ts:108-144`) status=open only; frozen once an action proposed.
  7. **Cancel.** `cancelNcr` (`actions.ts:307-335`): DB decides who may cancel from which state; HQ audit.
  - Evidence via `AttachmentsPanel targetTable="non_conformance_reports"` (editable). No email/AI/finances.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Accept corrective action | Pending action | `decideCorrectiveAction` accepted (admin, DB-gated) | — | Accepted, NCR advances | IMPLEMENTED, NOT LIVE-VERIFIED |
| Reject this proposal | Pending action | decision=rejected | reason* | Rejected | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record completion | Accepted action | `completeCorrectiveAction` | what was done* | Completed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Propose action | Propose block (open, no pending) | `proposeCorrectiveAction` insert | the fix* | Proposed, status cascades | IMPLEMENTED, NOT LIVE-VERIFIED |
| Assigned-to / Due | Propose form | optional | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Close NCR | Verify-close (completed; admin, DB-gated) | `closeNcr` | closure comment* | Closed+verified | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save NCR | Edit form (open) | `updateNcr` | title, description, severity | Saved | IMPLEMENTED, NOT LIVE-VERIFIED |
| Attach evidence | NCR body | `AttachmentsPanel` (editable) | file | Attached | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel NCR | Cancel block | `cancelNcr` | — | Cancelled (kept) | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: ITP templates library — route `/quality/templates`  *(IMPLEMENTED, NOT IN NAV)*
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. Not in nav — reachable via the "Templates" header button on `/quality`.
- **Roles:** All members.
- **Purpose:** Versioned reusable ITP checklists; one published version per name, instantiable into a real draft plan.
- **What the user sees:** Breadcrumb; grouped families (name → versions newest-first) with v-number, status chip, check count + description; Create-a-template form (name*, description) that starts the next version if the name exists.
- **Features:**
  1. **Library read.** `listTemplates` reads `inspection_plan_templates` + item counts, active-org pinned, loud (`templates/_data.ts:29-53`); grouped by name.
  2. **Create / next version.** `createTemplate` (`actions.ts:50-88`): reads max version for the name, inserts next version (unique `(org_id,name,version)` backstops a race); redirect to detail.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Template version row link | Library | → `/quality/templates/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create draft template | Form | `createTemplate` → insert v1 or next version | name* | New draft template | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Template detail — route `/quality/templates/[id]`  *(IMPLEMENTED, NOT IN NAV)*
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members.
- **Purpose:** One template version — draft (add/remove items, publish), published (instantiate a plan, start next version, archive), archived (read-only).
- **What the user sees:** Breadcrumb; v-number + status chip; item cards; Add-item form (draft); "Create a plan from this template" block (published); Version-control block.
- **Features:**
  1. **Load.** `getTemplate` reads template + items, active-org pinned, `notFound()` on null.
  2. **Add/remove item.** `addTemplateItem`/`deleteTemplateItem` (`actions.ts:158-221`), draft-only; hold-point forces required; duplicate number mapped.
  3. **Publish.** `publishTemplate` (`actions.ts:226-260`): pre-check ≥1 item, RPC `publish_inspection_plan_template` atomically archives the family's current published version; HQ audit.
  4. **Start next version.** `createTemplateVersion` (`actions.ts:91-153`) copies items into a new draft (supersedes_id); rollback on item-copy failure.
  5. **Archive.** `archiveTemplate` (`actions.ts:262-278`).
  6. **Instantiate.** `instantiateTemplate` (`actions.ts:283-359`): published-only; inserts a **real DRAFT `inspection_test_plans` row + items** (so M1 freeze-on-issue applies); job required & DB-verified same-org; rollback on item failure; HQ audit; redirect `/quality/{planId}?saved=created`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Add item | Add-item form (draft) | `addTemplateItem` | item no, title, acceptance, control pt | Item added | IMPLEMENTED, NOT LIVE-VERIFIED |
| Remove item | Item card (draft) | `deleteTemplateItem` | — | Removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Publish template | Version control (draft) | `publishTemplate` RPC (needs ≥1 item) | — | Published, prior archived | IMPLEMENTED, NOT LIVE-VERIFIED |
| Archive draft/template | Version control | `archiveTemplate` | — | Archived | IMPLEMENTED, NOT LIVE-VERIFIED |
| Start version N+1 | Version control (published) | `createTemplateVersion` copies items | — | New draft version | IMPLEMENTED, NOT LIVE-VERIFIED |
| Create draft plan | Instantiate block (published) | `instantiateTemplate` → real draft plan+items | job*, work package* | Draft plan created | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Delays & EOT

### Page: Delays & EOT register — route `/delays`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members (`nav-model.ts:151` no `roles`).
- **Purpose:** The contemporaneous evidence log behind a future extension-of-time claim — what stopped work, with linked proof.
- **What the user sees:** Header + "Log a delay"; stat tiles (Recorded / Ongoing / Drafts / Days claimed) when rows exist; filter pills (Ongoing / Recorded / Draft / Withdrawn / All); list (category label, status chip, "Ongoing" badge, date span, description, job label, days-claimed, "diary linked"/"variation linked" tags).
- **Features:**
  1. **Register read.** `listDelayEvents` reads `delay_events` + job labels, active-org pinned, loud (`_data.ts:47-60`). `claimedDays` sums `working_days_lost` over recorded events (`page.tsx:83`). Read-only. **No AI, no finances** (`actions.ts:27-28`); "Days claimed" is a manual human figure.
  2. **Filters.** ongoing = recorded & `ended_on===null` (`page.tsx:57-70`).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Log a delay | Header | → `/delays/new` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |
| Filter pills ×5 | Nav | `?filter=` reload | — | Filter | IMPLEMENTED, NOT LIVE-VERIFIED |
| Event row link | List | → `/delays/[id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Log a delay — route `/delays/new`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (online + offline). Weather corroboration: **PLACEHOLDER / COMING SOON** (field works; no provider backend).
- **Roles:** All members.
- **Purpose:** Draft a delay event. Job required; evidence pickers (diary/variation) job-scoped, shown once a job is chosen.
- **What the user sees:** Breadcrumb; amber no-jobs block when org empty; else `DelayCreateForm` (client): offline connectivity banner, Job* (F-1 paged + preserved option), shared `DelayEventFields` (Category* with inline descriptions, Started*, Ended, Working-days-lost manual claim, What-happened*, Evidence-links fieldset: diary/variation selects when a job chosen, Postcode district), Cancel + Save draft.
- **Features:**
  1. **Create (online).** `createDelayEvent` (`actions.ts:62-88`) → single write path `createDelayEventDraftRecord` (shared with offline replay); job-guard rejection surfaced; redirect `/delays/{id}?saved=created`.
  2. **Offline create.** When `offline` config present + `navigator.onLine` false, submit written to local outbox (`enqueue`, kind `delay_event.create`); "Saved on this device"; 11 specific enqueue-error messages; evidence pickers + photos withheld offline. Online path works with JS disabled.
  3. **Weather district.** Stored as outward postcode; **no weather provider connected** — field help states no readings can corroborate it today; stored so evidence attaches automatically if a provider is ever connected.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Job select | Form | sets jobId (resolved preset) | required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Category select | Fields | sets category | required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Diary entry / Variation selects | Fields (job chosen, online) | link evidence | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Postcode district | Fields | stores district | — | stored, no corroboration yet | PLACEHOLDER / COMING SOON (weather backend) |
| Save draft (online) | Form | `createDelayEvent` → draft | job, start, description | Draft created | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save on this device (offline) | Form | `enqueue` to local outbox | job, start, description | Queued draft | IMPLEMENTED, NOT LIVE-VERIFIED |
| Cancel | Form | → `/delays` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Delay event detail — route `/delays/[id]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** All members. Controls gate on lifecycle status (draft/recorded/withdrawn); DB triggers own the hard gates.
- **Purpose:** One delay event, rendering only what the lifecycle allows: draft → edit + record; recorded → frozen record + write-once completion + EOT notice PDF + withdraw; withdrawn → retracted read-only.
- **What the user sees:** Breadcrumb; category + status chip; job + date span; withdrawn notice when applicable; **draft:** full edit form + "Record delay event"; **recorded/withdrawn:** read-only metadata + What-happened; **recorded:** write-once completion form (shows only still-NULL fields), "Contractual notice" block with Generate-EOT-notice-PDF, Withdraw panel; a link to the job's Delays & EOT panel.
- **Features:**
  1. **Load.** `getDelayEvent` active-org pinned, `notFound()` on null (`[id]/page.tsx:68-69`). Draft loads diary + variation options.
  2. **Save draft (update).** `updateDelayEvent` (`actions.ts:90-125`) status=draft only; count-gated.
  3. **Record.** `recordDelayEvent` (`actions.ts:131-147`) draft → recorded; `recorded_at/by` DB-pinned (`tg_delay_event_transition`); freezes the record.
  4. **Complete (write-once).** `closeDelayEvent` (`actions.ts:174-204`) sets `ended_on` and/or `working_days_lost` only where still NULL; trigger refuses overwrite; "nothing_to_complete" guard if patch empty.
  5. **Withdraw.** `withdrawDelayEvent` (`actions.ts:150-166`) recorded → withdrawn; irreversible; record kept visible.
  6. **EOT notice PDF** `/api/delays/[id]/notice/pdf` (nodejs runtime): active-org pinned via `loadEotNotice`; **recorded-only** (404 foreign / 409 draft or withdrawn); missing fields print `[not specified]`; `private, no-store`; explicitly a draft for human review, **never sent anywhere automatically**.
  - No AI, no finances.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Save draft | Edit form (draft) | `updateDelayEvent` | job, start, description, category | Saved | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record delay event | Record panel (draft) | `recordDelayEvent` → recorded (DB pins recorder) | — | Frozen evidence | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save completion | Completion form (recorded, open field) | `closeDelayEvent` write-once | ended-on and/or days-lost | Field frozen | IMPLEMENTED, NOT LIVE-VERIFIED |
| Generate EOT notice (PDF) | Contractual notice (recorded) | GET notice PDF route | — | Draft PDF (409 if not recorded) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Withdraw | Withdraw panel (recorded) | `withdrawDelayEvent` → withdrawn (irreversible) | — | Retracted, kept visible | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open the job (link) | Footer | → `/jobs/[job_id]` | — | Navigate | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Site reports

### Page: Site reports — route `/site-reports`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (full lifecycle + PDF + portal publish code-complete)
- **Roles:** Nav ADMIN_ROLES (`nav-model.ts:152`); page `requireOrgContext()` only (`page.tsx:66`) — no page-level role guard. Destructive/exposing actions re-check owner/admin: `deleteSiteReport` (`actions.ts:572`), `publishToPortal` (`:618`), `withdrawFromPortal` (`:695`); lifecycle moves (submit/approve/issue/supersede/archive) do NOT re-check role.
- **Purpose:** Formal client-ready progress reports that aggregate a job's site diary, snags and toolbox talks over a period, then run review → approve → issue → publish-to-portal with a frozen snapshot.
- **What the user sees:** Header + "+ New report", a status-filter pill row (All + 6 statuses), card list (number, status pill, revision, title, job/customer name, period), footer count.
- **Features:**
  1. **Report register (list).** Paged org-scoped read of `site_reports` via `fetchAllRows` (`page.tsx:81-96`), active-org pinned, ordered created_at+id desc; optional `?status=`; chunked job→customer name lookup (500-id chunks). Read-only, loud, F-1 paged.
  2. **Create draft.** `createSiteReport` (`actions.ts:159`): job* (fully paged list, `?job=` preserved via `withPreservedOption`) + title + period → single write path `createSiteReportDraftRecord` (job guard, source aggregation, cosmetic number, draft insert, audit). → redirect `/site-reports/{id}?saved=created`. Offline-capable (see #3).
  3. **Offline draft capture.** `_form.tsx:109-146`: offline + queue-supported → header written to IndexedDB outbox (kind `site_report.create`); "Saved on this device"; 9-case enqueue error map; source gathering only on server-side sync.
  4. **Detail view + gathered stats.** `[id]/page.tsx` reads one report active-org pinned; 4 stat tiles (diary/snags/toolbox/customer-photos) from `content.sources` (issued = frozen snapshot, draft = working selection).
  5. **Commentary editor.** Editable states only: 11 free-text fields + progress %, `updateReportContent` (`actions.ts:194`) merges over existing content preserving `sources`, count-gated, audit.
  6. **Customer photo selection.** `_photo-picker.tsx` + `updateReportPhotos` (`actions.ts:269`). Lists job's image `tenant_attachments` (tenant RLS client, org+target pinned, limit 60), 60s signed thumbnails via **service-role** admin client. Each submitted id re-verified server-side (`filterVerifiedPhotoIds`); any failed id rejects the whole submission. Max 12. Writes `content.sources.photo_attachment_ids`.
  7. **Lifecycle state machine.** `assertTransition`-guarded: submitForReview / returnToDraft / approveReport (stamps approved_by/at) / archiveReport / issueReport / supersedeReport (`actions.ts:381-567`). Issue **materializes a frozen snapshot** (re-resolves job name + re-gathers sources + re-verifies photos); DB trigger makes snapshot write-once. Supersede creates a new draft revision (revision+1, `supersedes_id`). All count-gated + audited.
  8. **Customer-portal publish/withdraw.** Owner/admin, issued/superseded only. `publishToPortal` (`:615`) stamps portal_published_at/by, and **best-effort sends `sendReportPublishedNotificationEmail`** (scoped link only, never report body; recipient derived from the report's own customer, never caller input; mail failure never rolls back the publish). `withdrawFromPortal` hides it. Both audited.
  9. **PDF.** `GET /api/site-reports/[id]/pdf` via `@react-pdf/renderer` (Node runtime), active-org pinned, issued → frozen snapshot, draft → live preview.
  10. **Delete draft.** Owner/admin + draft-only; count-gated delete, audited.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + New report | List header | → `/site-reports/new` | — | Create form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Status filter pills (All + 6) | List nav | sets `?status=` | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open | Each card | → `/site-reports/{id}` | — | Detail page | IMPLEMENTED, NOT LIVE-VERIFIED |
| Gather & create draft / Save on this device | New form submit | `createSiteReport` or offline enqueue | title, job, period | Draft created / queued | IMPLEMENTED, NOT LIVE-VERIFIED |
| Submit for review | Detail (draft) | `submitForReview` | — | → ready_for_review | IMPLEMENTED, NOT LIVE-VERIFIED |
| Approve / Back to draft | Detail (ready) | `approveReport` / `returnToDraft` | — | status change + approver stamp | IMPLEMENTED, NOT LIVE-VERIFIED |
| Issue report / Back to draft | Detail (approved) | `issueReport` | job present | Frozen snapshot, issued_at | IMPLEMENTED, NOT LIVE-VERIFIED |
| Start new revision | Detail (issued) | `supersedeReport` | — | New draft rev+1 | IMPLEMENTED, NOT LIVE-VERIFIED |
| Archive | Detail (non-archived/superseded) | `archiveReport` | — | → archived | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete draft | Detail (owner/admin, draft) | `deleteSiteReport` | — | Row deleted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Publish to portal | Detail (admin, issued) | `publishToPortal` | — | Portal-visible + customer email (best-effort) | IMPLEMENTED, NOT LIVE-VERIFIED |
| Withdraw from portal | Detail (admin, visible) | `withdrawFromPortal` | — | Hidden from portal | IMPLEMENTED, NOT LIVE-VERIFIED |
| Save report (commentary) | Detail (editable) | `updateReportContent` | schema-valid fields | Content merged | IMPLEMENTED, NOT LIVE-VERIFIED |
| Photo checkboxes + Save photo selection | Detail (editable, has job) | `updateReportPhotos` | ≤12 verified job photos | Selection saved | IMPLEMENTED, NOT LIVE-VERIFIED |
| Download/Preview PDF | Detail header | opens `/api/.../pdf` new tab | — | Streamed PDF | IMPLEMENTED, NOT LIVE-VERIFIED |
| AttachmentsPanel | Detail footer | report-level upload | file | Attachment added | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Drawings (Blueprint Centre)

### Page: Drawings — route `/blueprints`
- **Status:** LIVE & WORKING as a routing/index surface (code-complete; corroborated by the full job-scoped viewer/markup/compare subsystem it links into). **Intentionally a thin index, not a stub.**
- **Roles:** ALL_ROLES (inherits parent; `nav-model.ts:153`; keywords include "markup"). Page guard `requireOrgContext()`.
- **Purpose:** Org-wide drawing register — groups every drawing across jobs and links into each job's blueprint workspace. Adds no blueprint logic of its own (`page.tsx:13-25`).
- **What the user sees:** "Drawings" header, a list of job cards (customer · scheduled date, drawing count, last-updated) each → `/jobs/{id}/blueprints`. Empty state → `/jobs`. Footer: "N jobs with drawings · M drawings total."
- **Markup verification:** Markup genuinely exists — job-scoped, not on this page. `app/(app)/jobs/[id]/blueprints/` contains `_markup-ui.tsx`, `markup-actions.ts`, `_pins-ui.tsx`/`pin-actions.ts`, `_compare.tsx`/`_compare-launcher.tsx`, `_pdf-viewer.tsx`, `_drawing-render-surface.tsx`, `_offline-controls.tsx`, and a version-file route `f/[versionId]/route.ts`. The nav keyword "markup" is honest; it resolves one level deeper.
- **Features:**
  1. **Org drawing index.** `listBlueprintsForOrg(ctx.org.id)` (org-pinned, loud, F-1 paged) → `groupByJob` (count + latest updated_at, newest-activity-first, stable job-id tiebreak `page.tsx:34-50`) → chunked job-label lookup (500-id chunks, loud `:62-77`). Read-only. `force-dynamic`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Job name link | Each card | → `/jobs/{id}/blueprints` | — | Job drawing workspace | LIVE & WORKING |
| Open drawings | Each card (right) | → `/jobs/{id}/blueprints` | — | Same | LIVE & WORKING |
| Go to jobs | Empty state | → `/jobs` | — | Jobs list | LIVE & WORKING |

---

## Documents

### Page: Documents — route `/documents`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **Not a stub** — a real aggregating index over two live stores (`job_documents` + `tenant_attachments`); reads but does not store.
- **Roles:** Nav ADMIN_ROLES (`nav-model.ts:154`); page `requireOrgContext()` only. RLS is the real visibility boundary: non-admins see only `staff`-visibility `job_documents`, admins also see `private` (same tenant client as the job page — never service-role `page.tsx:14-30`).
- **Purpose:** One org-wide document home aggregating structured per-job documents and the universal polymorphic attachment store, searchable and filterable, each row deep-linking to its owning entity.
- **What the user sees:** "Documents" header, a search box (name/reference), a source-filter pill row (All / Job documents / Attachments), a list of document rows (badge, title, type·status·job·ref·🔒Private or label·mime·size, date, optional "Shared with customer" pill, "Open →"). Empty/empty-search states. Footer count.
- **Features:**
  1. **Aggregated document list.** Two independent fully-paged RLS reads — `job_documents` (org-pinned, `.or()` ilike over `JOB_DOCUMENT_SEARCH_COLUMNS` `:129-147`) and `tenant_attachments` (org-pinned, filename ilike `:152-171`). Source filter can suppress either. Chunked job→customer resolve. Merge into `DocEntry[]`, sort newest-first + title tiebreak. Read-only (files served through each entity's own signed-URL pipeline). Loud reads. `ATTACHMENT_HREF` map decides linkability (jobs/quotes/invoices/suppliers/customers/leads/snags/site_reports linkable; memberships/toolbox_talks/site_diary_entries labelled but unlinkable).
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Search box + Search | Header | GET `?q=` (preserves source) | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| Source pills (All/Job docs/Attachments) | Nav | sets/clears `?source=` | — | Filtered by store | IMPLEMENTED, NOT LIVE-VERIFIED |
| Document row (when linkable) | List | → owning entity route | — | Entity detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Row (unlinkable) | List | static card, no link | — | — | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Site compliance

### Page: Site compliance (hub) — route `/site-compliance`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** ALL_ROLES (`nav-model.ts:155`). Page `requireOrgContext()`.
- **Purpose:** Pick an active site to run inductions, visitor sign-in/out, and a live fire-muster roll.
- **What the user sees:** "Site compliance" header, a table of active sites (name link, kind, induction count, visitors-on-site count). Empty state → `/sites/new`.
- **Features:**
  1. **Site picker with counts.** `Promise.all([listSitesForOrg, loadComplianceCounts])` both active-org pinned (`page.tsx:26-29`). Counts (`_data.ts:140-175`) fully page `site_inductions` (all) and `site_visitors` (signed_out_at null) per site, loud. Active sites `compareSites`-sorted. Read-only. `force-dynamic`.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Site name link | Table row | → `/site-compliance/{siteId}` | — | Site detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Add a site | Empty state | → `/sites/new` | — | Site create | IMPLEMENTED, NOT LIVE-VERIFIED |
| Manage sites | Empty state | → `/sites` | — | Sites list | IMPLEMENTED, NOT LIVE-VERIFIED |

### Page: Site compliance (detail) — route `/site-compliance/[siteId]`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED
- **Roles:** ALL_ROLES. Site re-loaded active-org pinned (`loadSiteForOrg`, `page.tsx:60`), notFound on miss.
- **Purpose:** Run one site's inductions, visitor log, and live fire muster, with PDF/CSV muster export.
- **What the user sees:** Site header (name, kind, address, retired flag), banners, a **Fire muster** panel (present count badge, generated time, Muster PDF + CSV, table of workers + visitors on site), an **Inductions** section (record form + inductions table with Current/Expired), a **Visitors** section (sign-in form + on-site table with Sign-out).
- **Features:**
  1. **Live fire muster.** `buildMusterRoll` (`_data.ts:97-137`) reads inductions + org-wide open `time_entries` (ended_at null) + on-site visitors + staff names → pure `computeMuster`. Shows inducted+clocked-in workers and signed-in visitors with on-since times. Read-only. Exports: `GET /api/site-compliance/[siteId]/muster/pdf` and `/csv`.
  2. **Record induction.** `recordInduction` (`actions.ts:46`): `useActionState` + `window.location.assign` on success (deep-swap race cure). Validates `recordInductionSchema`; re-loads site active-org pinned; captures server-side provenance (hashed IP + user-agent); optional drawn signature stored FIRST (`storeSignatureImage`, best-effort — failure never blocks); inserts `site_inductions` (org re-derived by DB trigger; append-only). 23505 (duplicate worker+version) treated as idempotent success + orphan signature cleaned. Current vs expired via `isInductionCurrent`/`valid_until`.
  3. **Visitor sign-in.** `signInVisitor` (`actions.ts:124`): validates `visitorSignInSchema`, re-loads site active-org pinned, inserts `site_visitors` (org re-derived by trigger, immutable identity).
  4. **Visitor sign-out.** `signOutVisitor` (`actions.ts:171`): count-gated update pinned to id + active org + `signed_out_at is null` — a wrong-org/already-out click is a reported no-op, never false success.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| Muster PDF | Muster header | opens `/api/.../muster/pdf` new tab | — | Streamed muster PDF | IMPLEMENTED, NOT LIVE-VERIFIED |
| CSV | Muster header | `/api/.../muster/csv` | — | CSV download | IMPLEMENTED, NOT LIVE-VERIFIED |
| Worker/team select | Induction form | choose member or External | — | field | IMPLEMENTED, NOT LIVE-VERIFIED |
| External name / company / version / re-induct-by / name signed | Induction form | schema fields | version + signed name required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| SignaturePad | Induction form | captures PNG (optional) | — | Stored on induction row | IMPLEMENTED, NOT LIVE-VERIFIED |
| Record induction | Induction form submit | `recordInduction` | version, signed name, valid site | Append-only induction, idempotent on dup | IMPLEMENTED, NOT LIVE-VERIFIED |
| Visitor name/company/purpose/host/vehicle reg | Visitor form | schema fields | visitor name required | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Sign visitor in | Visitor form submit | `signInVisitor` | valid site | Visitor row inserted | IMPLEMENTED, NOT LIVE-VERIFIED |
| Sign out | On-site table row | `signOutVisitor` | — | Count-gated sign-out | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Compliance library

### Page: Compliance library — route `/compliance`
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (upload/store/expiry-tracking/signed-download code-complete; expiry reminders depend on the daily cron, out of scope here)
- **Roles:** Nav ADMIN_ROLES (`nav-model.ts:156`); page/list `requireOrgContext()` only. Mutations re-check owner/admin: `deleteComplianceDocument` (`actions.ts:151`); upload RLS-gated via `is_org_admin()` + service-role storage. Read-side RLS admits org members.
- **Purpose:** Library of insurance/trade certificates, permits, contracts — with expiry tracking and 30d/7d/day-of reminders.
- **What the user sees:** "Compliance" header + "+ Add document", a kind-filter pill row (All + 5 kinds), a card list (kind pill, expiry badge — EXPIRED/Expires in Nd/No expiry, title, filename, notes, View + Delete). Empty state. Footer with "expiring soon" threshold date.
- **Features:**
  1. **Document list.** `compliance_documents` read ordered `expires_at` asc, **`.limit(500)`** cap, active-org pinned, optional `?kind=` (`page.tsx:69-85`). Client-computes expired/urgent(≤7d)/soon(≤30d) badges. **Note:** NOT F-1 paged (hard 500 cap) — a divergence from sibling registers.
  2. **Upload.** `uploadComplianceDocument` (`actions.ts:59`): validates kind/title/expiry/notes; file PDF/JPEG/PNG/HEIC/HEIF/WebP ≤25 MB. Uploads to **`compliance-docs` bucket** via service-role admin client at `{org}/{docId}.{ext}` (`upsert:false`), then inserts tenant row; on insert failure removes the orphaned blob. Audited `compliance_document.uploaded`.
  3. **View + signed download.** `[id]/page.tsx` reads row active-org pinned, shows metadata + reminder history. `getComplianceDocSignedUrl` (`actions.ts:227`): active-org pinned read (fixes a prior cross-tenant gap `:235-242`), `storagePathBelongsToOrg` check, 60s signed URL via service-role. Fallback `downloadAction` redirects to a fresh link.
  4. **Delete.** Owner/admin (in-code gate because storage remove uses service-role). Count-gated delete gates the storage removal — no-op never orphans/false-successes. Audited.
  5. **Expiry reminders (referenced, external).** Rows with `expires_at` pinged by the daily compliance-expiry cron at 30d/7d/today; `reminded_*_at` columns on detail.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Status |
|---|---|---|---|---|---|
| + Add document | Header | → `/compliance/new` | — | Upload form | IMPLEMENTED, NOT LIVE-VERIFIED |
| Kind pills (All + 5) | Nav | sets `?kind=` | — | Filtered list | IMPLEMENTED, NOT LIVE-VERIFIED |
| View | Card | → `/compliance/{id}` | — | Detail | IMPLEMENTED, NOT LIVE-VERIFIED |
| Delete | Card & detail | `deleteComplianceDocument` (owner/admin) | — | Row + blob removed | IMPLEMENTED, NOT LIVE-VERIFIED |
| Type/Expiry/Title/Notes/File | Upload form | schema fields | kind, title, file; ≤25MB; allowed mime | — | IMPLEMENTED, NOT LIVE-VERIFIED |
| Upload document | Form submit | `uploadComplianceDocument` | valid file + title | Stored + row + audit | IMPLEMENTED, NOT LIVE-VERIFIED |
| Open document | Detail | opens 60s signed URL | — | File opens | IMPLEMENTED, NOT LIVE-VERIFIED |
| Get download link | Detail (fallback) | `downloadAction` → redirect to signed URL | — | File opens | IMPLEMENTED, NOT LIVE-VERIFIED |

---

## Weather

### Page: Weather — route `/weather`
- **Status:** **PLACEHOLDER / COMING SOON — deliberately DARK (built, provider-gated OFF).** This is the expected and correct state. Renders **no weather data at all** by design (safety-adjacent; a fake forecast is a hazard, `page.tsx:29-39`). The decision/threshold layer is real and tested; the data pipeline is dark.
- **Gating — exact mechanism (verified).** Not a `FEATURE_*` nav flag — the nav item is simply ADMIN_ROLES (`nav-model.ts:157`), always reachable. Darkness is computed by `getWeatherReadiness()` in `lib/weather/readiness.ts`. `available` is false in **every** environment and can never be true without both `providerImplemented` AND `districtResolutionAvailable` (verified `readiness.ts:35,41,45`; reads `process.env` directly, `:54`):
  - **Provider adapters (build-time):** `open-meteo` = implemented (Train 7 adapter); `metoffice` = not implemented. (`PROVIDER_IMPLEMENTED`)
  - **Env vars (the real gate):** `WEATHER_PROVIDER` (selection) + the vendor credential — `OPEN_METEO_API_KEY` or `MET_OFFICE_API_KEY`. The credential is the commercial-licence gate a human must open; **no credential is set in any environment**, so `available` stays false.
  - `districtResolutionAvailable` is TRUE (~2,900 ONSPD-derived district centroids).
  - A `strandedCredentialRisk` warning (red box) fires if a credential is set for a vendor whose adapter does not exist.
- **Roles:** ADMIN_ROLES (nav). Page `requireOrgContext()`. STRICTLY READ-ONLY — no form, no server action, no mutation (`page.tsx:66`).
- **Purpose:** The eventual "can the weather let the work happen" surface. Today: an honest readiness/status page plus genuinely useful reference content (the thresholds and their legal/standard provenance).
- **What the user sees:** "Weather" header; a **Status panel** (Active/Not configured badge — always "Not configured"; a 4-fact grid: thresholds built=Ready, provider=Missing/None connected, location lookup=Ready with district count, weather data held=None; an "Outstanding to activate" blockers list; attribution). A **Locations being watched** panel (empty — nothing creates watches yet; reads `readWeatherWatches`). A **"The limits CrewFlow will apply"** table per work type (concrete/lifting/roofing/groundworks/external) with condition, limit (m/s + mph), Stop-work/Review severity, and source — rows on a CrewFlow default (vs BS/ISO/reg) badged; fully-unsourced work types flagged. An **advisory-only** CDM/Work-at-Height/LOLER disclaimer. A **"What this becomes when connected"** prose panel (deliberately prose, not a greyed mock).
- **Features:**
  1. **Readiness/status (real, dark).** `getWeatherReadiness({hasActiveWatches})` folds runtime watch signal into readiness so `available` can't be true with nothing to fetch. Read-only (`readWeatherWatches`). No AI, no provider call.
  2. **Thresholds reference (real, useful with no provider).** Static data from `lib/weather` (`WORK_TYPE_THRESHOLDS`, `ALL_THRESHOLDS`, `isSourced`), with per-row provenance.
  3. **Watch list (empty by design).** Reads org watch config; nothing creates watches yet.
- **Buttons & controls:** None. No buttons, forms, selectors, or actions — entirely read-only display. (Only an inline `<code>` text reference to `docs/weather/provider-options.md`.)

---

## DOMAIN SUMMARY

**Counts.** 13 nav children covering **25 distinct pages/routes audited** (incl. 5 implemented-not-in-nav sub-pages and the implemented-not-in-nav worker-links subtree). ~21,000 lines of route code read across the domain.

**Pages by nav group:** Health & safety (register, new, [id], permits register, permit new, permit [id], worker-links) = 7; Toolbox (register, new, [id], [id]/edit) = 4; Diary (register, new, [id], [id]/edit) = 4; Snags (register, new, [id], [id]/edit) = 4; Quality (register, new, [id], ncrs, ncrs/new, ncrs/[id], templates, templates/[id]) = 8; Delays (register, new, [id]) = 3; Site reports (register + lifecycle) = 1 family; Drawings = 1; Documents = 1; Site compliance (hub, [siteId]) = 2; Compliance (register, new, [id]) = 1 family; Weather = 1.

**Status tally (page-level verdicts):**
- **LIVE & WORKING:** 1 (`/blueprints` as a routing/index surface, corroborated by the job-scoped markup subsystem).
- **IMPLEMENTED, NOT LIVE-VERIFIED:** 23 (the overwhelming majority — code-complete, not browser-confirmed because authed multi-role prod access is out of scope).
- **PLACEHOLDER / COMING SOON (deliberate dark):** 1 (`/weather`), plus the delay **weather-district corroboration** affordance (field works, backend dark).
- **PARTIALLY IMPLEMENTED:** 1 affordance (permits `?filter=` link from dashboard signals is a no-op).
- **BROKEN:** 0.
- **FLAGGED OFF:** the diary auto-weather-suggest (dark via `isWeatherAvailable()`), which is the same provider gate as `/weather`.

**Hard-to-discover / implemented-not-in-nav:**
- `/health-safety/worker-links` — real feature, NO nav entry; reachable only via the register's inline sub-nav.
- `/quality/ncrs`, `/quality/ncrs/new`, `/quality/ncrs/[id]`, `/quality/templates`, `/quality/templates/[id]` — all absent from the nav model; reachable only via header buttons / item links on `/quality` (by design, as sub-surfaces).
- Blueprint markup/compare/pins live under `/jobs/[id]/blueprints/*`, one level below the `/blueprints` index — the nav keyword "markup" resolves there.

**Orphaned / dead:** None found. The permits `?filter=` link is a harmless no-op (lands on the unfiltered register), not dead code.

**Server actions / API with thin or no direct nav UI:**
- PDF/CSV API routes with no nav entry (reached via in-page buttons): `/api/health-safety/[id]/pdf`, `/api/health-safety/permits/[id]/pdf`, `/api/health-safety/toolbox-talks/[id]/pdf`, `/api/quality/[id]/pdf`, `/api/delays/[id]/notice/pdf`, `/api/site-reports/[id]/pdf`, `/api/site-compliance/[siteId]/muster/pdf`, `/api/site-compliance/[siteId]/muster/csv`. All `@react-pdf/renderer`/Node, active-org pinned, draft→409, `private, no-store`, subject-org letterhead.
- `/worker-portal/[token]` — the external consuming surface for worker-links (outside this domain's route list but it exists).

**Notable findings (for the caller):**
1. **No server-side role enforcement anywhere in this domain.** Every "admin" page uses `requireOrgContext()`, never `requireManagementContext()` (verified on health-safety, site-reports, compliance; same across the subtree). "Admin-only" = nav discoverability + table RLS + per-mutation owner/admin re-checks on destructive actions. A staff member typing an admin URL is not redirected. Reads depend entirely on RLS (not verified statically). **This is the one item worth escalating.**
2. **No AI exists in this domain at all.** The "auto-generated RAMS" is a deterministic in-repo template catalogue (`rams-templates.ts`), not an LLM. No governor, no feature flag, no dark AI call site — confirmed by grep across all 12 route groups.
3. **Weather is honestly dark, and by design (not a bug).** Gated by a readiness computation + a missing vendor credential env var (`OPEN_METEO_API_KEY`/`MET_OFFICE_API_KEY`), not a `FEATURE_*` flag; `available` is false in every environment and can never be true without an implemented adapter. The diary weather-suggest and the delay weather-district corroboration share the same gate. The page refuses to fake a forecast (safety-correct).
4. **Strong evidence/immutability posture.** RAMS, permits, toolbox talks, ITP plans, NCR corrective actions, delay events and site reports all use draft→issued/recorded freeze via DB triggers + RPC-allocated references + append-only acknowledgements/sign-offs. Immutability is enforced by status-transition triggers and append-only tables, NOT by a stored `content_hash` digest on the H&S document tables (the SHA-256 usage found is the signature-PNG path discipline and the worker-token hash). ITP sign-off evidence is byte-immutable (migration 20261033).
5. **Signature capture is service-role + hardened.** Drawn signatures go to private `signatures` bucket via the admin client with magic-byte sniffing, size cap, org-first keys, `storagePathBelongsToOrg` re-checks, and 60s signed URLs. Best-effort by contract — a storage failure never blocks a sign-off. This is the only service-role usage in most of these domains; H&S table reads/writes are tenant-client/RLS.
6. **Offline writes are real (diary, snags, delays, site-reports).** Online and queued writes share ONE server write-core (validation, RLS, cross-org guard, idempotency key, audit); edits use a server-side 3-way merge. Photos/evidence pickers are withheld offline. The online edit paths are last-write-wins (baseVersion merge applies only to the queued replay).
7. **Two notifications-adjacent side-effects, both guarded.** Site-report **publish-to-portal** sends a customer email (scoped link only, recipient from the report's own customer, best-effort, never rolls back). Quality **witness invitations** send NO email — contacting the witness stays manual. No SMS anywhere.
8. **One completeness divergence:** `/compliance` list uses a hard `.limit(500)` rather than the F-1 `fetchAllRows` pagination used by site-reports/documents/blueprints/worker-links — the exact completeness-cap class the sibling pages were fixed for. Low risk per org, worth flagging.
9. **One minor no-op:** dashboard H&S signals link to `/health-safety/permits?filter=expired|expiring`, but the permits register reads no `filter` param — the link lands unfiltered (harmless).
10. **Weather and sign-off panels are the only places a worker without a login participates** (worker-links portal + authenticated operative sign-off on RAMS/permits/toolbox). Required-operative denominators come from crew rota'd to the job (`rota_entries`); honest "Not tracked" when no job link — the product never invents a sign-off obligation.
