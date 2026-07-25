# Retention release scheduling (Programme C extension)

Turns the passive "£X held" retention figure into **"£X due back on [date]"** —
the cash a builder most often forgets to chase. Extends the Programme C
construction-retention system (`jobs.retention_percent` + the `retention_releases`
ledger); adds no new table and no new cash-path invariant. Migration
`20261013000000`.

> **Staff-internal.** Retention is the customer's money the builder is chasing
> back; the schedule (and the dashboard rollup) are **never** exposed on the
> customer portal — pinned by a security test.

## Terms (on the job)

Three contract terms, added to `jobs` (1:1 with the job, same admin-only UPDATE
RLS as `retention_percent`):

| Column | Meaning |
|---|---|
| `practical_completion_date` (date, null) | Practical Completion — starts the defects clock; the release forecast anchors here. |
| `defects_liability_months` (int, default 12, CHECK 0–120) | Defects Liability / rectification period (UK convention is months). |
| `retention_first_release_pct` (numeric, default 50, CHECK 0–100) | % of accrued retention released at PC (JCT default 50; **100 = a single release at PC**). |

## The forecast (derived, never stored)

`lib/retentions/schedule.ts` (`computeRetentionSchedule`) is a **pure forecast
layer over the ledger** — the releases ledger stays the source of truth. Two
moieties (UK/JCT convention):

- **First** — `accrued × first%`, due at Practical Completion.
- **Second** — the remainder, **due *from*** PC + defects-liability months (the
  Certificate of Making Good can slip later, so it's a reminder, not an "overdue"
  alarm).

Two correctness rules the design turns on:

1. **Sized off `accrued` (= held + released), never live `held`.** `held` shrinks
   as money is released, so sizing a moiety off `held` would make a fully-released
   first moiety still appear to owe money. Reconstruct `accrued` and split that.
2. **FIFO waterfall** reconciles actual releases against the moieties (fill the
   first, overflow to the second) — the ledger is a flat, immutable sum with no
   moiety tag, so FIFO is the only defensible mapping.

Degrades safely: no retention (rate 0) → no schedule; retention but no PC date →
"awaiting completion date" (never a fake "due"/"overdue").

## Surfaces

- **Job page** — a "Release schedule" block in the retention panel: each moiety
  with its amount, due date and status (Upcoming / Due / Released), a
  £-due-now callout, and an admin-only "Set completion date" form.
- **Dashboard** — a **"Retention due back"** KPI in the receivables row (retention
  *is* a receivable), showing total due-now + total held across jobs. Computed by
  `lib/retentions/rollup.ts` over data read on the **tenant client + paginated**
  (`fetchAllRows`), reusing the per-job derivation so the portfolio number and the
  job number always agree.

## Security & authorization

- `setRetentionSchedule` writes the terms on the **tenant client** — the
  admin-only `jobs` UPDATE RLS means a non-admin's write matches zero rows (same
  pattern as `setJobRetentionRate`). DB CHECKs are the backstop.
- The rollup reads on the tenant client (RLS), never the admin client. The pure
  libs import no Supabase client.
- No portal exposure (the terms are never selected on any `customer-portal` query).

## Tests

- **Unit** — `schedule.test.ts` (13: the size-off-accrued fix, FIFO waterfall,
  single-release, degradation, month arithmetic), `rollup.test.ts` (3).
- **Integration** (real Postgres) — `retention-schedule.test.ts` (5): the DB
  CHECKs (months 0–120, pct 0–100) + admin-only write RLS.
- **Security** — pure-derivation + portal-absence source contract.
- **E2E** — the due-back figures sit behind the auth wall.

## Deferred (documented fast-follows)

- **Reminder cron** (`retention.due` notification) — needs a `retention_reminders`
  dedup claim table (mirroring the inspections/maintenance cron doctrine) so it
  doesn't re-notify daily; the dashboard tile is the passive reminder for v1.
- Per-moiety planned-release rows / a retention cap (£ ceiling) — not modelled.
- Sequencing note: merge #402's `20261012` (retention over-release concurrency
  fix) with/before this, since the feature drives more release activity.
