# CrewFlow — Feature Functionality Audit (Phase 3)

**Audit date:** 2026-10-28 · **Tree:** `/Users/moetalibi/Code/web-main` (origin/main, prod `aedb9279` baseline)
**Author:** QA director, Phase-3 functionality delta pass
**Scope:** High-value hunt for genuinely **broken or misleading user-facing controls** and **orphan plumbing**. This does **not** re-inventory every surface — the completed encyclopaedia in `docs/audit/` (17 files, ~985 control rows) already does that. This document records only the delta that matters for functionality.

---

## (a) Method + honesty note

**What was done (code-level, read-only):**
- Pattern sweep across `app/` + `components/` for every classic dead/misleading-control signature:
  `href="#"`, empty/no-op `onClick` (`() => {}`, `/* noop */`), hardcoded `disabled`, `TODO`/`FIXME`/`HACK`, `coming soon` / `not implemented`, `alert(`, empty `catch {}`, error-swallowing `.catch(() => …)`.
- **Orphan-action analysis:** enumerated every `export [async] function` in the 159 `"use server"` files (plus `lib/staff/secrets.ts`), then checked for any referencing file other than the definition. Candidates were then re-verified by exact-name grep and in-file reference count to eliminate false positives (the first-pass combined-regex greps produced two false "callers" — corrected below).
- **Broken-navigation check:** extracted every static internal `href`/`router.push`/`redirect`/`redirectTo` target, reduced to 117 distinct ≥2-segment static links + all first-segments, and resolved each against the route tree across all route groups (`(app)`, `admin`, `(marketing)`, `(public)`, `(site)`, `(auth)`).
- **Misleading-success check:** inspected the error-swallowing call sites and audited how success is signalled app-wide; checked mutations that discard their `error` result.
- Suspicious hits were **opened and read** to confirm. Only CONFIRMED items appear below.

**Honesty boundary (hard):** this is a **code-level** audit. A true **VERIFIED-WORKING** verdict requires authenticated, multi-role, in-browser click-through — that is **Phase 8**, not done here. Nothing below is asserted "working" because a handler exists; the default remains **IMPLEMENTED-NOT-LIVE-VERIFIED**, consistent with `docs/audit/CONVENTIONS.md`. The value of this pass is the **negative result** (the control surface is clean) plus the **orphan register**.

---

## (b) Status distribution across major domains

Counts are **not** re-tallied here; this is the qualitative distribution of each domain's controls against the legend. It reflects the `docs/audit/` classification plus the delta findings of this pass. Legend: **VERIFIED-WORKING** (needs Phase 8) / **IMPLEMENTED-NOT-LIVE-VERIFIED** (INLV) / **PARTIAL** / **FLAGGED-OFF** / **PROVIDER-BLOCKED** / **DEFERRED** / **BROKEN**.

| Domain | Dominant status | FLAGGED-OFF / PROVIDER-BLOCKED (honest "not available") | BROKEN | Orphan plumbing in domain |
|---|---|---|---|---|
| **Dashboard / Home / `/me`** | INLV | — | 0 | — |
| **Jobs** (`/jobs`, `/jobs/[id]` 8 tabs) | INLV | — | 0 | `movePinAction` (blueprint pin reposition) |
| **Sales / Quotes / Leads / Customers** | INLV | — | 0 | — |
| **Money / Finance** (invoices, payments, expenses, costs, CIS, tax, reports, insights) | INLV | AI insights narrative = governed/metered; billing **self-serve switch OFF** (`settings/billing`) | 0 | — |
| **Site & Safety** (RAMS, permits, toolbox, diary, snags, quality, delays/EOT) | INLV | — | 0 | `supersedeRiskAssessment` (redundant — supersession is automatic via issue-revision) |
| **People / Payroll** (staff, rota, leave, payroll) | INLV | payroll = estimates (no employer NI/pension — documented elsewhere) | 0 | `upsertStaffNiNumber` |
| **Operations** (assets, fleet, stock, materials, sites, suppliers, POs) | INLV | — | 0 | `deleteFuelLog` (fleet fuel) |
| **Settings / Onboarding / Account** | INLV / FLAGGED-OFF | **webhooks delivery = dark** ("Coming soon", honest — `settings/webhooks`); integrations/accounting/calendar lanes credential-gated; data-retention GDPR-erase gated | 0 | `overrideColumnMapping` (imports column-map override) |
| **Portals** (`/q`, `/customer-portal`, `/worker-portal`) | INLV | — | 0 | — |
| **HQ** (`/admin/*`) | INLV | voice/AI-receptionist telephony, outreach auto-send, analytics/PostHog, local AI, bulk sourcing — all **dark by design**; SMS not configured | 0 | `assignAlert`, `assignTicket`, `researchExistingCompanyAction`, `updateNoteAction` |

**Flagged-off surfaces are honest.** Where a capability is dark it renders a truthful "not available / coming soon" state (e.g. `settings/webhooks/page.tsx:90` renders a "Coming soon" card and the whole delivery path is intentionally absent; `settings/billing/page.tsx:166` states self-serve switching is coming soon). These are **FLAGGED-OFF / PROVIDER-BLOCKED**, not defects.

---

## (c) CONFIRMED broken / misleading controls

**None found.**

After a full sweep of the standard failure signatures, there are **zero** confirmed broken or misleading user-facing controls on `main`. The evidence for the negative result:

| Vector hunted | Result | Evidence |
|---|---|---|
| `href="#"` dead links | 0 | no matches in `app/` or `components/` |
| Empty / no-op `onClick` (`() => {}`, `noop`) | 0 | no matches |
| `alert()` stand-in handlers | 0 | no matches |
| `TODO` / `FIXME` / `not implemented` in UI | 0 user-facing | only honest "coming soon" (dark webhooks, billing self-serve) + an intentional GDPR-scope note (`app/api/gdpr/export/route.ts:24`) |
| Empty `catch {}` swallowing errors | 0 | the only `catch {}` text found is a **defensive comment arguing against** the anti-pattern (`jobs/[id]/blueprints/_pdf-viewer.tsx:121`) |
| Hardcoded `disabled` with no enable path | 0 | all `disabled` hits are standard placeholder `<option value="" disabled>` prompts |
| Error-swallowing `.catch(() => {})` masking a primary write | 0 | every instance sits on a **best-effort audit-log / notification side-effect** that runs *after* the primary DB write and before the real `formSuccess` (e.g. `suppliers/[id]/payments/actions.ts:165`, `quality/actions.ts:179` — both `recordAdminActivity(...).catch(() => {})`); `res.json().catch(() => ({}))` is the standard safe-parse idiom |
| Mutations that discard their `error` result (silent-failure → false success) | 0 user-facing | only 4 lines, all in `server/services/whatsapp-media-pipeline.ts` writing a `status:"failed"` row inside an error path (dark channel) |
| Broken navigation (link → non-existent route) | 0 | all 117 distinct static ≥2-segment links + every first-segment resolve to a real `page.tsx`/`route.ts` |
| Optimistic success with no server call | 0 | app signals success via server-returned `FormState`/`formSuccess`, not client toast/optimistic state — structurally resistant to this class |

**Why this is credible rather than a missed pass:** success is server-driven (no `toast.success`/`setSuccess` optimistic layer exists), reads are held to a fail-loud contract (`lib/supabase/read-failure.ts`), and the repo carries the scars of multiple prior hardening waves (loud-reads, active-org pins, data-API grant guards). The control surface being clean is consistent with that history, not surprising.

---

## (d) Orphan plumbing (exported server actions with NO caller anywhere)

These are **dead/undialled backend actions**, not broken buttons. Each was confirmed by exact-name grep returning **only the definition file** and an in-file reference count that excludes internal callers. Per the Phase-3 brief these are listed separately and must **not** be reported as "broken controls." Several indicate an **honestly-absent feature** (the backend exists, no UI wires it, and crucially **no dead button is shown** for it) rather than a half-built one.

| # | Orphan action | File:line | What it would do | Reality in UI | Note |
|---|---|---|---|---|---|
| 1 | `assignTicket` | `app/admin/support/actions.ts:321` | Assign/unassign an HQ support ticket (real DB update + redirect `?saved=assign`) | `/admin/support/[id]` wires status / priority / category / reply-draft forms but **no assign form** | Feature absent, no dead button |
| 2 | `assignAlert` | `app/admin/alerts/actions.ts:282` | "Owner pickup" — set `admin_alert_state.assigned_to` | No caller in alerts UI | Feature absent |
| 3 | `updateNoteAction` | `app/admin/notes/actions.ts:182` | Edit an HQ internal note's content | Notes UI wires create / pin / archive / unarchive — **no edit control**; page shows an "edited {date}" label (bumped by pin/archive) but note *content* cannot be edited | Feature absent; "edited" label is mildly optimistic but not a control defect |
| 4 | `researchExistingCompanyAction` | `app/admin/research/actions.ts:75` | Re-run research on an existing sales company | No caller | Feature absent (HQ sales, dark-adjacent) |
| 5 | `movePinAction` | `app/(app)/jobs/[id]/blueprints/pin-actions.ts:54` | Reposition a blueprint pin (wraps `movePin`) | `_pins-ui.tsx` imports place/link/delete pin actions but **not** move | Pins are place/delete only in UI; backend reposition unused |
| 6 | `overrideColumnMapping` | `app/(app)/imports/actions.ts:1175` | Manually override a CSV import column mapping | No caller | Feature absent |
| 7 | `supersedeRiskAssessment` | `app/(app)/health-safety/actions.ts:242` | Manually mark a RAMS record superseded | No caller — supersession happens **automatically** when a new revision is issued (`issue_rams_revision`, mig 20261022); UI exposes issue-revision + withdraw, not manual supersede | **Redundant**, not missing — safe to delete |
| 8 | `deleteFuelLog` | `app/(app)/fleet/fuel-actions.ts:133` | Delete a fleet fuel log | No delete control in `fleet/fuel` UI | Previously known; confirmed still orphan |
| 9 | `upsertStaffNiNumber` | `lib/staff/secrets.ts:81` | Upsert a staff member's NI number (sensitive column) | No caller | Previously known; confirmed still orphan |

**Recommendation (not actioned — no code changes in this pass):** #7 is dead-redundant and can be removed; #1/#3/#5 represent small, genuinely-missing UI affordances (assign ticket, edit note body, reposition pin) that would be cheap to wire if product wants them; #2/#4/#6/#8/#9 are unexercised backend endpoints — either wire a control or drop the export to reduce attack surface. None is user-visible as a broken button today.

---

## Bottom line

- **CONFIRMED broken/misleading controls: 0.** The user-facing control surface on `main` is clean against every standard failure signature. This is a negative result stated plainly, not an invented defect list.
- **Orphan handlers: 9** (`assignTicket`, `assignAlert`, `updateNoteAction`, `researchExistingCompanyAction`, `movePinAction`, `overrideColumnMapping`, `supersedeRiskAssessment`, `deleteFuelLog`, `upsertStaffNiNumber`) — dead/undialled backend, each confirmed definition-only, none surfaced as a dead button.
- **Residual caveat:** VERIFIED-WORKING still requires Phase 8 authenticated browser testing; this pass certifies the *code-level* control surface only.
