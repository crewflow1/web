# CrewFlow — Live Roadmap Status (programme control plane)

> **This file is the control plane for autonomous roadmap execution.** Every
> release train updates it. Statuses are evidence-based: `PRODUCTION` means
> merged **and** migrated **and** deployed **and** verified — not "code exists".

**Last reconciled:** 2026-07-27
**Production `main`:** `aa8b810`
**Production migration tip:** `20261040`
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

---

## PHASE 2 — WOW FEATURES

| Item | Status | Evidence |
|---|---|---|
| Blueprint Centre (viewer, pins, markup, compare, offline, PWA) | **PRODUCTION** | shipped via release train `#421`; `app/(app)/blueprints/**`, migrations `20261014`–`20261017` |
| Variation management (request → approve → quote/invoice → audit) | **PRODUCTION** | `quotes.variation_number`; `20260520180000_variation_orders.sql`; accepted-quote immutability `20261004` |
| Offline mode / PWA | **PRODUCTION** | `public/sw.js`, offline shell, logout purge, real-offline E2E |
| AI WhatsApp Assistant | **PARTIAL — inbound BUILT-DARK, outbound in open PR** | inbound webhook + handler + conversation engine on main (`app/api/webhooks/whatsapp/route.ts`), gated by `NEXT_PUBLIC_FEATURE_WHATSAPP=false`; outbound sender + read receipts only in #360/#361/#362 |
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
| Snagging | **PARTIAL** | `20260919000000_snags.sql` exists — needs verification of UI/workflow depth |
| Daily site diary | **PARTIAL** | `20260920000000_site_diary.sql` exists — needs verification of UI/workflow depth |
| Digital inspections + templates | **PRODUCTION** | inspections M4/M4b (immutable snapshots, scheduling) |
| Progress tracking | **PARTIAL** | job status + photos exist; no dedicated % / S-curve |
| Weather intelligence + Extension-of-Time letters | **NOT BUILT** | needs a weather provider (free tiers exist) |
| Site timeline | **PARTIAL** | `lib/commercial/timeline.ts` is commercial-event only |

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
| **CIS automation + reverse-charge VAT + subcontractor commercial** | **NOT BUILT** | **highest-value remaining UK-construction moat** |
| OCR / receipt scanning | **NOT BUILT** | needs an OCR provider |
| Expenses + budget tracking | **PARTIAL** | `finances` table carries costs; no dedicated expense workflow |
| Online invoice payment (Stripe) | **FOUNDATION (dark seam)** | `PaymentProvider` seam documented in `docs/billing-plans.md`; needs live creds + product decision |

## PHASE 6 — OPERATIONS

| Item | Status | Evidence |
|---|---|---|
| Assets + QR tags + labels | **PRODUCTION** | asset epic M3b/M4/M5 (scanner, QR, inspections, maintenance scheduler) |
| Maintenance schedules | **PRODUCTION** | idempotent scheduler |
| Fleet / vehicles / MOT / insurance / fuel | **NOT BUILT** | should extend the **existing asset model**, not a new one |
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

## Open PR ledger (post-Train-2)

| PR | Verdict | Action required |
|---|---|---|
| #148 launch-checklist runtime probe | **RECONCILE-THEN-MERGE** (next, best value/effort) | 1 trivial `next.config.ts` conflict; probe list still matches main's 9 paths 1:1; admin page is red in prod for no reason |
| #136 address-first search | **RECONCILE-THEN-MERGE** | 3 files conflict (jobs 5 hunks, leads 2, search 1); rename migration `20260706` → forward; check trgm index-name collision vs `20260709000000_scale_indexes.sql` |
| #137 company-logo upload | **RECONCILE-THEN-MERGE, STRIP MIGRATION** | ⚠️ its storage migration creates client-write policies on `storage.objects` — exactly what `20261032` lockdown removed. App already uploads via service-role, so keep **read policy only**. Also closes a live third-party-fetch surface (`app/q/[token]` renders raw `org.logo_url`) |
| #362 WhatsApp stack tip (contains #360+#361) | **RECONCILE-THEN-MERGE (stay dark)** | renumber 3 migrations (`20260919/20/21` collide with `snags`/`site_diary`/`toolbox_talks` **by version, invisible to git**) → `20261041+`; rebase onto main; retarget base `directive/018-r6` → `main` (that branch is now an ancestor of main) |
| #360 / #361 | **fold into #362** | close as merged-via-stack after #362 lands |
| #113 Vapi telephony | **CLOSE-AS-SUPERSEDED, re-cut** | 624 commits drift, Vercel failing, no integration/security/e2e gates, migration `20260630` collides with `organizations_rls_impersonation_aware`; design (phone_numbers → org → assistant → call) is NOT superseded — preserve it, discard the branch |
| #398 types regen | **CLOSED (obsolete)** | done — its migration was byte-identical to main's; regen was itself stale; loose-cast seams make it optional |
| #424 roadmap docs | **superseded by this file** | close or fold |

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
