# CrewFlow Subsystem Ownership & Bus-Factor Map

> **Purpose.** Reduce bus factor. Today the deep context for most subsystems lives
> in git history and the audit-wave record, not in a durable, human-readable map.
> This document is that map: for every major subsystem it states **what it is,
> where it lives, the invariants that must never break, how it fails, how to
> recover it, and who owns it.** The `Owner` column is deliberately `TBD (CEO to
> assign)` — assigning named human owners is an organisational action, not an
> engineering one, and is the single biggest remaining bus-factor risk. Filling
> that column is the CEO/hiring action this document exists to surface.

**Scale context (2026-08-17):** Next.js 15 + React 19 + Supabase (Postgres),
single production project `jzntbskdqdopzwdqwvkp`, prod `crewflow.uk`,
**347 migrations** (tip `20261176`), **1,123 test files**. Email (Resend) is the
only live external provider; all others are built **dark** (activation = config).

---

## How to read this map

- **Invariants** are the things a change must never violate. If your change would break one, it is wrong even if CI is green — add a guard.
- **Failure mode** is what a real production incident in this subsystem looks like.
- **Recovery** is the first thing an on-call engineer should do.
- **Owner** = the human accountable. `TBD` means unassigned → bus-factor risk.

---

## Financial core

| Subsystem | Path(s) | What it is | Owner |
|---|---|---|---|
| Invoicing | `lib/invoices`, `app/(app)/invoices` | Invoice lifecycle, outstanding-amount authority | TBD |
| Finances / VAT / Corp-tax | `lib/finances`, `lib/tax`, `lib/reports` | Single VAT-quarter authority, corp-tax, profit docs | TBD |
| Payroll | `lib/payroll`, `app/api/payroll` | PAYE/NI/pension/student-loan compute, CSV, payslip PDF | TBD |
| CIS | `lib/cis`, `server/services/cis-deduction.ts` | Subcontractor deductions, HMRC verification gating | TBD |
| Payments | `lib/billing`, `app/payments` | Portal pay-now (Stripe, **dark**), reconciliation | TBD |
| Banking | `lib/integrations` (Plaid/Nordigen, **dark**) | Feed sync, cursor, dedupe | TBD |

**Invariants (financial core):**
- All money aggregates read via `fetchAllRows` — never a capped `select` (F-1).
- VAT computed by the **one** VAT-quarter authority; no per-surface re-derivation.
- Outstanding amount from the payment-ledger authority only.
- Payroll outputs use the **per-employee** tax profile (plan, NI category, sacrifice).
- CIS posting **refuses** on stale HMRC verification at both RPC and trigger.
- Composite `(id, org_id)` FKs on every money child row.

**Failure mode:** silent under-count of a money figure as a tenant grows (F-1),
or a cross-org money injection via a bare FK. **Recovery:** identify the surface,
confirm it routes through the authority + `fetchAllRows`, check the composite FK.

---

## Multi-tenancy & auth

| Subsystem | Path(s) | What it is | Owner |
|---|---|---|---|
| Auth / onboarding | `lib/auth`, `app/onboarding` | Sign-in, invite accept, org join | TBD |
| Active-org resolution | `lib/auth` (`getActiveOrgId`) | The pin every tenant query depends on | TBD |
| Staff invites | `server/services/staff-invite.ts` | Invite issuance — **authority in `app_metadata` only** | TBD |
| RLS + SECDEF RPCs | `supabase/migrations` | Row-level isolation, definer functions | TBD |

**Invariants:** invite authority (`invited_org_id`/`invited_role`) lives in
**`app_metadata`** (service-role-writable) — **never** `user_metadata` (the user
can self-write it → role escalation). Every SECDEF RPC re-checks caller org.
Every tenant read/write is active-org-pinned.

**Failure mode:** privilege escalation or cross-tenant leak. **Recovery:** this is
a P0 — check the active-org pin guards and the SECDEF-org guard first.

---

## Inbound / receptionist / comms

| Subsystem | Path(s) | What it is | Owner |
|---|---|---|---|
| Receptionist inbound | `app/api/receptionist/inbound`, `lib/receptionist` | Route inbound call/WhatsApp/email to the **destination-resolved** org | TBD |
| Voice (telephony) | `lib/ai-receptionist` | **Dark** — no live telephony creds (phone_numbers is the real gap) | TBD |
| Inbox / comms | `lib/inbox`, `lib/comms`, `app/(app)/inbox` | Unified inbound, reply composer | TBD |
| Outbound webhooks | `lib/*` + mig `20261087`/`20261176` | Per-org fair delivery, lease-reclaim | TBD |
| Email | Resend (**live**) | The one live provider | TBD |

**Invariant:** inbound org is resolved from the **dialed/destination** address
(`phone_numbers`/`whatsapp_number_routes`/`email_inbound_routes`), never trusted
from a body `org_id`; a mismatch is a 422, unresolvable is a 200 ack-drop.

---

## Operations, fleet, stock, H&S

| Subsystem | Path(s) | Owner |
|---|---|---|
| Fleet / assets / compliance | `lib/fleet`, `lib/assets`, `server/services/asset-maintenance-generator.ts` | TBD |
| Stock / operational stock | `lib/stock`, `app/(app)/stock` | TBD |
| Material requests / fulfilment | `lib/material-requests` | TBD |
| Health & Safety (RAMS/permits/toolbox) | `lib/health-safety`, `app/api/health-safety` | TBD |
| Job programme / EOT | `lib/job-programme`, `lib/eot` | TBD |

**Invariants:** stock write-path gate (no manufacture via bare `transfer_in`);
compliance maintenance types stay in parity across the two TS constant sets **and**
the DB CHECK (the tyres drift); H&S storage bytes are write-once/immutable with
SHA-256 content hashes.

---

## AI layer (governed, mostly dark)

| Subsystem | Path(s) | Owner |
|---|---|---|
| AI cost governor | `lib/ai/governor.ts` | TBD |
| AI employees / HQ | `lib/ai-employees`, `lib/hq` | TBD |
| Quote writer (**dark**) | mig `20261068` | TBD |
| Embeddings (governed) | mig `20261080` | TBD |

**Invariants:** **every** AI call site passes through the governor (atomic
reserve-then-settle under a per-org advisory lock; £-ceiling enforced *before* the
call, not after). A raw provider key must never reach a call site that bypasses
the ceiling. AI is generated, never faked; dark features stay dark until real
creds + a human decision.

---

## Platform / cross-cutting

| Subsystem | Path(s) | What it is | Owner |
|---|---|---|---|
| Request correlation | `lib/api/request-id.ts` | `x-request-id` mint/propagate, header-injection safe | TBD |
| Error monitoring | `sentry.*.config.ts`, `lib/monitoring/scrub.ts` | Sentry wiring + PII scrubber (**DSN-gated**) | TBD |
| Health / readiness | `app/api/health`, `lib/health/db-probe.ts`, `lib/monitoring/readiness.ts` | Liveness + DB probe | TBD |
| Offline | `lib/offline` | Write-queue + conflict resolution | TBD |
| Correctness guards | `__tests__/security/*` | The class-defect meta-tests (see `CORRECTNESS-GUARDS.md`) | TBD |
| Migrations | `supabase/migrations` | Schema-first; additive; migration-before-code | TBD |

---

## The bus-factor action (external)

**ENGINEERING COMPLETE / EXTERNAL PROOF REQUIRED.** Every subsystem above is
documented, tested, and recoverable from this map. The residual bus-factor risk
is purely organisational: **no named human owns any subsystem.** Closing it
requires the CEO to (a) assign a named owner per row and (b) hire/allocate enough
engineers that no subsystem has a bus factor of one. Neither is an action an
engineering session can perform — it is surfaced here as the explicit CEO action.
