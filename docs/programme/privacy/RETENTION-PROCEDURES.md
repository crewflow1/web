# Retention procedures — what enforces each period today

Prepared 2026-11-16 on `privacy/data-minimisation` · validates `RETENTION-SCHEDULE.md`; **invents no period**. A row says either "enforced by X (period set in code)" or "none — needs founder period (PD-x)". Code on `main` d24295e plus this branch; the #1091 deletion workstream (account/company/staff erasure, tombstones) is pending and is listed as "pending #1091" where it changes the answer.

Legend: **ENFORCED** = a scheduled job runs unprompted and deletes; **GATED** = exists, switched off; **MANUAL** = a person must call it; **NONE**.

## 1. Mechanisms, verified

| # | Mechanism | Period (in code) | Trigger (file) | Verification run for this document |
|---|---|---|---|---|
| M1 | `cron_runs` prune | success 14 d, failed/unfinished 90 d (`server/services/cron-runs-prune.ts`; SQL guard: success >= 8 d, failure >= success) | cron `/api/cron/cron-runs-prune` daily 04:25 (`vercel.json`) | **Real Postgres:** `__tests__/integration/ops/cron-runs-prune.test.ts` (5 tests, pass) — old success deleted, recent kept, old failure survives the success horizon, crashed run treated as failure, ancient failure deleted |
| M2 | Rate-limit counter sweep | windows closed > 1 day (`rate_limit_sweep()`, migration `20260707000000`) | same cron route, fail-soft (`app/api/cron/cron-runs-prune/route.ts` → `sweepExpiredCounters`) | **NEW real-Postgres test** `__tests__/integration/privacy/rate-limit-sweep.test.ts` (1 test, pass): a 2-day-old window is deleted, a recently closed and an open window are kept. Existing unit tier `__tests__/security/rate-limit.test.ts` pins the call and the digest keys |
| M3 | Notification email queue clean-up | status `sent`/`skipped` older than 90 d; `failed`/`queued` never deleted (`lib/notifications/email.ts` `cleanupOldEmailRows`) | called by `app/api/cron/notifications-drain/route.ts` (every 15 min) and `server/services/hq-cadence.ts` | Unit tier `__tests__/notifications/email-drain.test.ts` (existing). Not re-run against Postgres |
| M4 | Document-import purge (`form-imports`) | 7 days after upload (`AUTOFILL_RETENTION_DAYS`); consumed/discarded drafts immediately (`purgeExpiredFormImports`, `server/services/document-autofill.ts`) | `app/api/cron/retention-purge/route.ts`, **not** behind the flag, daily 03:45 | Code read; storage removal + row delete both error-checked. No dedicated test found by grep (`purgeExpiredFormImports` is unreferenced in `__tests__`) — **gap: add a test when the autofill area is next touched** |
| M5 | Per-org retention policies | tenant-chosen 30-3,650 d over 10 allow-listed tables (`lib/retention/policy.ts`, SQL `retention_purge_run`, migration `20261184000000`) | same cron; `FEATURE_RETENTION_PURGE` default OFF → dry-run only | Existing: `__tests__/security/retention-purge-primitive.test.ts`, `retention-policy-exclusions.test.ts`. Production: 0 policies, 0 log rows — never acted |
| M6 | Activity-log purge | operator-chosen interval (runbook example 24 months) (`purge_activity_log`, migration `20260710000000`, `docs/activity-log-retention.md`) | **MANUAL** — nothing calls it (grep over `app lib server` finds only the generated types) | Existing `__tests__/ops/activity-log-retention.test.ts`. Not scheduled |
| M7 | HQ memory lifecycle / purge tombstone | worker-driven expiry; explicit `hq_memory_purge` | `/api/cron/memory-lifecycle` gated by DB flag `memory_lifecycle.worker_enabled`; CrewFlow-internal data | Existing `memory-purge-invariants.test.ts`, integration `memory/purge-path.test.ts` |
| M8 | Cookie consent record | 365 d (`CONSENT_MAX_AGE_SEC`) | browser cookie expiry | Code only; consent workstream owns |
| M9 | Photo/image upload metadata removal (storage minimisation, not an age rule) | n/a | `lib/uploads/strip-image-metadata.ts` on all 15 upload files | `__tests__/uploads/strip-image-metadata.test.ts` (8) + source guard `__tests__/security/image-upload-metadata-guard.test.ts` (17) |
| M10 | Org erasure (`gdpr_erase_org`, `POST /api/gdpr/erase`) | on request | `FEATURE_GDPR_ERASURE` default OFF (503) | Existing tests; pending #1091 replaces/extends with company deletion (7-day cooling-off) behind `FEATURE_ACCOUNT_DELETION` |

Not retention: `whatsapp-events-sweep` (`server/services/whatsapp-events-sweep.ts`) retries failed webhook rows and dead-letters after 5 attempts; it deletes nothing. `spine-partitions` creates future partitions of `hq_events` and never drops old ones.

## 2. By data class (classes and order follow `RETENTION-SCHEDULE.md` §2)

### 2.1 Tenant business data (CrewFlow = processor)
| Data class | Enforcing mechanism today | Period set? | Decision needed |
|---|---|---|---|
| Customers, contacts, properties | none (manual delete; FK-blocked with history). M5 cannot target it (not allow-listed) | no | Tenant's; CrewFlow default only via PD-9/PD-16 |
| Leads / enquiries (`leads`, `inbound_enquiries`) | none | no | Stale-lead age rule — **PD-10/PD-15 area, founder** |
| Quotes, invoices, payments, valuations, retentions, POs | none; kept + anonymised on org erasure | no | Statutory records (**PD-9**) |
| Jobs, diaries, snags, reports, certificates, warranties | none | no | **PD-9** |
| Files (buckets `job-photos`, `receipts`, `blueprints`, `job-docs*`, `tenant-attachments`, `portal-uploads`, `compliance-docs`) | org erasure only (M10); stripped of EXIF on write (M9) | no | **PD-9 / PD-1** |
| E-signature evidence | none (kept with quote) | no | — |
| Portal tokens | rotation / optional expiry column | per token | — |
| Suppliers / subcontractors / CIS | none | no | **PD-9** |
| Import staging (`imports`, `import_files`, `import_rows`, bucket `imports`) | **none** (M4 covers only `form-imports`, a different feature) | no | **PD-15** |
| Search index | follows source row (queue) | n/a | — |

### 2.2 Tenant staff data
| Data class | Mechanism | Period set? | Decision |
|---|---|---|---|
| Account identity | membership delete only; accounts never deleted — pending #1091 | no | **PD-16** |
| Pay, tax, NI number, DOB, pension, emergency contact, payroll lines | **none** (rows reference `users`, not `memberships`) | no | **PD-14** |
| Timesheets, rota, leave | none | no | **PD-14** |
| Qualifications + card scans | row cascades on membership delete; file removal unverified | partial | **PD-14** |
| H&S acknowledgements, inductions, toolbox attendance | none; `ON DELETE RESTRICT` blocks user deletion | no | **PD-14 / PD-16** |
| Notifications | M5 (tenant opt-in policy, unused) | no default | founder default? |

### 2.3 CrewFlow's own data (controller)
| Data class | Mechanism | Period set? | Decision |
|---|---|---|---|
| Demo requests, sales CRM | none | no | **PD-10** |
| Billing (`billing_invoices`, `billing_events`, `org_subscriptions`) | none (kept on erasure) | no | CrewFlow's accounting duty — **legal** |
| Support-access audit (`impersonation_sessions`, raw IP) | none | no | **PD-13** |
| `admin_activity_log` | none (append-only trigger) | no | **PD-13** |
| `activity_log` | M6 manual only | no schedule | **PD-13** |
| AI usage ledger (`ai_invocations`, `ai_cost_reservations`) | none; `user_id` nulled on erasure | no | founder |
| `hq_events`, `hq_timeline` | none (partitions never dropped) | no | **PD-13** |
| `comm_events`, webhook inboxes (`whatsapp_webhook_events`, `email_webhook_events`, `billing_events`, `call_events`) | none | no | **PD-15** |
| Voice `calls` (transcripts, recording URLs), `missed_call_textbacks` | none (dark) | no | **PD-15** + DPIA-03 |
| `telematics_readings` | M5 only if a tenant sets a policy (dark) | no default | DPIA-04 |
| `rate_limit_counters` | **M2 ENFORCED** (1 day after window) | yes | — |
| `cron_runs` | **M1 ENFORCED** (14 d / 90 d) | yes | — |
| `notification_email_queue` | **M3 ENFORCED** (sent/skipped 90 d) | yes | `failed`/`queued` rows never age out — minor |
| `form_import_drafts` + `form-imports` bucket | **M4 ENFORCED** (7 d) | yes | — |
| Consent choice | **M8** 365 d | yes | — |
| `auth.sessions` (raw IP, UA) | Supabase project setting | **PD-17** | — |

### 2.4 Copies outside the live database
No mechanism in this repository sets these periods: Supabase backups (7 d, `NEEDS-FOUNDER`), Backblaze archive newest 8 weekly (`scripts/ops/off-platform-backup.sh` `CF_BACKUP_RETENTION`), local plaintext dumps (**PD-7**), and provider-held logs (Vercel, Sentry, PostHog, Resend, Anthropic/OpenAI, Twilio/Vapi, Meta): all `NEEDS-FOUNDER` from dashboards.

## 3. Summary

**Enforced and verified today (5):** `cron_runs` (real PG), rate-limit counters (real PG, new), notification email queue (unit), form-import documents (code read; test gap), consent cookie expiry.
**Available but not running:** per-org retention policies (flag off, 0 policies), activity-log purge (manual), org erasure (flag off), HQ memory lifecycle (DB flag).
**No mechanism, needs a founder-decided period before any job is built:** PD-1/PD-9 (tenant records after cancellation/statutory), PD-10 (prospects, demo requests), PD-13 (security/audit/event logs: `activity_log` schedule, `impersonation_sessions`, `hq_events`, `admin_activity_log`), PD-14 (ex-staff sensitive data), PD-15 (import staging, webhook payloads, comm events, call/transcript data), PD-17 (session lifetime), PD-7 (backups, local dumps), plus AI ledger and telematics defaults.

No deletion job was built or scheduled by this change. When the founder decides a period, the existing primitives to reuse are M5 (allow-listed tables), M6 (`purge_activity_log`), and the bounded-batch pattern in M1.
