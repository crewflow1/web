# ADR 0010 — The Capability Registry

> **Status:** **Accepted** *(CEO independent CTO review, 2026-06-28 — approved with one amendment:
> the **Approval Ratchet Rule** for inherited approval posture, recorded in Decision 5).* This
> decision record was authored under the [`../README.md`](../README.md) *document-before-you-build*
> rule in its **strictest** form — the CEO ruled implementation *"remains gated on ADR 0010
> approval"* — and is now accepted, **authorising Directive #015 implementation to begin** in small
> reviewable increments, starting with the smallest safe slice **R1 (Registry Schema)**; R2 does not
> begin until R1 is implemented, validated and reviewed. · **Date:** 2026-06-28 · **Directive:** CEO Directive **#015 / D-05** (*The
> Capability Registry*) · **Supersedes:** none · **Superseded by:** none · **Builds on:**
> [ADR 0008](./0008-ai-sdk-envelope.md) (the AI SDK Envelope — Tool Registry Principle, the
> authorisation split), [ADR 0007](./0007-runcontext-runtime-contract.md) (RunContext — canonical
> identity, the frozen `ctx`), [ADR 0009](./0009-sdk-executor-apply-on-approval.md) (the executor —
> the resolved-capability consumer it must not disturb).
>
> Tenth ADR under the *document-before-you-build* rule. It formalises the CEO-approved architecture
> proposal and folds in the **rulings the review returned**, each encoded below as a first-class
> Decision: the **declarative-database-of-authority** refinement; the **owns / does-not-own** list
> verbatim; the **inheritance model** the CEO added as a first-class responsibility; and the
> **Single Source of Authority Rule**, which the CEO set as *"the governing principle of Directive
> #015."* It defines the **nine areas the CEO required** — authority ownership · registry boundaries
> · grant model · inheritance model · migration strategy · runtime resolution model · interaction
> with the Tool Registry · interaction with the SDK · interaction with the API Gateway. On
> acceptance and completion it graduates Architecture-Freeze contract **#8 (Capability Registry)**
> Reserved → Established. This document changes no code, schema, migration, configuration, or git
> history.

---

## Context

Directive #014 is **complete** ([ADR 0009](./0009-sdk-executor-apply-on-approval.md); contract #3
graduated Partial → Established): the SDK is a single employee-facing door whose gate *enforces*
authority and whose executor *applies* a cleared action. Directive #013 is **complete** ([ADR
0007](./0007-runcontext-runtime-contract.md)): identity is canonical (`EmployeeIdentity.slug`) and
the frozen `ctx` threads a resolved capability set the gate reads. With both upstreams settled, the
[dependency-ordering analysis](../governance/directive-013-dependency-ordering-analysis.md) places
#015 **last** — *registry depends on RunContext + SDK, never the reverse* — and it is, at last, safe
to cut **once**: the registry keys to a stable slug, so there is no re-keying hazard.

**The problem #015 solves is scatter, not a missing capability.** An employee's authority lives
today in **four columns on `ai_employees`** — `tools_allowed text[]` (the capability labels),
`permissions jsonb` (`{can_execute, requires_approval, scopes}`, default-locked), `memory_scope
text` (`isolated | department | organization | global`), and `department text`
(`supabase/migrations/20260712000000_ai_employees.sql:72,77,80,32`) — and its *registration* lives
in **four further surfaces** with no single owner (the cron manifest, the admin nav, the CEO
dashboard card, the migrated-roster test — [platform-independence
audit](../governance/directive-012-platform-independence-audit.md) §5). #014 already reads the
authority data through **one** function: `resolveEmployeeCapabilities()` produces the opaque, frozen
`ResolvedCapabilitySet { tokens, source }` that `ctx.capabilities` threads and the gate enforces
(`server/sdk/tasks.ts:126-162`). That function's own comment **pre-designed this directive** — *"D-05
can repoint the source to the Capability Registry by changing ONLY this function — the
`ResolvedCapabilitySet` every handler sees stays byte-for-byte identical"* (`tasks.ts:137-144`) — and
`source: "ai_employees" | "registry" | "none"` already reserves the `"registry"` value
(`tasks.ts:128`). #015 builds **one declarative source of truth + the runtime that reads it**,
repoints that single seam, and **removes the scatter**. It is a **consolidation / removal**
directive — high on the [Platform Reuse Index](../governance/platform-reuse-index.md) **R4**
(infrastructure removed).

**The CEO review of the proposal returned four things this ADR must encode.** The CEO **approved
the architecture** and ruled:

1. **A direction.** *"The Capability Registry should become the single authoritative source of
   capability ownership. It is not another execution layer. It is not another runtime. It is not
   another permission system. It is the authoritative capability catalogue from which the runtime
   derives grants."*
2. **An owns / does-not-own list** (Decision 3, verbatim).
3. **An architectural refinement.** *"The Capability Registry should be treated as a declarative
   database of authority, not a behavioural service. The runtime queries it. The SDK consumes the
   resolved capabilities. No runtime behaviour should migrate into the registry itself."* (Decision
   2 — it **sharpens** the proposal, which had spoken of the registry "owning the resolver"; under
   this refinement the registry owns the *data and the resolution contract*, while the *resolution
   behaviour* stays in the runtime.)
4. **A new first-class responsibility — *capability inheritance*** — added to the owned set, with an
   *inheritance model* required of this ADR (Decision 5 — not present in the proposal, designed
   here).

And the CEO set the **governing principle** of the directive (Decision 1).

---

## Decision

**1. Authority ownership — the registry is the single authoritative source of capability ownership,
and the *Single Source of Authority Rule* governs the directive.** The CEO set this permanent
engineering standard on the #015 architecture review; it is homed in the [Kernel Contract
Map](../governance/kernel-contract-map.md) §2 (the thirteenth standard) by the same PR that carries
this ADR:

> **Every runtime authorisation decision must ultimately derive from exactly one authoritative
> source. The platform may expose multiple read models. The platform may expose caches. The
> platform may expose projections. Authority itself must never exist in more than one place. This
> rule becomes the governing principle of Directive #015.**

The rule fixes the *why* of #015: today authority exists in eight places (the four columns + the
four registration surfaces), so the platform has no single answer to *"what may employee X do?"* —
the precise condition the rule forbids. After #015 there is **one** authoritative source; everything
else — the gate's in-memory view, a process-start cache, an operator read model, the legacy columns
during cutover — is a **read model / cache / projection** *of* that source, never a second home for
authority. This is the consolidation thesis stated as a law: the scatter the #012 audit named cannot
silently re-accrete, because a second authority home is now a **rule violation**, not merely untidy.

**2. The registry is a *declarative database of authority*, not a behavioural service (the CEO's
refinement) — and this draws the line between what the registry owns and what the runtime owns.**
The registry is **passive data + a typed read model**: the grant records and the *contract* of what
a resolution yields. It **runs nothing during a task**. The *resolution behaviour* — the pure
function that, at claim time, reads the registry and composes the effective `ResolvedCapabilitySet`
(including the inheritance composition of Decision 5) — is **runtime behaviour and stays at the
existing SDK seam** (`resolveEmployeeCapabilities` / `resolveEmployeePosture`, `server/sdk/tasks.ts`
/ `server/sdk/gate.ts`). So the CEO's two sentences resolve precisely:

- *"The runtime queries it"* — the runtime reads the registry's data and **computes** the
  resolution; the computation lives in the runtime, not the registry.
- *"No runtime behaviour should migrate into the registry"* — the registry never becomes a service
  that *executes* logic for a running task; it is queried like a database.

Reconciling this with the CEO's list (Decision 3), which names *capability resolution* among the
**owned** responsibilities: the registry owns the **resolution contract and its inputs** — the grant
data and the declared inheritance semantics that define *how authority composes* — while the runtime
owns the **resolution execution**. The registry is the single source the resolution *derives from*
(Decision 1); it is not the thing that *runs* the resolution. This is the **SDK ABI Principle** one
layer down: a stable, declarative source behind a runtime that reads it.

**3. Registry boundaries — what it owns and what it explicitly does not (the CEO's list,
verbatim).** The registry **owns**:

- **capability definitions** — the vocabulary of capability tokens (opaque labels such as
  `memory.write`, `comm.send`, the scope `read`) that authority is expressed in;
- **capability grants** — which identities (and which scope levels — Decision 5) hold which tokens
  and posture;
- **capability metadata** — the per-employee authority data that is *not* a token: employment
  posture (`can_execute`, `requires_approval`), memory scope, department, the budget *default*, and
  the registration metadata that today scatters across the four manifest surfaces;
- **capability inheritance** — the declared semantics by which scoped grants compose (Decision 5);
- **capability resolution inputs** — the grant data and the declared inheritance semantics the
  runtime reads to resolve authority; the resolution *behaviour* itself is the runtime's (the CEO's
  refinement, Decision 2).

The registry **does not own**:

- **execution** — the executor applies ([ADR 0009](./0009-sdk-executor-apply-on-approval.md));
- **runtime composition** — the runtime composes capabilities (the **Runtime Composition Rule**);
- **approval** — the Approval Engine decides;
- **task lifecycle** — the Generic Task Engine owns the row;
- **tool execution** — the Tool Registry describes tools, the executor invokes them;
- **API Gateway behaviour** — the deferred external-call layer (Decision 9).

This is the [Kernel Contract Map](../governance/kernel-contract-map.md) §3 *Owns / Does-not-own*
discipline applied to contract #8. The boundary that matters most: the registry is **data, not
judge** — it supplies the grant; the **gate decides** over it (the **Policy vs Mechanism Rule**).

**4. The grant model — the scoped grant record, default-deny, immutable at runtime.** A grant is a
declarative record stored in a new additive table **`hq_capability_grants`**, keyed by **scope level
+ scope key** (Decision 5), carrying: the **capability tokens** held at that scope; the **posture**
(`can_execute`, `requires_approval`); the **memory scope**; the **budget default** (a *number* — the
ceiling `ctx.budget` threads read-only; metering is the deferred gateway's job, Decision 9); and, at
the employee scope, the **registration metadata** (schedule / nav / dashboard / roster membership)
that collapses the four manifest surfaces into one place. A DB table is chosen over a code manifest
for **parity with every other kernel contract** (which persist their authoritative state) and to
carry a typed read model and an administration surface; this is submitted for the CEO's ratification
(it was open question §12.1 of the proposal). The model is bound by two invariants:

- **Default-deny is the floor and the registry must preserve it.** The Built default is locked —
  `{can_execute: false, requires_approval: true, scopes: ["read"]}`
  (`ai_employees.sql:77`) — and the empty grant is the safe frozen default (`EMPTY_CAPABILITIES`,
  `tasks.ts:132-135`). An unknown identity, a missing grant, or an unavailable registry resolves to
  `EMPTY_CAPABILITIES` + the locked posture — **never** an open grant. No resolution path may
  produce authority the floor did not permit **without an explicit, recorded grant**.
- **Grants are immutable platform metadata at runtime** (the **Registry Immutability Rule** applied
  to authority, the analogue of the Tool Registry's). Grants are administered **out of band** — seed
  / migration / an authorised admin surface — and are **read-only during execution**: resolution
  consumes the registry and never mutates it, so two runs of the same employee resolve the same
  authority. **Who may write a grant** is privileged authority-of-authority: **CEO / Boardroom-
  authorised administration only; never self-service by the employee whose authority it is** (open
  question §12.2, decided here and submitted for ratification). The Boardroom (contract #9) may
  *observe* grants as a read model; a write surface beyond seed/migration is out of #015 scope
  unless the CEO scopes it in.

**5. The inheritance model — scoped grants composed over the default-deny floor (the new
requirement).** Authority is granted at one of **four nested scope levels**, mirroring the existing
`memory_scope` vocabulary so the platform gains no new hierarchy concept:

| Scope level | Applies to | Scope key | `memory_scope` analogue |
|---|---|---|---|
| **global** | every employee | *(none)* | `global` |
| **organization** | every employee in the organisation | org id | `organization` |
| **department** | every employee in a department | `department` | `department` |
| **employee** | one employee | `EmployeeIdentity.slug` | `isolated` |

(In today's single-org HQ, *organization* and *global* may coincide; they are kept distinct to match
the established enum and to stay multi-tenant-ready.) The runtime composes the levels that apply to
an employee — its own, its department's, the organisation's, and the global — into the effective
authority, **over the default-deny floor as the irreducible base**:

- **Capability tokens compose by UNION.** The effective token set is the union of the token grants
  at every applicable level, accumulated over the empty floor. Inheritance is therefore **additive**:
  a broader scope can only *grant* capability, never remove it, and every token held is traceable to
  an explicit recorded grant at some level. This is the §3 *grants-are-additive-over-the-floor*
  invariant extended across scopes.
- **Approval posture ratchets toward strict — the *Approval Ratchet Rule* (set by the CEO on the
  ADR 0010 review, the stricter rule chosen over most-specific-wins).**

  > If any inherited grant requires approval, the resolved capability requires approval. Approval
  > posture must ratchet upward, never downward. A lower-level grant may add stricter controls. A
  > lower-level grant may not silently weaken approval requirements inherited from a broader scope.

  So `requires_approval` resolves as the **logical OR** across all applicable levels over the floor's
  `true`: a more-specific grant may *add* an approval requirement (stricter), but **may not silently
  clear** one a broader scope set. Autonomous execution (`requires_approval=false`) is possible only
  when **no** applicable level — and not the floor — requires approval. This is **safer than
  most-specific-wins** for the security-critical flag, making the invariant *no weaker grant may
  silently override a stronger approval requirement* hold by construction.
- **Execution posture (`can_execute`) resolves *deny-wins*** — the security companion to the ratchet.
  `can_execute=false` is the strict floor value; a more-specific grant may **restrict** (set false),
  and a denial at any applicable level is never silently widened, so execution is enabled only when
  it is explicitly granted and **not** denied at any applicable scope. (The floor's `false` is the
  *default when unspecified*, not a grant of false — so an explicit grant still enables execution,
  while any explicit denial wins.)
- **Budget default composes by *effective minimum*** — the **lowest** ceiling among the applicable
  levels (the stricter bound). A narrower scope can tighten a broader, more generous budget; it can
  never silently raise a tighter inherited ceiling.
- **Memory scope composes *most-specific-wins*** over the safe `isolated` default — it is local
  configuration, not an approval control, so the most specific applicable level wins (employee
  overrides department overrides organisation overrides global), the precedence the `memory_scope`
  enum already implies. Most-specific-wins stays available for other **non-security metadata**
  (display / local configuration); it is **not** used for approval posture.
- **Composition fails closed.** If any applicable level is missing, malformed, or unavailable,
  resolution falls back to the floor — it never silently widens.

Inheritance composition is **resolution behaviour** (Decision 2): the registry *stores* the scoped
grant rows; the runtime *reads and composes* them at claim. The result is still a single opaque,
sorted, frozen `ResolvedCapabilitySet` + posture — the contract a handler sees does not change
(Decision 6). Because the base is default-deny, every token / execute grant is an **explicit recorded
grant**, and approval **ratchets up, never down**, no inheritance path yields authority — least of
all weaker approval — absent an explicit grant: the floor invariant (Decision 4) and the Approval
Ratchet Rule hold **by construction**.

**6. Runtime resolution model — resolve-once-at-claim, frozen onto `ctx`, fail-closed, ABI-stable.**
The runtime resolves the effective grant **once**, when the runner builds the context at claim time,
and freezes it onto `ctx.capabilities` (+ posture + memory scope + budget). This matches the
immutable-per-invocation model #013 chose and #014 enforces; **resolve-per-`invoke` is explicitly
not proposed** (it would reopen the frozen-context model the freeze protects). Budget stays a
**read-only passthrough ceiling**, not a live-decremented counter (metering is the deferred gateway,
Decision 9). The swap is the **SDK ABI Principle** in action: #015 repoints the **one seam** —
`resolveEmployeeCapabilities` / `resolveEmployeePosture` — to read the registry, so `source` flips
`"ai_employees" → "registry"`; the `ResolvedCapabilitySet` and `EmploymentPosture` a handler and the
gate see stay **byte-for-byte identical**. Because `source` is on the contract, the swap is
**observable** (operators see resolution moved to the registry) **without any contract change**.
Resolution stays **deterministic** — tokens de-duplicated and sorted, as today — so the parity gate
(Decision 8) is a mechanical set comparison; it is **one keyed read per claim**, cacheable at
process start and invalidated only on administration, adding **no per-`invoke` cost**. **Failure
mode:** registry unavailable, identity absent, or grant malformed → fail closed to
`EMPTY_CAPABILITIES` + the locked posture (Decision 4).

**7. Interaction with the SDK — the registry sits *behind* the SDK; it is not a facet.** The SDK
(contract #3, Established) consumes the registry through the seam that already exists:
`resolveEmployeeCapabilities → ResolvedCapabilitySet`, threaded onto the frozen `ctx.capabilities`,
with the gate (`ctx.proposeActions`) enforcing. An employee never *queries* the registry as a
capability call ("what can I do?"); it attempts an action and the gate returns the verdict. So #015
adds **no new facet and no new `ctx` field** — the registry is *the implementation behind the
capability*, the source the runtime reads, not a door the employee opens. The **SDK Stability Rule**
binds the whole interaction: `ResolvedCapabilitySet`, `EmploymentPosture`, the `evaluateAction`
signature, and every `ctx` field stay **frozen**; only the *sourcing* moves. The seam was pre-built
to make this swap non-breaking, so #015 incurs no SDK ADR for a contract change — there is none.

**8. Interaction with the Tool Registry — two registries, one clean boundary, meeting only at the
gate.** The **Tool Registry** (`server/sdk/tools.ts`, contract #3) answers *"what is this tool and
what token does it require?"* (it holds `label`, `permission`, `argSchema`, `costEstimator`,
`reversibilityClass` — it **describes capability**). The **Capability Registry** (#015, contract #8)
answers *"which identity holds which tokens, at which scope, with what posture / memory scope /
budget?"* (it **describes authority**). The two **never reference each other**; neither imports the
other; the **gate composes them** — it reads a tool's `permission` (Tool Registry) and tests
membership in `ctx.capabilities.tokens` (Capability Registry), with `scope.missing_capability` the
failure when the token is absent (`gate.ts:153`). This is the **Runtime Composition Rule** and the
**Facet Isolation Rule** at the registry seam, and it honours the boundary the CEO bound to #015 on
accepting [ADR 0008](./0008-ai-sdk-envelope.md) (Decision 6): *"The Tool Registry must never become
the authorization system."* One **build-time consistency obligation** (validation, not a runtime
coupling): registry tokens **should be a subset of** the known tool permissions (+ scopes), so typos
and dangling grants are caught at administration / CI time rather than as silent runtime denials.
Tokens stay opaque strings at runtime — matched, never interpreted.

**9. Interaction with the API Gateway — a deferred future extension; #015 is forward-compatible
only.** The API gateway + cost metering was the original "Phase D"; Directive #014 is complete at
Phase C, so the gateway is a **deferred future extension of the now-Established contract #3, not
authorised and not built by #015**. This area is therefore **forward-compatibility design**, not
gateway design — it states how the registry will interact *when* the gateway eventually lands, so the
registry is built **gateway-ready without designing the gateway now**:

- **API scopes are just more tokens.** When the gateway is built, the scopes it requires (e.g. an
  `api.<provider>` token) live in the **same** capability-token set and are matched the **same way**
  — the gateway tests its required scope against `ctx.capabilities.tokens` exactly as the gate
  matches a tool permission. The registry treats API scopes as ordinary tokens (no special-casing),
  which keeps it forward-compatible with zero gateway knowledge today.
- **The registry supplies the budget *default*; the gateway *meters*.** The registry owns the
  per-employee budget ceiling (a number) that `ctx.budget` already threads read-only; the gateway,
  when built, meters spend against it. **Registry = the number; gateway = the meter** (Policy vs
  Mechanism). This honours [ADR 0008](./0008-ai-sdk-envelope.md) Decision 5: the gateway owns
  external integration / auth / rate-limiting and *"should never become an SDK implementation
  detail"*; the registry sits behind the SDK and supplies grants + budget, never reaching into the
  gateway, and the gateway (later) reads resolved tokens / budget through `ctx`, not the registry.

**10. Migration strategy — consolidation / removal, parity-gated, reversible at every step, never
failing open.** The migration folds four data columns and four registration surfaces into one
declarative source **without a big bang**:

1. **Introduce `hq_capability_grants` as a new, initially non-authoritative (shadow) store** — the
   additive table of Decision 4, with a typed read model. No row is rewritten; nothing reads it yet.
2. **Backfill from the existing columns.** A one-time migration projects every live employee's
   `tools_allowed` / `permissions` / `memory_scope` / `department` into a registry grant at the
   **employee** scope, **preserving every current grant exactly** (the locked default stays locked).
3. **Parity gate (the safety interlock).** Before the registry becomes authoritative, assert
   `registry-resolution == ai_employees-resolution` for **every** live employee — a parity test in
   the spirit of `__tests__/security/employee-migration-parity.test.ts`. Because resolution is
   deterministic and sorted (Decision 6), this is a mechanical set comparison. **No cutover until
   parity is green.**
4. **Repoint the single seam.** Flip `resolveEmployeeCapabilities` / `resolveEmployeePosture` to
   read the registry; `source` becomes `"registry"`. The `ResolvedCapabilitySet` contract is
   unchanged (Decisions 6, 7), so the executor **Reference Path** and every runner suite must stay
   green across the flip — that *is* the regression gate (Decision 11).
5. **Collapse the registration surfaces (the R4 removal).** Repoint the cron manifest, admin nav,
   CEO dashboard card, and migrated-roster so each reads the registry instead of a hardcoded list,
   removing the scatter the #012 audit named. The authority cut (steps 1–4) lands **first** and is
   not blocked by this UI / manifest work, which is its own gated increment (open question §12.4,
   decided here as a sequencing, not a deferral out of #015).
6. **Deprecate the legacy columns — mirror, then drop.** Keep the four `ai_employees` columns
   initially as a **read model mirrored *from* the registry** (so they remain a projection, not a
   second authority home — Decision 1) to avoid a big-bang drop, then retire them in a later cleanup
   once nothing reads them (open question §12.3, decided here: mirror-then-drop). Cutover to
   `main` / prod is **CEO-gated**, consistent with the #012 / #013 discipline.

**Identity safety — the reason #015 waited.** Because identity is canonical
(`EmployeeIdentity.slug`, #013), the registry keys to a stable slug with **no re-keying risk** — the
precise hazard the dependency analysis flagged for building the registry too early.

**11. Validation strategy — anchored on the two evidentiary standards, plus the house discipline.**

- **The Reference Implementation Rule** (the twelfth standard, set on the #014 C4 review): #015
  ships **exactly one canonical reference implementation** exercising the **complete lifecycle** —
  resolve (with inheritance) → thread → gate-enforce → default-deny / fail-closed → the
  consolidation behaviour — **proven before** the platform consolidates onto the registry. This is
  the registry's equivalent of the executor Reference Path.
- **The Reference Path Rule** (the eleventh standard): the executor Reference Path
  (`__tests__/sdk/reference-path-execution.test.ts`) is the living regression gate — when the
  sourcing seam repoints to the registry (Decision 10 step 4), that **same** path must stay green,
  proving the contract did not move.
- **Parity tests** — `registry-resolution == legacy-resolution` for every live employee, gating
  cutover. **Inheritance tests** — union of tokens across scopes; most-specific-wins posture / memory
  scope / budget over the floor; a broader scope grants but never removes. **Default-deny /
  fail-closed tests** — missing identity, empty / unavailable registry, malformed grant →
  `EMPTY_CAPABILITIES` + locked posture. **Token-consistency validation** — registry tokens ⊆ known
  tool permissions (+ scopes), at build / CI time (Decision 8).
- **House discipline** — the registry contract modules are **pure / dependency-injected, no
  `server-only`, UI-importable** (the pattern proven across the #014 C-contracts), with unit +
  source-level trust-boundary tests, and the full **six-gate CI** (typecheck · lint · unit ·
  security · build · the runner suites) green. Cutover CEO-gated.

**12. Scope, sequencing within #015, and the implementation gate.** Implementation **does not begin
until this ADR is reviewed and accepted** (the CEO's gate). It then proceeds in **small reviewable
increments**, each its own PR under full validation and per-increment CEO review, mirroring #014
Phase C:

- **R1** — the registry contract + the runtime resolver (with inheritance) + its **reference
  implementation** (pure, dependency-injected; no cutover, no migration). Proves the lifecycle.
- **R2** — the backfill migration + the parity gate (shadow registry; legacy still authoritative).
- **R3** — repoint the sourcing seam (`source → "registry"`) behind the green parity gate; the
  executor Reference Path proves the contract held.
- **R4** — collapse the four registration surfaces (the R4 removal).
- **R5** — cutover (CEO-gated) + the completion record, graduating contract #8 Reserved → Established
  and syncing the Architecture Freeze §4 + the Kernel Contract Map in one PR.

**Out of scope (explicit):** the **API gateway + cost metering** (a deferred future extension of
contract #3, not authorised — Decision 9); any change to a facet contract, the gate signature, the
executor, or the `ResolvedCapabilitySet` shape (the SDK Stability Rule forbids it); identity (#013
settles it; the registry keys to it); tool definitions (the Tool Registry owns them).

---

## Alternatives weighed

- **The registry as a behavioural resolving *service* (it owns and runs the resolver).** **Rejected
  by the CEO's refinement** (Decision 2) — *"a declarative database of authority, not a behavioural
  service … No runtime behaviour should migrate into the registry."* The registry is queried data;
  the resolution behaviour stays at the runtime seam. (This revises the proposal's "the registry owns
  the resolver" wording to "owns the resolution *contract and data*.")
- **Uniform most-specific-wins for posture.** **Rejected on the CEO's ADR 0010 review** in favour of
  the **Approval Ratchet Rule** (Decision 5): for the security-critical approval flag,
  most-specific-wins would let a narrower grant *silently weaken* an approval requirement a broader
  scope set — unsafe. Approval posture therefore ratchets **upward only** (OR across levels),
  `can_execute` resolves deny-wins, and budget uses the effective minimum; only **non-security**
  metadata (memory scope, display / local configuration) uses most-specific-wins. (Pure **AND** over
  `can_execute` was also rejected — it would make the floor's `false` globally dominant and forbid
  any grant; the floor is the *default when unspecified*, not a grant of false, so explicit grants
  enable execution while denials still win.)
- **Resolve-per-`invoke` (re-read the registry on every action).** **Rejected** — it reopens the
  frozen-context model #013/#014 protect; resolution is once-at-claim, frozen onto `ctx` (Decision
  6).
- **A code manifest (or hybrid) instead of a DB table for storage.** **Considered** — simpler to
  diff. **Rejected** in favour of `hq_capability_grants` for parity with every other kernel
  contract's persisted authoritative state, a typed read model, and an administration surface
  (Decision 4; submitted for CEO ratification).
- **Big-bang drop of the four `ai_employees` columns within #015.** **Rejected** — mirror-then-drop
  (Decision 10 step 6) keeps cutover reversible and the columns a projection during transition, never
  a second authority home (Decision 1).
- **A new SDK facet or `ctx` field for capabilities (`ctx.capabilities.query(...)`).** **Rejected**
  — the registry sits *behind* the SDK; the employee attempts an action and the gate answers. The
  seam already exists; #015 adds no facet and no field (Decision 7).
- **The Tool Registry as the authorisation system** (a tool grant = a capability grant).
  **Rejected** (ADR 0008 Decision 6, re-affirmed) — the Tool Registry *describes*; the Capability
  Registry *holds authority as data*; the **gate** judges (Decision 8).
- **Build the API gateway / external-call authorisation in #015.** **Rejected** — a deferred future
  extension; #015 only keeps the token + budget model gateway-shaped (Decision 9).
- **Self-service grants (an employee widens its own authority).** **Rejected** — grants are
  privileged, CEO / Boardroom-authorised, immutable at runtime (Decision 4); self-grant would
  violate the Single Source of Authority Rule's intent and default-deny.
- **Ride ADR 0008 / 0009 with no new ADR, as #014 Phases A and B rode ADR 0008.** **Rejected** —
  #015 introduces **net-new persistence** (`hq_capability_grants`) and a **contract graduation**
  (#8 Reserved → Established), the same threshold that required ADR 0009 for the executor. This
  record is that ADR.

---

## Consequences

**What the platform inherits.** After #015 there is **one** authoritative answer to *"what may
employee X do?"* — the scatter across eight surfaces collapses to a single declarative source the
runtime reads through the seam that already exists. Adding or removing an employee, or changing its
authority, becomes a registry row plus authorised administration, in **one place**. Inheritance lets
authority be expressed at the scope it naturally belongs to (a department-wide grant, an org-wide
posture) instead of being copied onto every employee row — fewer hardcoded copies, less drift. The
employees on top get *simpler* and the kernel contract gets *more stable* — the §2 principle, scored
on the Reuse Index as **R4** (infrastructure removed).

**Blast radius.** *Schema:* **one additive table** (`hq_capability_grants`) + a backfill migration;
no historical row rewritten; the four `ai_employees` columns become a **mirror** (projection) before
a later drop. *Code:* the registry contract modules + the runtime resolver gain the inheritance
composition; the **one seam** (`resolveEmployeeCapabilities` / `resolveEmployeePosture`) repoints
its source; the four registration surfaces repoint to read the registry. *Reversibility:* every step
is parity-gated and reversible — the shadow store, the parity interlock, the seam flip behind a green
gate, mirror-then-drop. The `ResolvedCapabilitySet` / `EmploymentPosture` contracts and every `ctx`
field are **untouched** (the ABI Principle), so the executor and the two live handlers stay green.

**The governing principle is set.** This PR records the **Single Source of Authority Rule** in the
[Kernel Contract Map](../governance/kernel-contract-map.md) §2 as the **thirteenth** engineering
standard and the governing principle of #015 — the rule that *keeps* the consolidation consolidated.

**Freeze status & synchronisation.** Contract #8 (Capability Registry) is **Reserved** today. It
graduates **Reserved → Established** **only on #015 completion** (the R5 cutover + completion record),
**not** on acceptance of this ADR. Per the synchronisation rule, that graduation will update **both**
the [Architecture Freeze](../governance/architecture-freeze.md) §4 **and** the [Kernel Contract
Map](../governance/kernel-contract-map.md) (the Capability Registry row) **in the same PR** as the
completion record. This ADR's acceptance authorises **implementation to begin**, not the graduation.

**Numbering.** This is ADR **0010** ([`../governance/numbering.md`](../governance/numbering.md) §5);
ADR numbers are monotonic and never reused. The number is registered in §5 as **Proposed**, and the
next free ADR number stands at **`0011`**. Per the Architecture Freeze §2, the architectural-review
sign-off for the *contract change itself* travels with the implementation PRs that carry the #015
code; this decision record — once **accepted** — is those PRs' prerequisite, and the R1 → R5
increments build upon it.

**Acceptance & implementation authorisation (CEO independent CTO review, 2026-06-28).** ADR 0010 is
**accepted** — *"ADR 0010 correctly defines the Capability Registry as the declarative source of
authority for runtime capabilities … The direction is approved"* — **with one amendment**: inherited
**approval posture uses the Approval Ratchet Rule** (Decision 5), the stricter rule the CEO chose
over most-specific-wins, so *capability tokens are still resolved by union; budgets may use the
stricter / effective minimum; memory scope remains most-specific where appropriate; and no weaker
grant may silently override a stronger approval requirement.* The decisions submitted for
ratification stand as accepted (storage = the `hq_capability_grants` table; grant administration =
CEO / Boardroom-authorised, never self-service; legacy columns = mirror-then-drop; surface-collapse =
sequenced within #015). On acceptance the CEO **authorised Directive #015 implementation to begin**,
in small reviewable increments, starting with the smallest safe slice:

> **R1 — Registry Schema.** The capability-definition table, the capability-grant table, the
> inheritance scope model, immutable audit fields, and database constraints — **no runtime resolver
> yet, no SDK wiring yet, no migration away from the legacy columns yet.** R2 does not begin until
> R1 has been implemented, validated and reviewed, under the full validation discipline.

The CEO's standing constraints carry forward: implement the smallest safe slice; do not begin the
next increment until the current one is reviewed; maintain the six-gate validation discipline; and
the API gateway + cost metering remain a deferred future extension, out of #015 scope.

---

*Documentation only. No code, schema, migration, configuration, numbering, or git history was
changed by this record. Authored ahead of implementation under the document-before-you-build rule at
the CEO's direction. Prepared for CEO Directive #015 / D-05 (the Capability Registry), sequenced last
by the [dependency-ordering analysis](../governance/directive-013-dependency-ordering-analysis.md),
built upon the now-Established RunContext (#013) and AI SDK (#014) contracts, consolidating the
authority data named by the [platform-independence
audit](../governance/directive-012-platform-independence-audit.md). It formalises the CEO-approved
[architecture proposal](../governance/directive-015-capability-registry-architecture-proposal.md)
and the rulings the review returned — the declarative-database-of-authority refinement, the owns /
does-not-own list, the inheritance model, and the **Single Source of Authority Rule** the CEO set as
the governing principle of the directive — and, now **accepted** (with the Approval Ratchet Rule
amendment), is the prerequisite the authorised implementation PRs build upon, beginning with **R1
(Registry Schema)**.*
