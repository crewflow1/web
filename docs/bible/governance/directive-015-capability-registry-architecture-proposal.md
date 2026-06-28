# CrewFlow Governance — Directive #015 (D-05) Architecture Proposal: the Capability Registry

> **Status:** **Architecture proposal — for review.** *Not* a decision; it renumbers
> nothing, changes no code, schema, migration, configuration, or git history. It is
> authored under the *document-before-you-build* rule in its **strictest** form: the CEO
> directed, on completing Directive #014, that *"before writing any code, present the
> complete Directive #015 architecture proposal for review,"* and that *"no implementation
> is authorised until that proposal has been reviewed and approved."* This document presents
> that architecture across the **nine areas the CEO named** — Capability Registry
> responsibilities · authorisation model · runtime resolution · registry ownership ·
> interaction with the SDK · interaction with the Tool Registry · interaction with the API
> Gateway · migration strategy · validation strategy — each in its own section (§2–§10).
> Prepared under CEO Directive **#011** (*Governance, Numbering & Scope Reconciliation*;
> Master Roadmap **D-01**) as the architecture proposal for CEO Directive **#015 / D-05**
> (*The Capability Registry*). **The proposal proposes; it does not build.**
>
> **Sequence context.** #015 is the **last** of the three post-#012 platform directives, by
> the evidence the [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md)
> fixed: **#013 RunContext (Established) → #014 AI SDK (Established) → #015 Capability
> Registry**. Both of its upstreams are now settled — identity is canonical
> ([`runtime-identity.md`](./runtime-identity.md) §7) and the SDK's single enforcement point
> (`ctx` + the gate) is built and proven end-to-end (Directive #014 complete at Phase C). The
> one-way dependency the analysis required — *registry depends on RunContext + SDK, never the
> reverse* — is therefore satisfied, and #015 may now be designed correctly for the first
> time. It graduates Architecture-Freeze contract **#8 (Capability Registry)** Reserved →
> Established.

---

## 1. How to read this, and the one-paragraph thesis

The CEO's mandate is to **present the architecture and hold for review** — not to begin
building. §1 gives the thesis and the scope boundary. §2–§10 answer, in order, the **nine
areas the CEO required**, each in its own section. §11 lists the engineering rules this
directive will honour and the one rule it *proposes* (for the CEO to set or decline). §12
surfaces the genuine forks as **explicit questions for the CEO to rule on**. §13 sketches the
small-increment sequencing the implementation *would* follow **if approved**. Every factual
claim about today's code is cited to repository evidence verified at the current integration
tip; every interface fragment is **illustrative, not implemented**.

**The thesis (one paragraph).** The Capability Registry is **not a new capability — it is the
consolidation of authority data that already exists**, scattered, and read ad hoc. Today an
employee's authority lives in four columns on `ai_employees` (`tools_allowed text[]`,
`permissions jsonb` = `{can_execute, requires_approval, scopes}`, `memory_scope text`,
`department text` — `supabase/migrations/20260712000000_ai_employees.sql:72,77,80,32`) and its
*registration* lives in four further surfaces with no single source (the cron manifest, the
admin nav, the CEO dashboard card, the migrated-roster test — [platform-independence
audit](./directive-012-platform-independence-audit.md) §5). #014 already reads the authority
data through **one** function — `resolveEmployeeCapabilities()` produces the opaque, frozen
`ResolvedCapabilitySet { tokens, source }` that `ctx.capabilities` threads and the gate enforces
(`server/sdk/tasks.ts:126-160`) — and that function's own comment **pre-designs this directive**:
*"D-05 can repoint the source to the Capability Registry by changing ONLY this function — the
`ResolvedCapabilitySet` every handler sees stays byte-for-byte identical,"* with
`source: "ai_employees" | "registry" | "none"` already reserving the `"registry"` value
(`tasks.ts:123-128`). #015 therefore **builds one declarative source of truth + one resolver,
repoints that single seam, and removes the scatter** — consolidating identity (settled by
#013), facet permissions (settled by #014), and the four registration surfaces (named by the
#012 audit) into the one place an employee is granted authority and registered. It is a
**consolidation/removal** directive: high on the Platform Reuse Index's **R4** (infrastructure
removed — `platform-reuse-index.md` §R4), squarely on-thesis, and — because identity is now
canonical and the enforcement point is now singular — at last safe to cut **once**.

**Scope boundary (what this directive is *not*).** #015 does **not** build, reopen, or
authorise the **API gateway + cost metering** — that is a *deferred future extension* of the
now-Established contract #3, not part of this directive (and not yet authorised). #015 does
**not** change any SDK facet contract, the gate's signature, the executor, or the
`ResolvedCapabilitySet` shape (the SDK Stability Rule + ABI Principle forbid it). #015 does
**not** own enforcement (the gate decides), tool *definitions* (the Tool Registry owns them),
identity (RunContext settles it; the registry keys to it), or execution (the executor + Task
Engine). It owns the **authority data and its resolver** — nothing more.

---

## 2. Area 1 — Capability Registry responsibilities

The registry is the **single declarative source of truth for what an employee *is* and what it
*may* do**, keyed by canonical identity. Concretely it owns:

1. **The grant record**, one per employee identity (`EmployeeIdentity.slug`):
   - **capability tokens** — the opaque labels an employee holds (today the union of
     `tools_allowed` + `permissions.scopes`), the set the gate matches a tool's required
     permission against;
   - **employment posture** — `can_execute` and `requires_approval` (today `permissions.*`),
     the coarse stance the gate reads as `EmploymentPosture`;
   - **memory scope** — `isolated | department | organization | global` (today `memory_scope`),
     the scope the memory facet honours;
   - **department** — the org grouping (today `department`);
   - **budget default** — the per-employee spend ceiling the runtime threads as `ctx.budget`
     (a *number* the registry supplies; metering is not the registry's job — §8);
   - **registration metadata** — the data that today lives scattered across the four manifest
     surfaces (does this employee run on a schedule; does it surface in the admin nav / CEO
     dashboard; is it in the migrated roster), so a new employee is registered, and an old one
     de-registered, in **exactly one place**.
2. **The resolver** — the pure function `identity → ResolvedCapabilitySet` (+ posture + memory
   scope + budget default) that the SDK already calls. The registry owns the *contract* of this
   resolver and its data; the SDK owns *calling* it.

**What it explicitly does *not* own** (the boundaries that keep the kernel from forking):

- **Enforcement / the authorisation *decision*.** The gate (`evaluateAction`) decides; the
  registry only supplies the grant it decides over. This is the **Policy vs Mechanism Rule** —
  the registry is *data*, the gate is *judge*.
- **Tool definitions.** The Tool Registry (`server/sdk/tools.ts`) owns what a tool *is* and
  what token it *requires*; the Capability Registry owns who *holds* that token (§7).
- **Identity.** RunContext settles the canonical slug (#013); the registry **keys to** it and
  must never re-derive or re-key it.
- **Execution and lifecycle.** The executor applies; the Task Engine owns the row. The registry
  is consulted at claim time and is otherwise inert.

In one line: **the registry answers "does employee X hold token T — and what is X's posture,
scope, budget default, and registration?" — a pure, read-only lookup over declarative authority
data.**

---

## 3. Area 2 — Authorisation model

**Capabilities are tokens, matched not interpreted.** A capability is an opaque string (a tool
label such as `memory.write` / `comm.send`, or a scope such as `read`). An action is authorised
when **both** hold, and the **gate** — not the registry — checks them:

1. the tool's required permission token ∈ the employee's resolved capability tokens
   (`scope.missing_capability` is the gate's failure reason when it is not), **and**
2. the employment posture permits (the gate routes to approval on the Built floor
   `can_execute=false` or an explicit `requires_approval=true`, regardless of the P4 atoms —
   `server/sdk/gate.ts:146-147`).

The registry is the **source** of (1) and the posture in (2); the gate is the **judge**. The
runtime *matches* tokens; it never *interprets* them — exactly as the gate already consumes
`ResolvedCapabilitySet.tokens` today. This is the CEO's **Tool Registry Principle** made
operational (ADR 0008 Decision 6): *"Tools describe capability. The Capability Registry
authorizes capability … Authorization remains the responsibility of Directive #015."* #015 is
where "authorizes capability" finally has a home — as the **declarative grant the gate reads**,
not as a second decision engine.

**Default-deny is the floor, and the registry must preserve it.** The Built default is
locked-down — `{can_execute: false, requires_approval: true, scopes: ["read"]}`
(`ai_employees.sql:77-78`) — and the empty grant is the safe frozen default
(`EMPTY_CAPABILITIES`, `tasks.ts:132-135`). The registry must **fail closed**: an unknown
identity, a missing grant, or an unavailable registry resolves to `EMPTY_CAPABILITIES` + the
locked posture — **never** an open grant. Grants are **additive** capability tokens *over* the
floor; no resolution path may produce authority the floor did not permit without an explicit,
recorded grant.

**Grants are immutable platform metadata at runtime.** Mirroring the **Registry Immutability
Rule** the CEO set for the Tool Registry, capability grants are administered out-of-band
(seed / migration / an authorised admin surface) and are **read-only during execution**:
runtime resolution consumes the registry and never mutates it. This preserves determinism — two
runs of the same employee resolve the same authority — and keeps authorisation auditable.

**Who may grant** (the authorisation-of-authorisation question) is a governance fork raised for
the CEO in §12, not silently decided here: grants must not be self-service by employees.

---

## 4. Area 3 — Runtime resolution

**Resolve-once-at-claim, frozen onto `ctx`.** The runtime resolves the grant **once**, when the
runner builds the context at claim time, and freezes it onto `ctx.capabilities` (+ posture +
memory scope + budget). This matches the model #013 already chose and the dependency analysis
ratified (§4): the context is *immutable per invocation*; budget is a **read-only passthrough
ceiling**, not a per-`invoke` live-decremented counter (`tasks.ts` budget is "passthrough …
NOT metered here"; metering is the deferred gateway's concern, §8). Resolve-per-`invoke` is
explicitly **not** proposed — it would reopen the frozen-context model the freeze protects.

**The swap is the SDK ABI Principle in action.** Today `resolveEmployeeCapabilities(emp)` reads
the `ai_employees` row (`tasks.ts:146-160`); #015 introduces a registry-backed resolver and
repoints that **one seam** so `source` flips `"ai_employees" → "registry"`. The
`ResolvedCapabilitySet` a handler sees stays **byte-for-byte identical** — the comment at
`tasks.ts:137-144` was written for exactly this moment. Because `source` is on the contract, the
swap is **observable** (operators can see resolution moved to the registry) **without any
contract change**. The same applies to `resolveEmployeePosture` (the gate's `EmploymentPosture`
stays identical; only its source moves).

**Determinism and shape.** Resolution stays deterministic and stable — tokens de-duplicated and
sorted (as today), so the set is comparable across runs and across the legacy/registry sources
(this is what makes the parity gate in §9 mechanical).

**Performance.** The registry is small, immutable platform metadata. Resolution is one keyed
lookup per claim; the registry may be cached at process start and invalidated only on
administration. Resolution must add no per-`invoke` cost (it happens once, at claim).

**Failure mode.** Registry unavailable, identity absent, or grant malformed → **fail closed** to
`EMPTY_CAPABILITIES` + the locked posture. This is the reference implementation's recovery
obligation (§9) and the §3 default-deny floor restated at the resolution boundary.

---

## 5. Area 4 — Registry ownership

**Directive D-05 / #015 owns the registry** — contract #8, graduating Reserved → Established.

- **It is platform substrate, employee-agnostic.** The registry stores rows keyed by identity
  and names **no specific employee in code** — preserving the independence property the #012
  audit verified for the rest of the substrate (§6 of the audit). Adding or removing an employee
  becomes a registry row plus administration, in **one** place, collapsing the four scattered
  registration surfaces the audit named.
- **Ownership boundaries.** The registry owns the **grant data** and the **resolver contract**.
  It does **not** own: identity (RunContext owns; the registry keys to it), tool definitions
  (the Tool Registry owns), the enforcement decision (the gate owns), the budget *meter* (the
  deferred gateway), or the run loop (the Task Engine owns). These are the same
  *Does-not-own* boundaries the [Kernel Contract Map](./kernel-contract-map.md) draws for every
  contract.
- **Administration ownership.** Grants are authority; writing them is a privileged operation. The
  registry is the **write surface** for grants, but *who* may write (CEO / Boardroom only;
  never the employee whose authority it is) is a governance decision raised in §12. The
  Boardroom's read surfaces (contract #9) may *observe* grants; a write/decision surface is out
  of scope for this directive unless the CEO scopes it in.
- **Single source of truth.** After #015, the four `ai_employees` authority columns and the four
  registration surfaces are no longer independent sources — they are either migrated into the
  registry or mirrored *from* it (the cutover strategy, §9). "One declarative source + resolver"
  is the whole point.

---

## 6. Area 5 — Interaction with the SDK

**The registry sits *behind* the SDK; it is not an SDK facet.** The SDK (contract #3,
Established) consumes the registry through exactly the seam that already exists:
`resolveEmployeeCapabilities → ResolvedCapabilitySet`, threaded onto the frozen
`ctx.capabilities`, with the gate (`ctx.proposeActions`) enforcing. An employee never *queries*
the registry ("what can I do?") as a capability call — it simply attempts an action and the gate
returns the verdict. The SDK **exposes capability, never implementation** (Kernel Contract Map
boundary #2 / the SDK ABI Principle); the registry is precisely the *implementation behind the
capability*, the source the runtime reads, not a door the employee opens. So the registry adds
**no new facet** and **no new field** to `ctx`.

**The SDK Stability Rule binds the whole interaction.** The #015 swap must change **no** facet
contract: `ResolvedCapabilitySet`, `EmploymentPosture`, the `evaluateAction` signature, and
every `ctx` field stay frozen. Only the *sourcing* moves. Any change to those surfaces would be
a breaking SDK change requiring its own ADR justification — and #015 is designed specifically to
avoid one (the seam was pre-built to make the swap non-breaking).

**Why this is safe now and was not before.** The dependency analysis (§3, dimensions 2/3/8)
showed the registry's *enforcement interface* is defined by the SDK's propagation model. That
model is now **built and proven** — the gate consumes `ResolvedCapabilitySet`, and the executor
Reference Path exercises the whole resolve→gate→apply composition end-to-end (Directive #014
complete). The registry therefore resolves *into* a settled contract instead of an assumed one.

---

## 7. Area 6 — Interaction with the Tool Registry

**Two registries, one clean boundary, meeting only at the gate.**

| | **Tool Registry** (`server/sdk/tools.ts`, contract #3) | **Capability Registry** (#015, contract #8) |
|---|---|---|
| Answers | *What is this tool, and what token does it require?* | *Which employee holds which tokens (+ posture/scope/budget)?* |
| Holds | `label`, `permission`, `argSchema`, `costEstimator`, `reversibilityClass` | the per-identity grant |
| Describes | **capability** | **authority** |
| Rule | Registry Immutability (immutable platform metadata) | Single source of authority (proposed, §11) |

The two **never reference each other**. The gate composes them: it reads a tool's
`permission` (from the Tool Registry) and tests membership in `ctx.capabilities.tokens` (from
the Capability Registry). Neither registry imports the other; the **runtime** is the only
composer (the **Runtime Composition Rule**; the **Facet Isolation Rule**). This is exactly the
**Tool-Registry/authorisation split** the CEO bound to #015 on accepting ADR 0008: *"The Tool
Registry must never become the authorization system."* #015 honours it by keeping tool
*definition* (what a tool is) wholly separate from the authority *grant* (who may use it).

**One consistency obligation (validation, not runtime coupling).** A capability token granted in
the registry *should* correspond to a real tool permission (or, later, an API scope). Tokens stay
**opaque strings at runtime** — matched, never interpreted — but #015 *should* ship a
**validation** that registry tokens are a subset of the known tool permissions (+ scopes), to
catch typos and dangling grants at administration/CI time rather than as silent denials at
runtime. This is a build-time check, not a runtime dependency between the registries.

---

## 8. Area 7 — Interaction with the API Gateway

**The API gateway + cost metering is a deferred future extension of contract #3 — not
authorised, not built by #015.** Directive #014 is complete at Phase C; the gateway was the
original "Phase D" and is now a separate future extension. This area is therefore **forward-
compatibility design**, not gateway design: it states how the registry will interact *when* the
gateway eventually lands, so the registry is built **gateway-ready without designing the gateway
now**.

- **API scopes are just more tokens.** When the gateway is built, the scopes it requires (e.g. an
  `api.<provider>` token) will live in the **same** capability-token set and be matched **the same
  way** — the gateway tests its required scope against `ctx.capabilities.tokens` exactly as the
  gate matches a tool permission. The registry must therefore treat API scopes as ordinary tokens
  (no special-casing), which keeps it forward-compatible with zero gateway knowledge today.
- **The registry supplies the budget *default*; the gateway *meters*.** The registry owns the
  per-employee budget ceiling (a number) that `ctx.budget` already threads read-only; the gateway,
  when built, meters spend against it. This is Policy vs Mechanism again: **registry = the number,
  gateway = the meter** (the dependency analysis dimension 6: *"registry only supplies a default
  number"*).
- **The boundary the CEO set holds.** ADR 0008 Decision 5: *"The API Gateway owns external
  integration, authentication, authorization [of external calls], rate limiting … The SDK
  consumes the API Gateway. The API Gateway should never become an SDK implementation detail."*
  The registry sits behind the SDK and supplies grants + budget; it never reaches into the
  gateway, and the gateway (later) reads resolved tokens/budget through `ctx`, not the registry
  directly. #015 commits to **not** building the gateway and **only** to keeping the token+budget
  model gateway-shaped.

---

## 9. Area 8 — Migration strategy

#015 is a **consolidation/removal** directive; the migration's job is to fold four data columns
and four registration surfaces into one declarative source **without a big bang and without ever
failing open**. Proposed strategy, parity-gated and reversible at every step:

1. **Introduce the registry as a new authoritative store** (storage form is an open question for
   the CEO — §12: a DB table `hq_capability_grants` keyed by slug, a code manifest, or a hybrid;
   the recommendation is a DB table for parity with the kernel's other contracts, with a typed
   read model). It starts **non-authoritative** (shadow).
2. **Backfill from the existing columns.** A one-time migration projects every live employee's
   `tools_allowed` / `permissions` / `memory_scope` / `department` into a registry grant,
   **preserving every current grant exactly** (the locked default stays locked).
3. **Parity gate (the safety interlock).** Before the registry becomes authoritative, assert
   `registry-resolution == ai_employees-resolution` for **every** live employee — a parity test in
   the spirit of `__tests__/security/employee-migration-parity.test.ts`. Because resolution is
   deterministic and sorted (§4), this is a mechanical set comparison. **No cutover until parity
   is green.**
4. **Repoint the single seam.** Flip `resolveEmployeeCapabilities` / `resolveEmployeePosture` to
   read the registry; `source` becomes `"registry"`. The `ResolvedCapabilitySet` contract is
   unchanged (§4, §6), so the executor Reference Path and every runner suite must stay green
   across the flip (§10) — this *is* the regression gate.
5. **Collapse the registration surfaces (the R4 removal).** Repoint the cron manifest, admin nav,
   CEO dashboard card, and migrated-roster so each reads the registry instead of a hardcoded
   list — removing the scatter the #012 audit named. (Whether all four land in #015 or the
   data-three first and the UI/manifest surfaces in a follow-up is a scope fork — §12.)
6. **Deprecate the legacy columns.** Keep the four `ai_employees` columns initially as a
   **mirror** (written *from* the registry) to avoid a big-bang drop, then retire them in a later
   cleanup once nothing reads them. Drop-now vs mirror-then-drop is an open question (§12).

**Identity safety — the reason #015 waited.** Because identity is canonical now
(`EmployeeIdentity.slug`, settled in #013), the registry keys to a stable slug with **no
re-keying risk** — the precise hazard the dependency analysis flagged for building the registry
too early (§4.1: a slug change *"is a data migration … not a documentation edit"*). Cutover to
`main`/prod is **CEO-gated**, consistent with the #012/#013 cutover discipline.

---

## 10. Area 9 — Validation strategy

The validation plan is anchored on the two **evidentiary standards** the CEO has set, plus the
house validation discipline.

- **The Reference Implementation Rule (the twelfth standard, set on the #014 C4 review).** #015
  must ship **exactly one canonical reference implementation** that exercises the **complete
  lifecycle** — resolve → thread → gate-enforce → (default-deny) → and the consolidation/removal
  behaviour — and that reference must be **proven before** the platform consolidates onto the
  registry. This is the registry's equivalent of the executor Reference Path.
- **The Reference Path Rule (the eleventh standard).** The executor Reference Path
  (`__tests__/sdk/reference-path-execution.test.ts`) is the living regression gate: when the
  sourcing seam repoints to the registry (§9 step 4), that **same** path must stay green,
  proving the contract did not move. A frozen-contract extension must keep one canonical
  end-to-end path green.
- **Parity tests.** `registry-resolution == legacy-resolution` for every live employee, gating
  cutover (§9 step 3).
- **Default-deny / fail-closed tests.** Missing identity, empty registry, unavailable registry,
  malformed grant → `EMPTY_CAPABILITIES` + locked posture. Authority is never invented.
- **Token-consistency validation.** Registry tokens ⊆ known tool permissions (+ scopes) —
  dangling-grant detection at build/CI time (§7).
- **House discipline.** The registry contract modules should be **pure / dependency-injected,
  no `server-only`, UI-importable** (the pattern proven across the #014 C-contracts), with
  unit + source-level trust-boundary tests, and the full six-gate CI (typecheck · lint · unit ·
  security · build · the runner suites) green. Cutover CEO-gated; on completion, an
  **ADR 0010** (the next free ADR number) and a completion record graduate contract #8
  Reserved → Established and update both the Architecture Freeze and the Kernel Contract Map in
  the **same PR** (the synchronisation rule).

---

## 11. Engineering rules this directive honours — and the one it proposes

**Honours (no new rule needed):** the **SDK Stability Rule** and **SDK ABI Principle** (the swap
is invisible to handlers); **Policy vs Mechanism** (registry = data, gate = judge); **Facet
Isolation** + **Runtime Composition** (the Tool and Capability registries meet only at the
gate); **Registry Immutability** (grants immutable at runtime); the **Reference Path Rule** and
the **Reference Implementation Rule** (one canonical reference, proven before consolidation); and
the default-deny floor.

**Proposes (for the CEO to set or decline) — the *Single Source of Authority Rule*:**

> *An employee's authority — its capability tokens, posture, scope, budget default, and
> registration — has exactly one declarative source: the Capability Registry. No platform
> surface may hardcode an employee's grant or registration, and runtime resolution reads the
> registry and never a scattered copy.*

This would be the #015 analogue of the Tool Registry's Immutability Rule — the rule that *keeps*
the consolidation consolidated, so the scatter the #012 audit named cannot silently re-accrete.
It is offered as a candidate, **not** self-adopted.

---

## 12. Open questions for the CEO to rule on

1. **Storage form.** DB table (`hq_capability_grants` keyed by slug, recommended), code
   manifest, or hybrid? This sets the migration and admin shape.
2. **Grant administration authority.** Who may write grants (CEO / Boardroom only)? Should #015
   build any write surface, or only the read/resolve path plus a seed/migration administration?
3. **Legacy columns — drop or mirror.** Retire the four `ai_employees` authority columns within
   #015, or mirror-then-drop in a later cleanup (recommended)?
4. **Surface-collapse scope.** Do all four registration surfaces (cron · nav · dashboard ·
   roster) collapse in #015, or the data-three consolidation first and the UI/manifest surfaces
   in a scoped follow-up?
5. **The proposed rule.** Set the *Single Source of Authority Rule* (§11), or leave the
   consolidation governed by the existing rules?
6. **ADR.** Confirm #015 warrants its own **ADR 0010** (the registry introduces net-new
   persistence and a contract graduation, as the executor did with ADR 0009) — to be written and
   accepted **before** implementation, per the strict document-before-you-build gate.

---

## 13. Proposed sequencing — *if approved* (not authorised here)

Following the #014 Phase C precedent (small, independently reviewable increments, each its own
PR under full validation and per-increment CEO review):

- **R1 — the registry contract + resolver + its reference implementation** (pure, descriptive,
  dependency-injected; no cutover, no migration). Proves the lifecycle per the Reference
  Implementation Rule.
- **R2 — the backfill migration + the parity gate** (shadow registry; legacy still
  authoritative).
- **R3 — repoint the sourcing seam** (`source → "registry"`) behind the green parity gate; the
  executor Reference Path proves the contract held.
- **R4 — collapse the registration surfaces** (the R4 removal).
- **R5 — cutover (CEO-gated) + ADR 0010 + completion record**, graduating contract #8 Reserved →
  Established and syncing the Freeze + the Kernel Contract Map in one PR.

Each increment is gated; **no increment is authorised by this document.**

---

*Documentation only. No code, schema, migration, configuration, numbering, or git history was
changed by this proposal. Prepared under CEO Directive #011 (Master Roadmap D-01) as the
architecture proposal for CEO Directive #015 / D-05 — the Capability Registry — sequenced last
by the [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md), built
upon the now-Established RunContext (#013) and AI SDK (#014) contracts, consolidating the
authority data named by the [platform-independence audit](./directive-012-platform-independence-audit.md).
It is governed by the engineering standards homed in the
[Kernel Contract Map](./kernel-contract-map.md) §2. No implementation is authorised until this
proposal has been reviewed and approved; on approval, an ADR 0010 is written and accepted before
any code is built. A section for the CEO's review outcome is reserved below.*

---

## 14. CEO review outcome

*Reserved for the CEO's review decision (approve / revise / hold), any rulings on the §12 open
questions, and the disposition of the §11 proposed rule.*
