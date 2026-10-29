# CrewFlow — Security, Functionality & Production-Hardening Program

**Durable progress tracker (resumable across sessions).** This is the single spine for the
multi-phase hardening program authorised 2026-10-28. Update it as each finding moves
from OPEN → FIXING → IN-REVIEW → MERGED → PROD-VERIFIED. Detailed evidence lives in
`docs/hardening/findings/` and the Phase-12 deliverables; this file is the index + status.

---

## Phase 0 — Authoritative baseline (locked 2026-10-28)

| Item | Value |
|---|---|
| Production SHA | `aedb9279` (PR #946) — `/api/health` → `ok/healthy`, db `ok`, crons fresh (0 min) |
| Local analysis tree | `/Users/moetalibi/Code/web-main` synced to `origin/main` = `aedb9279` |
| Migration tip | `20261240000000` (399 migrations) |
| Comms | email ✅ · whatsapp ✅ · sms ❌ · missed-call-textback not ready |
| Dark (intended) | weather, analytics/PostHog (client+server off), local AI, voice inbound, outreach auto-send, bulk sourcing import |
| Billing | configured, webhook configured, selfServe `false` |
| Monitoring | Sentry enabled + SDK integrated |
| Open PRs (not this program) | #919 dependabot bundle; #903 draft local-AI; #842–845 stale dependabot bumps |
| Encyclopaedia | `docs/audit/` 17 files — PRESERVED, not overwritten; corrections go in `docs/hardening/` |

**DB/worktree ops reminder:** `supabase db query/push --linked` runs from `~/Code/web` (the linked
worktree), NOT `web-main`. Source read/edit happens in `web-main`. `main` branch itself is checked
out at `~/Code/web-mkt`; this worktree is detached at the `aedb9279` content — create fix branches
explicitly with `git checkout -b`.

---

## Guard contract (ground truth — verified in code)

- `requireOrgContext()` — any signed-in member of active org; anon → `/login`. (`server/auth/session.ts`)
- `requireManagementRole(ctx)` / `requireManagementContext()` — owner/admin; page redirect `/dashboard?error=forbidden`.
- `requireManagementApi()` — owner/admin; else 403 JSON.
- `requireHqPage()` / `requireHqApi()` — env super-admin allowlist (`isSuperAdminEmail`); anon→`/login`, non-superadmin→404. (`server/auth/hq.ts`)
- Roles: **owner, admin, staff** only. `ADMIN_ROLES=[owner,admin]`. Nav gating = presentation only; RLS = last line.

---

## Severity model

- **P0** — cross-tenant read/write, public server-secret exposure, super-admin priv-esc, critical data leak.
- **P1** — staff→management privilege gain (mutation), unauthorised financial/payroll op, broken session enforcement, serious data-integrity defect.
- **P2** — broken important workflow, missing authorisation defence-in-depth (RLS still holds), incomplete business-critical integration, significant mobile failure.
- **P3** — minor UI/label/secondary-action defects.

Each finding is also tagged **CLEAR** (intended policy obvious → fixable under standing merge authorisation)
or **AMBIGUOUS-NEEDS-CEO** (intended access genuinely unclear → documented, held for explicit decision).

---

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Baseline | ✅ DONE |
| 1 | Auth/authz (routes, RBAC, IDOR/priv-esc) | ✅ ANALYSED — P0=0, P1=0. Member-floor universal. Quote CRUD actions all management-gated (residual refuted). Gaps: 1 latent authz (billing), 1 dark authz (quote-writer), + AMBIGUOUS policy class. |
| 2 | Secrets & data exposure | ✅ CLEAN — 0 exposures (gitleaks CI SHA-pinned full-history; boundary verified; 26 NEXT_PUBLIC all expected-public). Info: install gitleaks locally. |
| 3 | Feature functionality audit | ✅ DONE — FEATURE-FUNCTIONALITY-AUDIT.md: **0 broken/misleading controls** (evidenced); dark surfaces honestly flagged-off; 9 orphan handlers (plumbing, not dead buttons). Code-level only; live = Phase 8. |
| 4 | Incomplete/disconnected functionality | ✅ verified at code level (FN-01/02/03; no misleading controls; held PII/financial/GPS builds for CEO) |
| 5 | Feature flags / AI / providers | ✅ DONE — FEATURE-ACTIVATION-MATRIX.md: 7 Class-A / 0 Class-B / 6 Class-C / 20 Class-D. AI safety confirmed (£100 ceiling, 0 ungoverned entry points, autonomous-apply triple-locked off). Flag: WhatsApp outbound ON in prod (see OPS-01). |
| 6 | HQ super-admin security | ✅ ANALYSED — P0=0 (no non-superadmin reach; impersonation unforgeable). 1×P1 (demo-promote no confirm), 1×P2 (39/81 pages layout-gate-only), 2×P3. Memory-purge already hardened. All CLEAR. |
| 7 | DB / RLS / backend | ✅ ANALYSED — 0 confirmed-reachable P0/P1. ~190 SECDEF all guarded; 421 admin-client sites 0 IDOR; grants clean; signed-URLs clean. 1×P2 + 2×P3 theoretical/DiD coverage. |
| 8 | End-to-end authenticated browser testing | ✅ NOT BLOCKED — harness seeds owner/staff/HQ on LOCAL stack; **PR #949** adds role-access boundary spec (staff→/me on /quotes+/invoices; owner→404 on /admin) |
| 9 | Automated security & quality gates | 🔄 existing 9-check CI green on fix PRs (typecheck/lint/unit/integration/security/e2e/gitleaks/Vercel) |
| 10 | Fix / review / merge / deploy | 🔄 PRs #947 (SEC-02/03), #948 (SEC-01), #949 (Phase-8) IN-REVIEW — merge on CEO approval |
| 11 | Independent second-pass verification | ⬜ QUEUED (after merges) |
| 12 | Final deliverables | 🔄 tracker + 4 findings + 2 deliverables-in-progress; security/permissions/readiness docs next |

---

## Remediation register

Columns: ID · Sev · CLEAR/CEO · Title · Evidence · Status.

### No P0 anywhere. Security spine verified strong (0 cross-tenant, 0 secret exposure, 0 HQ priv-esc, impersonation unforgeable, quote CRUD all management-gated, memory-purge already hardened).

| ID | Sev | Policy | Title | Evidence | Status |
|---|---|---|---|---|---|
| SEC-01 | P1 | CLEAR | Demo→customer promote has no confirmation interstitial (creates real auth user+org+invite email; HQ-only, audited, idempotent) | `app/admin/demos/_detail-panel.tsx:180,377`, `_kanban.tsx:75`, `demos/actions.ts:99` | **IN-REVIEW PR #948** (server token both actions + 2-step confirm UI; 92/92) |
| SEC-02 | P2 | CLEAR | Billing page renders subscription+SaaS invoices to any member; no early management gate (latent — activates with self-serve billing) | `app/(app)/settings/billing/page.tsx:54-68` | **IN-REVIEW PR #947** (→requireManagementContext) |
| SEC-03 | P2 | CLEAR | AI quote-writer (generate/apply/discard) requires only member, not management — unlike all other quote actions (dark feature) | `server/services/ai-quote-writer.ts:436,617,667` | **IN-REVIEW PR #947** (requireManagementRole on 4 entrypoints; sec 52/52) |
| SEC-04 | P2 | CLEAR (DiD) | 39/81 HQ pages rely solely on layout gate; admin-client fetch runs before the 404 (no leak) | `app/admin/**/page.tsx` | OPEN |
| SEC-05 | P3 | CLEAR | 24 HQ server-action files reimplement the allowlist inline instead of a shared `requireHqAction()` | `app/admin/**/actions.ts`, `switch-to-customer/route.ts:33` | OPEN |
| SEC-06 | P2 | CLEAR (test) | Data-API grant guard only couples policy↔grant within the SAME migration; cross-file create→later-expose slips (fail-closed 42501, not exposure) | `__tests__/security/migration-data-api-grant-guard.test.ts:164` | OPEN |
| SEC-07 | P3 | CLEAR (test) | SECDEF `guarded` predicate is a body-string match; add new client-exec secdef-uuid fns to the anon-denied effect probe | `__tests__/integration/rls/secdef-org-rpc-guard.test.ts` | OPEN |
| POLICY-01 | P2 | ✅ DECIDED→mgmt | Operations area staff-denied (founder policy); lock to management | GAP-1 | R4/R5 per-action (mixed-domain finding) |
| POLICY-02 | P2 | ✅ DECIDED→mgmt | Site & Safety admin registers staff-denied — domain MIXED (operative sign-off is staff field) | GAP-2 | R5 per-action + founder field-flow ruling |
| POLICY-03 | P2 | ✅ DONE | Inbox customer-comms staff-denied → SHIPPED | GAP-3 | **IN-REVIEW PR #951** (page+actions) |
| POLICY-04 | P2 | ✅ DECIDED→mgmt | `recordSupplierBill` + template publish/archive member-writable → management | GAP-7 | R4/R5 per-action |
| PERM-00 | — | — | **Founder role architecture 2026-10-28** → `ROLE-PERMISSIONS-IMPACT-ASSESSMENT.md`; detailed R3–R5 plan + ownership-transfer design → `ROLE-PERMISSIONS-R3-R5-PLAN.md`. Prod 1 owner/0 admins/0 staff ⇒ near-zero lockout. Phases R1(inbox, done)→R2(admin capability M1)→R3(owner-only+UI+transfer-design)→R4(swap 163 gates)→R5(staff assigned-jobs M2–M5). | findings/05,06 | R1 #951; **R2 #952 (migration apply HELD for approval)**; R3–R5 planned, await approval |
| PERM-R2 | — | ✅ built | Admin capability foundation: `membership_permissions`+`permission_audit`+`can()`+audit+backfill. Additive/DARK (no enforcement swap). Independent security review PASS (no self-escalation). unit13/security18/integration green. | mig `20261241000000` | **IN-REVIEW PR #952** — migration apply needs founder OK |
| PERM-FIND-1 | P2 | note | ~100 server actions across Operations+Site&Safety are member-writable today (`requireOrgContext` only). Not a live exploit (0 staff) but the partial-enforcement surface the new policy closes in R4/R5 | findings/05 | tracked |
| FN-01 | P3 | **CEO** | `upsertStaffNiNumber` orphan — NI-number WRITE path has zero callers/UI repo-wide (sensitive PII). Build an authorised admin-only entry flow, or remove the dead helper? | `lib/staff/secrets.ts:81` | HELD (don't build PII UI unilaterally) |
| FN-02 | P3 | **CEO** | `deleteFuelLog` built+tested (org-scoped, count-gated) but has no UI caller. Hard-delete of a cost record vs write-once-immutability — wire a delete control, or remove the action? | `app/(app)/fleet/fuel-actions.ts:133` | HELD |
| FN-03 | Info | — | Clock-in accepts/stores `gps_lat/gps_lng` but NOTHING captures geolocation (no `navigator.geolocation` in tree) → no silent location collection. Leave dormant; don't build capture without product+privacy sign-off. | `app/(app)/me/actions.ts:27-67` | DOCUMENTED (no action) |
| FN-04 | P3 | **CEO** | 9 orphan server actions (zero callers, plumbing — NOT dead buttons): `assignTicket` (HQ support-assign, no UI — worst), `assignAlert`, `updateNoteAction` (HQ notes show "edited" but content can't be edited), `researchExistingCompanyAction`, `movePinAction`, `overrideColumnMapping`, `supersedeRiskAssessment`, + FN-01/02. Wire or remove per product intent. | `app/admin/support/actions.ts:321` + 8 others | HELD |
| OPS-01 | P2 | **CEO/OPS** | WhatsApp **outbound** is ON in prod (both switches live) vs otherwise-dark posture; matches the 2026-10-19 activation attempt, narrowed by founder recipient allowlist, but NOT production-proven (Meta 0 POSTs, verify-token drift). Confirm allowlist set in prod + resolve Meta block, OR re-darken until proven. | `lib/telephony/config.ts`, `/api/health comms.whatsapp` | HELD (not a code defect) |

---

## Deliverables (Phase 12)

- `docs/hardening/SECURITY-AUDIT.md`
- `docs/hardening/PERMISSIONS-MATRIX.md`
- `docs/hardening/SECRETS-EXPOSURE-AUDIT.md`
- `docs/hardening/FEATURE-FUNCTIONALITY-AUDIT.md`
- `docs/hardening/FEATURE-ACTIVATION-MATRIX.md`
- `docs/hardening/REMEDIATION-TRACKER.md` (this file)
- `docs/hardening/E2E-VERIFICATION-REPORT.md`
- `docs/hardening/FINAL-PRODUCTION-READINESS.md`

## Approval-gated actions (will STOP and ask)
Destructive prod DB changes · credential rotation · enabling customer-facing AI autonomy · enabling paid
providers (new recurring cost) · billing-behaviour changes · mass comms · sensitive permission-policy changes
where intended access is **AMBIGUOUS** · any irreversible/materially customer-impacting action.
Standing authorisation covers: safe reviewed code fixes via branch→PR→green CI→squash-merge, and
non-destructive verification.
