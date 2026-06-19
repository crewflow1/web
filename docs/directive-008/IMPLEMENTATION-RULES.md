# CrewFlow OS — Implementation Rules (Definition of Done)

**CEO Directive #003.5 ("Lock the Foundation") · Part 6 of 7 · The quality bar no feature may skip**

> A feature is not "done" when it works. It is done when it is **tested, observed, audited, measured, documented, secured, fast, and usable** — and not before. This document is the binding Definition of Done for every feature built from the frozen Bible. It turns the CEO's ten-point bar into concrete, checkable gates, each grounded in the chapter that owns it. **"Works on my machine" is not a state this programme recognises.**

---

## The principle

The [Architecture Freeze](bible/00-INDEX.md) governs *what* gets built and *in what order*. These rules govern *when it is allowed to be called finished*. They exist because the failure mode of an ambitious programme is not bad architecture — it is good architecture shipped at 80%, where the missing 20% (the tests, the monitoring, the audit trail) is exactly what you need the day something breaks.

So the bar is **binary and non-negotiable**: every gate below is either **green (with evidence)** or the feature is **not done**. There is no "done except for tests." There is no "we'll add monitoring later." A feature at 80% is not 80% done; it is **not done**, because the absent 20% is the safety margin the whole programme depends on.

This is the same discipline that shipped Directive 007 — validation triplet green, preview-first, gated — raised to match the higher stakes of an OS that will eventually let AI move money.

---

## How the gates apply

Not every gate applies to every feature, and pretending otherwise produces cargo-cult checklists. A backend projection genuinely does not need an accessibility review; an inbox UI genuinely does. So each gate below states its **scope** — *universal* (every feature) or *conditional* (only when the trigger applies). A conditional gate that doesn't apply is marked **N/A with a one-line reason** in the PR — never silently skipped.

| Scope | Meaning |
|---|---|
| **Universal** | Applies to every feature without exception. |
| **Conditional — UI** | Applies only to features with an operator-facing surface (Mission Control, approvals inbox, search, timeline). |
| **Conditional — DB** | Applies only to features that touch the database (new tables, columns, RLS, migrations). |
| **Conditional — consequential** | Applies only to features that move money, grant permission, or let AI act (the gate, approvals, execution). |

---

## The ten gates (the CEO's bar, made concrete)

### Gate 1 — Unit tests · *Universal*
- **Requirement:** the feature's pure logic is unit-tested, branches and **fail-closed paths** included. The gate's deny path, the policy engine's routing, a projection's shaping, a budget breaker's trip — all have tests that assert the *unsafe* outcome is refused.
- **Grounded in:** [Ch.18 §test pyramid](bible/18-testing-strategy.md) (the broad base).
- **The check (evidence):** tests exist and pass in CI; the dangerous branch (deny, reject, suspend) is explicitly asserted, not just the happy path.
- **Enforced at:** CI (the validation triplet must be green before merge).

### Gate 2 — Integration tests · *Universal (heaviest for Conditional — DB)*
- **Requirement:** the feature is tested **against a real Postgres**, not a mock — including its **RLS posture** and its **event contracts**. An `RLS:hq` table is proven service-role-only; an emitted event is proven to match the `Verb` registry; a consumer is proven idempotent on replay. **Mandatory-domain rule (Directive #004 / P11):** every feature that affects **Security, Authentication, Multi-tenancy, the Database, AI Infrastructure, Billing, Payroll, or Customer Data** *must* carry a live integration test here — a mocked test alone is no longer sufficient.
- **Grounded in:** [Ch.18 §RLS tests, §event-contract tests, §13a the mandatory pipeline](bible/18-testing-strategy.md); the enabling dependency, **[OQ-16 — a real Postgres in CI](bible/20-glossary-conventions-decision-log.md)**, is **resolved** ([ADR-015](bible/20-glossary-conventions-decision-log.md), [PR #172](https://github.com/crewflow1/web/pull/172)).
- **The check:** integration tests run against the CI-Postgres harness and pass; RLS tests prove no JWT path reads an HQ table; replay tests prove no double-apply.
- **Enforced at:** CI — **and the gate now truly gates.** The harness (Supabase CLI local stack in the runner) applies every migration to a fresh volume and runs the RLS suite as anon / tenant-JWT / service-role on every PR. On its first live runs it caught two real defects that every mock had passed ([§20.6 L-1, L-2](bible/20-glossary-conventions-decision-log.md)) — the proof that *real infrastructure proves behaviour where a mock only proves intent.*

### Gate 3 — End-to-end tests · *Conditional — UI*
- **Requirement:** the operator's actual flow works end-to-end against a preview deployment — Mission Control loads and renders capability-filtered tiles; an approval can be decided; search returns and navigates; the timeline streams.
- **Grounded in:** [Ch.18 §E2E](bible/18-testing-strategy.md) (the pyramid's apex — few, high-value).
- **The check:** an E2E test exercises the full path (load → act → observe the result) on preview.
- **Enforced at:** preview, before the production flag flip.

### Gate 4 — Monitoring · *Universal*
- **Requirement:** the feature is **observable from its first minute** — it emits its [canonical events](bible/04-event-spine-and-taxonomy.md), exposes its [metrics](bible/15-observability-metrics-audit.md), and its golden signals are wired to alerts. *You cannot operate what you cannot see.*
- **Grounded in:** [Ch.15](bible/15-observability-metrics-audit.md) (the metric registry, golden signals, SLOs); [Ch.19 §3 P3](bible/19-rollout-plan.md) (observable-before-active).
- **The check:** the feature appears in `getMetricsSnapshot()`; at least one golden signal + alert is defined; a trace by `correlation_id` reconstructs its flow.
- **Enforced at:** PR review + the phase success criteria (a phase whose feature isn't observable does not advance).

### Gate 5 — Audit logging · *Universal (mandatory for Conditional — consequential)*
- **Requirement:** every consequential action lands in the **immutable audit log** with its actor (human `HqActor.id` or AI slug). *Who did what, when* is reconstructable forever.
- **Grounded in:** [Ch.15 §immutable audit](bible/15-observability-metrics-audit.md) (♻️ `admin_activity_log`, append-only, no update/delete path); [ADR-014](bible/20-glossary-conventions-decision-log.md).
- **The check:** the action writes an audit row with `decided_by`/actor; the row is immutable by construction; for approvals, both the request and the decision are recorded.
- **Enforced at:** PR review (consequential features) + integration test (the audit row is asserted).

### Gate 6 — Analytics · *Universal*
- **Requirement:** the feature's **usage and outcomes are measurable** — its events flow to the spine, and at least one metric derives from them, so adoption, cost, and effect can be answered without instrumenting it later.
- **Grounded in:** [Ch.04 §the spine](bible/04-event-spine-and-taxonomy.md) (every fact is an event) + [Ch.15 §metric registry](bible/15-observability-metrics-audit.md) (one formula per metric).
- **The check:** the feature emits spine events that a metric (adoption, throughput, cost) can be computed from; for AI features, `cost_usd`/tokens/latency are recorded per run.
- **Enforced at:** PR review (the events are the analytics — no separate analytics pipeline to bolt on).

### Gate 7 — Documentation · *Universal*
- **Requirement:** the PR **cites the Bible chapter(s) it realises** (the [freeze rule](bible/00-INDEX.md)); any deviation from the chapter is an **ADR** in [Ch.20 §20.3](bible/20-glossary-conventions-decision-log.md); operator-facing features carry user-facing docs.
- **Grounded in:** [Ch.00 Change control & governance](bible/00-INDEX.md) (architecture before code; PR cites its chapter); [Ch.20 §20.2](bible/20-glossary-conventions-decision-log.md).
- **The check:** the PR description names its chapter(s); if behaviour differs from the chapter, an ADR is added in the *same* PR (Bible edited first); canon changes (03/04/14) include the consistency sweep.
- **Enforced at:** PR review — *"which chapter is this?"* is the first review question; "none" stops the PR.

### Gate 8 — Security review · *Conditional — consequential (and any DB/boundary change)*
- **Requirement:** the feature respects the **five trust boundaries**; the service-role key never crosses to the client; the RLS posture is correct; injection/abuse vectors are considered and the gate-checks-the-grant-not-the-wish property holds.
- **Grounded in:** [Ch.16](bible/16-security.md) (trust boundaries, AI defences, `import "server-only"`); [Ch.19 §9](bible/19-rollout-plan.md) requires an **explicit security sign-off** for the real-time broadcast boundary (P3) and graduated execution (P7).
- **The check:** a named reviewer signs off; for P3, the broadcast boundary is proven (no client subscription to `hq_events`); for P7, the least-privilege and no-`permission.*`-for-AI properties are proven.
- **Enforced at:** PR review for any boundary/DB/consequential change; a **mandatory dedicated review** at P3 and every P7 grant.

### Gate 9 — Performance validation · *Universal (with the one-million test)*
- **Requirement:** the feature meets its **budget** (TTFB, query p95, snapshot time) and **answers the Golden Rule by name** — *if CrewFlow had one million companies, is this still O(1)-ish?* Claims like "Mission Control snapshot < 50ms, O(1) in company count" are *proven*, not asserted.
- **Grounded in:** [Ch.15 §Performance](bible/15-observability-metrics-audit.md); every chapter's §Performance and §Scalability ([Ch.17](bible/17-scalability.md)) answers the one-million test explicitly.
- **The check:** a performance test asserts the budget (e.g. MC snapshot < 50ms; query p95 < 200ms); the scaling analysis is written (indexed read, bounded scan, partition-pruned).
- **Enforced at:** preview (perf test) + PR review (the one-million paragraph exists).

### Gate 10 — Accessibility review · *Conditional — UI*
- **Requirement:** operator surfaces are **keyboard-navigable, ARIA-correct, and contrast-compliant**, building on the Directive 007 design system — the ⌘K palette is keyboard-first, the inbox is operable without a mouse, live regions announce politely.
- **Grounded in:** [Ch.09](bible/09-mission-control.md)/[Ch.10](bible/10-global-search.md) §UI behaviour (states, keyboard, accessibility, the live model); the design-system foundation (Directive 007, the now-frozen RC).
- **The check:** an a11y pass (keyboard traversal, screen-reader labels, contrast) on the operator-facing surface; live regions use appropriate politeness.
- **Enforced at:** preview, before the production flag flip.

---

## The CrewFlow-specific gates (inherited from the freeze + Ch.19)

Beyond the CEO's ten, four CrewFlow-specific conditions are part of "done" for *every* feature, because they are what make the rollout safe. They come from the [per-phase contract](bible/19-rollout-plan.md) and the [freeze](bible/00-INDEX.md):

| Gate | Requirement | Grounded in |
|---|---|---|
| **A — Additive migration** | The migration is `create` / `add column` only — forward-only, non-destructive. **No backout is ever a `down` that drops data.** | [Ch.03 §Migration plan](bible/03-data-model.md), [Ch.19 §7](bible/19-rollout-plan.md) |
| **B — Flag-gated** | The behaviour ships behind an `hq_settings` flag, default **off**. Shipping ≠ activating. | [Ch.19 §3, §6](bible/19-rollout-plan.md) |
| **C — Written backout** | The PR includes the backout (almost always "flip the flag"); for P7, "revoke the grant." Reversibility is documented, not assumed. | [Ch.19 §7](bible/19-rollout-plan.md) |
| **D — Validation triplet + Vercel build green on preview** | tsc / lint / tests pass and the Vercel build is green on a **preview deployment** before production — exactly as Directive 007 shipped. | [Ch.19 §3 P1](bible/19-rollout-plan.md) |

---

## The PR checklist (copy into every implementation PR)

Every implementation PR carries this block. A box is **checked with evidence** (a link, a test name, a reviewer) or marked **N/A + reason**. An unchecked box is an unfinished feature.

```md
## Definition of Done — CrewFlow OS

**Chapter(s) realised:** Ch.__ §__  (the freeze rule — name them)
**Deviation from chapter?**  ☐ none  ☐ ADR added: ADR-___ (Bible edited first)

### Universal gates
- [ ] **Unit tests** — logic + fail-closed paths asserted        (evidence: ____)
- [ ] **Integration tests** — real Postgres; RLS + event contracts (evidence: ____)
- [ ] **Monitoring** — events emitted, metric + golden signal wired (evidence: ____)
- [ ] **Audit logging** — consequential actions recorded w/ actor   (evidence: ____ / N/A: ____)
- [ ] **Analytics** — usage/cost derivable from spine events        (evidence: ____)
- [ ] **Documentation** — chapter cited; ADR if deviation; user docs if UI (evidence: ____)
- [ ] **Performance** — budget met; one-million test answered        (evidence: ____)

### Conditional gates
- [ ] **E2E tests** (UI)              ☐ done (evidence: ____)  ☐ N/A: not operator-facing
- [ ] **Security review** (consequential/boundary/DB) ☐ signed: ____  ☐ N/A: ____
- [ ] **Accessibility** (UI)          ☐ done (evidence: ____)  ☐ N/A: no UI

### CrewFlow-specific (the freeze + Ch.19)
- [ ] **Additive migration** — forward-only, non-destructive   ☐ done  ☐ N/A: no DB change
- [ ] **Flag-gated** — `hq_settings` key, default off          (flag: ____)
- [ ] **Written backout** — flip-the-flag / revoke-the-grant   (backout: ____)
- [ ] **Preview green** — tsc/lint/tests + Vercel build         (preview: ____)
```

---

## Enforcement — where each gate actually bites

Rules that aren't enforced are decoration. Each gate has a real enforcement point:

| Enforcement point | Gates it holds | How |
|---|---|---|
| **CI (the validation triplet + the live real-Postgres harness)** | Unit, Integration, preview-green | tsc / lint / tests must pass; the **live** CI-Postgres harness applies every migration to a fresh DB and runs the RLS/contract tests as anon / tenant / service-role on every PR (OQ-16 resolved, [ADR-015](bible/20-glossary-conventions-decision-log.md)). Red CI = no merge. |
| **PR review** | Documentation (chapter citation), Monitoring, Audit, Analytics, Performance (the one-million paragraph), Additive-migration | A human reviewer checks the DoD block against the diff; *"which chapter?"* is question one. |
| **Preview, pre-flip** | E2E, Accessibility, Performance budgets | Exercised on the preview deployment before the production flag flips. |
| **Dedicated security sign-off** | Security review | Mandatory at P3 (broadcast boundary) and every P7 grant; named reviewer. |
| **The phase success criteria** | Monitoring, Performance | A phase does not advance until its [Ch.15 success metrics](bible/19-rollout-plan.md) are green — the gate that catches anything the PR-level checks missed. |
| **The CEO gate** | (P7 only) the whole bar + the grant decision | The CEO approves *which employee, which capability* — the human lock over the machine checks. |

---

## The exceptions clause (honest, because pretending there are none is worse)

There will be moments when a gate genuinely cannot be met on the normal timeline — a third-party dependency, a tool not yet built, a measurement that needs production data. Pretending this never happens produces *silent* skips, which is the real danger. So:

1. **A gate is never skipped silently.** It is either green-with-evidence or **explicitly waived in writing** in the PR, with the reason and the named approver.
2. **A waiver is time-boxed and tracked.** It names *when* the gate will be met and *who* owns closing it — a follow-up issue, not a forgotten corner.
3. **The consequential gates (2, 5, 8 — integration/RLS, audit, security) are not waivable for money-moving, permission-granting, or AI-acting features.** There is no version of "ship the refund capability without the security review." For these, the bar is the bar.
4. **A waiver on a canon feature (03/04/14) requires CEO awareness.** The foundation does not ship on an IOU.

> **The test for "done," stated once:** *every applicable gate is green-with-evidence, or explicitly and accountably waived.* If a box is blank, the feature is not done — no matter how well the code works. This is how an ambitious programme stays trustworthy: not by moving slowly, but by never lying to itself about what "finished" means.

---

*Grounded in [Ch.18 Testing](bible/18-testing-strategy.md), [Ch.15 Observability](bible/15-observability-metrics-audit.md), [Ch.16 Security](bible/16-security.md), and the [Ch.19](bible/19-rollout-plan.md) per-phase contract. Enforces the [Architecture Freeze](bible/00-INDEX.md). Companion documents: [CEO Review Pack](CEO-REVIEW-PACK.md) · [Build Dependency Graph](BUILD-DEPENDENCY-GRAPH.md) · [Prioritisation Matrix](PRIORITISATION-MATRIX.md) · [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md) · [CEO Gate](CEO-GATE.md).*
