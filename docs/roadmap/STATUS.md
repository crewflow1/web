# CrewFlow — Live Roadmap Status (programme control plane)

> **This file is the control plane for autonomous roadmap execution.** Every
> release train updates it. Statuses are evidence-based: `PRODUCTION` means
> merged **and** migrated **and** deployed **and** verified — not "code exists".

**Last reconciled:** 2026-07-27 (Train 4 + CIS M1 shipped)
**Production `main`:** `3f5ffb1`
**Production migration tip:** `20261046`
**Providers:** email **live**; SMS, WhatsApp, voice, Stripe **dark** (deliberate — activation needs CEO/cost/legal approval)

## Status vocabulary

| Status | Meaning |
|---|---|
| `PRODUCTION` | merged + migrated + deployed + smoke-verified |
| `BUILT-DARK` | in production code but provider/flag-gated off |
| `BUILT/READY` | complete + CI-green on a branch, not merged |
| `PARTIAL` | some slices shipped, named gaps remain |
| `FOUNDATION` | schema/seam exists, no user-facing vertical |
| `NOT BUILT` | no implementation |
| `SUPERSEDED` | replaced by a later implementation |

---

## Release train history

| Train | Date | Migrations | Contents | Result |
|---|---|---|---|---|
| **1** | 2026-07-26 | `20261038`, `20261039` | H2-CASH M1 billing plans (#426) + M2 cash visibility (#427) + M3 precise cash/forecast (#428 cumulative) + Daily Briefing (#425); dashboard retention pagination (#429) | `ed748b5` → `82cb5b7`, verified |
| **2** | 2026-07-27 | `20261040` | Customer/staff import correctness (#121, launch blocker) + org_id perf indexes (#128) | `82cb5b7` → `aa8b810`, verified |
| **4** | 2026-07-27 | `20261043`–`20261045` | **Train 4 — WhatsApp consolidated, ships DARK** (#433, supersedes #360/#361/#362): 3 version-colliding migrations renumbered · honest readiness (`outboundReady` can't be true without `senderImplemented`) · kill-switch gap closed at `getWhatsAppProvider()` | `dffd68a` → `9a633cd`, verified dark |
| **5** | 2026-07-27 | `20261046` | **CIS M1 — subcontractor domain + HMRC verification** (#434) | `9a633cd` → `266d9e9`, verified |
| **3** | 2026-07-27 | `20261041`, `20261042` | PWA offline-shell hydration **product bug** (#431) · company-logo private bucket with the storage regression stripped (#137) · launch-checklist runtime probe (#148) · address-first search (#136) | `aa8b810` → `636a794`, verified |

---

## PHASE 2 — WOW FEATURES

| Item | Status | Evidence |
|---|---|---|
| Blueprint Centre (viewer, pins, markup, compare, offline, PWA) | **PRODUCTION** | shipped via release train `#421`; `app/(app)/blueprints/**`, migrations `20261014`–`20261017` |
| Variation management (request → approve → quote/invoice → audit) | **PRODUCTION** | `quotes.variation_number`; `20260520180000_variation_orders.sql`; accepted-quote immutability `20261004` |
| Offline mode / PWA | **PRODUCTION** | `public/sw.js`, offline shell, logout purge, real-offline E2E |
| AI WhatsApp Assistant | **BUILT-DARK (inbound + outbound + receipts)** | consolidated in #433 (prod `9a633cd`); webhook returns 404 and `/api/health` reports `whatsapp:false` with the flag off — verified post-deploy. Activation needs `NEXT_PUBLIC_FEATURE_WHATSAPP=true` + `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (+ `WHATSAPP_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN` inbound) + per-org DB state |
| Native mobile apps (iOS/Android) | **NOT BUILT** | PWA is the current mobile strategy |

## PHASE 3 — AI OPERATING SYSTEM

| Item | Status | Evidence |
|---|---|---|
| AI Business Coach / Daily Briefing | **PRODUCTION** (deterministic) | `lib/briefing/compose.ts`, `server/services/briefing.ts`, `20261038_briefing_dismissals`; ranked money + safety signals, non-dismissible live breaches |
| AI Voice Receptionist | **BUILT-DARK (inbound engine)** | ~40 `lib/receptionist/conversation-*.ts` + ~30 `server/services/receptionist-*.ts` on main; Vapi telephony **NOT BUILT** (#113 superseded) |
| AI Quote Writer | **NOT BUILT** | needs an LLM key (provider decision) |
| AI Scheduler | **NOT BUILT** | deterministic constraint version is viable without a provider |
| AI Cashflow | **PARTIAL** | deterministic forecast shipped in H2-CASH M3 (`lib/commercial/cash-forecast.ts`): overdue / due / planned / unscheduled, honest certainty labels, no fake probability |

## PHASE 4 — SITE MANAGEMENT

| Item | Status | Evidence |
|---|---|---|
| RAMS / risk assessments | **PRODUCTION** | H&S epic M1–M6, migrations `20261018`+ |
| Permits to work | **PRODUCTION** | permit lifecycle + DB-authz parity |
| Toolbox talks | **PRODUCTION** | migrations `20261025`–`20261030` |
| Operative sign-off gate | **PRODUCTION** | required-operative model + missing-signoff visibility |
| H&S evidence PDFs + integrity | **PRODUCTION** | SHA-256 `content_hash`, write-once immutability, storage byte lockdown (`20261031`–`20261037`) |
| Snagging | **PRODUCTION** | `20260919000000_snags.sql` + full vertical: `app/(app)/snags/{page,new,[id],actions.ts}` (`createSnag`/`updateSnagStatus`/`reassignSnag`/`setSnagPriority`/`deleteSnag`), lifecycle open→in_progress→fixed→verified/wont_fix, photos via `tenant_attachments`, RLS isolation test, sidebar. **Verified 2026-07-27 — was wrongly marked PARTIAL; do NOT rebuild.** Gap: no job-page embed, no e2e spec |
| Daily site diary | **PRODUCTION** | `20260920000000_site_diary.sql` + full CRUD: `app/(app)/diary/{page,[id],[id]/edit,actions.ts,_form}`, `lib/site-diary/schema.ts`, photos via `tenant_attachments`, RLS isolation test, sidebar. **Verified 2026-07-27 — was wrongly marked PARTIAL; do NOT rebuild.** Gap: not surfaced on the job page; weather is free text (no provider) |
| Digital inspections + templates | **PRODUCTION** | inspections M4/M4b (immutable snapshots, scheduling) |
| Progress tracking | **PARTIAL** | `progress_percent` DOES ship inside `site_reports.content` (validated 0–100) and is surfaced to the customer portal. True gap: no job-level progress log / time series / S-curve |
| Weather intelligence + Extension-of-Time letters | **NOT BUILT** | needs a weather provider (free tiers exist) |
| Site timeline | **NOT BUILT (site)** | `lib/commercial/timeline.ts` is commercial-only; `server/services/spine-timeline.ts` is HQ-internal (service_role); asset timeline is asset-scoped. No unified operational timeline over diary+snags+inspections+toolbox+photos — all source tables exist, so this is a pure read/compose |

## PHASE 5 — FINANCE

| Item | Status | Evidence |
|---|---|---|
| Quotes → invoices → payments → allocation | **PRODUCTION** | `allocate_payment` RPC, per-invoice caps, idempotency |
| Retention (accrual, release schedule, moieties) | **PRODUCTION** | `lib/retentions/**`, `20261005`/`20261012`/`20261013` |
| Billing plans (deposit / staged / milestone) | **PRODUCTION** | `20261039_job_billing_plans` + `generate_stage_invoice` RPC |
| Precise cash position + forecast + portal payment schedule | **PRODUCTION** | H2-CASH M3: per-invoice retention attribution, `collectableNow`, org=Σjobs reconciliation |
| Purchase orders | **PRODUCTION** | Programme C slice 2 |
| Supplier invoices / committed costs | **PRODUCTION** | Programme C slice 3 |
| Profitability + VAT summary reporting | **PRODUCTION** | `lib/profitability/compute.ts`, dashboard/reports |
| Payroll (timesheets → PAYE lines) | **PRODUCTION** | `lib/payroll/compute.ts`, `payroll_lines` |
| **CIS — subcontractor domain + HMRC verification (M1)** | **PRODUCTION** | `20261046_cis_subcontractors` (#434): 1:1 extension on `suppliers` keyed `(org_id, supplier_id)`; real HMRC statuses (gross/20/30, `failed`→30); status↔rate CHECK using `is not distinct from`; admin-only RLS + masked UTR; manual verification + unimplemented `CisVerificationProvider` seam |
| CIS M2 — money-out ledger | **NOT BUILT — NEXT** | no money-out ledger exists (`payments`/`invoice_payments` are money-IN, carrying `customer_id`). CIS deducts **at payment**, so this is the load-bearing net-new engine. Slot `20261047` |
| CIS M3–M5 — deduction calc + reverse-charge VAT · monthly statements · HMRC seam | **NOT BUILT** | M3 must split labour vs qualifying materials (CIS never applies to materials or VAT); M4 clones the completion-certificate immutability/PDF stack; M5 stays DARK/BLOCKED_BY_PROVIDER |
| OCR / receipt scanning | **BUILT-DARK** | `server/services/expense-drafts.ts` calls `maybeExtractReceipt`; `expense_drafts.ai_confidence` exists; with no AI key the draft is created with NULL extraction fields. **Verified 2026-07-27 — was wrongly marked NOT BUILT.** Needs a provider key only |
| Expenses | **PRODUCTION** | `app/(app)/expenses/{page,new,[id],actions.ts}` with `uploadExpenseReceipt`/`approveExpenseDraftAction`/`rejectExpenseDraft`, `expense_drafts` table, sidebar. **Verified 2026-07-27 — was wrongly marked PARTIAL.** Budget tracking specifically remains NOT BUILT |
| Online invoice payment (Stripe) | **FOUNDATION (dark seam)** | `PaymentProvider` seam documented in `docs/billing-plans.md`; needs live creds + product decision |

## PHASE 6 — OPERATIONS

| Item | Status | Evidence |
|---|---|---|
| Assets + QR tags + labels | **PRODUCTION** | asset epic M3b/M4/M5 (scanner, QR, inspections, maintenance scheduler) |
| Maintenance schedules | **PRODUCTION** | idempotent scheduler |
| Plant/equipment → job allocation | **PRODUCTION** | `asset_assignments.assignment_type` already includes `allocated_to_job` + `loaded_on_vehicle`, with `job_id`, `vehicle_asset_id`, issue/return meter readings, condition + transfer lineage; surfaced at `app/(app)/jobs/[id]/_job-assets.tsx` |
| Fleet compliance (MOT / insurance / road tax / fuel) | **NOT BUILT** | Confirmed an **EXTENSION, not a fork**: `assets` already has `registration`, `ownership`, hire fields, `supplier_id`; `asset_service_schedules` is a generic date-cadence engine. Deltas: widen its `maintenance_type` CHECK to add mot/insurance/road_tax, add odometer to `assets`, add `asset_fuel_logs`. Inherits the existing scheduler/QR/custody engines |
| Stock / warehouse / material ordering | **NOT BUILT** | — |

## PHASE 7 — CUSTOMER EXPERIENCE

| Item | Status | Evidence |
|---|---|---|
| Portal: quotes, approval, e-sign accept | **PRODUCTION** | `app/q/[token]`, `acceptQuoteByToken` |
| Portal: invoices + paid/due/overdue + payment schedule + retention line | **PRODUCTION** | H2-CASH M2/M3 (customer-safe DTOs) |
| Portal: jobs, progress, photos, documents, reports, messages | **PRODUCTION** | `app/customer-portal/[token]/**` |
| Portal: completion certificates | **PRODUCTION** | certificate PDFs |
| Portal: payment proof upload | **PRODUCTION** | `portal_uploads` |
| Portal: variation approval | **PARTIAL** | variations are quotes, so the accept flow works; no dedicated variation UX |
| Portal: warranties, maintenance reminders, book future work | **NOT BUILT** | — |
| Online "Pay now" | **FOUNDATION (dark)** | Stripe decision pending |

## PHASE 8 — AI COMMUNICATION

| Channel | Status |
|---|---|
| Email | **PRODUCTION** (`RESEND_API_KEY` set) |
| SMS | **BUILT-DARK** (needs `TWILIO_ACCOUNT_SID`+`AUTH_TOKEN`+`SMS_FROM`) |
| WhatsApp inbound | **BUILT-DARK** (needs `NEXT_PUBLIC_FEATURE_WHATSAPP=true` + Meta creds) |
| WhatsApp outbound + read receipts | **BUILT/READY in #362 stack** (needs migration renumber + rebase) |
| Missed-call text-back | **BUILT-DARK** (needs flag + Twilio) |
| Voice (Vapi) | **NOT BUILT** (#113 superseded — design preserved, branch stale) |

> ⚠️ **Known trap:** `lib/comms/readiness.ts` probes `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`, but **no outbound sender exists on main**. Setting those vars today would flip `/api/health` to `whatsapp:true` while sending is still impossible. Do not set them before the #362 stack lands.

## PHASE 9 — INTELLIGENCE

| Item | Status |
|---|---|
| Deterministic commercial risk (overdue, retention due, unscheduled value, ready-to-invoice) | **PRODUCTION** (H2-CASH M3 + briefing) |
| Company health score | **PARTIAL** (`lib/ai/aggregates.ts` insights) |
| Subcontractor scoring, delay/labour/material prediction | **NOT BUILT** — must ship as *deterministic* metrics first, never labelled as prediction |

## PHASES 10–15 (ecosystem, AI workforce, HQ, automation, marketplace, global)

**FOUNDATION / NOT BUILT.** The AI-employee framework exists as a *framework only* (PR #163, unmerged; execution locked). HQ, automation engine, marketplace and multi-country are not started. Dependency-gated behind the product core — do not start to tick boxes.

---

## MIGRATION SLOT ALLOCATION (read before authoring any migration)

Production tip is **`20261042`**. Slots are pre-allocated to parallel workstreams so
two branches can never collide on a numeric prefix (Supabase keys migration identity
on that prefix — a collision is **invisible to git** because filenames differ):

| Slot | Owner | Status |
|---|---|---|
| `20261043` | Train 4 — `inbound_enquiries_provider_dedup` | **SHIPPED** |
| `20261044` | Train 4 — `widen_transport_channel_whatsapp` | **SHIPPED** |
| `20261045` | Train 4 — `whatsapp_read_receipt_status` | **SHIPPED** |
| `20261046` | CIS M1 — `cis_subcontractors` | **SHIPPED** |
| `20261047` | CIS M2 — `supplier_payments` (money-out ledger) | in flight |
| `20261048` | CIS M3 — deduction engine + reverse-charge VAT | reserved |
| `20261049` | CIS M4 — monthly statements | reserved |
| `20261050+` | **NEXT FREE** (e.g. fleet-as-asset-extension) | — |

Before pushing any migration, prove no duplicate prefixes:
`ls supabase/migrations | sed 's/_.*//' | sort | uniq -d` must print nothing.

## Next dependency-safe milestone per lane (evidence-based, 2026-07-27)

Each avoids `cis_*`, `supplier_payments`, `finances`, `lib/cis/*` and the receptionist/whatsapp suites:
- **LANE A — "Job Site Hub"**: ZERO new tables. Embed the existing diary + snags panels on the job page and compose a read-only site timeline over `site_diary_entries` + `snags` + `asset_inspections` + `toolbox_talks` + photos.
- **LANE B — "Fleet as an asset extension"**: one migration (slot `20261050+`, NOT 20261047 which CIS M2 holds) widening `asset_service_schedules.maintenance_type` to add mot/insurance/road_tax, plus odometer + `asset_fuel_logs`.
- **LANE C — "Deterministic Schedule Integrity"**: read-only conflict detector over `jobs` × `rota_entries` × `leave_requests` × `asset_assignments` (double-booked staff, unassigned imminent jobs, plant clashes, expiring competence) emitted as `composeBriefing` operations signals. **No migration, no provider.** A deterministic Scheduler is viable; an AI Quote Writer is not (pricing prose is generative — `DRAFT_PROVENANCES` shows the deterministic path is a degraded mode, not a product).

Note: the Observe→Draft→Approve→Execute substrate ALREADY EXISTS but is HQ-internal (`lib/drafts/`, `lib/approvals/state.ts` + its DB-trigger mirror in `20260730000000_hq_approvals.sql`, `app/admin/`). `server/services/expense-drafts.ts` proves the pattern ports tenant-side. Reuse it — do not build a second approvals engine.

## Completed this continuation (was: in-flight)

- **TRAIN 4 — WhatsApp consolidation (ships DARK).** Branch `feat/whatsapp-consolidated`
  off main. Verified: **#362 is the cumulative tip** containing #360+#361, and
  `directive/018-r6` **is already an ancestor of main** (so #359 inbound is LIVE and
  #360/#361 point at a dead base). Work: single merge of #362 → renumber the 3
  colliding migrations to `20261043/44/45` → **fix false readiness** in
  `lib/comms/readiness.ts` (env vars alone must not report WhatsApp ready when no
  outbound sender exists; split configured / credentialsPresent / inboundReady /
  outboundReady / enabled) → gates → push. **No provider activation.**
- **CIS M1 — subcontractor domain + verification.** Branch `feat/cis-m1-subcontractors`.
  Migration `20261046`. Composes on `suppliers` (the only entity with payable FKs);
  1:1 `cis_subcontractors` keyed `(org_id, supplier_id)`; UTR with regex CHECK;
  admin-only RLS + masking per the `staff_secrets` precedent; real HMRC statuses
  (gross / standard_20 / higher_30) with a status↔rate integrity guard; **manual
  verification workflow + provider seam — no faked HMRC calls**.

## Open PR ledger (post-Train-2)

| PR | Verdict | Action required |
|---|---|---|
| #148 launch-checklist runtime probe | **RECONCILE-THEN-MERGE** (next, best value/effort) | 1 trivial `next.config.ts` conflict; probe list still matches main's 9 paths 1:1; admin page is red in prod for no reason |
| #136 address-first search | **RECONCILE-THEN-MERGE** | 3 files conflict (jobs 5 hunks, leads 2, search 1); rename migration `20260706` → forward; check trgm index-name collision vs `20260709000000_scale_indexes.sql` |
| #137 company-logo upload | **RECONCILE-THEN-MERGE, STRIP MIGRATION** | ⚠️ its storage migration creates client-write policies on `storage.objects` — exactly what `20261032` lockdown removed. App already uploads via service-role, so keep **read policy only**. Also closes a live third-party-fetch surface (`app/q/[token]` renders raw `org.logo_url`) |
| #362 WhatsApp stack tip (contains #360+#361) | **IN FLIGHT** → `feat/whatsapp-consolidated` | migrations renumbered to `20261043/44/45`; replaces #360/#361/#362 |
| #360 / #361 | **fold into #362** | close as merged-via-stack after #362 lands |
| #113 Vapi telephony | **CLOSED (superseded)** — design preserved, branch discarded | 624 commits drift, Vercel failing, no integration/security/e2e gates, migration `20260630` collides with `organizations_rls_impersonation_aware`; design (phone_numbers → org → assistant → call) is NOT superseded — preserve it, discard the branch |
| #398 types regen | **CLOSED (obsolete)** | done — its migration was byte-identical to main's; regen was itself stale; loose-cast seams make it optional |
| #424 roadmap docs | **CLOSED** (superseded by this file, merged as #430) |

## Known risks / debt

1. **`e2e/pwa-offline.spec.ts:61` is flaky** (service-worker timing). Failed on #429 and #121, passed on retry both times with no code change. Retries were used only to *diagnose*, never as the definition of correctness — but the root cause must be fixed rather than tolerated (§23).
2. **Generated types are stale** (`lib/supabase/types.ts` lacks the newest ~6 tables). Mitigated by deliberate loose-cast seams. If regenerated, do it against the current tip with a narrow, justified scan exclusion.
3. **Observability gap** — Sentry has no DSN; `/api/health` reports `ok:true` without probing dependencies. A true launch blocker for founder-led launch.
4. **Object-level authz** — RLS is member-level; the manager gate is app-only for some commercial writes, so a staff JWT could direct-PostgREST write where the UI forbids it. H1-TRUST wave.
5. **GDPR / org teardown** — storage bytes orphan on org delete. Legal decision pending.
6. **Self-serve billing / trial expiry** — `orgHasActiveAccess` ignores `trial_ends_at`. Only blocks self-serve, not founder-led.

## Next build lanes (dependency-safe, in priority order)

- **LANE B — FINANCE / CIS + subcontractors** — biggest remaining UK-construction moat; no external provider needed; extends the existing commercial spine.
- **LANE A — SITE OPERATIONS programme** — verify snags/site-diary depth first, then complete one coherent vertical (diary + progress + photo evidence + snags + timeline + portal-safe progress).
- **LANE D — CUSTOMER EXPERIENCE** — variation approval UX + warranties/maintenance reminders.
- **LANE F — INTELLIGENCE** — deterministic company-health / commercial-risk scoring (honest labels only).
- **LANE C — OPERATIONS** — fleet/plant as an **extension of the existing asset model**.
