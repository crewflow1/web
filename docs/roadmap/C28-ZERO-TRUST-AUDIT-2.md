# CrewFlow — Zero-Trust Audit 2 (C28)

**Generated:** 2026-08-03 · **Prod `main`:** `dccfe4f1` · **Migration tip:** `20261111` · **Providers:** 100% dark (email/Resend only).
**Method:** 18 independent hostile domain auditors (Rule Zero — trust no prior claim) → adversarial verification of every claimed engineering gap → synthesis. 51 agents total.
**Verdict:** **B — NOT COMPLETE.** 11 confirmed engineering gaps across 8 domains. Do **not** certify "Engineering backlog = EMPTY".

This audit ran *after* the C27 remediation (10 trains: calendar/telematics/banking/accounting/webhook OAuth + /stock overflow + HQ honesty + automation dispatch + corp-tax/VAT + Voice-Notes orphan) was merged, migrated (`20261109`–`20261111`), deployed, and production-verified. It attempts to disprove the resulting "complete" claim and succeeds.

## Confirmed FALSE / stale prior claims (proven by the auditors)

- ❌ "Engineering backlog = EMPTY" / "activation = credentials + flag only" — false for calendar (rota half), telematics (no consumer), weather (no producer), accounting (AccountCode/VAT), HQ narratives, HQ apply, voice.
- ❌ MEMORY: "payroll = estimates only (no employer NI/pension)" — **stale/false**; `lib/payroll/compute.ts` implements employer NI + pension (auditor ✅).
- ❌ MEMORY: "offline mode is READ-ONLY (no queue/retry/conflict)" — **stale/false**; a full offline write queue with retry drains E2E for 5 entities (auditor ✅).
- ❌ MEMORY: "5 ungoverned AI call sites; a key alone bypasses the £100 ceiling" — **closed**; governor is atomic reserve→settle, fail-closed, CI-ratcheted (auditor ✅).
- ✅ Genuinely complete & verified this pass: migration catalogue (271==271, zero drift), CI Node-20/22 tiering, banking dedupe/idempotency correctness, automation `payment.recorded` dispatch at all 3 write paths, portal + offline write queue.

## The 11 confirmed engineering gaps (🔴 — buildable now, no external gate)

### 1. crm-jobs — Archived leads leak into pipeline + inflate forecast
`app/(app)/leads/page.tsx` pipeline query has no `status` filter; the bucketing loop coerces any status not in `LEAD_STAGES` (incl. `archived`) into `byStage['new']`, and `totalValue` sums **all** rows before the enum check. Archive action sets `status='archived'` and its own comment says it should "drop out of pipeline view" — it does the opposite. Live, no dark flag. Latent only because prod `leads` is empty.
**Files:** `app/(app)/leads/page.tsx`, `app/(app)/leads/actions.ts`, `lib/leads/schema.ts`, `__tests__/leads/`.
**Fix:** `.neq("status","archived")` on the query; move the `LEAD_STAGES` membership check above bucketing **and** `totalValue` and `continue` on unknown status; regression test.

### 2. hq-governance — 10 board narrative loaders are `return null` stubs + false UI copy
All 10 `load*Narrative()` (`hq-finance/cto/operations/marketing/product/customer-success/qa/executive-assistant/sales-orchestrator/support-ai`) are literal `return null;` with no governor call; `lib/ai/governor/registry.ts` registers no `hq.*_narrative` keys, so a tier bind alone leaves them null. The admin `*-ai` pages claim "narrative populates once a model tier is bound" — untrue. The tenant `insights.narrative` path (`lib/ai/insight-narrative.ts`) is the correct, fully-built dark pattern the boards omit.
**Fix:** per board, register a feature key + implement the loader mirroring `insight-narrative.ts` (narrate-only over the already-computed deterministic board, `invokeWithGovernor`, temp 0, strip org ids, null on blocked/no-tier). Until wired, correct the misleading empty-state copy.

### 3. hq-governance — apply-on-approval has no production apply authority
The only `ApplyAuthority` is `createUnboundApplyAuthority()` → `resolve:()=>null` (default; the cron runs production defaults), so every real approval hits `skipped++; continue` — applies nothing. The one non-null resolve is a test stand-in. Executor also defaults to `REFERENCE_EXECUTOR` (reference tools, not real SECURITY DEFINER entry points). Comments at `route.ts:22` / `hq-apply-drain.ts:46-47` claim "config flip, not engineering" — false. **Note:** live cut-over is *additionally* gated by ADR 0009 (CEO). Minimum honest fix now = correct the comments; full fix = build a bound `ApplyAuthority` routed through the sanctioned executor with exactly-once live-DB tests.
**Files:** `server/services/hq-apply-drain.ts`, `app/api/cron/hq-apply-drain/route.ts`.

### 4. accounting — Xero invoice lines omit AccountCode
`buildXeroInvoicesBody` emits `Status:'AUTHORISED'` ACCREC invoices whose line items carry no `AccountCode`/`ItemCode`; Xero rejects AUTHORISED ACCREC without an account ref. Asymmetric with payments (which read a configurable `XERO_BANK_ACCOUNT_CODE`). No sales-account env exists.
**Fix:** add `XERO_SALES_ACCOUNT_CODE` (default `'200'`), thread into `buildXeroInvoicesBody`, set `LineItems[].AccountCode`; unit test.

### 5. accounting — VAT unreliable in both provider payloads
Xero: manual `TaxAmount` with no `TaxType` → non-standard rates (0/5/exempt) post wrong gross. QBO: `TxnTaxDetail.TotalTax` with no `TxnTaxCodeRef`/`GlobalTaxCalculation` → VAT ignored/recalculated. The shipped **CSV** export path already maps `vat_rate`→provider tax code, but the API push discards it (`CanonicalAccountingRow` carries only net/vat/gross, no `vat_rate`).
**Fix:** thread `vat_rate` onto the canonical row; Xero line-level `TaxType` (OUTPUT2/5%/ZERORATEDOUTPUT/EXEMPTOUTPUT); QBO `GlobalTaxCalculation:'TaxExcluded'` + resolved `TxnTaxCodeRef`; tests asserting posted gross == canonical gross at 20/5/0%.

### 6. calendar — no rota-shift producer (advertised phantom)
`calendar_event_links` is only ever written with `localKind:'job'`; `buildEventPayload` accepts only `JobForEvent`; `createRotaEntry` has no calendar side-effect. Yet "push scheduled jobs and rota shifts" is in the panel copy, the DB CHECK (`local_kind in ('job','rota')`), and the store union. Job push also rebuilds fixed 08:00–17:00 from `scheduled_date`, so adjusted/standalone shifts are wrong/absent.
**Fix (build the half):** rota→payload builder using `rota_entries.starts_at/ends_at`, `pushRotaToCalendar`/`bestEffortPushRota` (`localKind:'rota'`), wired into `createRotaEntry` + update path as a dark best-effort side-effect. (Or, if deferred: remove the copy + `'rota'` from the CHECK/union.)

### 7. telematics — `telematics_readings` has zero consumers
One write (`telematics-sync.ts` upsert) + migration DDL/RLS/tests; **no SELECT anywhere** — no service/RPC/view/page. Sync never updates `fleet_vehicles.odometer_*`; fleet UI renders no telematics. Migration header + GAP-ANALYSIS claim activation "feeds a screen that already knows the vehicles" — false.
**Fix:** reader service over `telematics_readings` (latest fix + recent track, org-pinned) surfaced on `fleet/vehicles/[id]`, and/or forward-update `odometer_miles/odometer_recorded_at` (respect the forward-only guard).

### 8. weather — no `weather_watches` producer
`weather_watches` is read in two sites, written nowhere; no cron/trigger/hook/action/UI creates one. `runWeatherFetch` with zero watches returns "nothing to fetch"; the read path is watch-gated by RLS too. `getWeatherReadiness` omits any watch-producer clause, so `available` can be true while nothing is produced.
**Fix:** job/site→watch producer (`districtForAddress(resolveJobAddress(...))`) as a cron or create/update/close hook; fold a `hasActiveWatches`/producer signal into readiness.

### 9 + 11. reporting — `/reports` aggregates truncate at 1000 rows (F-1) + no volume test
`lib/reports/aggregates.ts` (`jobsPerWeek`, `revenuePerMonth`, `vatPerQuarter`×2 reads, `topCustomersByRevenue`) uses bare `.select()` with no pagination; `max_rows=1000` (config.toml). Every peer aggregate migrated to `fetchAllRows`; reports is the sole holdout → VAT/revenue silently under-report past 1000 rows. The export route reuses these and its test mocks the module, so CSV inherits the truncation uncaught.
**Fix:** route every read through `fetchAllRows` with a unique-id tiebreak; real (non-mocked) test seeding >1000 rows.

### 10. voice — no conversational spoken-turn (unreachable dead code)
`buildInboundTwiml` returns only `<Response><Say>…</Say></Response>` — no `<Gather input='speech'>`/`<Stream>`/gather-callback route. The origination POST reads `SpeechResult`, but Twilio only delivers it to a `<Gather action=…>` URL that is never emitted, so `maybeGenerateVoiceTurn` short-circuits on empty transcript every call. Comment claiming "AI spoken-turn seam reachable → activation config-only" is false. Vapi has no assistant-request/tool-call handler. Inbound routing/logging substrate (Wave 8) is genuinely complete; the gap is narrowly the spoken-turn loop.
**Fix:** wrap greeting in `<Gather input='speech' action='/api/webhooks/twilio/voice/gather'>`; add the gather-callback route (maintenance→rate-limit→dark-gate→raw-body→fail-closed signature verify→org-by-dialed-number→`maybeGenerateVoiceTurn`) returning TwiML that speaks the turn and nests a further `<Gather>`, with no-input fallback; Vapi assistant-request + tool-call handler; E2E test.

## NOT engineering backlog (correctly excluded)
Activation-hardening (OAuth redirect-uri host-pinning parity on banking/HMRC/calendar; HMRC token-refresh — HMRC is legal-gated), product/legal decisions (AI cost-tier bind, executor ADR 0009 cut-over, VAT scheme basis, public-API exposure, HMRC MTD/RTI recognition, native mobile/i18n/marketplace strategy), and pure credential flips. These are 🟡/🟠, not 🔴.

## Remediation (C28 fix wave — in progress)
Each gap fixed C27-style: verify-then-fix in an isolated worktree → adversarial review → full CI → migrate-first (ascending, if any) → merge → deploy → verify. Providers stay dark; no fakes; honest labels.
