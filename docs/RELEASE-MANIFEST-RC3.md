# CrewFlow — Production Release Manifest (RC3)

> **⚠ SUPERSEDED — RC3 was cut over to production on 2026-07-20 (`94eeea8`).**
> This is the pre-cutover record; the "DO NOT MERGE / DO NOT DEPLOY" language
> below is historical. Current state: `docs/stage-one-reconciliation.md`.

**Candidate branch:** `release/rc3-full-platform` → `main` (PR #397) · **DO NOT MERGE / DO NOT DEPLOY**
**Supersedes:** RC2 #375 (stale — stopped at #374 / 158 migrations) and RC #363.
**Produced by:** the Release-Recovery & CTO Consolidation directive — a 20-role multi-agent audit + serial consolidation. Every claim below is evidence-backed against the repository, not prior milestone reports.

---

## 1. Executive summary

RC3 is the single canonical candidate that collapses ~40 unmerged feature PRs into one linear, CI-green branch on top of production `main`. It carries the entire Directive-#018 foundation (dark), the full Site-Management and Asset-Management clusters, the Commercial programme, the Customer-Experience/onboarding work, and three release-recovery hardening fixes surfaced by the audit.

- **170 migrations** (100 already on `main` + 70 new), applied as a clean linear append — **zero duplicate timestamps**, verified fresh-DB-appliable by the CI integration gate.
- **Test posture:** 8,700+ tests across 4 tiers (unit/integration/security/e2e); all six CI gates run as separate jobs; integration + e2e run on a real Postgres; **zero disabled tests**.
- **Audit verdict:** no launch **blockers**. One MEDIUM security finding was **fixed in this candidate**; the remainder are documented, non-blocking tech-debt or explicit decision-items.
- **Nothing is activated.** All Stage-Two AI (receptionist autonomy, WhatsApp, missed-call text-back, booking execution) ships **dark** behind default-`false` flags that additionally require external credentials.

## 2. Architecture summary

Next.js 15 (App Router, RSC) + Supabase Postgres 17, multi-tenant via RLS (`current_org_ids()` / `is_org_admin()`). Single-per-concern systems verified by the architecture audit: **one** portal auth authority (`loadCustomerByPortalToken`), **one** customer directory, **one** money engine (`lib/money` + `lib/quotes/totals`), **one** universal attachment table (`tenant_attachments`), **one** audit writer per plane, **one** notification emitter. Committed spend (purchase orders) is deliberately separate from actual cost (`finances`) — no `supplier_bills` fork. No parallel systems, no dead code, no circular deps, no RLS bypass, no money-math drift.

## 3. What ships (by capability)

| Capability | State in RC3 |
|---|---|
| HQ AI task/approval/draft/comms substrate (`hq_*`) | Built, **dark** (HQ-internal) |
| Capability Registry (sole authority for AI-employee grants) | Built; legacy mirror retired + dropped (LR5.4B) |
| AI-SDK envelope + doorman + RunContext + Shadow Executor | Built, **shadow-only** |
| Voice Receptionist conversation engine (~28 migrations) | Built; decides/drafts/audits, **effect-free** |
| AI reply pipeline + human-review inbox | Built, **dark** |
| WhatsApp **inbound** channel (Meta webhook, routing) | Built, **dark** (outbound #360–362 **deferred** — see §8) |
| Semantic Shared Memory (embeddings + pgvector) | Built, **dark** (needs key + worker flag) |
| Tenant-integrity hardening (cross-tenant invoice-payment, billing claim-lease, portal token expiry, invoice snapshots) | Built — **real prod fixes, ship active** |
| **Site Management** — Snagging, Daily Diary, Toolbox Talks, Site Reports (immutable snapshot + PDF + portal) | Built, **active** |
| **Asset Management** — register, custody, QR, inspections (+templates/schedules/overrides), maintenance (+service schedules), holdings, history | Built, **active**; 2 daily crons |
| **Commercial** — job commercial position, accepted-quote immutability, retention, purchase orders, committed-cost-on-job, portal completion | Built, **active** |
| **Customer Experience** — guided first-run, sample data, comms-readiness, empty states, loading, polish | Built, **active** |
| Release-recovery fixes — accepted-quote freeze hardening (`20261007`), PO list bound, `server-only` QR module | Built, **active** |

## 4. Migration inventory (deployment order = filename-timestamp order)

**170 total = 100 on `main` (baseline, already applied) + 70 new.** All 70 are timestamped `20260730…20261007`, strictly after `main`'s applied max `20260729` — a clean append with **no interleaving and no duplicate timestamps**.

| Group (timestamp range) | Content | Notes / dependencies / rollback |
|---|---|---|
| HQ AI substrate + Capability Registry `20260730–20260811` | hq_approvals/drafts/communications/ai_tasks(+spine/cancel), capability_registry(+backfill/authoring/scope/retire), lr5_4a | Additive tables + FK + data backfill. `20260807` backfill **MUST** precede LR5.4B. Rollback: inert (HQ-internal, no live consumer). |
| **⚠ LR5.4B (the one irreversible)** `20260812` | `alter table ai_employees drop column tools_allowed, drop column permissions` | **DESTRUCTIVE + IRREVERSIBLE.** Forward-safe — Capability Registry is sole authority, no live reader. Depends on the `20260807` backfill. **Rollback: none** — mitigate with the pre-migration `ai_employees` snapshot (already captured). **Requires explicit authorization.** |
| Shadow Executor + Receptionist engine `20260813–20260909` | executor_shadow_observations, voice_receptionist, ai_reply_*, receptionist_conversation_* (28 migs), conversation claims | Additive tables + views + SECURITY DEFINER RPCs + append-only triggers. Sequential deps within the chain. RLS-on/zero-policy ledger posture. Rollback: inert (engine dark). |
| Tenant-integrity hardening `20260910–20260916` | support_messages_org_author, invoice_payments_org_integrity, automation_runs_claim_semantics, billing_events_claim_lease, portal_token_expiry, invoice_customer_denormalisation, invoice_line_item_snapshot | Additive columns/constraints/indexes that **fix real live-table issues**. Take effect immediately (intended). 4 non-concurrent index builds (customers/invoices/automation_runs/billing_events) — negligible now (prod small), brief write-lock only if re-applied over large data. |
| WhatsApp inbound `20260917–20260918` | whatsapp_webhook_events, whatsapp_number_routes | Additive, dark. |
| **Site Management** `20260919–20260923` | snags, site_diary, toolbox_talks, site_reports(+portal) | Additive tenant tables + RLS + `tenant_attachments` CHECK widening (each preserves prior targets). |
| **Asset Management** `20260924–20261003` | assets, asset_assignments, asset_qr_identities, asset_inspections(+safety/templates/schedules/overrides), asset_maintenance_cases(+service_schedules) | Additive; partial-unique custody invariant; SECURITY-INVOKER transfer RPC; admin-only cost satellite; 2 crons (`inspections-due`, `maintenance-due`). |
| **Commercial** `20261004–20261006` | accepted_quote_immutability, retention, purchase_orders(+line_items) | Additive; DB-enforced freeze/over-release/immutability triggers. |
| **Release-recovery hardening** `20261007` | harden_accepted_quote_freeze | `CREATE OR REPLACE` of two freeze functions — re-keys on `accepted_at` (closes the status side-channel). No schema change. |

**`tenant_attachments.target_table` CHECK** — audited across all redefinitions: monotonic growth, **no target ever dropped**. Final allowlist (15): customers, jobs, quotes, invoices, suppliers, memberships, leads, snags, site_diary_entries, toolbox_talks, site_reports, assets, asset_assignments, asset_inspections, asset_maintenance_cases.

## 5. PR disposition (58 open PRs)

- **In RC3 (are the release):** the linear stack #367–#374, #376–#396 + foundation chain #189/#190/#269–#274 + #187/#188 (HQ, already in-stack) — **close as included when RC3 merges**. Plus **CX #364–366** and the `20261007` hardening (both folded in during consolidation).
- **Close as superseded (content already in `main`/stack):** #119 (imports needs-review — migration byte-identical), #182 (bible analysis — byte-identical).
- **Close as release-meta (superseded by RC3):** #363, **#375 (RC2)**.
- **Close as obsolete:** #171 (design-system — 52 commits stale, dirty, none landed), #268 (orphaned executor fork), #267 (optional governance doc).
- **Deferred decision-items (NOT in RC3):** see §8.

*(These close-recommendations are for the human release owner to execute — the consolidation does not close PRs, preserving history.)*

## 6. Feature flags (all default `false` = dark)

| Flag | Gates | State |
|---|---|---|
| `NEXT_PUBLIC_FEATURE_WHATSAPP` | + Meta app secret / verify token | Dark |
| `NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK` | + Twilio creds + `TWILIO_SMS_FROM` | Dark |
| `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION` | strongest eligibility = `requires_human_review` | Dark |
| `NEXT_PUBLIC_FEATURE_VOICE_NOTES` | (schema only, no runtime) | Inert |

## 7. Environment / cron / storage / secrets (prod-readiness inventory)

- **Hard-required env (boot crashes if missing):** `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Operationally required (schema-optional):** `CRON_SECRET` (**all 19 crons 401 without it**), `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`.
- **Env-schema gap (recommended pre-launch):** add `RESEND_NOTIFICATIONS_FROM`, `COMPANIES_HOUSE_API_KEY`, `CHANNEL_INBOUND_SECRET`, `CREWFLOW_INTERNAL_ORG_ID`, `CREWFLOW_EXECUTOR_SHADOW`, `DEMO_NOTIFY_EMAIL` to `lib/env.ts` so misconfig fails fast at boot.
- **Cron:** 19 jobs in `vercel.json`, each with a matching authenticated route (`isCronAuthorised()` fails closed). New in this release: `inspections-due` (05:00), `maintenance-due` (05:30). 6 crons lack an explicit `maxDuration` (fall to platform default).
- **Storage buckets (7, all declared):** compliance-docs, imports, job-docs, job-photos, portal-uploads, receipts, tenant-attachments.
- **External integrations:** Supabase, Resend (email), Stripe (billing), Twilio (SMS — dark), Vapi (voice — decision-item), Anthropic/OpenAI (optional), Meta/WhatsApp (dark), Companies House, Sentry/PostHog/BetterStack.

## 8. Deferred / decision-items (NOT in RC3 — reasoned)

| Item | Why deferred | Path to include |
|---|---|---|
| **WhatsApp draft-first + outbound (#360–362)** | **3-way migration timestamp collision**: its migs `20260919/20/21` collide with the stack's snags/diary/toolbox at the same timestamps → would create duplicate-timestamp migrations. Also dark + activation is a product decision. | Re-date the 3 WhatsApp migrations to `>20261007`, re-verify clean apply, then merge. |
| **Telephony / Vapi spine (#113)** | **Failing CI** on the PR; inbound-phone channel is a product-scope decision. | Fix CI + product decision on phone channel; re-date its migration (`20260630` < prod max). |
| **Address-first search (#136)**, **Company-logo upload (#137)** | New features during a release freeze; both need migration re-dating (dates predate prod max) + conflict resolution. | Post-launch fast-follows on top of RC3. |
| **Imports customer-vs-staff (#121)** | Enhancement (imports already works); `detect.ts` 3-way diverged → conflict. | Cherry-pick + resolve post-launch. |
| **Perf org_id indexes (#128)** | Safe/additive but needs migration re-dating; no missing-index hotspot on the new work. | Post-launch perf fast-follow (re-date migration). |
| **launch-checklist probe (#148)** | Small `next.config` fix; conflicts with stack config. | Cherry-pick post-launch. |

## 9. Known tech-debt (non-blocking, tracked)

1. **Stale generated Supabase types** (`lib/supabase/types.ts`, frozen ~`20260527`) → **292 `.from(...as never)` casts, 556 total `as never`, across 165 files** (verified count; an earlier draft under-reported this as 216/106). Regenerate against the RC3 schema before/just-after launch — highest bug-surface reduction. (Requires DB access.)
2. `lib/retention` (customer-health) vs `lib/retentions` (contract holdback) naming collision — rename one post-launch.
3. `round2` duplicated 5× (all identical today) — collapse the 4 legacy copies onto `lib/money.round2`.
4. Two deliberate feature limitations, both documented: Toolbox-talks attendance is free-text (no structured sign-off); QR scan resolves a token rather than logging a scan event.

## 10. Verdict

RC3 is a coherent, CI-green, migration-safe, security-sound consolidation of the entire accumulated platform. It is **ready to be evaluated for a production cutover**; the go/no-go, the LR5.4B authorization, and the credential/flag decisions remain with the human release owner. See `docs/PRODUCTION-DEPLOYMENT-RUNBOOK-RC3.md` for the deploy + rollback procedure and the final CTO report for the full risk assessment and launch checklist.
