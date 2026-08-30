# ADR 0012 — Roster Staging and Product-Mapped Employees

> **Status:** **Accepted** (build lane L10, `roadmap/final-completion`) · **Date:** 2026-08-29 ·
> **Supersedes:** none · **Superseded by:** none · **Builds on:**
> [ADR 0010](./0010-capability-registry.md) (the Capability Registry and its default-deny floor —
> the served posture the new identities inherit),
> [ADR 0004](./0004-generic-task-engine.md) (the Task Engine every dedicated runner would use),
> [ADR 0011](./0011-live-executor-rollout.md) (the rollout discipline this ADR deliberately does
> **not** invoke — no execution, no runner, no rollout stage is touched here).
>
> **Twelfth ADR** under the [`../README.md`](../README.md) *document-before-you-build* rule.
> Records the decision behind migration `20261225000000_hq_roster_completion_2.sql` (the
> tenant-domain roster cohort) and the contract fields of `20261222000000_ai_employee_contract_fields.sql`.
> Scope note: this ADR covers **roster staging only**; it does not decide, alter, or close any
> other open decision.

---

## Context

The workforce bible (`docs/bible/workforce/`) specifies a 42-employee AI workforce. Before this
decision the `ai_employees` registry carried 33 identities; eleven **specified** employees —
`whatsapp-ai`, `email-ai`, `scheduler-ai`, `quote-writer-ai`, `cashflow-ai`, `payroll-ai`,
`business-coach-ai`, `site-manager-ai`, `blueprint-ai`, `procurement-ai`, `intelligence-ai`
(bible #27–#37, excluding the already-seeded voice receptionist #26) — had **no registry row at
all**, despite every one of their FUNCTIONS being live product capability that tenants use today:
the WhatsApp inbound engine, the email pipeline, the deterministic rota solver, the (dark,
governed) AI quote writer, the cash engine and briefing, the payroll estimates engine, the
company-health coach signals, the site-report/RAMS/toolbox engines, the Blueprint Centre, the
materials/stock engines, and the governed intelligence/insights engines.

That gap made the roster dishonest in the *other* direction from the usual risk: the boardroom
under-reported the company the bible describes, and there was no identity row to hang cost
attribution, KPIs, or an approval posture on when those functions' AI seams activate.

## Decision

### 1. The tenant-domain cohort is **product-mapped**

These eleven employees' functions live as **product features**, built and shipped in the tenant
product where customers use them. The HQ identity row is therefore a **registry entry** — a
truthful map from the bible's org design onto the engines that already exist — not a second
implementation and not a promise of one. Each seeded row's `description` names the live engine
that serves the function today, so an operator reading the boardroom learns exactly what is real.

### 2. Dedicated runners are **deferred**

No `server/services/hq-*-runner.ts` is created for any of the eleven, and none is planned by this
ADR. Building a runner that re-does what a deterministic product engine already does would be
duplication; building one that *drives* the product engine is an execution decision that belongs
to the Live Executor rollout governance (ADR 0011) and a CEO activation call, not to a roster
migration. Consequences, accepted deliberately:

- The rows are seeded `status = 'disabled'` — dark identities, honest about having no worker.
- ~~**No Capability Registry grants** are seeded~~ **Superseded in the same branch by migration
  `20261227000000`:** the registry's own pinned invariant (R2 backfill completeness / LR5.3
  registry-only operation, integration-enforced) requires every non-retired employee to be
  served FROM the registry by an EXPLICIT grant — the implicit floor is the automatic
  fail-safe, never the steady-state posture. Each of the eleven now carries the explicit
  deny-floor grant the 20261205 roster-workers precedent established (read/draft/memory,
  `can_execute false`, `requires_approval true`) — the IDENTICAL posture this section argued
  for, but registry-served, auditable, and individually revocable.
- No `model_provider` / `model_name`: registered, not wired.

### 3. The management spine is data, not prose

`ai_employees.manager_slug` (migration 20261222000000) carries the canonical reporting line from
`docs/bible/workforce/relationships.md` §2, FK'd to the roster's own slugs with a not-self CHECK.
The two identities that exist outside the 42-roster (`design-ai`, `exec-assistant-ai`) take the
documented fallback (execs manage department workers): `design-ai → cto-ai`,
`exec-assistant-ai → ceo-ai`. Seeding fills NULLs only — operator edits are never clobbered.

### 4. Honest lifecycle and honest metrics ride on the same contract wave

Recorded here because they land in the same contract migration and share the honesty rule:

- **Retirement is terminal** (`retired_at`, status `'retired'`, trigger-enforced: only
  `disabled → retired` is admitted; a retired row refuses every update and delete).
- **Cost attributes per employee** (`ai_invocations.ai_employee_id`, threaded through the
  governor's record/settle paths as attribution-only telemetry — never a budget decision).
- **KPIs are derived, persisted, and never invented** (`ai_employee_kpis`: task outcomes,
  approvals raised, attributed cost per UK budget month; compute-on-read upsert, no cron).
- **"Conversation history" is the merged interaction feed** (engine tasks + config audit +
  approvals). No chat UI exists for these employees to hold a literal conversation in, so no
  transcript is fabricated; the feed of stored rows *is* the employee's real conversation with
  the company.

## Alternatives rejected

1. **Seed with runners** — duplicates live product engines or smuggles in execution without the
   ADR 0011 gate. Rejected.
2. **Do not seed until runners exist** — leaves the roster under-reporting reality indefinitely
   and gives activation day a schema scramble. Rejected.
3. **Seed as `idle`** — implies a worker that could pick up tasks. `disabled` is the honest state
   for an identity with no runner. Rejected.

## Consequences

- Roster count rises 33 → 44; the boardroom now shows the bible's tenant-domain cohort with
  honest dark status, the engine each maps to, a manager line, per-employee KPIs and cost.
- Activation of any of the eleven is a deliberate future step: build/authorise the runner (ADR
  0011 discipline), author registry grants, flip status — no schema work needed.
- Note for future reviewers: the roster's `lead-qualification` slug (bible #14) predates the
  `-ai` suffix convention; this ADR maps it in the management spine but does not rename it —
  a rename would touch grant scope keys and event `actor_id` history, and is out of scope.
