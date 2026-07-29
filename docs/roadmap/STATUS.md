# CrewFlow — Live Roadmap Status (programme control plane)

> **This file is the control plane for autonomous roadmap execution.** Every
> release train updates it. Statuses are evidence-based: `PRODUCTION` means
> merged **and** migrated **and** deployed **and** verified — not "code exists".

**Last reconciled:** 2026-07-29 (Continuation 11 — O3 stock + M4 material requests + AI quote writer dark)
**Production `main`:** `8b4377f`
**Production migration tip:** `20261068`
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
| **8** | 2026-07-27 | `20261051` | **CIS M3 — deduction engine + reverse-charge VAT** (#443): HMRC-verified rules (20/30/gross, exclusions, CITB, **6th–5th tax month**), server-derived rate (forgery-proof on the service_role path), cumulative partial-payment maths, reverse charge as a real treatment with `computeVatQuarter` proven unchanged | `656f5b8` → `3d6f724`, verified |
| **30** | 2026-07-29 | `20261068` | **AI Quote Writer DARK foundation** (#491): `ai_quote_drafts` (immutable model content vs write-once applied content; discard=status; provenance CHECK omits deterministic), 10-field disclosure contract enforced by `assertQuoteContextDisclosure` + PII value-level test, 6×3 injection corpus contained (unforgeable fence nonce, byte-identical system channel), governor-only via `quote.writer_draft` (renamed to dotted convention while ledger empty), no draft→send path (pinned). **Two ACTIVATION BLOCKERS recorded: governor ceiling is a start-gate not a reserve (concurrent overshoot) + dedupe races — both need one atomic SQL reservation** | `→ 8b4377f`, verified |
| **29** | 2026-07-29 | `20261066`–`20261067` | **M4 Material Requests** (#490): job-site request → admin approval (leave_requests precedent — the true tenant approvals pattern) → **derived** fulfilment (no hand-set statuses, pinned; corrected issues excluded via `corrects_movement_id`); DB transition trigger (illegal transitions → 8 red when dropped); free-text lines first-class; Hub Materials panel; /materials/requests queue; PO-draft handoff (never sent; notes-marker provenance recorded honestly as human-grade); per-user approver notifications | `→ 8b4377f`, verified |
| **28** | 2026-07-29 | `20261063`–`20261065` | **O3 Operational Stock** (#489): append-only movement ledger, balance=SUM (no mutable qty field anywhere); GRN→stock human-matched + idempotent; issue/transfer/adjust RPCs under per-(item,site) advisory locks — **negative-stock counterfactual proven (−10.00 without the lock)**; transfer conservation proven; GRN void refused while receipt stands (separate trigger); **ACCOUNTING BOUNDARY ENFORCED: no finances writes, by security test — D1 remains open, this is the authorised operational-only interim**. Also found+fixed a real Next.js defect: `revalidatePath` inside `useActionState` stalls the commit (double-issue hazard) — pinned, flagged app-wide. Known residue: members' direct INSERT on movements can bypass the lock (reasoned in-migration) | `→ 8b4377f`, verified |
| **27** | 2026-07-29 | — | **NUL-byte separators escaped** (#488, CEO-directed): `governor/policy.ts` + `receptionist-generation.ts` were grep-invisible binary — every repo security sweep silently skipped them; `\u0000` escapes are byte-identical at runtime (hash pins prove) | `→ 8b4377f`, verified |
| **26** | 2026-07-29 | `20261062` | **AI Cost Governor foundation, DARK** (#484): `ai_invocations` ledger (integer pence rounding UP; select-only admin RLS — spend unforgeable; `deterministic` absent from the task_class CHECK; Europe/London months; invoker-rights rollups), `lib/ai/governor.ts` seam (£100/mo hard ceiling in code, 50/80/100% bands, SHA-256 dedupe, refuses deterministic class), 3 dark paths governed (OCR, receptionist extraction, conversation engine), `/admin/ai-costs` HQ view with ungoverned-credential amber. No provider, no credentials, all model tiers null. Honest: `checkBudget` fails OPEN on ledger-read failure (documented); 4 legacy call sites flagged not yet wired | with #482/#483 → `d8aa459`, verified |
| **25** | 2026-07-29 | `20261061` | **Sites/depots entity** (#483): org locations (depot/yard/warehouse/office/container/lock-up — `job_site` excluded on a four-axis rationale); typed FKs ALONGSIDE kept free text on `fleet_vehicles.home_site_id` + `asset_assignments.site_id` (SET NULL + trigger guard — composite would CASCADE: deleting a depot must not delete the van); deactivate-never-delete with the 20261052 teardown escape; `/sites` register + pickers in fleet + custody | with #482/#484 → `d8aa459`, verified |
| **24** | 2026-07-29 | `20261059`–`20261060` | **PO Receiving / GRN — warehouse M1** (#482): mobile receive-delivery flow (per-line ordered/so-far/outstanding), immutable posted GRNs (`GRN-0001…`, void-with-reason walks the PO back), DB-derived receipt state (`partially_received` added; hand-set contradictions refused), over-receipt BLOCKED (tolerance = CEO decision), per-PO advisory lock — counterfactual proven (110 posted against 100 without it), teardown-safe DEFERRED FKs. Absorbed #481's 4-function PO handoff incl. a real `recordSupplierBill` `job_id` gap. **Release incident, recorded honestly**: a worktree-locked checkout + a semicolon chain applied `20261062` from the wrong tree first and #482 merged pre-apply; recovery = merge #483/#484 to restore history consistency, then `--include-all` applied 59/60/61; full catalogue verified; fresh-replay order proven by CI on merged main | `55387ec` → `d8aa459`, verified |
| **23** | 2026-07-29 | — | **Hardening stack** (9 PRs, 4 trains): H1 nav race #470+#472 (mutations succeeded, browser never navigated — up to 10/10 loss; FormState+`window.location.assign` per the deep-swap race doctrine) · H2 #471 role-derivation (unfiltered `.single()` membership read locked admins out of multi-member orgs; conflict resolution WAS the bug — main still carried it in payments) + #473 H&S denominator · H3 #474/#477/#475/#476 (axe settles streamed content; hidden `<div id="S:">` ≠ visible; app-wide AA sweep; #476 retargeted off its stack) · H4 #478 auth listUsers pagination · #481 active-org WRITE closure (payroll cross-org hours £400-vs-£200; service-role imports copy/mass-delete class) | `04d6f3e` → `55387ec`, verified |
| **22** | 2026-07-29 | — | **Active-org list/dashboard/search closure** (#468): 86 files — the FINAL enumerated slice, and the worst finds were never enumerated: `/dashboard` had **14 blended reads** (every money tile summed two businesses), `/tax` + its **HMRC VAT PDF merged two companies under one letterhead**, `/api/search` all 8 palette branches, 8 uncovered detail pages (customers exposed the other org's `portal_token`), 30+ list pages, 9 shared helpers, 11 routes. Plus 7 F-1 silent-truncation fixes (`ORDER BY …, id`). +212 security (pin-COUNT per file — partial strips caught) +139 integration; mutation non-vacuity proven (101/139 red) | `86126a7` → `ca8cba6`, verified |
| **21** | 2026-07-29 | — | **Operations command centre** (#467): `/operations` — compose-don't-re-detect enforced by test (no severity/due-ness maths exists in its code); live-exposure banners, 5 counters, worst-first lists, all clickable through; dropped tiles honestly (no high-value flag exists to threshold; `activity_log` has zero asset/fleet trigger coverage so a feed would show sales events). 15-test dual-org suite; mutation 12/15 red | `425ed7e` → `86126a7`, verified |
| **20** | 2026-07-29 | `20261056`–`20261058` | **FLEET** (#465): vehicles as 1:1 asset extensions — register/detail/compliance-board/fuel at `/fleet`; MOT/insurance/road-tax/service via the widened service-schedule + maintenance engines; `asset_fuel_logs`; transactional two-row create + complete-and-roll RPCs; dual-org proof incl. service_role composite-FK block; E2E 5/5 ×3. First apply attempt hit a transient Supabase 503 — catalogue verify proved zero partial state, retry applied cleanly | `b15cc26` → `425ed7e`, verified |
| **19** | 2026-07-29 | — | **Asset/QR isolation hardening** (#464): scan resolver leaked foreign-org asset names (existence oracle confirmed; write-path on-ramp) — the shipped test was a FALSE PROOF testing an inline resolver copy with a pin the code lacked. Fixed + now drives the real export; label-PDF wrong-org letterhead fixed; asset detail page pinned; asset-register supplier reads closed at integration (tripwire retired). Mutation-proven | `4ab60d0` → `b15cc26`, verified |
| **18** | 2026-07-29 | — | **Active-org suppliers closure** (#463): 6 defect sites found (brief said 2) — address book had NO org predicate; detail/CIS/payments pages; update/delete actions; PO supplier+jobs pickers (comment claimed "org-scoped by RLS"); expenses supplier read. Lane self-corrected: reverted its own redundant guard after proving the finances org-integrity trigger IS the boundary, and pinned the trigger instead | `09465ca` → `4ab60d0`, verified |
| **17** | 2026-07-28 | — | **Active-org integrity, rota slice** (#461, CEO-directed): the weekly grid rendered a dual-org member's other-company shifts, the job picker listed the other org's jobs/customers, and `createRotaEntry`'s overlap check refused legitimate shifts because of clashes in the user's OTHER org. Reads moved to `server/services/rota.ts` (client-as-argument seam) so page/action/test share one implementation; **mutation-proven** (pins stripped → 4/4 red) | `97c9f6b` → `87707ae`, verified |
| **16** | 2026-07-28 | — | **Schedule Integrity detector** (#460): read-only, deterministic conflicts over rota/jobs/leave/assets — double-booked staff, assignee-with-no-shift, approved-leave clashes, unassigned imminent jobs (day 2+, disjoint from the existing briefing signal by construction), asset-custody anomalies. Half-open `[start,end)` matching the write-side rule; severity capped at `high` (a clash must not outrank a safety breach); org pin **mutation-tested**. Flagship find: `jobs_rota_sync_trigger` writes default shifts that bypass the form's overlap guard — silent double-booking, now surfaced. Also flagged: the write-side guard is blind to cross-midnight shifts (detector catches them) | `4f1cdb3` → `97c9f6b`, verified |
| **15** | 2026-07-28 | — | **Active-org integrity, finance/commercial writes** (#459): 19 sites examined, 15 confirmed+fixed, 2 already safe (pinned), suppliers deliberately deferred. Headline: cross-org \`acceptQuoteAsOwner\` **succeeded in the other org** — created their job, burned their invoice number, posted a draft invoice, **emailed their customer**, advanced their lead. Also \`deleteQuote\` (unscoped delete defeated its own org-scoped integrity guard), \`markAllNotificationsRead\` clearing BOTH orgs' queues, portal-token rotation, compliance signed-URLs. CIS/settlement 409 mapping preserved | `4f1cdb3` → (with #460/#461) `87707ae`, verified |
| **14** | 2026-07-28 | `20261055` | **CIS M4 — payment & deduction statements + CIS300 return dataset** (#458): HMRC rules re-verified at source (CISR12160/CISR61230/CIS340 §3.15 — statements NOT statutory for gross payment, modelled as `is_statutory`); new `cis_contractor_profiles` (employer's PAYE ref was nowhere in the schema and is mandatory — issue REFUSES without it); statements freeze M3 snapshot sums (zero new arithmetic, asserted); SQL-computed `ledger_fingerprint` makes divergence provable; void→supersede, all-voided→withdrawal with reason; **filing structurally unrepresentable** (`status IN ('prepared','exported')` — verified in prod catalogue). Escalations: CIS300 declarations (legal), export format, statement emailing | `9c6fc5d` → `4f1cdb3`, verified |
| **13** | 2026-07-28 | — | **Active-org integrity, jobs domain** (#456): app code read rows by PK alone, so a dual-org user active in Org A could read AND write Org B rows inside A's shell (`current_org_ids()` correctly returns all memberships — RLS is the outer boundary, not scoping). Fixed jobs-domain writes/reads end-to-end incl. `recordRetentionRelease` writing into **another org's retention ledger** and certificates freezing another org's address under the wrong letterhead; `loadJobForOrg()` seam; form-helpers chokepoint (11 call sites, 5 domains); site-report PDF letterhead. Red→green with a genuine dual-org user; RLS proven untouched. **Remainder is large and enumerated** (~90 unscoped writes, ~60 reads app-wide) — see "Active-org remainder" below | `db6ceb8` → `9c6fc5d`, verified |
| **12** | 2026-07-28 | — | **Destructive-test production-target guard** (#455): fail-closed allowlist guard (`lib/testing/destructive-db-guard.ts`, pure, no env reads) wired into every destructive entry point — integration harness chokepoint (all 152 files proven to route through it), e2e global-setup + 12 specs' `svc()`, `memory-bench`, and an **in-SQL guard** in `e2e-lifecycle.sql` keyed on the CLI's fixed local-dev JWT secret (`inet_server_addr()` and `rolsuper` proven false friends). **NO override escape hatch** by design. Also fixed a live product footgun: `/admin/launch-checklist` rendered a copy-pasteable `--linked` (production) destructive command. Live negative proof: non-local target → all 154 files refuse, zero credential leakage | `9e8a723` → `db6ceb8`, verified |
| **11** | 2026-07-27 | `20261053`, `20261054` | **Payables financial guards** (#452): CIS deduction basis frozen once a bill is part-paid — including the non-obvious fourth door, **INSERT of `cis_bill_details` after part-payment** (a bill legitimately part-paid with no details row freezes at materials = 0, so creating the row later moves the basis). Bill reductions floored at the settled total, without trapping legacy over-settled rows. **21/21 real two-session psql race proof**, zero deadlocks. Also enforces the previously-accidental trigger firing order that protects the CIS snapshot from a stale bill — the test identifies triggers by what their functions *do*, so a rename fails it | `db30989` → `9e8a723`, verified |
| **10** | 2026-07-27 | — | **Import correctness** (#451): the header matcher used substring matching with no token boundaries, so `total` bound to **"Subtotal"** (100, not 120) and `due_date` bound to **"Total Due"** — turning the amount `120` into the date **`"0120-01-01"`**. Replaced with whole-token matching + semantic field classes evaluated on *residual* tokens. Also: generated columns (`vat_total`, `total`) no longer written; malformed source dates become row errors instead of silently becoming "today" (wrong VAT quarter); explicit `vat_rate: 0` instead of inheriting the `20` default | `935f7fe` → `db30989`, verified |
| **9** | 2026-07-27 | `20261052` | **Org-teardown P1** (#448): deleting an organization failed — cascade DELETE fired `_record_activity`, which INSERTed into `activity_log` referencing the org being deleted (`activity_log_org_id_fkey` violation). Guard skips the write when the org no longer exists. Blast radius **proven** exhaustive (recursive `pg_proc` closure → 14 functions ∩ `pg_trigger` DELETE-firing on cascade-to-org tables = exactly 6 triggers), not assumed; two inherited claims found false and corrected | `397dab3` → `935f7fe`, verified |
| **7** | 2026-07-27 | — | **Job Site Hub** (#442): ZERO tables — composes the already-live diary/snags/inspections/toolbox/photos onto the job page + a pure totally-ordered site timeline | `0096a56` → `656f5b8`, verified |
| **6** | 2026-07-27 | `20261047` | **CIS M2 — supplier/subcontractor money-out ledger** (#438): `supplier_payments` + `supplier_payment_allocations`; general payable engine with optional CIS; composite-FK org/supplier/bill binding valid for service_role; deadlock-free allocation guard; write-once + void. Plus test-isolation fixes (#436, #439) and roadmap corrections (#437) | `266d9e9` → `28b2d85`, verified |
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
| AI Scheduler | **PARTIAL** (deterministic detection) | Train 16 (#460): `lib/schedule-integrity` + `/staff/rota/conflicts` + briefing signals — double-bookings, assignee-without-shift, leave clashes, unassigned imminent jobs, custody anomalies. Observe→explain only; recommendation/auto-move NOT built |
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
| Site timeline | **PRODUCTION** | `lib/site-ops/timeline.ts` (#442) — pure, total order, Europe/London day buckets; composes diary+snags+inspections+toolbox+RAMS/permits+docs+photos onto the job page |
| ~~Site timeline (old)~~ | superseded | `lib/commercial/timeline.ts` is commercial-only; `server/services/spine-timeline.ts` is HQ-internal (service_role); asset timeline is asset-scoped. No unified operational timeline over diary+snags+inspections+toolbox+photos — all source tables exist, so this is a pure read/compose |

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
| CIS M2 — money-out ledger | **PRODUCTION** | `20261047_supplier_payments` (#438). `supplier_payments` (gross/cis_withheld/net_paid with a DB CHECK enforcing `net_paid = gross − withheld`) + `supplier_payment_allocations` against `finances` bills. Composite FKs `(id, org_id, supplier_id)` enforce cross-org + cross-supplier + not-a-bill for **every role incl. service_role**; allocation guard locks payment-then-bill (deadlock-free) capping Σ at both payment gross and bill gross; **write-once + void** (never edit — `cis_withheld` is filed with HMRC and printed on statements); admin-only RLS. **Invariant proven 3 ways: CIS withholding does NOT reduce commercial cost** (£10k gross − £2k CIS = £8k cash, job still cost £10k) |
| CIS M3 — deduction calc + reverse-charge VAT | **PRODUCTION** | `20261051_cis_deduction` (#443, Train 8): HMRC-verified rules (20/30/gross, exclusions, CITB, 6th–5th tax month), server-derived rate, cumulative partial-payment maths, reverse charge as a real treatment; splits labour vs qualifying materials (CIS never applies to materials or VAT). Hardened by `20261053`/`20261054` (#452, Train 11): basis freeze incl. INSERT-after-part-payment door, settlement floor, enforced trigger firing order |
| CIS M4 — monthly statements + return dataset | **PRODUCTION** | `20261055_cis_statements` (#458, Train 14): immutable statements frozen from M3 snapshots, `cis_contractor_profiles` (PAYE ref gate), CIS300-shaped return dataset with honest nil returns; **prepare/export only — filing is structurally unrepresentable**. Gaps: no file export yet, no E2E browser run for the new UI |
| CIS M5 — HMRC filing seam | **NOT BUILT** | stays DARK/BLOCKED_BY_PROVIDER — no real or simulated filing without approved credentials |
| OCR / receipt scanning | **BUILT-DARK** | `server/services/expense-drafts.ts` calls `maybeExtractReceipt`; `expense_drafts.ai_confidence` exists; with no AI key the draft is created with NULL extraction fields. **Verified 2026-07-27 — was wrongly marked NOT BUILT.** Needs a provider key only |
| Expenses | **PRODUCTION** | `app/(app)/expenses/{page,new,[id],actions.ts}` with `uploadExpenseReceipt`/`approveExpenseDraftAction`/`rejectExpenseDraft`, `expense_drafts` table, sidebar. **Verified 2026-07-27 — was wrongly marked PARTIAL.** Budget tracking specifically remains NOT BUILT |
| Online invoice payment (Stripe) | **FOUNDATION (dark seam)** | `PaymentProvider` seam documented in `docs/billing-plans.md`; needs live creds + product decision |

## PHASE 6 — OPERATIONS

| Item | Status | Evidence |
|---|---|---|
| Assets + QR tags + labels | **PRODUCTION** | asset epic M3b/M4/M5 (scanner, QR, inspections, maintenance scheduler) |
| Maintenance schedules | **PRODUCTION** | idempotent scheduler |
| Plant/equipment → job allocation | **PRODUCTION** | `asset_assignments.assignment_type` already includes `allocated_to_job` + `loaded_on_vehicle`, with `job_id`, `vehicle_asset_id`, issue/return meter readings, condition + transfer lineage; surfaced at `app/(app)/jobs/[id]/_job-assets.tsx` |
| **Fleet (vehicles / MOT / insurance / road tax / service / fuel)** | **PRODUCTION** | Train 20 (#465), migrations `20261056`–`58`: `fleet_vehicles` 1:1 on assets (composite-FK, CIS-M1 precedent) — VIN/variant/year/fuel/class/weight/MOT-exemption/finance/depot/odometer; `operational_status` in_service\|off_road\|in_workshop split from `assets.status` disposal (transition-only guard); BOTH maintenance CHECKs widened together (generator passes type straight through); `asset_fuel_logs` keyed on asset (plant burns diesel too), forward-only odometer sync; transactional RPCs `save_fleet_vehicle` + `record_fleet_compliance_completion`; `/fleet` overview+register+detail+compliance board+fuel, plate-normalised search; 3 briefing signals; `critical` ONLY for expired MOT/insurance on an in-service vehicle (RTA s.47/s.143). Honest MPG (consecutive readings only). Deferred: fuel→finances seam (noted, not wired), depots entity (free text), custody stays on the asset page |
| QR cross-org isolation | **PRODUCTION (hardened)** | Train 19 (#464): scan resolver leaked foreign-org asset names to dual-org users with an existence oracle — fixed red→green; prior test was a false proof (tested an inline copy WITH a pin the code lacked; now drives the real export + pin against local copies); label-PDF wrong-org letterhead fixed; anon/non-member/token-entropy proven safe. Gap matrix: attachments UI missing on maintenance+custody; depot/location free-text; QR events absent from timeline; no damaged/under_repair status (needs DDL, slot later) |
| Stock / warehouse / material ordering | **PARTIAL — M1 GRN receiving, M2 sites, M3 operational stock (quantity-only interim, D1 open), M4 material requests ALL LIVE** (Trains 24/25/28/29). Remaining: D1 decision → valuation/COGS; joined fulfilment seam hardening (in flight); deferred FKs (request-line↔movements); van stock; supplier ordering automation | Read-only integration map complete (2026-07-29): NOTHING exists (no stock/GRN/sites/requisition tables — verified by full table enumeration). Milestone cut: **M1 PO receiving** (GRN + `partially_received`, slot `20261059`, dependency-FREE, standalone value) → **M2 `sites` entity** (three domains already carry free-text location debt: fleet `home_depot`, custody `location`, stock) → **M3 stock ledger + issue-to-job** (BLOCKED on decision D1) → M4 material requests. **D1 (CEO/product): stock is already expensed on purchase** (`recordSupplierBill` posts whole bill; yard POs have `job_id=NULL` so they hit org P&L but no job) — if issue-to-job ALSO posts to `finances` the £ double-counts org-wide. Options: operational-only ledger / reclassify-split the existing row / real inventory accounting (first balance-sheet position in CrewFlow). Also D3 (serialised-vs-fungible boundary vs `assets`), D4 (negative stock — odometer precedent says no hard CHECK), D5 (void vs adjust). PO gap confirmed: `received` is a bare status write recording nothing about what arrived; POs have NO tenant activity trigger (HQ audit only) |

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

**Production migration tip is `20261062` (AI invocations ledger, applied).** Slots BELOW
that are closed forever — Supabase keys identity on the numeric prefix, so a
lower-numbered file added later replays out of order from scratch. We have hit this
twice (#128 `20260711`, #136 `20260706`).

Read the tip from **production**, not from this table — this table can lag a
release by minutes:

```bash
supabase migration list --linked | awk -F'|' 'NF>=3 {gsub(/ /,"",$2); if($2 ~ /^[0-9]{14}$/) print $2}' | sort | tail -1
```

That `awk` reads the **remote** column deliberately. A positional parse (`tail -2 | head -1`)
reads the LOCAL column and will report your own unapplied migration as the production
tip — a mistake that silently authorises a colliding slot. The other authoritative read
is the database itself:

```sql
select max(version) from supabase_migrations.schema_migrations;
```

Remember why the duplicate-prefix check exists at all: a colliding prefix is
**invisible to git**. `20261055000000_a.sql` and `20261055000000_b.sql` are different
filenames — clean merge, no conflict, no reviewer signal. The collision only surfaces
at replay. Check this table *and* run the `uniq -d` proof before naming a file.

| Slot | Owner | Status |
|---|---|---|
| …`20261047` | CIS M2 `supplier_payments` | **APPLIED** |
| ~~`20261048`–`20261050`~~ | never written / retired (incl. the original org-teardown slot) | **DEAD — below applied tip, never claim** |
| `20261051` | CIS M3 `cis_deduction` | **APPLIED** |
| `20261052` | org-teardown P1 `activity_cascade_guard` | **APPLIED** — Train 9, #448 |
| `20261053` | CIS bill value freeze | **APPLIED** — Train 11, #452 |
| `20261054` | Supplier bill settlement floor | **APPLIED** — Train 11, #452 |
| `20261055` | CIS M4 `cis_statements` | **APPLIED** — Train 14, #458 |
| `20261056`–`20261058` | FLEET (`fleet_vehicles`, compliance widening, `asset_fuel_logs`) | **APPLIED (prod tip `20261058`)** — Train 20, #465 |
| `20261059`–`20261060` | PO receiving (GRN + receipt state) | **APPLIED** — Train 24, #482 |
| `20261061` | `sites` | **APPLIED** — Train 25, #483 |
| `20261062` | `ai_invocations` | **APPLIED (prod tip)** — Train 26, #484 |
| `20261063`–`20261065` | O3 operational stock | **APPLIED** — Train 28, #489 |
| `20261066`–`20261067` | M4 material requests | **APPLIED** — Train 29, #490 |
| `20261068` | AI quote drafts | **APPLIED (prod tip)** — Train 30, #491 |
| `20261069+` | **NEXT FREE** (candidates: request-line/stock FKs deferred-debt hardening, asset status additions) | unallocated |


> ### ⚠️ CORRECTION (2026-07-27) — the org-teardown slot MUST move
> `20261050_activity_cascade_guard` was allocated when the production tip was
> `20261047`. **CIS M3 has since shipped, taking the tip to `20261051`**, so
> `20261050` is now *below the applied tip* and can no longer be introduced. It
> was renumbered. **Continuation 8 re-computed the slot from the CURRENT max**
> (prod tip + main + every worktree + every remote = `20261054`) and assigned the
> org-teardown P1 to **`20261052`** — free and immediately above the applied tip —
> because it is a live production defect and must ship FIRST. Had it taken
> `20261055`, the already-written `20261053`/`20261054` would then have been below
> the applied tip. Ordering matters as much as uniqueness.
>
> **RULE: claim a slot above the production tip AND above every in-flight slot in
> this table. Re-check the tip immediately before merging — it moves.**

## Active-org remainder (named defect class — 2026-07-28, from #456's lane)

Train 13 fixed the **jobs domain** slice of a much larger class: application code
that reads/writes by PK alone and relies on RLS for scoping, which blends orgs for
any dual-org user (`current_org_ids()` returns ALL memberships by design). The
lane **proved** the remainder rather than guessing: **~90 unscoped writes and ~60
unscoped reads** app-wide. Highest-severity first for follow-up slices:

1. ~~**Finance/commercial writes**~~ — **DONE, Train 15 (#459)** — quotes (9 real
   sites, not the 5 enumerated), customers, expenses (already safe, pinned),
   leads, compliance, notifications. **EXCEPT `suppliers/actions.ts` (85,120)** —
   deliberately deferred to avoid colliding with the concurrent CIS M4 lane —
   **now DONE, Train 18 (#463)**: 6 sites in the suppliers domain plus PO/expenses
   pickers; the deferral pin became live coverage.
2. ~~**Route handlers**~~ — **DONE, Train 15 (#459)** — invoices
   `{route,pdf,send}` + quotes `{send}` + `finances/[id]` (409 mapping
   preserved); `remind` was already gated.
3. **Detail pages** — customers/invoices/expenses/leads/compliance/payments-reconcile/
   health-safety(+permits)/assets-templates/asset-inspections/diary-edit `[id]` pages
   — asset detail + scan resolver + label PDF **DONE, Train 19 (#464)**; the rest
   were closed across slices 1–3 where enumerated (verify per file if in doubt)
4. ~~**Blended list pages**~~ — **DONE, Train 22 (#468)** — plus /dashboard,
   /tax+VAT-PDF, /api/search and 8 uncovered detail pages the enumeration missed.
5. ~~**Blueprint services**~~ — **DONE, Train 22 (#468)** (the enumerated lines were
   right for blueprints.ts; blueprint-pins.ts's real list defects were unnamed).

**THE ORIGINAL 5-ITEM READ-SIDE REMAINDER IS NOW CLOSED.** Train 22's sweep surfaced
a NEW, separate **write-slice** enumeration (unpinned by-id reads/writes inside
actions): `deleteBlueprint` (read+DELETE must move as a pair or storage bytes
orphan — a dual-org owner can currently delete the other org's drawing),
`markNotificationsRead` (user-scoped, needs a ctx change, low harm), and 8 action
files: imports, payroll, payments, purchase-orders, reviews, support, me, inbox.
This is the next active-org slice — write-side, zero-migration.
6. ~~**Staff rota reads**~~ (found later by the schedule lane) — **DONE, Train 17
   (#461, CEO-directed)** — grid, job picker, overlap check via
   `server/services/rota.ts`, mutation-proven.

Two escalations pending CEO decision: (a) should opening a non-active-org URL
auto-switch the active org instead of 404ing? (b) the global fix — intersecting
`current_org_ids()` with an active-org signal — needs DDL and makes RLS trust a
client-supplied value; recommended for consideration, deliberately not done.
**Answered 2026-07-28 (read-only prod aggregate):** production has **1 total
user and 0 multi-org users** — the class has had ZERO real-world blast radius;
every fix landed pre-exposure. The remaining slices are pre-launch hardening,
not incident response: sequence them against feature lanes accordingly, and
re-run the aggregate when real customers onboard.

## Next dependency-safe milestone per lane (evidence-based, 2026-07-27)

Each avoids `cis_*`, `supplier_payments`, `finances`, `lib/cis/*` and the receptionist/whatsapp suites:
- **LANE A — "Job Site Hub"**: ZERO new tables. Embed the existing diary + snags panels on the job page and compose a read-only site timeline over `site_diary_entries` + `snags` + `asset_inspections` + `toolbox_talks` + photos.
- ~~**LANE B — "Fleet as an asset extension"**~~ — **SHIPPED as Train 20 (#465)**, exactly this shape (slots landed as `20261056`–`58`).
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
