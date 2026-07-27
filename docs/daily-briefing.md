# Daily Briefing — "what needs you today"

**Status:** built on `feat/daily-briefing` (off prod `ed748b5`). Unmerged, undeployed.
Migration `20261038`. Additive; no provider, bucket, cron or env introduced.

## What it is

The first thing an owner/manager sees on the dashboard: a short, ranked,
deadline-aware list of the things that need attention today, each with a **real
number** and a **deep link** — money, safety, operations and sales in one place.
It replaces "scan five different screens and hope you didn't miss anything" with
"CrewFlow tells you the few things that matter this morning."

This is the **AI Business Coach**, done the CrewFlow way: the intelligence is the
structured, evidence-backed items (OBSERVE → RECOMMEND → EXPLAIN), **not** a
black-box chatbot. It is fully deterministic and works in production today with
**no external AI provider**.

## What it surfaces (v1)

Composed entirely from CrewFlow's existing live signals — no new business rules:

| Item | Signal source | Category |
|---|---|---|
| `jobs_without_rams` | active jobs with no issued RAMS (`buildHealthSafetySnapshot`) | safety (critical) |
| `permits_expired` | live permits past expiry | safety (critical) |
| `permits_expiring` | permits expiring within 24h | safety |
| `rams_review_overdue` | issued RAMS past review date | safety |
| `compliance_expiring` | `compliance_documents.expires_at` within 30 days | safety |
| `toolbox_awaiting_ack` | delivered toolbox talks still unsigned | safety |
| `overdue_invoices` | `isInvoiceOverdue` authority (£ + oldest days) | money |
| `retention_due` | `computeRetentionDueRollup().dueNow` | money |
| `jobs_unassigned_tomorrow` | jobs scheduled tomorrow with `assigned_to` null | operations |
| `quotes_follow_up` | sent quotes, undecided, > 5 days | sales |
| `leads_cold` | open high-value leads (≥ £2,000) opened > 14 days | sales |

Each family emits **at most one aggregate item**, only when it triggers — the
briefing is a handful of lines, never a firehose.

## Architecture

- **`lib/briefing/compose.ts`** — PURE. `composeBriefing(input)` ranks items and
  filters dismissals. Severity **strictly dominates** (band gaps of 1000 vs a max
  secondary bonus of 350), so money/urgency only order items *within* a severity
  band — a critical safety item always outranks a high-value money one.
- **`lib/briefing/narrative.ts`** — PURE deterministic "coach voice" (greeting +
  count + "start with…"). *Seam:* when an LLM key lands, a service path may swap
  this for a richer generation, degrading to exactly this output when the provider
  is absent (mirrors `lib/ai/insight-narrative.ts`). No provider is wired today.
- **`server/services/briefing.ts`** — gathers the aggregates via RLS-scoped, paged
  reads (reusing `isInvoiceOverdue`, `computeRetentionDueRollup`,
  `buildHealthSafetySnapshot`), composes, and is **best-effort**: any failure
  degrades to an empty briefing so it can never break the dashboard.
- **`app/(app)/dashboard/_daily-briefing.tsx`** — server component at the top of
  the dashboard (owner/admin; staff are redirected to `/me`).
- **`app/(app)/dashboard/briefing-actions.ts`** — `dismissBriefingItem` server
  action on the **tenant client** (RLS is the authority).

## Dismiss / snooze

A user can mark a non-critical item "Done for today"; it returns tomorrow if the
condition still holds. Stored per-user in `briefing_dismissals` (migration
`20261038`), dated in UTC, idempotent (unique constraint), RLS-scoped to the
caller (`user_id = auth.uid()` + `org_id ∈ current_org_ids()`).

**Safety rule:** a live safety **breach** (`jobs_without_rams`, `permits_expired`)
is **not dismissible** — hiding a legal exposure for a day is unsafe. Enforced in
the composer, the action (rejects a crafted POST), and the UI (no button). The
briefing dismiss only declutters the feed; the underlying H&S register always
shows the item regardless.

## Security & tenancy

- Every read is RLS-scoped to the caller's JWT; the service also pins `org_id`.
- The dismiss table is per-user + org-scoped by RLS; no cross-user or cross-tenant
  write is possible (proven in `__tests__/integration/briefing/dismissals.test.ts`).
- `item_key` is allowlist-validated; no user-controlled strings are rendered.

## Tests

- `__tests__/briefing/compose.test.ts` (14) — ranking, severity dominance,
  per-family dedupe, dismiss filtering, the non-dismissible-safety invariant,
  determinism, key allowlist.
- `__tests__/briefing/narrative.test.ts` — greeting/headline/lead.
- `__tests__/integration/briefing/dismissals.test.ts` (7, real Postgres) — the RLS
  boundary: own-only visibility, cross-user/cross-tenant/anon denial, idempotency.

## Performance

~9 parallel RLS-scoped paged reads + `buildHealthSafetySnapshot`. Some overlap
with the dashboard's own reads (double-fetch) — acceptable at the launch horizon
(hundreds–low-thousands of rows/org); the deliberate next step is a DB-side SQL
aggregate / shared read, matching the dashboard's own scaling note. **Tracked P3.**

## Known limitations / follow-ups (tracked)

- **Cold-lead proxy** uses `created_at` (open + aged), not a true last-activity
  timestamp — conservative; refine with a real activity column later.
- **UTC day boundary** for dismissals (a BST user's day rolls at 01:00 local). Cosmetic.
- **AI narrative** deterministic only; LLM prose is a future provider-gated layer.
- **Payroll-approaching / cashflow-risk** deliberately omitted (no honest signal in
  the data yet — do not invent one).
