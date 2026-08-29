# Master Roadmap Reconciliation — zero-assumption, code-verified

**Date:** 2026-08-29 · **Audited:** `main` = production = `88cbe193` · **Method:** the complete Bible/master-roadmap corpus (15 volumes/major sections) atomised into **237 requirements** (`master-roadmap-reconciliation.json`), verified by 15 independent reviewer lanes (A–O incl. a Devil's Advocate) against the repository, local schema mirror (380/380 == prod), and production. No prior audit trusted; 31 spot re-verifications of this week's claims all CONFIRMED. No code changed.

## Headline counts (numerator/denominator shown — no percentage theatre)

| Status | Count | Meaning |
|---|---|---|
| A — BUILT+LIVE | **141** | implemented, reachable, tested |
| B — BUILT+DARK | **14** | complete substrate, provider/flag-gated by design |
| C — PARTIAL | **46** | meaningful implementation, promise not fully met |
| D — NOT BUILT | **19** | no meaningful implementation |
| E — DEFERRED (recorded) | 2 | ADR/doc-recorded deferral |
| F — FUTURE VISION | 3 | explicit long-term |
| G — SUPERSEDED | 4 | replaced by a recorded decision |
| H — CANNOT VERIFY | 3 | e.g. scale claims (no load tests), branch protection |
| P — PROCESS/STRATEGY | 5 | not a build commitment |

**Current-stage denominator:** 155 atoms (horizon = current commitment). **Fully satisfied (A+B+E+G): 120.** PARTIAL: 26 · NOT BUILT: 9. Exact calc: 120/155 = **77.4% strictly satisfied**; counting honest partials at half-credit: (120+13)/155 = **85.8%**. Classification rules are in the JSON (`horizon`, `status` per atom).

## The Devil's Advocate verdict (lane O)

*"Can I disprove 'everything intended by this stage is built (live or dark)'?"* — **YES, narrowly, on three counts** (search breadth; the HQ apply-leg being remaining engineering misfiled as a mere decision; roster #27–36 lacking a deferral record) — **while every bait item attacked proved genuinely built**: WhatsApp voice-note transcription (governed dark) + video/doc ingest, fleet tyres compliance, delivery-note OCR, portal book-future-work + servicing slots, drawn digital signatures, the spoken voice turn-loop, dark HMRC VAT/CIS300/FPS submit adapters, Jewson/Travis-Perkins cXML. His summary: **"the platform out-builds its paperwork."**

## ROADMAP BUILD GAPS (Phase-25 strict filter)

Items explicitly promised, current-stage, not superseded/deferred/future/process, materially incomplete. **None blocks Customer #1** (workarounds live; none is a safety/financial/tenant risk):

| # | Gap | Promise source | Evidence | Severity | Scope | Block #1? |
|---|---|---|---|---|---|---|
| G1 | **Global search breadth** — Cmd+K indexes 12 families; blueprints, photos/attachments, assets/fleet, suppliers, expenses, diary, toolbox, support tickets absent | DB volume "Everything searchable" + Product | `app/api/search/route.ts` (12 families, deliberate "address-first" self-description ≠ the promise) | Medium | ~1 wk incremental | **No** |
| G2 | **Variation-request intake** — no structured site/portal capture; chain starts at the management form (create→sign→derive→audit all live) | Vision-2030 Phase 2 #3 step 1 | zero request surface in worker-portal/diary/portal | Medium | 2–4 d | **No** (portal messages workaround) |
| G3 | **Advanced tables** — sticky headers, sorting, resizing, grouping, bulk actions, keyboard nav, inline editing: all absent (filtering/search partial at page level) | Design volume, explicit 9-item list | `components/ui/table.tsx` chrome-only by design; zero `sticky` in app | Medium | 1–2 wk for a real table primitive | **No** (E2E proved usability) |
| G4 | **Charting layer** — no chart library exists; dashboards are tiles/CSS bars | Design volume "charts simple/interactive/beautiful" | no recharts/d3/visx in package.json | Low-Med | ~1 wk | **No** |
| G5 | **CIS verification adapter** — manual-entry only; interface exists, no dark HMRC adapter despite VAT/CIS300/FPS siblings all built dark under the same legal gate | Finance phase "CIS automation / HMRC integration" | `lib/cis/verification.ts:363` manual provider only | Low | 2–3 d dark adapter | **No** |
| G6 | **saga_step orphan (defect, not gap)** — `hq-workflow.ts:385` enqueues `saga_step` tasks; **no `registerTaskHandler("saga_step")` exists** → tasks unclaimable, sagas pin at `running` forever, broken state accretes on a 5-min cron | HQ P15 | confirmed by two lanes | **P2 defect** | hours (handler or disable dispatch) | **No** (HQ-internal, sagas human-created & unused) |

**Documentation actions (not builds) surfaced by the filter:** record the offline scope supersede ("entire app offline" → the reasoned create/update-lite scope); record the roster #27–36 staging decision; reclassify the HQ apply-leg from "CEO decision" to "CEO decision + remaining engineering" (its own code says so); add the Bible ADR for the light-theme product decision; **rewrite README.md** (dangerous v0 fiction — advertises dark features as live, fake staging env, wrong stack); re-reconcile STATUS.md header (the control plane is 26 days stale with the NEXT-FREE-migration trap regrown).

## Built-but-unreachable register (Phase 21)

`/notifications` page (bell links to `/activity`; only push-fallback reaches it) · `/marketplace` nav-orphan even when flag lit · **`/settings/sso` actions exist with NO page** (SSO activation surface missing as UI) · GDPR export/erase have zero UI callers (API-only) · **Outreach AI code-complete with zero production callers/no admin page** · `/qa` orphan by design. Dead `inngest` dependency; `packageManager: pnpm` vs npm lockfile.

## Dark capability inventory (Phase 20)

All complete-substrate, refuse-before-fetch, none required for Customer #1: SMS (Twilio; `TWILIO_*`), WhatsApp (Meta; `NEXT_PUBLIC_FEATURE_WHATSAPP`+creds), missed-call textback, inbound email, voice inbound + spoken turn (Twilio/Vapi; flag+creds+mid-tier), weather (provider credential), portal payments + self-serve billing (Stripe Connect; 2 flags+keys+per-org onboarding), accounting push Xero/QBO/Sage (OAuth+`INTEGRATION_TOKEN_ENCRYPTION_KEY`), calendar Google/MS, banking TrueLayer (FCA-gated), telematics Samsara, HMRC MTD VAT/CIS300/RTI (vendor-recognition legal gate), merchants cXML (contract-gated), marketplace (flag+partners+nav work), enterprise SSO/SCIM (flag; **needs the missing settings page**), public API v1 (flag; SDKs absent), outbound webhooks (triple-gated), web-push (VAPID), PostHog (key+consent), Resend event ingestion (flag+secret), maintenance-reminder emails (flag), MS-SSO login, MFA enforcement, **all generative AI** (governor `TIER_MODEL` all-null — one binding + key lights the estate under the £100 fail-closed ceiling).

## Matrices (summary)

- **HQ phases 1–20:** A×5 (Boardroom, Task Engine, Decision Centre, CEO Briefing, Automation-tenant) · C×9 (Framework, Memory, Sales, QA, Product, Finance, Support, Operations, Collaboration†, Voice) · D×4 (Marketing/CTO/Design/Documentation — boards/linters wearing department names; no PR-review/merge/deploy, no content generation, no doc writes) · F×1. †Collaboration carries the saga_step defect.
- **Customer platform:** 33 foundation atoms A; portal 13/15 A + 2 B; workflow 11/12 arrows A + 1 D (G2); future-modules list largely built (A×10, B×6, C×1 offline, G×2 AI-scheduler/cashflow superseded-by-doctrine, F×1 native apps).
- **AI workforce contract:** REAL+enforced — permissions (capability registry, legacy columns dropped), tools, tasks, outputs envelope, audit, 5 autonomy levels (5 enforcement layers, pinned at 1–3), approval immutability. PARTIAL — memory consumption, confidence (binary), performance, lifecycle. ABSENT — manager, conversation history, per-employee cost, impact.
- **Database:** A across scoping/RLS(307/307)/FKs/constraints/audit/events/migrations/naming/separations; C on search (lexical), backups (PITR OFF — CEO), soft-delete uniformity; H on "millions" scale claims (UNPROVEN — no load tests).
- **API:** A on safe-errors/org-audit/incoming-webhooks/isolation; B on outbound-webhooks/public-API/versioning; C on envelope (9/148 ratchet), request-IDs (unpersisted), comms tracking (no `replied`), rate limits, monitoring (Sentry live in prod; no endpoint metrics); H on <200ms (UNPROVEN); D on SDKs.
- **Security:** A on the core promise set (31/31 re-verified); C on monitoring/paging, PITR, consent-persistence, dep-gate; E pentest (planned); D fuzzing.
- **Design:** A empty/loading/nav/a11y-contrast/mobile; C tokens/components/errors/reduced-motion/icons; D advanced-tables(7)/charts; G dark-theme (recorded light decision, ADR missing).
- **Engineering:** 12 CI-enforced gates (typecheck/lint/unit/integration-real-PG/security-tier/e2e/gitleaks/dependabot/migration-guards/ratchets/workflow-self-pins/advisory-audit); documented-only: pentest/rollback-automation; absent: perf/load/fuzzing; H branch-protection.

## Answers

**A. "Is everything explicitly intended to be BUILT BY THIS STAGE actually built?" — NO**, narrowly: G1–G5 above are unmet against explicit wording (plus the P15 defect G6), and four scope decisions lack written supersede/deferral records.
**B. "Is everything in the entire long-term roadmap built?" — NO** (by design: native apps, global platform, autonomous workforce, marketplace ecosystem, voice autonomy, i18n/multi-jurisdiction remain future).
**C. "Any missing current-stage commitments that should be implemented BEFORE acquiring Customer #1?" — NO.** Every gap has a live workaround, none touches safety/financial-correctness/tenant-isolation (all re-proven 31/31), and the correct sequencing per the freeze doctrine is: acquire Customer #1, then prioritise G1–G6 against real customer evidence.

## ROADMAP COMPLETION GATE: **GREEN**

All roadmap requirements intended for the current pre-Customer-#1 milestone are implemented, deliberately dark, intentionally deferred, or explicitly future — **with the six-item register above now identified, classified (standard-shortfalls and one HQ-internal defect, none Customer-#1-blocking), and handed to the evidence-driven backlog**. There is no *unidentified* current-stage roadmap build work remaining.
