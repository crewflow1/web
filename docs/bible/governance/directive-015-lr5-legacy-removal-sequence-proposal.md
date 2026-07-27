# CrewFlow Governance — Directive #015 (D-05) LR5 Proposal: the legacy-removal sequence

> **Status:** **Proposed — awaiting CEO review.** This is a **design proposal, not a decision**: it
> renumbers nothing and changes no code, schema, migration, configuration, or git history. It is
> authored under the *document-before-you-build* rule, in response to the CEO's authorisation on the
> **Directive #015 LR4 review**: *"Proceed to **LR5 Proposal only**. LR5 is **design only**. Its
> purpose is to define: compatibility retirement sequence · rollback retirement sequence · legacy
> column removal order · cleanup validation · final migration completion criteria. Do not: remove
> legacy columns · remove compatibility writes · remove rollback · remove parity verification · remove
> migration instrumentation. No legacy removal implementation begins until the LR5 Proposal has been
> reviewed and approved."* It presents those five areas, each in its own section (**§4–§8**), preceded
> by the **current** removal surface they act on (**§2**) and the **Retirement Readiness gate** that
> governs the whole phase (**§3**), and followed by the rules honoured (**§9**), the forks for the CEO
> (**§10**), and the sequencing the work *would* follow if approved (**§11**).
>
> **It removes nothing.** Per the CEO's LR4 authorisation, this phase produces **only this proposal**.
> No legacy column, no compatibility (mirror) write, no rollback control, no parity verification, and
> no migration instrumentation is removed, weakened, or scheduled for removal here. This document
> describes *how and in what order* each is retired and the gates each must pass first — it does not
> retire any of them. Prepared under CEO Directive **#011** (Master Roadmap **D-01**) for CEO Directive
> **#015 / D-05** (*The Capability Registry*), governed by the engineering standards homed in the
> [Kernel Contract Map](./kernel-contract-map.md) §2 — in particular the new **Retirement Readiness
> Rule** (the twenty-second standard, set on the LR4 review), which **gates the entire phase this
> proposal designs**. **The proposal proposes; it does not build.**
>
> **Sequence context.** Directive #015 has shipped R1 (schema) → R2 (backfill + parity gate) → R3
> (shadow resolver) → R4 (runtime authority switch) → LR1 (registry-native token authoring) → LR2
> (registry-native memory-scope authoring + atomic mirror) → LR3 (runtime read-path migration) → LR4
> (production-confidence audit), each reviewed and merged. The registry is now the **sole authoritative
> source** for **authoring** (LR1/LR2) and **serving** (R4/LR3) of all four authority dimensions, and
> the legacy `ai_employees` columns survive **only as a derived mirror retained for rollback and
> parity** — i.e. *exactly a compatibility layer* (the Compatibility Layer Rule, 21st). LR4 banked the
> production-confidence evidence. What remains is to **retire** that compatibility layer — but only
> once the Retirement Readiness Rule's bar is met and independently reviewed, and only as a sequence of
> **separately-authorised** increments. This document is the design for that sequence.

---

## 1. How to read this, and the one-paragraph thesis

The CEO's mandate is to **present the legacy-removal *sequence* and hold for review** — not to begin
removing. §1 gives the thesis and the scope boundary. **§2** re-inventories the removal surface **as it
stands today, after LR1–LR4** — which has changed materially from the original [Legacy Removal
Proposal](./directive-015-legacy-removal-proposal.md) §2, and the changes are the whole reason the
sequence is now short and clean. **§3** states the **Retirement Readiness gate** — the new rule's five
conditions made concrete — which governs *whether the phase may begin at all*. **§4–§8** answer, in
order, the **five areas the CEO required**: the compatibility retirement sequence (§4) · the rollback
retirement sequence (§5) · the legacy column removal order (§6) · cleanup validation (§7) · final
migration completion criteria (§8). §9 lists the rules honoured. §10 raises the genuine forks as
explicit questions. §11 sketches the sequencing *if approved* and states the STOP. Every factual claim
about today's code is cited to repository evidence verified at the current integration tip.

**The thesis (one paragraph).** When the original Legacy Removal Proposal was written, removal was
**blocked** on two unbuilt prerequisites — a registry-native authoring path (its Finding 1) and
registry-served posture (its Finding 2). **Both are now built and merged**: LR1/LR2 made the registry
the authoritative *writer* and inverted the mirror (the legacy columns are now written *from* the
registry, deterministically, inside the authoring RPCs — they are no longer the origin of anything),
and LR3 moved every served dimension — tokens, posture, and memory scope — onto the registry, so **no
production serve path reads legacy authority** any longer. The legacy resolvers remain reachable on the
live path in **exactly two** roles: the **rollback** fallback (`CAPABILITY_AUTHORITY_SOURCE=legacy`)
and the **parity** baseline. The compatibility layer is therefore now a thin, well-bounded thing, and
its retirement is a **dependency-ordered teardown**: retire the rollback first (it is what falls back
to legacy), then the legacy resolvers and the comparison surface, then stop the authority mirror and
drop the two authority-exclusive columns and the SQL parity oracle, then rewrite the dependent tests
and graduate the contract. The one structural constraint that **still holds** is the original
Finding 3: only `tools_allowed` and `permissions` are authority-exclusive and droppable; `department`
and `memory_scope` are **shared, non-authority** data and are **retained**. The whole teardown is gated
on the Retirement Readiness Rule: it may not begin until the registry has demonstrably, sustainably,
and *observably* stood alone — and that evidence has been independently reviewed.

**Scope boundary (what this proposal is *not*).** It does **not** remove, or authorise removing, any
legacy element — the columns, the legacy resolvers, the mirror writes, the parity verification, the
migration instrumentation, or the rollback all stay exactly as LR4 left them. It does **not** change
served behaviour. It does **not** set the confidence-window duration (that remains the CEO's to rule —
§10). It does **not** graduate contract #8 — that graduation is the *outcome* of the sequence this
document designs. And it sets **no** new rule: the governing rule (Retirement Readiness) was already
set on the LR4 review.

---

## 2. The removal surface today — what LR1–LR4 changed

This section fixes exactly what "the legacy authority model" *is* in the repository **now**, so the
sequence acts on a precise surface. Three of the original proposal's structural facts have changed; one
holds. Each claim is cited at the current integration tip.

### 2.1 CHANGED — authoring is registry-native and the mirror is inverted (original Finding 1 resolved)

The registry is the authoritative **write** target; the legacy columns are a **derived mirror** written
*from* the registry, deterministically, inside the authoring RPCs in a single transaction:
`hq_author_employee_capabilities` upserts the grant then mirrors the parity-faithful split to
`ai_employees.tools_allowed` / `permissions`
(`supabase/migrations/20260808000000_capability_registry_native_authoring.sql:143-180`);
`hq_author_employee_memory_scope` upserts the grant's `memory_scope` then mirrors it to the legacy
column (`supabase/migrations/20260809000000_capability_registry_native_memory_scope.sql:142-200`). The
TypeScript write seam is RPC-only (`server/sdk/registry-authoring.ts:100,194`), reached from the admin
Boardroom actions (`app/admin/ai-boardroom/actions.ts:292,396`). **No user-edit path writes the four
authority columns directly any more** — LR2 removed the last one (`updateAiEmployeeConfig` now writes
descriptive fields only; `memory_scope` is deliberately absent from its schema,
`app/admin/ai-boardroom/actions.ts:61-64`). *Consequence:* the columns are no longer the origin of
authority — they are kept alive **solely** as the mirror that backs rollback and parity.

### 2.2 CHANGED — every dimension is served from the registry (original Finding 2 resolved)

LR3 closed the serving gap. `resolveServedAuthority` returns tokens **and** posture **and** memory
scope (`server/sdk/registry-parity.ts:195-204,269-332`), and the two production serve sites assign all
three from the served result (`server/services/hq-research.ts:327-330`,
`server/services/hq-qualification.ts:243-246`). The original proposal's "posture is not yet served from
the registry" is **stale**. *Consequence:* no production serve path reads legacy authority; the legacy
resolvers are off the primary path entirely.

### 2.3 CHANGED — the legacy resolvers are reachable only as rollback + parity

`resolveEmployeeCapabilities` / `resolveEmployeePosture` (`server/sdk/tasks.ts:146,189`) are now called
**only** through the parity bridge — `legacyAuthorityOf` (`server/sdk/registry-parity.ts:130-131`) and
`legacyServedAuthority` (`:223-224`). Those two have just these live-path consumers: the **rollback**
arm of `resolveServedAuthority` (`registry-parity.ts:273-278`, reached when
`decideServedAuthority` returns `basis:"legacy"` — `server/sdk/registry-resolver.ts:281-292`), the
**parity** baseline in `verifyRegistryParity` (`registry-parity.ts:169`) and in the served decision's
divergence check (`:295`), and the LR4 **confidence audit** (`server/sdk/registry-confidence.ts:153`).
*Consequence:* the resolvers can be deleted the moment rollback and parity are retired — nothing else
depends on them.

### 2.4 HOLDS — only two of the four columns are authority-exclusive (original Finding 3)

`tools_allowed` and `permissions` are authority-exclusive: read on the authority path (the resolvers,
the SQL parity oracle, the confidence audit) and in two read-only **display/snapshot** readers — the
admin roster service (`server/services/ai-employees.ts:41,82-83`) and the Boardroom detail page
(`app/admin/ai-boardroom/[slug]/page.tsx:73`), plus the authoring before/after audit snapshot
(`app/admin/ai-boardroom/actions.ts:327,335`) — and **nowhere on the live serve path**. `permissions`'s
`can_execute` is **never written by any app code** (the execution lock is preserved). By contrast
`department` and `memory_scope` are **shared, non-authority** data read platform-wide — the memory
subsystem (`server/sdk/memory.ts`, `lib/memory/model.ts:448-461`), grant scoping
(`server/sdk/registry-resolver.ts:165`), and the roster/admin surfaces. *Consequence (unchanged):*
"drop the legacy columns" means **drop `tools_allowed` and `permissions` only** — never `department` or
`memory_scope`.

### 2.5 The instrumentation surface (all retained until it has served its purpose)

The parity/observability instruments that read the legacy columns: the standalone verifier
`verifyRegistryParity` (`registry-parity.ts:162-187`); the SQL oracle
`public.hq_capability_registry_parity()` (defined in the R2 backfill,
`supabase/migrations/20260807000000_capability_registry_backfill.sql:90-149`); the pure
`compareAuthority` (`server/sdk/registry-resolver.ts:213-224`, no DB); and the LR4 confidence audit
`auditRegistryConfidence` (`server/sdk/registry-confidence.ts`). The serve-path divergence check (via
`decideServedAuthority` → `compareAuthority`) provides continuous request-path parity. All stay in
place through the confidence window and are retired only as the teardown reaches them (§4).

---

## 3. The Retirement Readiness gate (governs the whole phase)

The **Retirement Readiness Rule** (22nd) is the entry gate: *a compatibility layer may enter retirement
only when objective operational evidence demonstrates that it is no longer required* — five conditions,
conjunctive, independently reviewed. **None of the increments in §4–§6 may begin until this gate is
passed.** LR4 built the instrument that measures it; this is the bar it must show met, on production
traffic, before the CEO authorises the first removal increment.

| # | Readiness condition | How it is demonstrated | Instrument |
|---|---------------------|------------------------|------------|
| 1 | **Sustained production stability** | Registry authoritative (`CAPABILITY_AUTHORITY_SOURCE=registry`) continuously on real traffic for the CEO-set window (§10 fork A), zero rollback events; a rollback resets the clock. | `auditRegistryConfidence` run on cadence; the env control |
| 2 | **Zero unresolved parity divergence** | Every interval reports `registryDivergent=0` (or each divergence individually accounted for as an intended authoring change); the serve-path divergence check and the SQL oracle agree. | confidence audit; `verifyRegistryParity`; `hq_capability_registry_parity()` |
| 3 | **Successful rollback validation** | The rollback has been *exercised and proven to restore the legacy serve path correctly* (not merely present) — the LR4 audit's `rolled-back` measurement, plus a controlled rollback drill. | confidence audit (`rolled-back` outcome); the integration proof |
| 4 | **Complete operational observability** | The window is *measured, not elapsed*: divergence/fallback/readiness are monitored on an ops/CI cadence with recorded readings. | confidence audit cadence; the R4 log lines |
| 5 | **Documented retirement evidence** | The evidence is a reviewable artefact: the [LR4 evidence ledger](./directive-015-lr4-production-confidence-evidence.md), extended with the window's recorded readings. | the evidence ledger |
| — | **+ Backfill gaps closed** | Every live employee has an authored grant — `backfillGaps=0` — so retiring the legacy fallback cannot strand anyone (a §4.4 precondition that becomes load-bearing at §5). | confidence audit (`backfill-gap` outcome) |

**The hard clause:** even with all five met, retirement **begins only after independent CEO review** of
the evidence authorises the first increment. This gate is re-checked before each *irreversible* step
(§5 rollback retirement, §6 column drop), not only once.

---

## 4. Compatibility retirement sequence (CEO area 1)

Removal proceeds as **ordered, independently-reviewable increments**, each its own PR under the full
validation, each leaving the platform shippable, each removing nothing the next still depends on. The
order follows the dependency chain in §2: **retire the rollback before what it falls back to; retire
the comparison before the data it compares; stop the mirror before you drop the columns it writes;
graduate last.** These refine the original proposal's C5–C8 for the now-accurate surface.

- **LR5·1 — Retire the rollback path** (the original C5; detailed in §5). Remove the
  `CAPABILITY_AUTHORITY_SOURCE` lever, the `legacy` arm of `decideServedAuthority`, and
  `legacyServedAuthority` / the legacy fail-safe in `resolveServedAuthority`; the registry-error /
  silent-registry fail-safe **re-points from legacy to the default-deny floor** (`EMPTY_CAPABILITIES` +
  locked posture), never to legacy. Its own independent review. *Precondition:* the §3 gate, including
  **backfill gaps closed**, so re-pointing the fail-safe to the floor cannot strand an employee.
- **LR5·2 — Remove the legacy runtime resolvers + the comparison surface.** With nothing serving or
  falling back to legacy, delete `resolveEmployeeCapabilities` / `resolveEmployeePosture` (legacy
  authority arms), `legacyAuthorityOf`, `legacyServedAuthority`, `compareAuthority`, and
  `verifyRegistryParity`; retire the runtime divergence check. Migrate the two read-only
  display/snapshot readers of `tools_allowed`/`permissions` (the admin roster service and the Boardroom
  detail page, §2.4) and the authoring audit snapshot onto the registry, so nothing outside the mirror
  reads the authority columns. The LR4 confidence audit's legacy-comparison ends here (its fate is
  §10 fork C).
- **LR5·3 — Stop the authority mirror + drop the authority-exclusive columns + retire the SQL oracle**
  (the original C7; order detailed in §6). Stop the deterministic mirror writes to
  `tools_allowed`/`permissions` inside `hq_author_employee_capabilities` (the columns go inert), then a
  new forward-only migration drops **only** those two columns and `public.hq_capability_registry_parity()`
  (it reads them). The `memory_scope` mirror and column are **retained** (shared data; §2.4, §10 fork B).
- **LR5·4 — Rewrite dependent tests + graduate the contract** (the original C8; §8). Update every suite
  that asserted legacy retention / read the columns / compared the two sources, in lockstep with the
  changes that obsolete them; write the completion record + ADR addendum; graduate Architecture-Freeze
  contract **#8** Reserved → Established.

LR5·1 gates LR5·2; LR5·2 gates LR5·3; LR5·3 gates LR5·4. No increment is authorised by this document;
each returns for its own review, and the two irreversible ones (LR5·1, LR5·3) are additionally CEO-gated
to production cutover.

---

## 5. Rollback retirement sequence (CEO area 2)

This honours the **Rollback Readiness Rule** (17th — "removing the rollback is a separate engineering
phase requiring independent review") and the **Retirement Readiness Rule** (22nd) directly. The rollback
path is **part of the R4 implementation**, not an operational extra, and is retired only as its own
increment (LR5·1), in this order:

1. **Pass the §3 gate first, including a rollback drill.** Retirement Readiness condition 3 requires the
   rollback be *proven to work* before it is removed — a controlled flip to `legacy` and back, observed
   correct, on top of the LR4 audit's honest `rolled-back` measurement. The safety net is validated
   precisely so it can be removed.
2. **Confirm backfill gaps are closed.** The fail-safe today catches a registry read error or a silent
   registry by serving legacy. After retirement it must serve the **default-deny floor** instead. That
   is only safe if every live employee has an authored grant (`backfillGaps=0`), so no one depends on
   the silent fallback — re-verified at the increment, not merely at the window's start.
3. **Re-point the fail-safe, then remove the lever.** In one reviewed increment: change the
   registry-error and silent-registry branches to resolve to `EMPTY_CAPABILITIES` + locked posture
   (preserving default-deny), then remove `CAPABILITY_AUTHORITY_SOURCE` from `lib/env.ts`, collapse
   `decideServedAuthority` to "serve the registry" (dropping the `legacy`/`rollback`/`empty`→legacy
   arms), and delete `legacyServedAuthority`. `resolveServedAuthority` becomes registry-only.
4. **Order is respected.** The rollback **depends on** the legacy resolvers and columns; it is therefore
   retired **before** them (LR5·1 before LR5·2/LR5·3) — never the reverse. Removing the columns while the
   `legacy` lever still claimed to work would be a rollback that silently fails: itself a violation.

After retirement, the standing escape hatch that remains is ordinary version-control revert — the
Rollback Readiness Rule's explicit distinction between an *immediately usable* rollback (retired here,
its bar met) and a code revert (always available).

---

## 6. Legacy column removal order (CEO area 3)

"Drop the legacy columns" means **`ai_employees.tools_allowed` and `permissions` only** — never
`department` or `memory_scope` (§2.4; the original Finding 3, unchanged). The order within LR5·3:

1. **Stop the authority mirror.** Remove the mirror writes to `tools_allowed`/`permissions` from
   `hq_author_employee_capabilities` (a new migration redefining the RPC; existing migrations are
   immutable history). Authoring continues to write the **grant**; it simply stops projecting onto the
   two columns, which become **inert** — written by nothing, read by nothing once LR5·2 migrated the
   display readers.
2. **Re-verify inertness.** A backfill-gap + reader audit confirms no live serve path, no display
   reader, and no instrument still reads `tools_allowed`/`permissions` (the confidence audit's roster
   read is updated or retired per §10 fork C).
3. **Drop the columns + the SQL oracle in one forward-only migration.** Drop `tools_allowed` and
   `permissions`, and drop `public.hq_capability_registry_parity()` (it reads them, R2 backfill
   `:108-144`). Parity verification, having served its purpose through the confidence window, is retired
   here — **last**, per the Evidence Before Deletion Rule.
4. **`memory_scope` and `department` are provably untouched.** The migration asserts it drops exactly
   two columns; the `memory_scope` mirror (`hq_author_employee_memory_scope`) and both shared columns
   remain, their memory/task-queue/roster readers unaffected. (Whether `memory_scope` should later be
   served-only and de-mirrored is §10 fork B — explicitly **out of scope** for #015.)

`can_execute` is never written by app code today, so dropping `permissions` removes no write path; the
execution lock is unaffected.

---

## 7. Cleanup validation (CEO area 4)

Cross-cutting checks applied to **every** increment, so removal can never strand an employee or silently
change behaviour:

- **Full validation per increment** — typecheck · lint · unit · security · integration · build, plus the
  runner/reference suites, green before merge.
- **Default-deny preserved at every step.** A missing grant, an unknown identity, or an unavailable
  registry resolves to `EMPTY_CAPABILITIES` + locked posture — *especially* after LR5·1 re-points the
  fail-safe from legacy to the floor. No increment may create a path that resolves to **more** authority
  than the floor without an explicit grant.
- **The reference path stays green.** The executor Reference Path
  (`__tests__/sdk/reference-path-execution.test.ts`) and the runner suites pass across every increment —
  the standing proof the served `ResolvedCapabilitySet` contract did not move.
- **Backfill-gap audit before each irreversible step.** Re-run the confidence audit's `backfill-gap`
  check before LR5·1 (fail-safe re-point) and LR5·3 (column drop): every live employee has an authored
  grant.
- **Parity green until the instrument is retired.** Until LR5·3 drops the oracle, `verifyRegistryParity`
  / the SQL oracle / the serve-path divergence check report parity for every live employee before each
  merge.
- **Shared columns provably untouched.** An explicit check that `department` and `memory_scope` are
  **not** in the LR5·3 drop, and that their memory/task-queue/roster readers are unaffected.
- **Forward-only migration discipline.** Existing migrations are immutable; the RPC change and the column
  drop are **new** migrations. Each irreversible cutover to production is CEO-gated.
- **No big-bang.** Each increment is independently shippable and revertible by version control; the
  irreversible drops come only after the confidence window (§3) and the rollback retirement (§5).

---

## 8. Final migration completion criteria (CEO area 5)

Directive #015 is **complete** — and Architecture-Freeze contract **#8 (Capability Registry)** graduates
**Reserved → Established** — when **all** of the following hold, demonstrated with evidence:

1. **The registry is the sole authority.** No rollback lever, no legacy resolver, no legacy-comparison
   surface remains; `tools_allowed` and `permissions` are dropped; the registry is the single
   authoritative source for authoring and serving all four dimensions — the **Single Source of Authority
   Rule** (13th) made literal, no longer a duplicated model.
2. **Shared data is intact.** `department` and `memory_scope` remain, with their platform-wide readers
   unaffected (Finding 3 honoured).
3. **Default-deny is intact.** The floor still governs every unresolved subject; the reference path and
   runner suites are green.
4. **The evidence is recorded.** The Retirement Readiness conditions were shown met and independently
   reviewed before retirement began; the LR4 evidence ledger carries the window's readings; a **#015
   completion report** + an **ADR 0010 addendum** record what was removed, what was deliberately retained
   (`department`, `memory_scope`, version-control revert), and what the platform learned.
5. **The canon is synced in one stroke.** The Architecture Freeze and the Kernel Contract Map graduate
   contract #8 together (the synchronisation rule); `numbering.md` records #015 complete.
6. **All six gates green** on the graduating PR, with every dependent test rewritten to the post-removal
   world in lockstep with the change that obsoleted it.

Graduation is the **outcome** of LR5·4, never an act of this proposal (§10 fork D confirms the timing).

---

## 9. Engineering rules this phase honours

No new rule is needed; the governing rule was set on the LR4 review. The sequence applies, in order:

- **The Retirement Readiness Rule (22nd).** The §3 gate *is* this rule: retirement begins only on the
  five conditions, demonstrated and independently reviewed. It governs the whole phase.
- **The Rollback Readiness Rule (17th).** Rollback retired as its own increment (LR5·1), only after
  sustained stability, and **before** what it falls back to (§5).
- **The Evidence Before Deletion Rule (18th).** Every deletion rests on objective evidence, never on the
  registry's mere existence; parity is retired **last**, after it has done its job (§6).
- **The Compatibility Layer Rule (21st).** This phase *executes* the retained layer's approved retirement
  plan — the layer was owned, bounded by measurable exit criteria, continuously validated, and carried
  this plan; LR5 is that plan made concrete.
- **The Mirror Integrity Rule (19th).** The mirror stays a deterministic derived representation right up
  to the moment it is stopped (§6 step 1); it is never edited directly while it exists.
- **The Behaviour Preservation Rule (15th)** and **Single Source of Authority Rule (13th).** Removal
  changes **no** observable behaviour (the served contract is unchanged throughout); the end state is the
  single authoritative source the 13th has always named.

---

## 10. Open questions for the CEO to rule on

- **Fork A — the confidence-window duration.** The Retirement Readiness Rule requires *sustained*
  production stability; the concrete duration (e.g. *N* consecutive weeks authoritative, zero rollback,
  zero unexplained divergence) remains the CEO's to set. This was fork B of the original proposal and is
  still open; LR5·1 cannot begin until it is fixed and met. *Recommendation: set a concrete minimum now.*
- **Fork B — `memory_scope`'s long-term shape.** `memory_scope` is served from the registry yet also
  mirrored to a **shared** column the memory subsystem reads. This proposal **retains** the column and its
  mirror (the conservative default; it is non-authority data). A later, separate directive could migrate
  the memory subsystem to read `memory_scope` from the registry and de-mirror the column — but that is
  **out of scope for #015**. *Recommendation: confirm retain-and-mirror for #015; defer de-mirroring.*
- **Fork C — the confidence audit's fate at LR5·2.** `auditRegistryConfidence` compares registry vs
  legacy; once legacy is gone it cannot compare. Either **retire** it with the comparison surface, or
  **transform** it into a registry-only readiness/health signal (registry readable, every employee has a
  grant, default-deny intact) so observability survives. *Recommendation: transform — keep a registry-only
  health check; retire only the legacy-comparison parts.*
- **Fork D — graduation timing.** Confirm contract #8 graduates Reserved → Established at **LR5·4** (after
  the columns drop and the registry is truly single-sourced), not earlier. *Recommendation: confirm.*
- **Fork E — increment granularity.** Confirm the four increments LR5·1–LR5·4 are each their own PR (with
  LR5·1 and LR5·3 additionally production-cutover-gated), versus a finer split. *Recommendation: confirm
  the four; split further only if a review surfaces risk.*

---

## 11. Proposed sequencing — *if approved* (not authorised here)

If the CEO approves the design, and **once the §3 Retirement Readiness gate is met on production and
independently reviewed**, the work would proceed as the §4 increments **LR5·1 → LR5·4**, in that order,
each its own PR under the full validation and **per-increment CEO review**, with the irreversible steps
(LR5·1 rollback retirement, LR5·3 column drop) additionally CEO-gated to production. The gate is
re-checked before each irreversible step, not only once.

**STOP.** Per the CEO's authorisation, this phase produces **only this proposal**. No legacy authority
column, no compatibility (mirror) write, no rollback control, no parity verification, and no migration
instrumentation is to be removed, weakened, or scheduled for removal until this proposal has been
**reviewed and approved** and each increment separately authorised. The full validation discipline is
maintained.

---

*Documentation only. No code, schema, migration, configuration, numbering, or git history was changed by
this proposal. Prepared under CEO Directive #011 (Master Roadmap D-01) as the legacy-removal *sequence*
design for CEO Directive #015 / D-05 — the Capability Registry — following the merged R1–R4 and LR1–LR4
slices, and governed by the engineering standards homed in the [Kernel Contract Map](./kernel-contract-map.md)
§2, in particular the Retirement Readiness Rule (the twenty-second standard) which gates the entire phase
this document designs. Architecture-Freeze contract #8 (Capability Registry) graduates Reserved →
Established only on completion of that phase (LR5·4). This proposal awaits CEO review; no implementation
begins until it has been reviewed and approved.*
