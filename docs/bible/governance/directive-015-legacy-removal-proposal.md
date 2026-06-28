# CrewFlow Governance — Directive #015 (D-05) Legacy Removal Proposal: retiring the legacy authority model

> **Status:** **Proposed — awaiting CEO review.** This is a **design proposal, not a decision**: it
> renumbers nothing and changes no code, schema, migration, configuration, or git history. It is
> authored under the *document-before-you-build* rule, in response to the CEO's authorisation on
> the **Directive #015 R4 review**: *"Proceed to the **Legacy Removal Proposal only**… The next
> deliverable is a design proposal describing: removal criteria · production confidence requirements ·
> rollback retirement conditions · migration cleanup sequence · operational safety checks. No
> implementation begins until that proposal has been reviewed and approved."* It presents those five
> areas, each in its own section (**§3–§7**), preceded by the removal surface they act on (**§2**) and
> followed by the rules honoured (**§8**), the forks for the CEO (**§9**), and the sequencing the work
> *would* follow if approved (**§10**).
>
> **It removes nothing.** The CEO directed that this phase **not** begin removing any of: the legacy
> authority columns · the legacy runtime resolver · the migration mirrors · the parity verification ·
> the rollback controls. This document describes *how and when* each could be retired, and the gates
> each must pass first — it does not retire any of them. Prepared under CEO Directive **#011**
> (*Governance, Numbering & Scope Reconciliation*; Master Roadmap **D-01**) for CEO Directive **#015 /
> D-05** (*The Capability Registry*). It is governed by the engineering standards homed in the
> [Kernel Contract Map](./kernel-contract-map.md) §2 — in particular the **Rollback Readiness Rule**
> (the seventeenth standard, set on the R4 review), which **names this proposal** as the gate the
> legacy-removal phase must pass. **The proposal proposes; it does not build.**
>
> **Sequence context.** Directive #015 has shipped R1 (schema) → R2 (backfill + parity gate) → R3
> (shadow resolver) → R4 (the runtime authority switch), each reviewed and merged. The registry is now
> the **authoritative** runtime source of an employee's capabilities, with the legacy `ai_employees`
> model **retained** as the immediately-usable rollback and automatic fail-safe (R4). What remains
> before Architecture-Freeze contract **#8 (Capability Registry)** can graduate Reserved → Established
> is this final phase: removing the retained legacy model — but only once it is *safe* to, and only as
> a **separately-authorised** act. This document is the design for that phase.

---

## 1. How to read this, and the one-paragraph thesis

The CEO's mandate is to **present the legacy-removal design and hold for review** — not to begin
removing. §1 gives the thesis and the scope boundary. **§2** inventories the legacy authority model as
it stands today — the precise *removal surface*, with the three structural findings that shape
everything after it. **§3–§7** answer, in order, the **five areas the CEO required**: removal criteria
(§3) · production-confidence requirements (§4) · rollback-retirement conditions (§5) · migration
cleanup sequence (§6) · operational safety checks (§7). §8 lists the engineering rules this phase
honours and the one prerequisite it surfaces. §9 raises the genuine forks as **explicit questions for
the CEO to rule on**. §10 sketches the sequencing the implementation *would* follow **if approved**,
and states the STOP. Every factual claim about today's code is cited to repository evidence verified
at the current integration tip.

**The thesis (one paragraph).** The legacy authority model can be removed — but **not yet, and not in
one act**, because today the registry is not yet an *independent* source of truth: it is a
**continuously-verified mirror** of the very legacy columns the phase would delete. The R2 backfill
populated `hq_capability_grants` **solely** by projecting each employee's `ai_employees.tools_allowed`
/ `permissions` / `memory_scope` into one employee-scoped grant (the *flat mirror*;
`supabase/migrations/20260807000000_capability_registry_backfill.sql:176-206`), and **no other path
writes a grant** — there is no registry-native authoring surface. So although R4 made the registry
*authoritative at serve time* (`resolveServedCapabilities`, `server/sdk/registry-parity.ts:208-262`),
the legacy columns remain the *de facto* origin of the data, and dropping them now would leave the
authoritative store **unwritable**. Legacy removal is therefore **gated on building what the migration
deferred** — a registry-native authoring path — and on two further facts the inventory surfaces
(posture is still not served from the registry; two of the four columns are shared, non-authority
data). This proposal defines the criteria, the production-confidence bar, the rollback-retirement
conditions, the cleanup order, and the safety checks under which that removal becomes correct — and
defers every byte of it to a future, separately-authorised slice.

**Scope boundary (what this proposal is *not*).** It does **not** remove, or authorise removing, any
legacy element — the columns, the legacy resolver, the mirrors, the parity verification, or the
rollback controls all stay exactly as R4 left them. It does **not** change the served behaviour (the
registry stays authoritative; the rollback stays usable). It does **not** build the registry-native
authoring path it identifies as the prerequisite — it only **names** it as the gate. It does **not**
graduate contract #8 — that graduation is the *outcome* of the phase this document designs, not an act
of this document. And it sets **no** new rule: the governing rule (Rollback Readiness) was already set
on the R4 review.

---

## 2. The legacy authority model today — the removal surface

Before naming criteria, this section fixes exactly **what** "the legacy authority model" *is* in the
repository, so the criteria act on a precise surface and the cleanup sequence (§6) can be checked
against it. There are five elements, and three findings that govern how — and in what order — they may
go.

### 2.1 The five legacy elements (the CEO's do-not-remove list, located in the code)

1. **The legacy authority columns** on `ai_employees`
   (`supabase/migrations/20260712000000_ai_employees.sql`): `tools_allowed text[]` (:72),
   `permissions jsonb` = `{can_execute, requires_approval, scopes}` (:77-78), `memory_scope text`
   (:80), `department text` (:32). These are the original source of authority.
2. **The legacy runtime resolver**: `resolveEmployeeCapabilities` (`server/sdk/tasks.ts:146-162`,
   stamps `source: "ai_employees"`) and its sibling `resolveEmployeePosture` (:189-197, reads
   `permissions`), plus the comparison bridge `legacyAuthorityOf`
   (`server/sdk/registry-parity.ts:121-134`).
3. **The migration mirrors**: the R2 flat-mirror backfill that derives every grant from the columns
   (`…_backfill.sql:160-206`), and the seed migrations that write the legacy columns directly
   (`…_ai_employees_seed.sql`, `…_research_ai_employee.sql`, `…_lead_qualification_employee.sql`,
   `…_outreach_ai_employee.sql`). The registry is, today, a one-directional mirror *of* these.
4. **The parity verification**: the SQL drift detector `public.hq_capability_registry_parity()`
   (`…_backfill.sql:90-149`), its pure runtime analogue `compareAuthority`
   (`server/sdk/registry-resolver.ts:213-224`), the request-path check `verifyRegistryParity`
   (`server/sdk/registry-parity.ts:154-179`), and the parity test suites (R2/R3/R4).
5. **The rollback controls**: the `CAPABILITY_AUTHORITY_SOURCE` env lever (`lib/env.ts:135-154`),
   the pure switch law `decideServedAuthority` (`server/sdk/registry-resolver.ts:281-292`) with its
   `legacy` arm, and the fail-safe fallback inside `resolveServedCapabilities`
   (`server/sdk/registry-parity.ts:208-262`).

### 2.2 Finding 1 — the flat-mirror authoring gap (the gating dependency)

The registry has **exactly one writer**: the R2 backfill. It inserts **one employee-scoped grant per
`ai_employees` row**, copying that row's resolved tokens, posture, and memory scope
(`…_backfill.sql:184-206`), and the backfill itself documents why it must stay flat — factoring tokens
up to broader scopes would grant authority the legacy model never gave and **break parity** (:30-43).
No admin surface, service, or seed writes a grant; the admin Boardroom pages still read and (for
`memory_scope`) write the **legacy columns** (`app/admin/ai-boardroom/actions.ts`,
`app/admin/ai-boardroom/[slug]/page.tsx`), and `applicableGrants` confirms the registry is empty above
the employee level — organization grants "are authored post-migration … exactly the flat-mirror state
R2 left" (`server/sdk/registry-resolver.ts:169-171`). **Consequence:** the legacy columns are still
the only place authority can be *authored*; the registry merely *reflects* them. Until a
**registry-native authoring path** exists (the admin surface and seeds writing grants directly, the
backfill mirror retired), dropping the columns would leave the authoritative store with no writer.
This is the single largest prerequisite, and may warrant its own slice or directive (§9, fork A).

### 2.3 Finding 2 — posture is not yet served from the registry

R4 switched **only capabilities**. Both production serve sites set `identity.capabilities = await
resolveServedCapabilities(emp)` and nothing more (`server/services/hq-research.ts:325`,
`server/services/hq-qualification.ts:241`), and `resolveServedCapabilities` returns only
`{ tokens, source }` (`server/sdk/registry-parity.ts:244`) — it **discards** the registry's composed
posture. `identity.posture` is never assigned on the serve path, so it resolves at build to the
locked floor (`posture: identity.posture ?? LOCKED_POSTURE`, `server/sdk/tasks.ts:595`). The registry
*stores* posture per grant and the parity function *verifies* it (`…_backfill.sql:133-144`), but no
runtime path *serves* it. **Consequence:** `permissions` carries two things — the capability *scopes*
(mirrored into tokens) **and** the *posture* (`can_execute`/`requires_approval`). Even once authoring
is registry-native, `permissions` cannot be dropped until posture too is served from the registry (a
posture analogue of the R4 capabilities switch — threading the registry's composed
`canExecute`/`requiresApproval` onto `ctx`). Tracked as a removal precondition, not a silent gap.

### 2.4 Finding 3 — only two of the four columns are authority-exclusive

The four legacy columns do **not** all belong to the authority model. `department` and `memory_scope`
are **shared, non-authority** data read platform-wide — the memory subsystem (`server/sdk/memory.ts`,
`server/services/hq-memory.ts`, `lib/memory/model.ts`), the task queue read model
(`server/services/hq-task-queue.ts`), and the admin memory surfaces — and `department` additionally
**keys the registry's own department-scope** (`server/sdk/registry-resolver.ts:165`). They must be
**retained**. Only `tools_allowed` and `permissions` are **authority-exclusive** — read on the
authority path and the admin authority editor and nowhere structural beyond it — and are therefore the
**only droppable columns** in this phase. "Drop the legacy columns" precisely means **drop
`tools_allowed` and `permissions`**, never `department` or `memory_scope`.

---

## 3. Removal criteria (CEO area 1)

The criteria are a **conjunction**: *every* one must hold before *any* legacy element is
removed. They are deliberately phrased as verifiable gates, not aspirations.

1. **Registry-native authoring exists and is the sole writer.** A path to author grants directly in
   the registry — the admin Boardroom authority editor writing `hq_capability_grants`, and seeds
   writing grants rather than columns — is built, reviewed, in use; the R2 flat-mirror is no longer
   the origin of authority (Finding 1). *Without this, nothing else may proceed.*
2. **Posture is served from the registry.** A served-posture path threads the registry's composed
   `canExecute`/`requiresApproval` onto `ctx`, so `permissions.{can_execute,requires_approval}` is no
   longer the served source (Finding 2), proven by the same parity discipline R4 used for tokens.
3. **The switch is complete across every serve site.** Every employee identity-assembly path serves
   the registry (today: `hq-research`, `hq-qualification`; any employee added later included) — no
   call site still assembles authority from the bare legacy resolver. Verified by a source-level test.
4. **Parity has held continuously, on real traffic, for the confidence window** defined in §4 — the
   registry and the (still-retained) legacy model resolving identically, with zero unexplained
   divergence.
5. **The rollback-retirement conditions (§5) are satisfied** for any element whose removal would
   weaken the rollback path — and that removal is taking place under its **own** independent review,
   never folded into another change.
6. **All dependent tests are rewritten green.** Suites that assert the legacy model is retained, read
   the legacy columns, or compare the two sources are updated to the post-removal world *in the same
   change* that removes what they cover (the synchronisation rule), with the full six-gate CI green.

Criterion 1 gates 2–6; criteria 4 and 5 gate the irreversible drops in §6. No criterion is waivable
under schedule pressure — that waiver is precisely what the Rollback Readiness Rule forbids.

---

## 4. Production-confidence requirements (CEO area 2)

The Rollback Readiness Rule requires "**sustained production stability** … not a single green deploy,
but confidence accrued over time on real traffic." This section makes that measurable. Confidence is
**banked**, not assumed, and the existing parity machinery (§2.1 element 4) is the instrument that
measures it — which is precisely why parity verification is removed **last** (§6), after it has done
its job.

- **A defined observation window on production traffic.** The registry must serve as authoritative
  (`CAPABILITY_AUTHORITY_SOURCE=registry`) continuously for a **sustained window** — proposed as a
  concrete minimum for the CEO to set (§9, fork B), e.g. *N* consecutive weeks of live operation —
  with **no rollback event** during it. A rollback (a flip to `legacy`) resets the clock.
- **Zero unexplained parity divergence across the window.** `compareAuthority` /
  `verifyRegistryParity` on the request path and `hq_capability_registry_parity()` run on
  ops/CI cadence must report parity throughout. Any divergence must be either (a) zero, or (b)
  individually explained and resolved as an intended registry-native authoring change — never an
  unexplained drift. Once authoring is registry-native (criterion 1), *intended* divergence from the
  frozen legacy columns is expected; the bar is that every divergence is **accounted for**.
- **Fail-safe exercised, not just present.** The fallbacks (registry read error → legacy; registry
  silent → legacy) must have been observed to behave correctly — ideally exercised deliberately in a
  controlled production check — so confidence covers the *failure* modes, not only the happy path.
- **Backfill gaps closed.** No live employee may be served via the silent-registry fallback (`source`
  resolving to legacy because no grant exists) — every employee has an authored grant. A subject the
  registry is silent about is, by definition, still depending on the legacy model.
- **Observability in place.** The divergence and fallback log lines R4 emits
  (`server/sdk/registry-parity.ts`) are monitored, so the window is *measured*, not merely elapsed.

Confidence is a property of the **registry**, demonstrated **before** the rollback is retired and long
before the legacy code is deleted. Meeting §4 unlocks §5; it does not by itself authorise removal.

---

## 5. Rollback-retirement conditions (CEO area 3)

This section honours the **Rollback Readiness Rule** directly — the rule names the rollback-retirement
conditions as a required output of this proposal. The rollback path (the `CAPABILITY_AUTHORITY_SOURCE`
lever, the `decideServedAuthority` `legacy` arm, and the fail-safe fallback) is **part of the R4
implementation, not an operational extra**, and may be retired only under all of the following:

1. **Sustained production stability is demonstrated first.** Every §4 requirement is met. Until then
   the rollback is **immutable** — it may not be removed, weakened, or made harder to use.
2. **Retirement is its own independently-reviewed phase.** Per the rule, removing the rollback is "a
   separate engineering phase requiring independent review." It is never folded into the authoring
   work, the column drop, or any unrelated change — it is a standalone, CEO-reviewed increment whose
   sole purpose is retiring the rollback.
3. **The replacement need it covered is gone.** The rollback exists to restore the *legacy serve path*
   instantly. It may be retired only once that path is no longer needed — i.e. after registry-native
   authoring (criterion 1) and registry-served posture (criterion 2) mean a flip to `legacy` would
   restore an **inferior, now-stale** model, not a needed safety net.
4. **Ordering is respected.** The rollback path **depends on** the legacy resolver and columns;
   therefore the rollback is retired **before** the legacy resolver and the columns it falls back to
   — never the reverse. Removing the columns while the `legacy` lever still claims to work would be a
   rollback that silently fails: itself a standards violation.

After retirement, `decideServedAuthority` collapses to "serve the registry" and
`CAPABILITY_AUTHORITY_SOURCE` is removed from `lib/env.ts`. Note the **standing escape hatch** that
remains regardless: ordinary version-control revert. The Rollback Readiness Rule distinguishes an
*immediately usable* rollback (a control, no redeploy) from a code revert; once confidence is
sustained, the rule's bar is met and the platform falls back to the normal revert path like any other
settled subsystem.

---

## 6. Migration cleanup sequence (CEO area 4)

Removal proceeds as **ordered, independently-reviewable increments**, each its own PR under the full
six-gate validation, each leaving the platform shippable. The order follows the dependency chain
in §2: **author before you stop mirroring; stop mirroring before you bank confidence; bank confidence
before you retire the rollback; retire the rollback before you delete what it falls back to.**

- **C1 — Build registry-native authoring (the prerequisite; possibly its own directive).** The admin
  Boardroom authority editor writes `hq_capability_grants`; new seeds write grants; the registry gains
  an independent writer (Finding 1; criterion 1). *No removal yet.* This is the long pole and is a
  fork for the CEO (§9, fork A).
- **C2 — Serve posture from the registry.** Add the posture analogue of the R4 capabilities switch so
  `ctx` posture comes from the composed registry authority (Finding 2; criterion 2), behind the same
  parity discipline. *No removal yet.*
- **C3 — Retire the mirror, not the columns.** Stop deriving grants from the columns: the flat-mirror
  backfill is no longer the origin (authoring is now native), and the columns become **inert** —
  written by no authority path, read by no serve path. *The columns still physically exist*; this only
  cuts the mirror relationship. (Existing migrations are immutable history, never edited; "retire
  the mirror" means no new mirror writes and inert columns.)
- **C4 — Bank production confidence (§4).** With the registry authoritative, authoring native, posture
  served, and the columns inert, run the **sustained observation window**. The parity machinery is the
  instrument and stays fully in place. *No removal yet — this is the waiting phase the rule demands.*
- **C5 — Retire the rollback path (§5; separate independent review).** Remove the
  `CAPABILITY_AUTHORITY_SOURCE` lever, the `decideServedAuthority` `legacy` arm, and the fail-safe
  fallback; `decideServedAuthority` collapses to serve-registry. Its own CEO-reviewed increment.
- **C6 — Remove the legacy runtime resolver.** With nothing serving or falling back to legacy, delete
  `resolveEmployeeCapabilities` / `resolveEmployeePosture` (legacy arms), `legacyAuthorityOf`, and the
  legacy-comparison surface (`compareAuthority`, `verifyRegistryParity`, the comparison types).
- **C7 — Drop the authority-exclusive columns + retire SQL parity.** A new migration drops **only**
  `ai_employees.tools_allowed` and `permissions` (never `department`/`memory_scope` — Finding 3), and
  drops `public.hq_capability_registry_parity()` (it reads the dropped columns). Parity verification —
  having served its purpose through C4 — is retired here, last.
- **C8 — Rewrite the dependent tests + graduate the contract.** Update every suite that asserted the
  legacy model / read the columns / asserted retention, in lockstep with the changes that obsolete
  them; write the completion record + ADR addendum; graduate Architecture-Freeze contract **#8**
  Reserved → Established, syncing the Freeze and the Kernel Contract Map in one PR.

C1 gates everything; C4 gates C5; C5 gates C6/C7. No increment is authorised by this document; each
returns for review on its own.

---

## 7. Operational safety checks (CEO area 5)

Cross-cutting checks that apply to **every** increment in §6, so removal can never strand an employee
or silently change behaviour:

- **Per-increment parity is green before merge** (until C7 retires the instrument): the SQL parity
  function and the runtime comparison report parity for every live employee.
- **The reference path stays green.** The executor Reference Path
  (`__tests__/sdk/reference-path-execution.test.ts`) and the runner suites must pass across every
  increment — the standing proof that the served `ResolvedCapabilitySet` contract did not move.
- **Default-deny is preserved at every step.** A missing grant, an unknown identity, an unavailable
  registry → `EMPTY_CAPABILITIES` + locked posture. No increment may create a path that resolves to
  *more* authority than the floor without an explicit grant.
- **No big-bang.** Each increment is independently shippable and revertible by version control;
  the irreversible drops (C7) come only after the confidence window (C4) and the rollback retirement
  (C5).
- **Backfill-gap audit before any drop.** Confirm every live employee has an authored registry grant
  (no reliance on the silent-registry fallback) before C5/C7 — the §4 "backfill gaps closed" check,
  re-run at the drop.
- **Shared columns are provably untouched.** A check that `department` and `memory_scope` are *not* in
  the C7 drop, and that their memory and task-queue readers are unaffected (Finding 3).
- **Forward-only migration discipline.** Existing migrations are immutable; the column drop is a new
  migration. Cutover of any irreversible step to production is CEO-gated, consistent with platform
  migration discipline.
- **Full six-gate CI per increment**: typecheck · lint · unit · security · build · the runner suites.

---

## 8. Engineering rules this phase honours — and the prerequisite it surfaces

**Honours (no new rule needed; all five §2 migration standards bear directly):**

- **The Rollback Readiness Rule (17th).** The whole shape of this phase — confidence before retirement
  (§4→§5), retired as its own reviewed increment (C5), rollback retired *before* what it falls
  back to (§5.4, C5→C6/C7) — is this rule applied. It explicitly names this proposal's
  rollback-retirement conditions (§5) as required output.
- **The Shadow Validation Rule (16th).** Its post-cutover complement; the shadow that earned
  R4's switch is the instrument that banks confidence here (§4) before it is finally retired (C7).
- **The Behaviour Preservation Rule (15th).** Removal changes **no** observable behaviour: the served
  `ResolvedCapabilitySet` contract is unchanged throughout; only sourcing and dead code are removed.
- **The Migration Parity Rule (14th).** "A legacy source is removed only after parity is demonstrated,
  and parity must be continuously verifiable" — §3 criterion 4 and §4 are this rule, applied to the
  *removal* direction.
- **The Single Source of Authority Rule (13th).** The end state the phase *delivers*: one
  authoritative source (the registry) with the legacy duplicate gone — the rule finally made literal.

**The prerequisite this phase surfaces (not a new rule — a build dependency).** Legacy removal is
**blocked on registry-native authoring** (Finding 1). The R2 migration deliberately deferred authoring
(it mirrored, it did not refactor); that deferral now comes due. Whether the authoring path is built
*within* this phase (as increment C1) or as a **separate directive** that this phase depends on is
the first fork for the CEO (§9).

---

## 9. Open questions for the CEO to rule on

- **Fork A — where authoring lives.** Build registry-native authoring as increment **C1 within the
  legacy-removal phase**, or scope it as a **separate directive** (it is net-new write surface —
  admin UI + seeds + grant administration — arguably its own piece of work) that legacy removal then
  depends on? *Recommendation: a separate, clearly-scoped slice, given its size and that it is
  net-new capability rather than removal.*
- **Fork B — the confidence window.** What is the concrete **sustained-stability bar** (§4)? Propose a
  minimum duration of authoritative-registry production operation with zero rollback and zero
  unexplained divergence (e.g. a number of consecutive weeks), for the CEO to set.
- **Fork C — posture serving (C2) scope.** Confirm posture is switched to the registry **within** this
  phase (recommended — `permissions` cannot drop otherwise), versus treating it as a separate
  capability switch first.
- **Fork D — column-drop confirmation.** Confirm the drop is **`tools_allowed` + `permissions` only**,
  with `department` and `memory_scope` **explicitly retained** as shared non-authority data
  (Finding 3). *Recommendation: confirm; this is load-bearing for the memory subsystem.*
- **Fork E — graduation timing.** Confirm contract #8 graduates Reserved → Established at **C8**
  (after the columns drop and the contract is truly single-sourced), not earlier at the R4 switch.

---

## 10. Proposed sequencing — *if approved* (not authorised here)

If the CEO approves the design, the work would proceed as the §6 increments **C1 → C8**, in that
order, each its own PR under the full six-gate validation and **per-increment CEO review**, with the
irreversible drops (C5, C7) additionally CEO-gated to production. C1 (or the separate authoring
directive, per fork A) is the long pole and must land and prove itself before C3 onwards; C4 is a
**deliberate waiting phase**, not idle time — it is where confidence is banked. **No increment is
authorised by this document.**

**STOP.** Per the CEO's authorisation, this phase produces **only this proposal**. No legacy authority
column, no legacy resolver, no migration mirror, no parity verification, and no rollback control is to
be removed, weakened, or scheduled for removal until this proposal has been **reviewed and approved**
and each increment separately authorised. The validation discipline is maintained in full.

---

*Documentation only. No code, schema, migration, configuration, numbering, or git history was changed
by this proposal. Prepared under CEO Directive #011 (Master Roadmap D-01) as the legacy-removal design
for CEO Directive #015 / D-05 — the Capability Registry — following the shipped R1–R4 slices and
governed by the engineering standards homed in the [Kernel Contract Map](./kernel-contract-map.md) §2,
in particular the Rollback Readiness Rule (the seventeenth standard) which names this proposal as the
gate the legacy-removal phase must pass. Architecture-Freeze contract #8 (Capability Registry)
graduates Reserved → Established only on completion of the phase this document designs. This proposal
awaits CEO review; no implementation begins until it has been reviewed and approved.*
