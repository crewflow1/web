# CrewFlow — Live Roadmap Status (programme control plane)

> **This file is the control plane for autonomous roadmap execution.** Every
> release train updates it. Statuses are evidence-based: `PRODUCTION` means
> merged **and** migrated **and** deployed **and** verified — not "code exists".

**Last reconciled:** 2026-08-01 (ROADMAP COMPLETION PROGRAMME, build-dark mandate — build every gated feature to the point where only a credential/decision/legal input remains, so activation is a config flip. Waves 1–2 shipped 4 trains: HQ **Decision Centre** `20261091` (Phase 16 + Layer-5 Delay/Delegate), **Deterministic Intelligence** (company-health RAG/CLV/subcontractor scoring, Phase 9, 0-mig), HQ **Finance AI** (MRR/ARR board, insufficient-honest, 0-mig), **Maintenance-reminder engine** `20261092` (Phase 7, built dark). Migration tip `20261090`→`20261092`.)
**Production `main`:** `b45226fa` — verified against `/api/health`, not inferred
**Production migration tip:** `20261108` — read from `supabase_migrations.schema_migrations`, NOT inferred

> **⚠️ CORRECTION (C26 zero-trust audit, 2026-08-03): the "engineering-complete" claim below was FALSE.** An independent 12-domain audit (`docs/roadmap/C26-ZERO-TRUST-AUDIT.md`) disproved it. The security/tenancy/DB/governance/financial spine is genuinely strong and survived, BUT real engineering remains: **the 5 dark OAuth integrations are NOT config-flip-ready** — no token-refresh path exists anywhere; accounting + calendar push are stubs (accounting's has a live UI caller that errors on use); banking/telematics sync are uncalled; connect dead-ends on unresolved account handles. Plus a shipped `/stock` mobile-overflow defect, an HQ CEO honesty crack (green-on-read-fail), an unwired automation trigger, 2 over-advertised webhook events, an orphaned VOICE_NOTES flag, and a corporation-tax marginal-relief under-calculation. See the audit doc for the full ✅/🟡/🟠/🔴 breakdown + remediation. Do NOT treat the paragraph below as accurate.
>
> **COMPLETION PROGRAMME — Waves 6–12 (2026-08-03).** Waves 6–12 shipped 24 trains (migrations `20261096`–`20261108`), all merged + migrated + deployed; providers 100% dark. This built the dark SUBSTRATES and the genuinely-complete features (DB/RLS/governance/portal/financial-logic/public-API/voice-routing), but the C26 audit found the integration ACTIVATION paths incomplete (above). **Wave 12 (final of the build phase):** HQ apply-on-approval `20261106`, stock reorder `20261107`, cadence-clock `20261108`. Migration tip `20261105`→`20261108`.

> **COMPLETION PROGRAMME Wave 11 (2026-08-03) — 5 trains merged + deployed + production-verified; providers still dark.** From the census Engineering-now queue: **van/vehicle stock** (`20261102` — vehicle modelled as a `sites` location, reuses the hardened movement ledger with zero new write path, no finances [D1 boundary held]; SECURITY DEFINER cross-tenant guard verified against live PG incl. UPDATE-forge); **GPS/telematics dark substrate** (`20261103` — clone of the banking OAuth pattern; append-only readings with two composite FKs; P2-3 timeless-sample bug fixed pre-merge; FCA/provider-gated go-live); **HQ Workflow-Saga foundation** (`20261104` — the one missing internal-OS mechanism: directive → cross-department step graph; deterministic substrate + dark governor-gated AI decomposition [no unbound tier]; agent stalled at verify → taken over and verified); **HQ executor R2 shadow-recording idempotency** (0-mig — natural-key dedup so retries don't duplicate shadow rows; observation-only, live-apply stays unwired); **GDPR data-export** (`20261105` — admin-gated, export-only [erasure legal-gated], #456 org-pinned, two-layer secret exclusion; P1 subcontractor-UTR raw-export + P2 jsonb-nested redaction fixed pre-merge). Every train adversarial-gated (van-stock/telematics/GDPR reviews verified against live PG); each caught a real defect fixed pre-merge. Migration tip `20261101`→`20261105`.

> **COMPLETION PROGRAMME Wave 10 (2026-08-02/03) — 5 trains merged + deployed + production-verified (prod `cf3a0fb`); providers still dark.** From the 3-slice census's Engineering-now queue: **Weather consumers** (0-mig — wired the dark weather cache into schedule-integrity + briefing + EOT; byte-identical dark, honest "not connected", never a fabricated forecast); **HQ Sales-Orchestrator board** (0-mig — unifies research→qual→outreach into one funnel; roster now 13); **HMRC MTD dark substrate** (`20261099` — `hmrc_connections`+`hmrc_submissions`, VAT 9-box + CIS300 composers, filing structurally unrepresentable [`prepared|held` only], refuse-before-fetch, tokens encrypted+service-role-only; go-live legally gated by HMRC recognition); **Banking/open-banking dark substrate** (`20261100` — `bank_connections`, aggregator seam onto existing `bank_statement_lines`, refuse-before-fetch ×3 layers, FCA-gated go-live); **Offline vertical-fill** (`20261101` — `delay_event.create` + `site_report.create` offline write-queue + field-authorable create forms; toolbox/ITP/time/photo honestly deferred [attestation-misdating / money / blob-sync]). Adversarial reviews SHIP/SHIP-WITH-FIXES; HMRC & banking token-security verified against live PG. Migration tip `20261098`→`20261101`. (Migrate-first history-mismatch trap hit + recovered on the offline apply — see the migration ledger note below / worktree gotchas memory.)

> **COMPLETION PROGRAMME Waves 8–9 (2026-08-02) — "finish every remaining roadmap item" mandate; a 3-slice census (HQ / product / integrations) established the definitive remaining backlog: the platform is FAR past the 63% audit snapshot — the overwhelming majority of roadmap items are BUILT-DARK or PRODUCTION (activation = config), leaving a bounded, concrete Engineering-now queue. 6 trains merged + deployed + production-verified; providers still dark.**
> **Wave 8:** **Dark inbound-voice telephony** (#563, `20261098`) — `phone_numbers` routing + append-only `call_events` + composite `(id,org_id)` on `calls`; full `lib/telephony/` provider abstraction (Twilio/Vapi), refuse-before-fetch, signature-verify-before-parse, #456 org-from-dialed-number, tokens/secret columns service-role-only, governor-gated AI-turn seam (dark). Wires the existing 21-table receptionist runtime to live calls; activation = provider creds + flag. Adversarial SHIP-WITH-FIXES; P2s fixed pre-merge (a11y select-name regression, enquiry dedup/delegation, AI-turn wired so activation stays config-only).
> **Wave 9 (all 0-mig):** **Governor fail-CLOSED** (#564 — `checkBudget` denies on unreadable ledger/reservations instead of allowing uncapped spend; the one hazard blocking safe cost-tier activation); **EOT contractual notice-of-delay PDF** (#565 — deterministic NEC/JCT notice, "[not specified]" never fabricated); **CIS export** (#568 — CIS300 + deduction-statement CSV over frozen data + subcontractor statement emailing via existing queue; stops at the HMRC-filing legal boundary; **+ shared `csvEscape` formula-injection guard** protecting all export surfaces at once, preserving negative numbers); **HQ Customer-Success board** (#566) + **HQ Executive-Assistant board** (#567) — deterministic boards + dark narratives + honest-insufficient. **HQ AI-employee roster: 12 boarded** (+ CS, EA). Every train adversarial-gated; each caught a real defect fixed pre-merge. Migration tip `20261097`→`20261098`.

> **COMPLETION PROGRAMME Wave 7 (2026-08-02) — 1 train (0-mig), merged + deployed + production-verified; providers still dark.** **Shared token-encryption seam** (#562, `49a0a36`): closes the shared P1 activation-blocker on BOTH dark OAuth substrates (accounting #558 / calendar #560) where tokens were written plaintext + state compared non-constant-time. New `lib/integrations/token-crypto.ts` (AES-256-GCM envelope, key `INTEGRATION_TOKEN_ENCRYPTION_KEY` base64-32B, `v1:<iv>:<tag>:<ct>`, fresh IV/call, auth-tag enforced). Both callbacks now: **encrypt-before-write** on access+refresh tokens, a **code tripwire** refusing the exchange (writes nothing) when creds are present but no valid key (enforces "no plaintext token, ever" in code — not prose), and **constant-time `timingSafeEqual`** state compare. Decrypt seam in the `oauth.ts` modules (preserving the services' token-free read surface). Adversarial review SHIP (crypto independently proven; no P0/P1/P2). Makes OAuth activation pure config (creds + flag + encryption key), never engineering. Migration tip unchanged (`20261097`). NOTE: activation now also requires setting `INTEGRATION_TOKEN_ENCRYPTION_KEY` (a KMS/secret decision) — this is intentional: the seam refuses to run without it.

> **COMPLETION PROGRAMME Wave 6 (2026-08-02) — 2 more trains, merged + deployed + production-verified; providers still dark.** **Calendar OAuth connection substrate** (#560, `20261097` — `calendar_connections` + `calendar_event_links`, clone of the accounting OAuth pattern; two-switch dark gate, PKCE + single-use httpOnly state, calendar-only scopes (Google `calendar.events`, MS Graph `Calendars.ReadWrite offline_access` on a **separate** MS_GRAPH client, not the SSO client), no-fake-connected CHECK, **tokens service-role-only** via table-revoke + non-token-column re-grant, and a **composite `(connection_id, org_id)` FK making cross-org event binding structurally impossible**. Adversarial review verified all four load-bearing properties against live Postgres; SHIP. Two activation-blockers documented (byte-identical to the accounting substrate, unreachable dark): plaintext token write + request-origin redirect_uri → both to be closed by the shared **token-encryption seam** train next). **Automation engine completion** (#561, `20261096` — `automation_rules` per-org enabled-state overrides + `automation_schedules` cron-triggered rules; wires 2 of 3 stub actions (`send_email_queue`→notification-email bridge, `create_invoice_draft`→quote→draft-invoice authority, both org-pinned + idempotent + cross-org-refused), 3rd `update_status` an honest documented no-op (no safe generic status authority); deterministic UTC cron evaluator, CRON_SECRET-gated drain, admin UI. Both wired actions live on `enabled:false` catalogue rules → **zero live-path impact** until an org enables an override. P1 fixed pre-merge: stepped `*/n` on day-of-month/day-of-week was treated as a wildcard → schedule fired daily instead of every nth day; fixed + regression-tested). Migration tip `20261095`→`20261097` (Calendar `097` applied first; Automation `096` applied out-of-order via `--include-all`). Migrations no longer strictly contiguous — both applied and present.

> **COMPLETION PROGRAMME Wave 5 batch-2 (2026-08-02) — 2 more trains, merged + deployed + production-verified; providers still dark.** **Marketing AI** (#559, 0-mig — deterministic acquisition/funnel over `demo_requests` (CrewFlow's own marketing capture, not tenant `leads` → #456-safe) + analytics; channel/campaign/ad-spend/SEO honestly insufficient; P1 fixed pre-merge: demo-status classifier aligned to the LIVE sales lifecycle `won/lost/payment_*/active` so metrics can't under-report or falsely say "no decisions yet"). **Xero/QuickBooks OAuth connection substrate** (#558, `20261095` — `accounting_connections`, two-switch dark gate, PKCE+single-use-state, no-fake-connected CHECK; **P1 fixed pre-merge: token columns made service-role-only** via table-revoke + 12-column re-grant, since a bare column-revoke is a Postgres no-op while the table grant stands). Activation = provider creds + `FEATURE_ACCOUNTING_CONNECT` + app-side token encryption (KMS decision). HQ AI-employee roster: 10 boarded (research/qual/outreach + Finance/Support/CTO/QA/Operations/Product/Marketing); remaining Design/Documentation lack a deterministic data source (needs-new-capability, not built). Migration tip `20261094`→`20261095`.

> **COMPLETION PROGRAMME Wave 5 batch-1 (2026-08-02) — 3 more AI-employee executors, all 0-migration, merged + deployed + production-verified; providers still dark.** **QA AI** (#556 — executor-shadow divergence/error, reply-audit acceptance, task failure/retry; test-results/a11y/release-approval honestly insufficient), **Operations AI** (#555 — system/cron/email health, alert load, task-queue health; estate-throughput deliberately NOT read cross-tenant per the #456 leak class), **Product AI** (#557 — feature-request demand + themes via a PII-free lean reader, adoption/activation/growth; competitor/roadmap insufficient). All follow the Finance→Support→CTO→QA pattern (deterministic board + dark narrative + honest-insufficient + no unwired governor key). Adversarial reviews all SHIP; Product's P2 (loud-read ratchet blinded by a shared `res` var name) fixed pre-merge — ratchet coverage restored, baseline back to 62. Migration tip unchanged (`20261094`). HQ AI-employee roster now executing/boarded: research, qualification, outreach + Finance, Support, CTO, QA, Operations, Product (9 of ~13); remaining: Marketing, Design, Documentation, Executive-Assistant, Sales-orchestrator, Customer-Success.

> **COMPLETION PROGRAMME Waves 3–4 (2026-08-02) — 6 more trains, all merged + deployed + production-verified; providers still dark.**
> Wave 3: **Accounting export** `20261093` (deterministic canonical mapper + live CSV + Xero/QuickBooks adapters built dark; P2s fixed pre-merge: draft-invoice exclusion + non-silent truncation); **Open API expansion** (0-mig — `/api/v1/{customers,invoices,quotes}` + OpenAPI 3.1 doc, flag-dark, key-auth, org-scoped, explicit DTO allowlists excluding cost/secret/PII; a flaky test de-flaked). Wave 4: **Support AI** (0-mig deterministic triage board; P2 fixed: open-count from active rows, no fake-zero-on-error); **HQ Task Pipeline + Boardroom Confidence/ETA/Health** `20261094` (additive `pipeline_stage` + append-only `hq_ai_task_stage_events` + sanctioned `set_stage` RPC); **Auth completion** (0-mig — email+password, reset, MFA-TOTP enrol/challenge, Microsoft-SSO + account-linking dark; additive/no-lockout, MFA NOT enforced; P2 fixed: backslash open-redirect + signup enumeration + a login-form e2e regression); **CTO AI** (0-mig deterministic platform-health board — uptime/CI/deploy metrics honestly insufficient, no data source). Every train ran the full gate; adversarial review caught real defects each time (GDPR-erasure immutability, INSERT-bypass, honest-null seam, double-send, open-redirect) fixed before merge. Migration tip `20261092`→`20261094`.

> **✅ C15 INTERRUPTION FULLY RECOVERED (Continuation 16, 2026-08-01).** The four spend-limit-killed
> lanes were **resumed from their worktrees (never rebuilt)** and shipped, alongside five new trains.
> Nine PRs merged in strict slot order with migrate-first discipline; every train got a fresh
> adversarial review before merge, and two real P1s were caught+fixed pre-merge (EOT withdrawn-event
> teardown-abort; NCR evidence deletability). Migration slots `20261080`–`20261086` are now ALL
> APPLIED (see the train table). Next free slot: `20261087+` — re-verify against the DB before claiming.
>
> | PR | Train | Slot | Adversarial |
> |---|---|---|---|
> | #525 | Works Quality M2 (NCRs, corrective actions, witness invitations, ITP templates, revision lineage, PDF) | `20261081` | SHIP — P1 NCR-evidence-freeze + P2 series-root fixed |
> | #522 | Portal evolution (photos consumer+producer, future-work→leads, preferences, mobile nav) | `20261082` | SHIP — 3 P2s fixed |
> | #523 | Offline expansion (snags + material-request drafts) | `20261083` | SHIP — UUID-envelope P2 fixed |
> | #529 | EOT delay-event evidence foundation (human-driven, weather-seam dormant) | `20261084` | SHIP — P1 teardown escape fixed |
> | #530 | Job programme baseline (write-once revisions, milestones, derived planned line) | `20261085` | SHIP clean |
> | #527 | Public API-key foundation (hashed keys, resolver, probe) | `20261086` | SHIP clean |
> | #524 | Deterministic intelligence (FACT/DERIVED/HEURISTIC signals) | — | SHIP — 2 P2s fixed |
> | #526 | HQ approval console + executor-shadow observability | — | SHIP clean |
> | #528 | Weather fetch pipeline + Open-Meteo adapter (BUILT-DARK) | — | SHIP clean |

> ### C17–19 TRAIN HISTORY (2026-08-01, 11 trains, all merged + deployed + production-verified)
> Every train ran the full gate: fresh adversarial review → fix → CI → migrate-first → merge → deploy → verify.
> | PR | Train | Slot | Adversarial outcome |
> |---|---|---|---|
> | #531 | Outreach AI onto the HQ task engine (execution stays LOCKED) | — | SHIP |
> | #532 | AI-cost spend trend on /admin/ai-costs | — | SHIP |
> | #533 | Programme-variance + delay-exposure intelligence rollup | — | SHIP |
> | #534 | Outbound webhooks (SSRF+DNS-rebind, HMAC, BUILT-DARK) | `20261087` | SHIP-with-fixes — P1 INSERT verify-bypass + **P0-class spine-projection clobber** fixed pre-merge |
> | #535 | Supplier payment terms + true overdue-payables ageing | `20261088` | SHIP |
> | #536 | Portal reply notifications (both directions) + unread badge | — | SHIP |
> | #537 | Supplier-performance intelligence rollup | — | SHIP |
> | #538 | Expenses budget tracking (org/category vs actual) | `20261089` | SHIP |
> | #539 | Portal bulk/zip document download | — | SHIP — real org-column + React-runtime bugs fixed; scoped to bulk-download only |
> | #540 | QR identity lifecycle on asset timeline + maintenance/custody attachments | — | SHIP |
> | #541 | Public `/api/v1/jobs` read — flag-gated dark (`FEATURE_PUBLIC_API_JOBS`) | — | SHIP |
>
> **Notable defends:** #534's migration silently clobbered the live Pulse-timeline projection consumer (would have broken HQ in prod) — caught by adversarial review + local isolation, fully decoupled. A hidden-red-main integration test (`eot-delay-events`, broken since #529, invisible because integration is not a required check) was root-caused across three latent bugs and repaired. A certificate-PDF blank-org-address defect surfaced by #539's loud reads was spun off to its own session.
>
> **STALE ROWS CORRECTED (verified on `8ac0fc8`):** snags job-page embed = SHIPPED (`_job-snags.tsx`); diary job-page surfacing = SHIPPED (`_job-diary.tsx`); job progress time-series/S-curve = SHIPPED (#512 + intelligence rollup); portal variation UX = SHIPPED (#517/#522). Do NOT rebuild these.
>
> **Remaining roadmap is now CEO/provider/product-gated, not implementation-gated:** bind an AI cost tier (activates the governed-but-dark embeddings/HQ/quote-writer/receptionist paths); activate providers (SMS/WhatsApp/voice/Stripe/HMRC/weather); choose which webhook verbs are externally exposable; flip `FEATURE_PUBLIC_API_JOBS` to expose the read API; AI-employee evaluations (product decision — zero foundation); appointments/booking; activities/CPM programme model. The safe net-new implementation backlog is substantially exhausted.

> ### C20 TRAIN HISTORY (2026-08-01, 3 hardening trains, all merged + deployed + production-verified)
> A 6-agent read-only recon first re-confirmed the safe backlog is drained (the active-org write-slice was **already shipped** in `9c5b995`; company-health score, EoT letters, maintenance-reminder sends, stock valuation, all providers are gated). Then three genuinely-safe hardening trains ran the full gate (adversarial + security review → CI → migrate-first where needed → merge → deploy → verify):
> | PR | Train | Slot | Adversarial outcome |
> |---|---|---|---|
> | #542 | `/api/health` live DB reachability probe (risk #3) — edge-safe, never-throws, no new credential, no tenant data; `ok`/`status`/`db` now reflect Postgres | — | SHIP — took the 401/403 "auth-degraded, not healthy" refinement pre-merge |
> | #543 | pwa-offline service-worker control-wait made deterministic (risk #1 flake) — event-driven `controllerchange` + bounded safety cap; `sw.js`/allowlist untouched | — | SHIP-WITH-FIXES — applied the uncapped-`ready`-await P2 |
> | #544 | Quotes-approval gate enforced at the DB layer (risk #4, quotes arm) — `BEFORE INSERT OR UPDATE` trigger; service_role + admins exempt; 13/13 dual-org integration proof | `20261090` | SHIP-WITH-FIXES — adversarial probe found an **INSERT-path bypass** (staff could CREATE a quote already approved/sent); fixed `BEFORE UPDATE`→`BEFORE INSERT OR UPDATE` + 4 INSERT regression tests pre-merge |
>
> **Recon-corrected stale rows (do NOT rebuild):** the "Active-org remainder" write-slice below is DONE (`9c5b995`, ancestor of main) — `deleteBlueprint`, `markNotificationsRead`, and the 8 action files are all pinned or documented false-positives (`me/actions.ts` is user-scoped BY DESIGN). Offline diary vertical, EoT evidence-pack PDF, and portal maintenance-reminder display are all SHIPPED.
>
> **Known P2 follow-up (flagged, NOT closed — product decision):** quote transitions INTO `'accepted'` are unguarded, and `acceptQuoteAsOwner` carries no approver gate — closing this safely requires deciding whether staff may record acceptances at all. The object-authz `material_requests` decide/raise-PO arm is likewise a transition-guard follow-up. Neither has live blast radius (prod has 1 user, 0 multi-org).

**Providers:** email **live**; SMS, WhatsApp, voice, Stripe, HMRC, weather **dark**. **AI providers DARK.** Weather now has a real Open-Meteo adapter + fetch pipeline **built-dark** (activation = provider licence + credential + cron schedule); embeddings + all HQ AI paths governed but tier-unbound (dark).
The 2026-07-30 ungoverned-call-site hazard is **CLOSED** — see below.

## ✅ EMBEDDINGS GOVERNANCE — CLOSED 2026-08-01 (C15, #521, migration `20261080`)

The "STILL OPEN — embeddings are ungoverned" paragraph below is now HISTORY. Migration `20261080`
widened both `task_class` CHECKs to admit `'embedding'`; the registry carries an `embedding` task
class on its OWN tier (dark — `TIER_MODEL.embedding = null`) with features `memory.embedding_write`
and `memory.embedding_query` billed fail-closed to `CREWFLOW_INTERNAL_ORG_ID`; the paid provider
door refuses on a bare `OPENAI_API_KEY`; both call sites (worker batch, HQ recall query probe) run
through `governedEmbed` → `invokeWithGovernor`; the deterministic CI provider is the one pinned
exemption (zero egress, zero cost). **The dark short-circuit is now PER-TIER** — and the adversarial
review of this train found the P0 that change exposed: the three self-SDK services
(`research-llm`, `lead-summary`, `receptionist`) gated on the GLOBAL predicate, so an
embedding-only activation would have run them ungoverned. All three now gate on their own class's
tier, the ratchet's `ACTIVATION_GATE` no longer accepts `isGovernorActivated` for SDK-constructing
files, and `governedEmbed` + the worker enforce the reservation envelope per batch (chunking; an
over-envelope single memory fails to DLQ instead of wedging the queue). Proofs: from-scratch replay
to `20261080`; 20-concurrent-embedding-claims exact-at-ceiling; cross-org isolation; dedupe;
settlement/release — all in `__tests__/integration/ai/embedding-budget-reservation.test.ts`.
Activation remains a CEO decision: bind the tier + calibrate the envelope for worst-case batches.

## ✅ WEATHER DISTRICT→COORDINATE BLOCKER — CLOSED 2026-08-01 (C15, #520, zero migrations)

`DISTRICT_RESOLUTION_AVAILABLE` is now TRUE and **derived from the dataset, not asserted**:
`lib/weather/geo/district-centroids.ts` carries 2,943 ONSPD-May-2026-derived outward-code centroids
(WGS84, incl. 80 BT districts; GY/JE/IM/GIR deliberately unresolved — ONSPD carries no grid for
them), with full OGL attribution rendered on `/weather` and a checked-in offline derivation script.
Weather remains BUILT-DARK with zero egress (the 64-test proof grew to 68 and now sweeps the geo
directory recursively). Remaining activation blockers are exactly the commercial ones: provider
selection + adapter + credential. Escalation for legal: ONSPD NI postcodes carry OSNI/LPS terms —
confirm before any surface REDISTRIBUTES BT-derived coordinates (in-product display is standard
OGL practice).

## ✅ AI GOVERNANCE — CLOSED 2026-07-31 (was: 5 ungoverned call sites)

Shipped in **#502**. Two things the original audit got wrong, both corrected by the closing lane:

**It was 7 sites, not 5.** Sweeping for provider-SDK *constructions* rather than `isAiConfigured()` *gates*
also found `server/services/lead-summary.ts` (**tenant-facing**, own SDK) and `server/services/research-llm.ts`
(the most expensive path in the tree, 2 × ~3k output tokens). The gate expression varied too: only
`ai-question.ts` called `isAiConfigured()`; three used `getTextProvider()` and `imports/ocr.ts` read
`env.ANTHROPIC_API_KEY` directly.

**Wrapping alone would have closed nothing.** `invokeWithGovernor` runs the caller's function immediately
when no cost tier is bound (the dark short-circuit, by design) — so a credential set *without* a tier binding
produced unmetered spend through the **three already-governed paths too**. The fix moved the GATE: both
provider doors (`lib/ai/text`, new `lib/ai/vision`) now require `isGovernorActivated()` — a **bound cost tier,
not a key**. `isAiConfigured()` now has **zero callers**.

A **ratchet** (`__tests__/security/ai-governance-closure.test.ts`, 8 source-derived tests, mutation-verified)
fails the build if a new direct SDK construction or bare `isAiConfigured()` gate appears outside the governor.

**STILL OPEN — embeddings are ungoverned.** Named in the readiness flag's docstring so the green light stays
narrow. Not closable without a migration: the ledger's `task_class` CHECK admits only
classification/drafting/complex. The HQ ceiling is also a product decision — `hq.draft` / `memory.summarise` /
`research.*` bill CrewFlow's own org via `CREWFLOW_INTERNAL_ORG_ID` (fail-closed when unset), and £100 was
priced for a *customer's* unit economics, not ours.

## 🕐 INCIDENT — BST month-end red main (2026-07-31/08-01), root cause CORRECTED

**What was first concluded, and was WRONG:** that six feature merges between `f2a9c93` (green,
22:31Z) and `8daa416` (red, 23:05Z) introduced a regression in the AI reservation ledger. The bisect
boundary was real; the causal inference was not. **That 34-minute window is elapsed wall clock, not
code.**

**Actual root cause — test harness only, never the product.** `ai_invocations_month_totals` and
`ai_reservations_month_totals` bucket rows by the **Europe/London** month:
`created_at >= (date_trunc('month', p_month) at time zone 'Europe/London')`. Both integration suites
passed the **UTC** calendar date (`new Date().toISOString().slice(0,10)`). For `p_month='2026-07-31'`
that yields the window `[2026-06-30 23:00Z, 2026-07-31 23:00Z)`. **CI ran at 23:07:48Z** — past the
window's end — so rows written at `now()` fell outside it and both rollups returned **no rows**. Every
assertion then read `0` or `undefined` (`expected +0 to be 3000`, `no totals row for org A`).

Signature: 2 files (`ai/budget-reservation`, `rls/ai-invocations`), **17 failed / 47 passed**.

**Proof it was not the merges:** the exact signature was reproduced on a database that does **not**
have migrations `20261075`–`20261078` applied, and the files fail **in isolation** — killing the
cross-file fixture-destruction hypothesis too. It would have fired at 23:00Z on any BST month-end, on
any commit.

**Production was unaffected and no rollback was needed.** `lib/ai/governor.ts` derives `p_month` via
`ukMonthWindow`, correctly London-pinned. The defect existed only in `__tests__/integration/_harness.ts`.

**Fix (#518):** `ukTodayIso()` built on production's own `formatDayKeyUK`; 11 call sites; plus two
deterministic pins that **freeze the instant main died**, so a regression fails at any hour instead of
only in a one-hour window on the last day of a BST month. **No assertion was weakened, skipped or
removed** — the atomic-ceiling, per-org isolation, dedupe, settlement and monthly-total proofs all
still run. Red→green measured *inside* the failure window (23:24–23:29Z): 17 failed → **184 files /
1923 tests, 0 failed**.

**Standing lesson:** a date handed to London-pinned SQL must be a London day. Any test that computes
"today" with `toISOString()` is a time bomb with a monthly fuse.

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
| **C13** | 2026-07-31 | `20261072`–`20261074`, `20261076` | **Roadmap reduction wave — 13 parallel lanes.** #501 notifications dead code + BST day-bucket defect · **#502 AI governance CLOSED** (7 sites not 5; the GATE moved to `isGovernorActivated()` because wrapping alone left the 3 already-governed paths spending) · **#503 variations** (`valid_until` carried an EoT date, so `acceptQuoteByToken` force-expired variations — customers could not accept them) · **#504 payroll employer NI + pension** (margins were overstated: 36%→26% on a worked example) · #505 retention register + aged ledgers · #507 works-quality ITP with DB-modelled hold points · #508 weather DARK · #509 three-way PO/GRN/bill matching · #513 scheduler recommendations · #514 job cost baseline. **A duplicate cost store was caught before merge** — job-budgets had built `quote_cost_estimates` mirroring `20261073`'s columns on `quotes`; both were additive so CI would have gone green on both. Removed, repointed at the GENERATED `quotes.cost_total`. | `0355ec1` → `f2a9c93`, tip `20261071` → `20261076`, verified |
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
| Offline mode / PWA | **WRITE QUEUE BUILT — in flight (#506, `20261077`)**; was READ-ONLY | The offline shell + IndexedDB drawing cache are real and good (`public/sw.js`, `lib/blueprints/offline-store.ts`, `/offline` renders the real viewer from local bytes). But audited tree-wide: **no sync queue, no outbox, no retry, no idempotency key, no conflict detection anywhere**. A foreman with no signal can READ a pre-downloaded drawing and nothing else — no offline diary, snag or photo. 'Offline mode' in a construction product means work without signal; that is gap #10 below |
| AI WhatsApp Assistant | **BUILT-DARK (inbound + outbound + receipts)** | consolidated in #433 (prod `9a633cd`); webhook returns 404 and `/api/health` reports `whatsapp:false` with the flag off — verified post-deploy. Activation needs `NEXT_PUBLIC_FEATURE_WHATSAPP=true` + `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (+ `WHATSAPP_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN` inbound) + per-org DB state |
| Native mobile apps (iOS/Android) | **NOT BUILT** | PWA is the current mobile strategy |

## PHASE 3 — AI OPERATING SYSTEM

| Item | Status | Evidence |
|---|---|---|
| Daily Briefing | **PRODUCTION** (deterministic, 21 signals) | `lib/briefing/compose.ts`, `server/services/briefing.ts`, `20261038_briefing_dismissals`; ranked money + safety signals, non-dismissible live breaches |
| AI Voice Receptionist | **BUILT-DARK — but it is a TEXT engine; there is NO VOICE** | 22,361 LOC across 81 files is a genuinely strong inbound-**enquiry text** engine (intent, slot extraction, gap-filling, governed generation, human claim/release worklist). Audited 2026-07-30: **zero** hits tree-wide for vapi/twiml/telephony/call_sid/audio/transcription/speech/tts/stt, and **no `phone_numbers` table exists in the repo** — so phone→org routing has no schema either. Voice needs: telephony provider, routing migration, audio streaming, STT/TTS, barge-in, real-time turn loop. 'Vapi telephony NOT BUILT' read like the last mile; it is the whole road |
| AI Quote Writer | **BUILT-DARK** (see Train 30) | **This row said NOT BUILT until 2026-07-30 — it was wrong and 44 lines from the train that shipped it.** `lib/ai/{quote-context,quote-prompt,quote-draft-schema,quote-draft-pipeline,quote-writer-readiness}.ts`, `server/services/ai-quote-writer.ts`, `20261068`, live panel in the quote builder. Remaining before activation: model binding (a CEO/cost decision — all `TIER_MODEL` tiers are null), the atomic governor reservation, and `checkBudget`'s fail-open |
| AI Scheduler | **PRODUCTION (detection + recommendations)** — C13 #513 added deterministic resolution candidates with visible, record-traceable reasoning; propose-only, never auto-move. No skills model exists in the schema, so ranking answers who is FREE, never who is BEST | Train 16 (#460): `lib/schedule-integrity` + `/staff/rota/conflicts` + briefing signals — double-bookings, assignee-without-shift, leave clashes, unassigned imminent jobs, custody anomalies. Observe→explain only; recommendation/auto-move NOT built |
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
| Works quality (ITP, hold points, sign-off) | **PRODUCTION** — C13 #507, `20261076`. Hold points modelled in the DB; the gate is a WARN that STAMPS `hold_point_breach` rather than refusing (refusing would not stop the pour, only destroy the evidence). M2+: revision lineage with hold-point carry-forward, portal witness invitations, NCR workflow, template library, PDF pack |
| Asset/plant inspections + templates | **PRODUCTION** (mis-filed here until 2026-07-30 — these are **asset** inspections, not site QA) | Migrations `20260927`–`20261001` are all `asset_inspection*`; routes are `/assets/[id]/inspections/**`. **There is NO site/works quality inspection: no ITP, no hold points, no witness/approval regime, no per-job inspection register.** Under a Site-Management heading the old label read as site QA — it never was |
| Progress tracking | **TIME SERIES BUILT — in flight (#512, `20261078`)**. Actual progress only: four candidate baselines were checked and CrewFlow holds NO programme, so no planned line is drawn and the panel says so on screen | `progress_percent` DOES ship inside `site_reports.content` (validated 0–100) and is surfaced to the customer portal. True gap: no job-level progress log / time series / S-curve |
| Weather intelligence | **BUILT-DARK — PRODUCTION (dark)** — C13 #508, `20261074`. Global district-keyed cache (`weather_readings` has NO `org_id`; `weather_watches` is org-scoped), 25 thresholds across 7 activities with 10 sourced and 15 marked as defaults, 64-test no-egress proof. `/api/health` reports `weather:{available:false,providerImplemented:false}`. **Activation blockers:** provider choice + licence (Met Office redistribution terms unpublished; Open-Meteo free tier is non-commercial and works WITHOUT a key, so readiness demands one anyway), and district→coordinate resolution — every provider takes lat/lon and CrewFlow has none. EoT letters remain NOT BUILT |
| Site timeline | **PRODUCTION** | `lib/site-ops/timeline.ts` (#442) — pure, total order, Europe/London day buckets; composes diary+snags+inspections+toolbox+RAMS/permits+docs+photos onto the job page |
| ~~Site timeline (old)~~ | superseded | `lib/commercial/timeline.ts` is commercial-only; `server/services/spine-timeline.ts` is HQ-internal (service_role); asset timeline is asset-scoped. No unified operational timeline over diary+snags+inspections+toolbox+photos — all source tables exist, so this is a pure read/compose |

## PHASE 5 — FINANCE

| Item | Status | Evidence |
|---|---|---|
| Quotes → invoices → payments → allocation | **PRODUCTION** | `allocate_payment` RPC, per-invoice caps, idempotency |
| Retention (accrual, release schedule, moieties) | **PRODUCTION** | `lib/retentions/**`, `20261005`/`20261012`/`20261013` |
| Billing plans (deposit / staged / milestone) | **PRODUCTION** | `20261039_job_billing_plans` + `generate_stage_invoice` RPC |
| Precise cash position + forecast + portal payment schedule | **PRODUCTION (money-in)**; money-out + net position in flight (#511) — supplier bills, VAT, CIS, draft payroll, committed spend, all composed from existing authorities with a documented double-count precedence | H2-CASH M3: per-invoice retention attribution, `collectableNow`, org=Σjobs reconciliation |
| Purchase orders | **PRODUCTION** | Programme C slice 2 |
| Supplier invoices / committed costs | **PRODUCTION** | Programme C slice 3 |
| Profitability + VAT summary reporting | **PRODUCTION** | `lib/profitability/compute.ts`, dashboard/reports |
| Payroll (timesheets → PAYE lines) | **PRODUCTION (estimates, now including employer on-costs)** — C13 #504. Employer NI + pension now enter the `labour` bucket, so margins are no longer overstated (worked example: 36% → 26%, band green → amber). Dated rate tables in `lib/payroll/rates.ts` (2024-25 / 2025-26 / 2026-27); **the brief's 13.8% was 2024-25 — current is 15% above £5,000**. Still NOT modelled, each with its error direction, in `NOT_MODELLED`. No RTI/FPS, no P60/P45 | `lib/payroll/compute.ts` line 1 says so itself: annualise → flat bands → divide. **No employer NI, no pension/auto-enrolment**, no tax codes, no cumulative basis, no RTI/FPS, no P60/P45. Materially: employer NI + pension are real job costs, so **every margin figure is understated** |
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
| WhatsApp outbound + read receipts | **BUILT-DARK — shipped, not pending.** `lib/comms/providers/meta-whatsapp-sender.ts` is on `main` and `SENDER_IMPLEMENTED.whatsapp = true`. The old "#362 stack, needs renumber" note was stale by several trains |
| Missed-call text-back | **BUILT-DARK** (needs flag + Twilio) |
| Voice (Vapi) | **NOT BUILT** (#113 superseded — design preserved, branch stale) |

> ✅ **That trap is FIXED — this warning was itself stale and was blocking a legitimate activation.** `lib/comms/readiness.ts` no longer derives `configured` from credentials alone; it decomposes into `credentialsPresent` / `senderImplemented` / `selectionUsable` / `providerResolvable`, and `SENDER_IMPLEMENTED.whatsapp` is `true` because the sender exists. Corrected 2026-07-31 after the control plane was found telling the CEO not to activate WhatsApp for a reason that had already been engineered away.

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

**Production migration tip is `20261076` (works-quality ITP, applied 2026-07-31).** Slots BELOW
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
| `20261068` | AI quote drafts | **APPLIED** — Train 30, #491 |
| `20261069` | stock correction transfer guard | **APPLIED (prod tip)** — Train 31, #493 |
| `20261070` | AI budget reservation | **APPLIED** — C12, #497 |
| `20261071` | stock residual hardening (deferred FKs et al) | **APPLIED** — C12, #496 |
| `20261072` | job cost baseline (`job_budgets`) | **APPLIED** — C13, #514. Needed `--include-all`: `20261073` reached prod first while this PR was still open |
| `20261073` | variation EoT + cost basis on `quotes` | **APPLIED** — C13, #503 |
| `20261074` | weather intelligence (dark) | **APPLIED** — C13, #508 |
| `20261075` | — | **ALLOCATED AND DECLINED.** The payroll lane (#504) was given this slot and correctly did not use it: employer NI/pension are a pure function of `(gross_pay, cycle, period_start)`, all already persisted. **Do not recycle this number** — it appeared in a brief |
| `20261076` | works quality ITP | **APPLIED (prod tip)** — C13, #507 |
| `20261077` | offline write queue idempotency key | **APPLIED** — #506 |
| `20261078` | job progress observations | **APPLIED** — #512 |
| `20261079` | portal warranties | **APPLIED** — #517 |
| `20261080` | embeddings governance (task_class widen) | **APPLIED** — C15, #521 |
| `20261081` | works quality M2 (NCRs, corrective actions, witness, templates, lineage) | **APPLIED** — C16, #525 |
| `20261082` | portal evolution (`customer_portal_preferences`) | **APPLIED** — C16, #522 |
| `20261083` | offline write expansion (snags + material-request drafts) | **APPLIED** — C16, #523 |
| `20261084` | EOT `delay_events` | **APPLIED** — C16, #529 |
| `20261085` | job programme baseline (`job_programme_baselines` + `job_milestones`) | **APPLIED** — C16, #530 |
| `20261086` | public API keys (`api_keys`) | **APPLIED** — C16, #527 |
| `20261087` | outbound webhooks (`webhook_endpoints`, `webhook_deliveries`) | **APPLIED** — C17, #534 |
| `20261088` | supplier payment terms (`suppliers.payment_terms_days`) | **APPLIED** — C17, #535 |
| `20261089` | expense budgets (`expense_budgets`) | **APPLIED** — C18, #538 |
| `20261090` | quote-approval authz trigger (`enforce_quote_approval_authz` on `quotes`) | **APPLIED** — C20, #544 |
| `20261091` | HQ Decision Centre (`hq_decisions` + `hq_decision_events`) | **APPLIED** — Completion W1, #545 |
| `20261092` | maintenance-reminder engine (`maintenance_reminder_log` + `claim_due_maintenance_reminders`) | **APPLIED** — Completion W2, #548 |
| `20261093` | accounting export log (`accounting_export_log`) | **APPLIED** — Completion W3, #549 |
| `20261094` | HQ task pipeline (`hq_ai_tasks.pipeline_stage` + `hq_ai_task_stage_events`) | **APPLIED** — Completion W4, #552 |
| `20261095` | accounting OAuth connections (`accounting_connections`, tokens service-role-only) | **APPLIED** — Completion W5, #558 |
| `20261096` | automation rules + schedules (`automation_rules`, `automation_schedules`) | **APPLIED** (out-of-order, after `097`, via `--include-all`) — Completion W6, #561 |
| `20261097` | calendar OAuth connections (`calendar_connections` + `calendar_event_links`, tokens service-role-only, composite-FK cross-org bind blocked) | **APPLIED** — Completion W6, #560 |
| `20261098` | voice telephony (`phone_numbers` routing, `call_events` append-only, `calls` composite `(id,org_id)` unique) | **APPLIED (prod tip)** — Completion W8, #563 |
| `20261099` | HMRC MTD dark substrate (`hmrc_connections` + append-only `hmrc_submissions`, prepared\|held only, tokens service-role-only) | **APPLIED** — Completion W10, #571 |
| `20261100` | banking/open-banking dark substrate (`bank_connections`, tokens service-role-only) | **APPLIED** — Completion W10, #572 |
| `20261101` | offline write-expansion 2 (`delay_events`/`site_reports` client_write_key + offline_authored_at + partial uniques) | **APPLIED (prod tip)** — Completion W10, #573 |
| `20261102` | van/vehicle stock (vehicle-as-`sites`-location, reuses movement ledger, no finances) | **APPLIED** — Completion W11, #575 |
| `20261103` | GPS/telematics dark substrate (`telematics_connections` + append-only `telematics_readings`, tokens service-role-only, two composite FKs) | **APPLIED** — Completion W11, #576 |
| `20261104` | HQ Workflow-Saga (`hq_workflow_sagas` + `hq_saga_steps`, deterministic + dark-AI decomposition) | **APPLIED** — Completion W11, #577 |
| `20261105` | GDPR export log (`gdpr_export_log`, export-only audit) | **APPLIED (prod tip)** — Completion W11, #578 |
| `20261106` | HQ apply-on-approval store (`hq_application_records`, apply-once partial-unique, default-off + unbound authority) | **APPLIED** — Completion W12, #581 |
| `20261107` | stock reorder points + replenishment (`stock_items.reorder_quantity`) | **APPLIED** — Completion W12, #580 |
| `20261108` | HQ cadence-clock (`hq_ai_schedules` + `hq_ai_schedule_runs`, default-off) | **APPLIED (prod tip)** — Completion W12, #579 |
| `20261109+` | **NEXT FREE** | unallocated — re-verify against the DB before claiming |

> **C13 ordering lesson, recorded because it will recur.** Under migrate-first with several
> PRs open at once, production can hold a migration that `main` does not yet contain. A branch
> cut before those landed has a local migrations directory missing versions the remote has, and
> `supabase db push` **correctly refuses** it. Do not force it. Stage instead from `origin/main`
> plus the specific new migration file(s) — `git checkout <branch> -- supabase/migrations/<file>`
> — which yields a tree containing every applied version, then push. Verify the catalogue after
> every apply, never just the version row.

> ### ⚠️ THIS TABLE WAS A LIVE TRAP UNTIL 2026-07-30
> A read-only audit found this file simultaneously claiming tip `20261062` (here),
> `20261068` (header) and declaring **`20261069+` "NEXT FREE"** — while `20261069`
> was **already applied in production**. Following it would have claimed a colliding
> prefix: exactly the failure the warnings above and below describe. Three lessons,
> now procedure: (1) the tip appears in ONE place in this file, not three; (2) always
> read it from the database, never from this table; (3) a slot row moves to APPLIED in
> the same train that applies it, never later.


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

1. ~~**`e2e/pwa-offline.spec.ts` is flaky**~~ — **CLOSED, C20 (#543).** Root cause was the offline-download warm path gating `data-offline-shell-ready` on a fixed-timeout SW-control check that lost the race against first-install `clients.claim()` under CI load. Fixed deterministically (event-driven `controllerchange` wait + one bounded safety cap); `public/sw.js` and the SW allowlist untouched, no assertion weakened. e2e passed green post-fix.
2. **Generated types are stale** (`lib/supabase/types.ts` declares ~40 of ~145 tables). Deliberately mitigated by ~575 loose-cast seams across 167 files, so the app is correct today. **Assessed C20: a bare regen is high-churn, zero-behavioural-value, and could turn green main red — left alone on purpose.** If pursued it must be human-owned: regen at the tip, review existing-table diffs, add the `gen types + git diff --exit-code` CI gate, then remove seams incrementally.
3. **Observability gap — PARTIALLY CLOSED, C20 (#542).** `/api/health` no longer reports `ok:true` blindly — it probes live DB reachability (edge-safe, never-throws, no new credential, no tenant data) and `ok`/`status`/`db` now reflect Postgres, verified live in prod. **Still open:** `SENTRY_DSN` is unset (the Sentry wiring is fully built and dark only for lack of that credential) — a provisioning/CEO decision, not an implementation gap.
4. **Object-level authz — quotes arm CLOSED, C20 (#544, migration `20261090`).** The owner/admin quote-approval gate is now enforced at the DB layer (`BEFORE INSERT OR UPDATE` trigger), so a staff JWT can no longer self-approve or send an un-approved quote via raw PostgREST; 13/13 dual-org integration proof. **Recon finding:** most other sensitive financial tables (billing plans, budgets, supplier payments, payroll, CIS, expense budgets, api_keys) were ALREADY `is_org_admin`-enforced by the H1-TRUST waves. **Still open (P2, product-gated):** the `quotes → accepted` provenance / `acceptQuoteAsOwner` gate, and the `material_requests` decide/raise-PO transition — both are transition-guards whose correctness intersects a product decision (may staff record acceptances?); prod has 0 multi-org users so zero live blast radius.
5. **GDPR / org teardown** — storage bytes orphan on org delete. Legal decision pending.
6. **Self-serve billing / trial expiry** — `orgHasActiveAccess` ignores `trial_ends_at`. Only blocks self-serve, not founder-led.

## Next build lanes (dependency-safe, in priority order)

- **LANE B — FINANCE / CIS + subcontractors** — biggest remaining UK-construction moat; no external provider needed; extends the existing commercial spine.
- **LANE A — SITE OPERATIONS programme** — verify snags/site-diary depth first, then complete one coherent vertical (diary + progress + photo evidence + snags + timeline + portal-safe progress).
- **LANE D — CUSTOMER EXPERIENCE** — variation approval UX + warranties/maintenance reminders.
- **LANE F — INTELLIGENCE** — deterministic company-health / commercial-risk scoring (honest labels only).
- **LANE C — OPERATIONS** — fleet/plant as an **extension of the existing asset model**.
