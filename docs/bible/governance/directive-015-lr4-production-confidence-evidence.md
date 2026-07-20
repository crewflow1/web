# CrewFlow Governance — Directive #015 (D-05) LR4: the production-confidence evidence ledger

> **Status:** Governance **ledger** — a standing record that **LR4 opens and the operational
> cadence keeps**, not a completion report. CEO Directive **#015 / D-05** (*The Capability
> Registry*), Legacy Removal increment **4 (LR4)**, which implements the [Legacy Removal
> Proposal](./directive-015-legacy-removal-proposal.md)'s **C4 — "Bank production confidence
> (§4)"** increment. Authorised on the **LR3 review**, with its governing rule — the
> **Compatibility Layer Rule** (the twenty-first §2 standard, [Kernel Contract Map](./kernel-contract-map.md)
> §2) — set in the same review. This ledger records the four accountability attributes that rule
> binds to Directive #015's legacy `ai_employees` authority model — **a documented owner,
> measurable exit criteria, continuous parity validation, and an approved retirement plan** —
> made concrete and evidenced, plus the **confidence instrument** that measures the §4 window and
> the **first banked snapshot** it produced.
>
> **It removes nothing.** Per the CEO's LR4 authorisation, this increment *prepares the
> compatibility-retirement evidence*; it does **not** begin the removal phase. No legacy column,
> no deterministic mirror, no rollback control, and no parity tooling is removed, weakened, or
> scheduled for removal here. The removal increments (proposal **C5–C8**) remain separately
> authorised and **are not begun**. See the **STOP** at §7. Governed by the engineering standards
> homed in the [Kernel Contract Map](./kernel-contract-map.md) §2 — in particular the
> **Compatibility Layer Rule** (21st), the **Rollback Readiness Rule** (17th), and the **Shadow
> Validation Rule** (16th). Authority: [ADR 0010](../decisions/0010-capability-registry.md).

---

## 0. LR4 in one paragraph

After LR3 the legacy `ai_employees` authority model is **exactly a compatibility layer**:
administrative authority is registry-authored (LR1, LR2), runtime authority is registry-served
(R4, LR3), and the legacy columns remain solely as a **deterministic compatibility
representation** for **rollback** and **parity**. The Compatibility Layer Rule binds four
accountability attributes to such a layer for its whole retained life, *conjunctively*. LR4 is
the phase that **gathers** that accountability: it stands up a read-only **production-confidence
audit** that runs, for every live employee, the **same** serving decision the runtime serves and
classifies the outcome, then aggregates the §4 confidence signal as one boolean —
`registryOnlyReady`. It demonstrates sustained production confidence is *measured, not merely
elapsed*; it keeps parity monitoring and rollback readiness live; it validates the registry-only
runtime under production conditions; and it prepares the compatibility-retirement evidence — so
the layer's exit criteria can be shown met **before** any removal is contemplated, never inferred
from the replacement's mere existence. **LR4 measures; it does not remove.**

---

## 1. What LR4 is — and what it is not

LR4 = the Legacy Removal Proposal's **C4, "Bank production confidence (§4)"**
([proposal §6](./directive-015-legacy-removal-proposal.md), increment C4): *"With the registry
authoritative, authoring native, posture served, and the columns inert, run the sustained
observation window. The parity machinery is the instrument and stays fully in place. No removal
yet — this is the waiting phase the rule demands."* It is an **evidence and observability**
phase, not a code-removal phase.

- **It is** a read-only instrument plus this ledger: the means to *measure* the §4 confidence
  window, the record of the four Compatibility Layer Rule attributes made concrete, and the first
  banked evidence snapshot.
- **It is not** the removal phase. C4 *gates* C5–C8 (retire rollback → remove the legacy resolver
  → drop the authority-exclusive columns + retire SQL parity → rewrite tests + graduate the
  contract); it does not begin any of them. Nothing authorised-to-keep is removed (proposal §1
  scope boundary; CEO LR4 prohibitions).
- **It changes no served behaviour.** The legacy columns, the deterministic mirror, the rollback
  control (`CAPABILITY_AUTHORITY_SOURCE`), and the parity verification all remain exactly as LR3
  left them. The instrument is strictly off-path: it never mutates authority while measuring it.

---

## 2. The Compatibility Layer Rule's four attributes, made concrete (the ledger core)

The rule's force: *maintaining a compatibility layer without an owner, measurable exit criteria,
continuous parity validation, and an approved retirement plan — or treating it as a permanent
dependency — is a standards violation.* For Directive #015's legacy model, each attribute is
carried explicitly and evidenced below.

| # | Attribute | How #015's legacy model satisfies it | Evidence |
|---|-----------|--------------------------------------|----------|
| 1 | **Documented owner** — a named party accountable for the layer's removal, so it can never become an orphan | The **CEO Directive #015 / D-05 legacy-removal workstream** owns the layer; the **CEO** is the retirement-approval authority who alone authorises each removal increment. The owner is named here and in canon, charged with retiring the layer — never left ownerless. | This ledger; [proposal §5.2](./directive-015-legacy-removal-proposal.md) (retirement is "its own independently-reviewed phase"), §10 STOP; [kernel-contract-map](./kernel-contract-map.md) §2 (Compatibility Layer Rule) |
| 2 | **Measurable exit criteria** — objective conditions fixed in advance whose satisfaction *ends* the layer, so "temporary" has a defined terminus | The **six removal criteria** ([proposal §3](./directive-015-legacy-removal-proposal.md)) plus the **production-confidence window** (§4) — the Evidence Before Deletion Rule's conditions made measurable. The instrument renders the §4 bar as **one boolean**, `registryOnlyReady` (every employee served the registry in parity; zero divergence, zero backfill gaps, zero read errors, zero rollback). The window's **duration** is the CEO's to set ([proposal §9, fork B](./directive-015-legacy-removal-proposal.md)) — **pending**; the instrument is in place so that, once set, the window is *measured*. | `server/sdk/registry-resolver.ts` (`ConfidenceSummary.registryOnlyReady`, `summarizeConfidence`); [proposal §3, §4, §9 fork B](./directive-015-legacy-removal-proposal.md) |
| 3 | **Continuous parity validation** — the layer's equivalence to the authoritative model proven on an ongoing basis, so it never silently diverges while it waits | **Three** retained instruments, none removed: the request-path shadow `verifyRegistryParity` (LR3), the SQL drift detector `public.hq_capability_registry_parity()` (R2), and the **new** roster-sweep audit `auditRegistryConfidence` (LR4), run on an ops/CI cadence (§6). The audit reuses the canonical bridge for both the registry read and the legacy baseline, so its verdict can never drift from what the runtime serves. | `server/sdk/registry-parity.ts` (`verifyRegistryParity`, `legacyServedAuthority`); `supabase/migrations/..._capability_registry_backfill.sql` (`hq_capability_registry_parity()`); `server/sdk/registry-confidence.ts` (`auditRegistryConfidence`) |
| 4 | **An approved retirement plan** — a reviewed path to the layer's removal exists *before* it is leaned upon | The **reviewed** Legacy Removal Proposal's ordered increments **C5 → C8** ([proposal §6](./directive-015-legacy-removal-proposal.md)): retire the rollback (C5, its own independent review) → remove the legacy resolver (C6) → drop `tools_allowed` + `permissions` and retire SQL parity (C7) → rewrite dependent tests + graduate contract #8 (C8). The *plan* is approved and canonical; the *execution* of each increment remains separately CEO-authorised and **is not begun** (§7 STOP). | [proposal §6 (C5–C8), §5, §10](./directive-015-legacy-removal-proposal.md); [kernel-contract-map](./kernel-contract-map.md) §2 (Evidence Before Deletion, Registry Completeness, Compatibility Layer Rules) |

All four hold, conjunctively. The layer is owned, bounded by measurable exit criteria,
continuously validated against the model it shadows, and carries an approved plan for its own
removal — so it stays a bridge, never a foundation.

---

## 3. The confidence instrument — what LR4 builds

A single read-only observability instrument, `auditRegistryConfidence`
(`server/sdk/registry-confidence.ts`), with its pure classification/aggregation law in the
import-free resolver core (`server/sdk/registry-resolver.ts`). It is the means by which the §4
window is *measured*.

- **It measures the same decision the runtime serves.** For each live employee the sweep runs the
  pure `decideServedAuthority` — the very serving law R4/LR3 serve from — over the registry
  authority and the legacy baseline, then classifies the result with `classifyServingConfidence`
  into one of five outcomes: `registry-parity`, `registry-divergent`, `backfill-gap`,
  `registry-error`, `rolled-back`. The audit's verdict therefore **cannot drift** from what the
  serve path does.
- **It delegates; it re-implements nothing.** The registry read and the legacy baseline both come
  through the canonical bridge (`resolveAuthorityFromRegistry`, `legacyAuthorityOf`); the
  classification and the aggregate come from the pure law (`classifyServingConfidence`,
  `summarizeConfidence`). The pure core stays import-free and IO-free (its security contract).
- **It is strictly read-only.** It issues only `.select()` reads (the roster) and the delegated
  grant read; it **never** writes the grants, the mirror, or the legacy columns — you must not
  mutate authority while measuring it. A per-employee registry-read failure is **caught** and
  classified as a measured `registry-error`, never an abort of the sweep; only a roster-read
  failure throws (the instrument could not run at all).
- **It honours the rollback control.** It measures what is *actually* served — `control` defaults
  to `env.CAPABILITY_AUTHORITY_SOURCE`, so under a `legacy` rollback the sweep honestly reports
  every employee `rolled-back` and `registryOnlyReady=false` (confidence is **not** accruing while
  rolled back; the §4 window resets).

Three test tiers pin it: the **pure law** as unit tests (`__tests__/sdk/registry-resolver.test.ts`
§11), the **safety invariants** as source-level security tests
(`__tests__/security/capability-registry-confidence.test.ts`), and the **behaviour** against live
Postgres (`__tests__/integration/registry/registry-confidence-audit.test.ts`).

---

## 4. The §4 production-confidence requirements, and how the instrument measures each

[Proposal §4](./directive-015-legacy-removal-proposal.md) makes "sustained production stability"
measurable. Each requirement maps onto a signal the instrument reports.

| §4 requirement | How LR4 measures it |
|----------------|---------------------|
| **A defined observation window on production traffic** (registry authoritative continuously; a rollback resets the clock) | `control` reflects `CAPABILITY_AUTHORITY_SOURCE`; a `legacy` reading yields all `rolled-back` and `registryOnlyReady=false`. The window's *duration* is the CEO's (fork B); the sweep, run on cadence, measures whether the bar holds *across* it. |
| **Zero unexplained parity divergence** | A divergence classifies as `registry-divergent` with the offending dimension **named** (`divergence`), defeating `registryOnlyReady`. Every divergence is thus accounted for, never silent. |
| **Fail-safe exercised, not just present** | The registry-read failure path is caught and surfaced as a measured `registry-error` outcome — a distinct, countable signal, so the failure mode is observable, not merely latent. |
| **Backfill gaps closed** (no employee served via the silent fallback) | A subject the registry is silent about classifies as `backfill-gap` and defeats `registryOnlyReady` — the §4.4 "every employee has an authored grant" check made concrete. |
| **Observability in place, so the window is *measured*** | The whole instrument: the per-employee verdicts plus the aggregate `ConfidenceSummary`, runnable on an ops/CI cadence to record each interval of the window. |

---

## 5. The first banked evidence snapshot

The instrument's first end-to-end run against a live registry (the integration suite,
`__tests__/integration/registry/registry-confidence-audit.test.ts`, all four tests green)
establishes the baseline and proves the instrument reports each §4 signal correctly:

1. **CONFIDENCE BANKED.** Under registry authority, the full production-path sweep
   (`createAdminClient` + live roster + live grants) reports **every** live employee served the
   registry **in parity**: `registryOnlyReady=true`, `registryParity === total`, zero backfill
   gaps, zero divergence, zero read errors, zero rollback. This is the **first banked evidence
   snapshot** that the registry-only runtime is whole.
2. **ROLLBACK IS HONESTLY MEASURED.** Under the `legacy` control, every employee is `rolled-back`
   and `registryOnlyReady=false` — confidence is not accruing while rolled back, and the
   instrument says so (the §4 window resets).
3. **A BACKFILL GAP IS DETECTED.** A subject the registry is silent about is classified
   `backfill-gap` and defeats readiness — the §4.4 check the removal phase depends on.
4. **A DIVERGENCE IS DETECTED AND NAMED.** An out-of-band grant change is classified
   `registry-divergent` with the offending dimension named (§4.2), then parity is restored,
   leaving no trace — proving the instrument never mutates authority it merely measured.

**What this snapshot is — and is not.** It is the instrument *validated whole* and producing
`registryOnlyReady=true` across a complete roster: the baseline from which the production window
accrues. It is **not** by itself the satisfied §4 window — that window is **sustained production
stability on real traffic over the CEO-set duration** (fork B), gathered operationally by running
this sweep on an ops/CI cadence (§6). A single green snapshot is *a* reading, not the window.

---

## 6. Operational cadence — measured, not merely elapsed

The §4 window is *operational*: the instant is measured in code; the **sustained window** is
gathered by running the sweep over time. The cadence the workstream keeps for LR4's life:

- **Run `auditRegistryConfidence` on an ops/CI cadence** against production, recording each
  interval's `ConfidenceSummary`. The window is *measured* — each reading is a banked datapoint —
  not assumed to have elapsed.
- **`registryOnlyReady=true` is the per-interval bar.** Any interval reporting a `backfill-gap`,
  `registry-divergent` (unaccounted), `registry-error`, or `rolled-back` outcome **breaks** the
  window for that interval; an unexplained break **resets the clock** (Rollback Readiness Rule:
  confidence is sustained stability, not a single green deploy).
- **A rollback event resets the window.** A flip to `CAPABILITY_AUTHORITY_SOURCE=legacy` is, by
  design, all `rolled-back`; the window restarts when registry authority is restored and parity
  resumes.
- **The window duration is the CEO's to set** ([fork B](./directive-015-legacy-removal-proposal.md)):
  **pending.** LR4 stands the instrument up so that, once the duration is ruled, the elapsed window
  is backed by recorded readings rather than inferred.
- **Parity monitoring and rollback readiness stay live throughout** — `verifyRegistryParity`, the
  SQL parity function, and the `CAPABILITY_AUTHORITY_SOURCE` lever are all retained and exercised.

---

## 7. What LR4 deliberately does not do — and the STOP

Per the CEO's LR4 authorisation, this increment **prepares the compatibility-retirement
evidence**; it does not retire the layer. Explicitly retained, untouched by LR4:

- the legacy authority columns (`ai_employees.tools_allowed`, `permissions`) and the shared
  non-authority columns (`department`, `memory_scope`);
- the deterministic mirror and the seed/backfill that write it;
- the rollback control (`CAPABILITY_AUTHORITY_SOURCE`, the `decideServedAuthority` `legacy` arm,
  the fail-safe fallback);
- the parity tooling (`verifyRegistryParity`, `hq_capability_registry_parity()`, the comparison
  surface) and the legacy runtime resolvers (`resolveEmployeeCapabilities`,
  `resolveEmployeePosture`, `legacyAuthorityOf`).

The confidence audit **removes nothing and mutates nothing** — it is purely additive, read-only
observability. Its source-level security suite pins exactly this (no `.insert(`/`.update(`/
`.delete(`/`.upsert(`/`.rpc(`; legacy resolvers, rollback control, and parity verification all
asserted still present).

**STOP.** The removal phase (proposal **C5–C8**) is **not begun** and is not authorised by this
ledger. Legacy compatibility remains until production evidence satisfies the retirement criteria
established in the Legacy Removal Proposal and the Evidence Before Deletion / Registry Completeness
/ Compatibility Layer Rules, and until the CEO has **reviewed and approved LR4** and separately
authorised each removal increment. The full validation discipline is maintained.

---

*Prepared under CEO Directive #011 (Master Roadmap D-01) as the LR4 production-confidence evidence
ledger for CEO Directive #015 / D-05 — the Capability Registry — following the merged R1–R4 and
LR1–LR3 slices, and governed by the engineering standards homed in the
[Kernel Contract Map](./kernel-contract-map.md) §2, in particular the Compatibility Layer Rule
(the twenty-first standard) which this increment is built to satisfy. Architecture-Freeze contract
#8 (Capability Registry) graduates Reserved → Established only on completion of the separately
authorised removal phase (proposal C8), which this ledger only prepares the evidence for; it does
not begin it.*
