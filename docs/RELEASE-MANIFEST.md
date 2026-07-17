# CrewFlow — Production Release Manifest

> **Canonical release document.** Directive `018-r6` branch → production `main`.
> Authored 2026-07-17. This document is authoritative and self-contained: a new CTO can deploy
> CrewFlow safely using only this manifest. Supersedes ad-hoc notes; cross-references
> `docs/directive-to-main-release-readiness.md` (audit) and `docs/whatsapp-*.md` (channel detail).
>
> **Release identity:** the entire directive branch (`directive/018-r6-controlled-live-execution`)
> **plus** the 3 open WhatsApp PRs (#360 → #361 → #362, merged in order) = the release candidate.
> Production `main` currently ends at migration `20260729`. Nothing in the delta is in production yet.

---

## 1. Executive summary

This is a **single major-version release** of the whole directive branch: **54 migrations, ~161 merged
PRs, directives #012–#018**. It is overwhelmingly **additive and DARK** — every new capability is gated
behind default-`false` feature flags and absent vendor credentials, layered on a **live, unaffected
Customer-CRM + Stripe-subscription-billing base**. It also delivers **real production integrity fixes**
(cross-tenant invoice-payment, billing claim-lease race, org-scoping) currently stuck behind the merge.

**Deploy model:** one grouped migration batch → dark code deploy → phased per-feature flag activation.
**One irreversible operation** in all 54 migrations (LR5.4B), verified forward-safe. **Zero new
required-to-boot env vars. No new npm dependency.** Rollback is a config flip. **Readiness: 88/100.**
**Recommendation: GO to ship dark**, subject to the §20 sign-off.

---

## 2. Architecture summary

CrewFlow is a Next.js 15 (App Router, Vercel) + Supabase (Postgres + RLS) multi-tenant SaaS for UK
construction firms. Two planes:

- **Customer plane (LIVE in prod):** jobs, quotes, invoices, customers, scheduling, customer portal
  (~58 pages, ~61 API routes), Stripe subscription billing, Event-Spine audit/timeline, lexical Shared
  Memory. The delta does **not** alter these except additively (integrity hardening).
- **AI plane (this release, DARK):** the AI-employee **execution kernel** built bottom-up over #012–#018 —
  Task Engine, RunContext, AI-SDK envelope + doorman (permissions), Capability Registry, shadow Executor —
  plus the **Voice/WhatsApp Receptionist** conversation engine (intent→goal→…→action→execution→
  authorisation, human-review inbox, governed transport seam), and 11 framework-only HQ AI employees.
  Everything here is inert until flags + credentials are set.

**Core safety doctrines:** database guarantees over app guarantees (RLS, claim-before-act ledgers,
composite-FK tenant integrity); one transport seam (no provider reachable outside it); one execution
engine (shadow-only until armed); deny-by-default (flags off, providers null, policy `review/block`).

---

## 3. Every merged feature (by capability)

| Capability | State in this release |
|---|---|
| HQ AI task/approval/draft/comms substrate (`hq_*`) | Built, dark (HQ-internal) |
| Capability Registry (sole authority for AI-employee grants) | Built; legacy mirror retired + dropped |
| AI-SDK envelope + doorman (P5 permissions) + RunContext | Built, dark |
| Shadow Executor (typed contract, no live ToolImplementation) | Built, **shadow-only** |
| Voice Receptionist conversation engine (~28 migrations) | Built; decides/drafts/audits, effect-free |
| AI reply pipeline (audit → transport → delivery receipt ledgers) | Built, dark |
| Human-review inbox + multi-operator claim/release/reassign | Built, dark |
| WhatsApp inbound channel (Meta webhook, claim, routing) | Built, dark |
| WhatsApp draft-first engine + governed transport + receipts | Built, dark (PRs #360/#361/#362) |
| Semantic Shared Memory (OpenAI embeddings + pgvector) | Built, dark (needs key + worker flag) |
| **Tenant-integrity hardening** (cross-tenant invoice-payment, billing claim-lease, org-scoping, portal token expiry, invoice snapshots) | **Built — real prod fixes, ship active** |

## 4. Every merged directive

| Directive | Title | Status in release |
|---|---|---|
| #012 | Task Engine | Complete (branch) |
| #013 | RunContext | Complete (branch) |
| #014 | AI-SDK envelope + doorman + executor | Complete; executor shadow-only |
| #015 | Capability Registry (LR5 legacy removal) | Complete; LR5.4B irreversible drop included |
| #016 | Live-Executor Rollout | In progress (R1 merged, R2 authorised, R3–R6 pending) — **shadow only in this release** |
| #017 | API Gateway + cost metering | Shipped on branch; **no ADR/ledger record (debt, §15)** |
| #018 | Controlled Live Execution — WhatsApp Employee #27 | Complete (branch), dark; **no ADR (debt, §15)** |

## 5. Every merged PR

**~161 PRs** compose the release: **158** merged into the directive branch (`git log --merges
origin/main..origin/directive/018-r6-controlled-live-execution`) **+ 3** pending WhatsApp PRs
(#360, #361, #362). By workstream: 72 `directive/*`, 35 `docs/*`, 24 `feat/*`, 15 `vision2030/*`,
7 `security/*`, 3 `fix/*`, 1 `ci/*`, 1 `adr/*`. The full enumerated list is the git merge log above
(authoritative); the release does not depend on reciting each — it depends on §6 (migrations) and
§7–9 (config). Most recent hardening PRs: #351 (invoice-payments org integrity), #353/#355 (claim
concurrency), #356 (portal token expiry), #357/#358 (invoice snapshots), #359 (WhatsApp foundation,
merged), #360/#361/#362 (WhatsApp draft-first/outbound/docs, pending).

## 6. Every migration (deployment order = filename-timestamp order)

**54 migrations, `20260730` → `20260921`.** Deploy **all in one monotonic pass, before the code
deploy** (single prod DB, no staging). Property unless noted: **additive · idempotent (`if not
exists`) · reversible-by-inaction (inert while flags off; no down-migration needed).**

| Group (timestamp range) | Migrations | Notes / dependencies / rollback |
|---|---|---|
| **HQ AI substrate** `20260730–20260805` | hq_approvals, hq_drafts, hq_communications, hq_ai_tasks (+_spine, +_cancel), hq_memories_bound_task_fk | Additive tables + FKs. `_spine` depends on `hq_ai_tasks`. Rollback: inert (HQ-internal, no consumer live). |
| **Capability Registry** `20260806–20260811` | capability_registry, _backfill, _native_authoring, _native_memory_scope, _retire_capability_mirror, lr5_4a_memory_write_registry_authority | Additive + data backfill from legacy columns into the registry. `_backfill` MUST precede `lr5_4b`. Rollback: registry inert; backfilled data harmless. |
| **⚠ LR5.4B (the ONE irreversible)** `20260812` | lr5_4b_remove_legacy_authority_columns | **DESTRUCTIVE + IRREVERSIBLE**: `alter table ai_employees drop column tools_allowed, drop column permissions`. **Forward-safe — verified no live reader** (Capability Registry is sole authority; apparent refs are an RPC-envelope read + audit-metadata jsonb). **Depends on** the registry backfill (`20260807`) completing first. **Rollback: none** — mitigate with a pre-migration `ai_employees` snapshot; operationally never needed (no dependency). **Requires CEO authorisation (§20).** |
| **Shadow Executor** `20260813` | executor_shadow_observations | Additive ledger. Rollback inert. |
| **Voice Receptionist engine** `20260814–20260909` (28 migs) | voice_receptionist_ai_employee, ai_reply_{audits,transports,delivery_receipts,lifecycle_view}, receptionist_conversation_{substrate,read_model,human_review_inbox,runtime,intent,goal,information,outcomes,actions,executions,authorisations,fulfilments,verifications,recoveries,resolutions,lifecycles,orchestrations,coordinations}, coordination_read_model, conversation_{claims,claim_releases,claim_reassignments} | Additive tables + views + SECURITY DEFINER RPCs + append-only triggers. Sequential dependencies within the chain (later ledgers reference earlier). RLS-on/zero-policy ledger posture. Rollback: inert (engine dark). |
| **Tenant-integrity hardening** `20260910–20260916` | support_messages_org_author, invoice_payments_org_integrity, automation_runs_claim_semantics, billing_events_claim_lease, portal_token_expiry, invoice_customer_denormalisation, invoice_line_item_snapshot | Additive columns/constraints/indexes that **fix real cross-tenant + concurrency issues on LIVE tables**. Safe supersets (existing rows satisfy new constraints). These take effect immediately (not flag-gated) — that is intended (they harden live data). Rollback: additive, reversible-by-inaction. |
| **WhatsApp** `20260917–20260921` | whatsapp_webhook_events, whatsapp_number_routes, inbound_enquiries_provider_dedup, widen_transport_channel_whatsapp, whatsapp_read_receipt_status | Additive (new tables, add-column-with-default, CHECK-widening). `20260919/21` predate `20260920` by PR order — **apply all 5 in one pass** so they land monotonically. Rollback: inert (WhatsApp dark). |

**No `drop table`, `truncate`, or `delete from` anywhere in the delta.** RLS is enabled on every new
table. The only irreversible statement is LR5.4B.

## 7. Feature flags

All are `NEXT_PUBLIC_FEATURE_*`, `z.enum(["true","false"]).default("false")`, read with strict
`=== "true"`. **Production owner: Platform/CEO** (set in the Vercel project env). Rollout order is the
§10 activation sequence; all default OFF and safe-dark.

| Flag | Default | Gates | Rollout order |
|---|---|---|---|
| `NEXT_PUBLIC_FEATURE_WHATSAPP` | `false` | WhatsApp inbound webhook + engine entry | 3rd (after per-org enable) |
| `NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK` | `false` | Phone missed-call SMS text-back (live send) | later (needs Twilio) |
| `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION` | `false` | Booking-execution eligibility (`blocked_by_org`→`requires_human_review` only; never autonomous) | last (governance-gated) |
| `NEXT_PUBLIC_FEATURE_VOICE_NOTES` | `false` | Voice-note capture | independent |

Per-org gate (not an env flag): `ai_receptionist_setups.enabled=true AND status='live'` (owner: Platform,
set in DB per tenant). Provider seams (`COMMS_{EMAIL,SMS,WHATSAPP}_PROVIDER`) default `"auto"` = dark
without vendor keys.

## 8. Environment variables

**Required-to-boot (already in prod `main` — no new ones):** `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. **The 11 new delta vars are all
optional/defaulted → zero new boot prerequisites.** Owner for all: Platform/CEO (Vercel env).

| Var | Req? | Default behaviour if unset |
|---|---|---|
| `WHATSAPP_APP_SECRET` | to activate WA inbound | webhook HMAC fails closed (dark) |
| `WHATSAPP_VERIFY_TOKEN` | to activate WA inbound | GET handshake 403 (dark) |
| `WHATSAPP_ACCESS_TOKEN` | to activate WA outbound | provider null → `no_provider`, sends nothing |
| `WHATSAPP_PHONE_NUMBER_ID` | to activate WA outbound | provider null (dark) |
| `WHATSAPP_GRAPH_VERSION` | no | defaults `v21.0` |
| `COMMS_WHATSAPP_PROVIDER` | no | `"auto"` → Meta once creds set, else null |
| `COMMS_SMS_PROVIDER` / `COMMS_EMAIL_PROVIDER` | no | `"auto"` → Twilio/Resend if configured, else null |
| `TWILIO_SMS_FROM` | to activate SMS send | SMS seam returns null (dark) |
| `TWILIO_STATUS_CALLBACK_URL` | no | route reconstructs from headers |
| `NEXT_PUBLIC_FEATURE_*` (4) | no | all `false` (dark) |

Pre-existing optional (confirm still set in prod): Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`),
Resend (`RESEND_API_KEY`), AI (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), observability
(`NEXT_PUBLIC_SENTRY_DSN`, `BETTERSTACK_*`, `POSTHOG_*`), `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.

## 9. Third-party services

| Service | Configured? | Optional? | Required before go-live? | Health verification |
|---|---|---|---|---|
| Supabase (Postgres/RLS) | Yes (live) | No | Yes (already) | `/api/health` 200; migrations applied |
| Vercel (hosting/cron) | Yes (live) | No | Yes (already) | deploy Ready; 2 new crons registered |
| Stripe (subscription billing) | Yes (live) | No (billing) | Already live | webhook success rate flat |
| Resend (email) | Yes (live) | Feature | No (live via legacy mailer) | test email deliverability |
| Anthropic / OpenAI | Optional | Yes | No (AI dark) | key presence; embeddings worker off |
| Twilio (SMS/voice) | Optional | Yes | Only to activate SMS/voice | number + status-callback |
| **Meta WhatsApp** | **Not yet** | Yes | **Only to activate WhatsApp** | app/WABA/verification/sender/tokens/webhook (see WA inventory) |
| Sentry / BetterStack / PostHog | **Confirm set** | Yes | **Recommended before deploy** (else blind) | error events flowing; §12 |
| Inngest | Dormant (0 refs) | Yes | No | n/a |

## 10. Smoke tests (post-deploy, DARK)

1. `GET /api/health` → 200 + commit SHA (app booted on the new build).
2. Existing CRM + billing pages load and function (regression-free — live base unaffected).
3. `GET/POST /api/webhooks/whatsapp` → **404 `not_enabled`** (route present, gate closed).
4. New ledger tables exist with **0 tenant rows** (`whatsapp_webhook_events`, `whatsapp_number_routes`,
   `ai_reply_transports`, `ai_reply_delivery_receipts`, `hq_ai_tasks`).
5. `select count(*)` on a sample of migrated tables — batch applied cleanly.
6. Stripe subscription webhook still processes (existing live path unbroken).
7. Both new crons (`overdue-invoices`, `task-reaper`) execute without auth errors.

## 11. Production verification checklist (dark, correctness)

- [ ] Migrations `20260730→20260921` all applied (54 rows in `supabase_migrations`).
- [ ] App boots; `/api/health` green with the new SHA.
- [ ] Existing customer features regress-free (jobs/quotes/invoices/portal/scheduling).
- [ ] All `NEXT_PUBLIC_FEATURE_*` read `false` in the deployed bundle.
- [ ] WhatsApp webhook dark-404; no `ai_reply_transports` row with `status='sent'`.
- [ ] `ai_employees` has no `tools_allowed`/`permissions` columns; AI-boardroom admin page renders (registry authority).
- [ ] Sentry error rate flat vs pre-deploy baseline.
- [ ] Integrity-hardening effective: spot-check an invoice-payment is org-scoped.

## 12. Rollback procedure

| Scenario | Action | Property |
|---|---|---|
| Any severity — kill all new features | `NEXT_PUBLIC_FEATURE_*=false` (already default) + redeploy env | Instant; webhook 404s, providers null |
| Stop a channel's outbound | clear `WHATSAPP_ACCESS_TOKEN` / `COMMS_*_PROVIDER=off` | Instant; records `no_provider` |
| Single tenant | `ai_receptionist_setups.status` off `live` / route `active=false` | Per-tenant |
| Bad AI/receipt data | disable outbound; ledgers are append-only + immutable triggers | No mutable state to unwind |
| Schema | **none needed** for 53 additive migrations (inert while dark) | — |
| **LR5.4B** | **cannot be reversed**; restore `ai_employees` from the pre-migration snapshot only if ever needed (no live dependency, so never operationally required) | Mitigated by snapshot |

**Rollback = a config flip, not a deploy revert or schema down-migration.**

## 13. Incident response

- **App won't boot after deploy:** almost certainly a migration not applied — verify all 54 applied;
  check Vercel build log for env-validation throw (only the 3 long-standing vars are required).
- **Error-rate spike (Sentry) while dark:** a migration or boot regression — roll the deploy back to the
  prior Vercel deployment (code revert is safe; migrations are additive and stay applied harmlessly).
- **A dark feature appears armed** (`ai_reply_transports.status='sent'` unexpectedly): flip its flag off +
  clear its provider creds immediately; investigate which gate opened.
- **Cron failures:** confirm `CRON_SECRET` set and migrations applied (`task-reaper` needs `hq_ai_tasks`).
- **Escalation:** production DB is single-instance, no staging — treat any migration anomaly as
  sev-1; the additive/idempotent design means re-running a migration is safe.

## 14. Monitoring

- **Sentry:** error-rate step-change — must stay **flat** while dark (the primary post-deploy signal).
- **Billing:** Stripe webhook success rate unchanged.
- **Event Spine:** cron/drain health; no stuck rows.
- **New ledgers:** `whatsapp_webhook_events` in-flight rows aging past the 15-min lease; **any
  `ai_reply_transports.status='sent'` before intended** (canary: an outbound seam armed unexpectedly).
- **Crons:** `overdue-invoices` / `task-reaper` succeed without auth failures.
- **Confirm before deploy:** Sentry + BetterStack env actually set in Vercel, or the above is blind.

## 15. Known technical debt

- **#017 / #018 have no ADR/ledger record** — governance canon (`numbering.md`, ADR ledger) is ~2
  directives behind the shipping work. Reconcile (safe, doc-only).
- **`docs/roadmap.md` stale at #009** — the reconciled living roadmap lives in
  `directive-to-main-release-readiness.md §2`; formalise into `roadmap.md`.
- **LOW security note:** legacy `/api/receptionist/inbound` trusts a body `org_id` behind a shared
  secret with a plain `!==` compare (ingest-only, not an IDOR). Hardening: constant-time compare +
  per-org secrets. Non-blocking.
- **`packageManager: pnpm` declared but repo ships `package-lock.json`** (npm) — pre-existing, unchanged.
- **Executor shadow-only** — no live `ToolImplementation` bound; the AI plane decides/drafts but does
  not act. Intended for this release.

## 16. Deferred roadmap

WhatsApp rich media + autonomous acknowledgements (default-off, governance-gated); the Sales
**conversion half** (send→reply→demo→won); Boardroom write/act (11 employees inert); Shared Comms
Protocol; Blueprint Centre / Mobile / Offline (Customer-WOW tier, gated behind an unbuilt design
system). **Critical path after this release:** arm **one** execution/outbound seam (the shared
bottleneck of the kernel, receptionist, comms, and sales).

## 17. Future migrations (post-release, pre-identified)

- Arming an execution/outbound seam will add outbound-send + delivery ledgers wiring (mostly built).
- Semantic memory activation needs no migration (schema shipped; needs key + worker flag).
- Sales conversion half will add outreach-send + reply-tracking tables.
- Governance-canon reconciliation is doc-only (no migration).

## 18. Release risk assessment

| Risk | Sev | Mitigation |
|---|---|---|
| LR5.4B irreversible drop | Med | Forward-safe (verified); pre-migration snapshot; CEO gate |
| 54 migrations to single prod DB, no staging | Med | Additive/idempotent; near-empty new tables → no long locks; one monotonic pass |
| Dark feature accidentally armed | Med | Triple-gated (flag-false + strict compare + absent creds); canary monitor |
| Ship blind (Sentry env unset) | Med | Confirm observability env pre-deploy (§20) |
| Authoritative full-delta CI not yet run | Med | Open the integration PR → six-gate CI before merge |
| Integrity-hardening migrations act on live tables immediately | Low | Verified safe supersets; they *fix* existing bugs |

## 19. Release score: **88 / 100**

Migration safety 19/20 · boot/deploy 20/20 · flag safety 15/15 · security/isolation 14/15 ·
CI rigour 10/15 (authoritative full-delta CI pending) · observability 10/15 (confirm env). No
release-blocking bug found.

## 20. CEO sign-off checklist

- [ ] **Authorise the production cutover** (directive → main).
- [ ] **Authorise the irreversible LR5.4B** `ai_employees` column drop (forward-safe; snapshot taken).
- [ ] Confirm **Sentry / BetterStack env are set** in Vercel prod (else deploy is blind).
- [ ] Approve the **deploy plan**: migrate all 54 first → deploy dark → phased flag activation.
- [ ] Acknowledge **no feature activates on deploy** (all flags off; providers dark) — activation is a
      separate, per-feature, reversible step.
- [ ] Approve opening the **directive → main integration PR** (triggers the authoritative six-gate CI).

**On sign-off:** take the `ai_employees` snapshot → open the integration PR (six-gate CI) → on green,
apply migrations → deploy dark → run §10 smoke + §11 verification → hold at dark; activate features
per §10 on a later CEO go.
