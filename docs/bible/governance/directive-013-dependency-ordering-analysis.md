# CrewFlow Governance — Directive #013 Dependency-Ordering Analysis

> **Status:** Governance **analysis & recommendation** — *not* a decision, and it
> renumbers nothing. It answers the CTO's question on holding the Capability Registry
> proposal: **can a Capability Registry be designed correctly before the final
> `RunContext` contract is defined?** Every conclusion is backed by `file:line`
> repository evidence. Prepared under CEO Directive **#011** (*Governance, Numbering &
> Scope Reconciliation*; Master Roadmap **D-01**); it informs which thing-name takes
> the next free directive number **#013 / D-03**.
>
> **Bottom line (this analysis reverses the author's prior proposal):** the dependency
> is **asymmetric** — the Capability Registry depends on the `RunContext` contract, and
> the `RunContext` contract does **not** depend on the registry. Of the eight
> dimensions the CTO named, **five are pure `RunContext` concerns** (three already
> shipped on the minimal context), **two are split** (data on the registry, *threading*
> on the `RunContext` — the constitution assigns the threading to the `RunContext`), and
> **none** constrains the `RunContext` from the registry side. Therefore the runtime
> contract should be defined **first**, and **Option B is the stronger ordering.**

---

## 1. The question, and the method

The author's earlier chat proposal put the **Capability Registry at #013**, before the
AI SDK / `RunContext` at #014. The CTO held that and asked for a dependency analysis
before approval — correctly, as it turns out.

The test is concrete: **for each of the eight named dimensions, does the registry's
correct design depend on the `RunContext` contract, or does the `RunContext`'s correct
design depend on the registry?** Whichever artifact's shape *constrains* the other must
come first, because the [Architecture Freeze](./architecture-freeze.md) exists precisely
to stop a load-bearing contract being improvised and then re-cut.

All evidence is `file:line` at integration tip after PR #202.

---

## 2. Two pivotal facts that reframe the whole question

Neither artifact is greenfield. Both partially **already exist** — which is what makes
the dependency direction decidable from evidence rather than speculation.

**(a) A minimal `RunContext` is already shipped (PR-C of #012).**
`server/sdk/tasks.ts:98` defines `export interface RunContext` carrying
`{ task, identity, memory, tasks, correlationId, budgetMicros }` (lines 99–110). The
runner **builds it at claim time** (`task-engine-lifecycle.md:338`). So `RunContext` is
not "embryonic intent" — it is **Partial**, with three of the CTO's eight dimensions
(identity, correlation, budget) **already on the wire**.

**(b) The Capability Registry's *data* already exists, scattered on `ai_employees`**
(`supabase/migrations/20260712000000_ai_employees.sql`):

| Column | Line | What it already holds |
|---|---|---|
| `tools_allowed text[]` | 72 | the per-employee tool capability list |
| `permissions jsonb` | 77–78 | `{"can_execute":…, "requires_approval":…, "scopes":["read"]}` — the scope/execution policy |
| `memory_scope text` | 80–83 | the memory permission (isolated / department / …) |
| `department text` | 32–33 | the org grouping |

So the "Capability Registry" is **not an invention — it is the *consolidation* of scope
data that already exists per employee**, today read **ad hoc** (architecture-freeze
contract #8: *"employee scopes are enforced ad hoc"*). A consolidation layer is
strongest built **last**, when everything it must consolidate is defined.

These two facts already tilt the answer: the runtime context is the *moving keystone*
that is actively being assembled; the registry is a *consolidation of static data* that
is waiting for its consumers to settle.

---

## 3. The eight-dimension dependency analysis

| # | Dimension | Whose contract owns it | Repository evidence | Direction |
|---|---|---|---|---|
| 1 | **Runtime identity** | **`RunContext`** (canonical decision deferred to #014) | `ctx.identity` (`tasks.ts:102`); the canonical identity is *explicitly deferred* — the qualification **three-way split** `lead-qualification` / `qualification-ai` / `lead-qualification-ai` is unresolved (`runtime-identity.md` §4, §6) | registry must **key to** identity → **depends on it** |
| 2 | **Capability propagation** | **`RunContext`** (data on registry) | enforcement is `ctx.tools.invoke(name,args)` → *"the SDK checks the permission"* (`volume-13-ai-sdk.md` §12, L281–288); the constitution says `RunContext` *"threads … scope … through every invocation"* (`constitution` L98) | registry holds data; **`RunContext` propagates** → registry's enforcement surface **depends on `RunContext`** |
| 3 | **Permission propagation** | **`RunContext`** | the SDK **permission-filters** memory during context assembly (`volume-13` §8 L220–222, §11 L255) | same as #2 |
| 4 | **Cancellation** | **`RunContext` only** | the state-machine guard *permits* `*→cancelled` but PR-A ships **no cancel entry point** — *"the verb is registered when that function lands, never as dead vocabulary"* (`lib/events/registry.ts:133–135`); not on the minimal context yet | registry has **nothing to say** → pure `RunContext` |
| 5 | **Deadlines** | **`RunContext` only** | task `scheduled_at` + lease/reaper exist; a *propagated* per-run deadline is a `RunContext` field, not yet present | pure `RunContext` |
| 6 | **Budget propagation** | **`RunContext`** (already shipped) | `budgetMicros` is **already** on the minimal context (`tasks.ts:109–110`, "passthrough … NOT metered here"); metering is `volume-13` §19 | pure `RunContext`; registry only supplies a default number |
| 7 | **Correlation** | **`RunContext`** (already shipped) | `correlationId` is **already** on the minimal context (`tasks.ts:107–108`, "thread it through anything downstream"); the saga is *inherited, not chosen* (`volume-13` L235) | pure `RunContext` |
| 8 | **SDK contracts** | **`RunContext` is the spine; registry is read *by* it** | the **memory-facet precedent**: a facet is built to a **stable contract**, then assembled into `ctx` *"with no change"* (`volume-13` §11 L262–277) | every facet needs the `RunContext` contract **stable first** |

**Reading the table.** Five dimensions (1 identity, 4 cancellation, 5 deadlines, 6
budget, 7 correlation) are **pure `RunContext`** — three of them already on the shipped
context. Two (2 capability, 3 permission) are **split**, and the constitution + the SDK
volume both place the *threading/enforcement* on the `RunContext`, leaving only the
*data* on the registry. The last (8) makes the `RunContext` the spine every facet hangs
off. **In none of the eight does the `RunContext`'s correct shape depend on the
registry.** The dependency runs one way.

---

## 4. The asymmetry, stated plainly

- **Does the `RunContext`'s shape depend on the registry?** No. The context carries
  *scope* as an **opaque resolved set** and *budget* as a number — indifferent to
  whether the registry stores them in `tools_allowed`, a jsonb blob, or a new table. The
  contract needs to know *"a permission set and a budget will be carried"*, not their
  storage.
- **Does the registry's shape depend on the `RunContext`?** **Yes, decisively, on its
  two load-bearing properties:**
  1. **The identity it keys to** is unresolved until #014 (`runtime-identity.md` §6). A
     registry keyed to `lead-qualification` today may be re-keyed when #014 picks the
     canonical slug — a **data migration of the registry itself** (`runtime-identity.md`
     §1: a slug change *"is a data migration … not a documentation edit"*).
  2. **The enforcement interface** — resolve-once-at-claim vs. check-per-`invoke`-with-
     live-budget-decrement — is *defined by* the `RunContext` propagation model
     (`volume-13` §12). Build the resolver first and you build it against an assumed
     model, then re-cut it when the real context lands.

> **Direct answer to the CTO's question:** *No* — the load-bearing parts of a Capability
> Registry **cannot** be designed correctly before the `RunContext` contract is defined.
> Its data model could be sketched (it already exists as columns), but its identity key
> and its enforcement interface are both downstream of the runtime contract. Building it
> first means building against assumptions the freeze exists to forbid.

---

## 5. Option A vs Option B

**Option A** — #013 Capability Registry → #014 `RunContext` + SDK.
**Option B** — #013 `RunContext` runtime contract → #014 AI SDK → #015 Capability Registry.

| Criterion | Option A (registry first) | Option B (runtime first) |
|---|---|---|
| **Architectural clarity** | builds the *consumer of scope* before the *propagator of scope* — inverted | keystone first, then envelope, then the data that flows through them — reads top-down |
| **Dependency ordering** | violates §3/§4: registry keyed to an unresolved identity, resolver against an undefined model | respects the one-way dependency; identity resolved before anything keys to it |
| **Future extensibility** | each new facet (tools/api/comms) may force a registry re-cut | registry consolidates *all* facets' permissions once they exist — extends by addition |
| **Implementation complexity** | higher: build resolver on assumptions, then refactor + a re-keying data migration | lower: registry becomes a **consolidation/removal** directive over settled inputs |
| **Long-term maintainability** | two cuts of the resolver in history; freeze churn on contracts #4/#8 | one cut each; contracts #4 → #3 → #8 graduate in dependency order |
| **OS coherence** | scope enforcement defined twice (ad hoc, then registry) before the context that carries it | one enforcement point (`ctx`), one declarative source (registry) consolidating the scattered columns + the audit's 4 registration surfaces |

**Option B wins on all six.** Option A's only apparent advantage — *"build the data the
SDK reads, first"* — is hollow: the data **already exists** (`tools_allowed` /
`permissions` / `memory_scope`, §2b), so #014's SDK can read the *existing* columns, and
#015 then **consolidates** them. The registry adds the most value **last**, as the layer
that unifies identity (from #013), facet permissions (from #014), and the four scattered
registration surfaces (the [platform-independence audit](./directive-012-platform-independence-audit.md)
§5) into one source of truth.

---

## 6. Recommendation

**Adopt Option B.** Sequence the next three platform directives:

1. **#013 / D-03 — The `RunContext` Runtime Contract** *(keystone)*. Freeze the full
   `RunContext` interface (identity · memory · tasks · tools · api · comms · events slots
   + scope / budget / deadline / cancellation / correlation propagation semantics) and
   **make the canonical runtime-identity decision** that `runtime-identity.md` §6 has been
   holding for exactly this moment. Graduates freeze contract **#4 Reserved → Established**.
   Builds on what already ships (the minimal context + the memory/tasks facets), so it
   *extends*, it does not restart.
2. **#014 / D-04 — The AI SDK Envelope**. Implement the remaining facets (tools registry,
   api gateway, comms, events) against the frozen contract, reading the **existing**
   `ai_employees` scope columns. Graduates freeze contract **#3 Partial → Established**.
3. **#015 / D-05 — The Capability Registry**. Consolidate `tools_allowed` + `permissions`
   + `memory_scope` + `department` **and** the four scattered registration surfaces into
   one declarative source of truth + resolver, now that identity is canonical and
   `ctx.tools.invoke` is the single enforcement point. Graduates freeze contract **#8
   Reserved → Established**. This is a **consolidation/removal** directive — high on the
   Platform Reuse Index's R4 (infrastructure removed), squarely on-thesis.

**Roadmap action requested (not taken here).** This reorders the post-#012 plan. Per the
CTO's instruction — *"recommend updating the roadmap before implementation"* — I
recommend the CEO approve updating [`numbering.md`](./numbering.md) §3/§7 and the
roadmap to record **D-03 = `RunContext`, D-04 = AI SDK, D-05 = Capability Registry**.
**No renumbering is performed in this document**; it awaits the CEO's decision. (Note:
the canon already names **D-04 / #014 = the AI SDK** in ~12 places; Option B keeps the
SDK at #014 only if `RunContext` and the SDK are treated as one directive. If they are
split — as Option B's three-step does — the SDK moves to a later number. The packaging
of "`RunContext` contract" vs "SDK envelope" into one or two directives is the CEO's
call; the **dependency order — runtime before registry — is what the evidence fixes.**)

---

## 7. What this means for the audit's finding, and an honest correction

The [platform-independence audit](./directive-012-platform-independence-audit.md) named
one real gap: registration scattered across four manifest surfaces with no declarative
Employee Registry. **That gap still gets closed — just last, by #015 — and the wait makes
the fix *better*:** the registry consolidates a settled set (canonical identity + all
facet permissions + the four surfaces) instead of a moving one, and it lands as a
removal-heavy, thesis-positive directive.

**Honest correction.** The author's earlier chat proposal recommended the registry
*first*. This analysis, run against the evidence the CTO asked for, shows that ordering
inverts the dependency. The CTO's instinct to validate the sequence before approving was
correct; the stronger operating-system architecture defines the runtime contract first.

---

*Documentation only. No contract, schema, migration, service, or numbering was changed
by this analysis. It is a recommendation prepared for CEO decision under CEO Directive
#011 (Master Roadmap D-01). If adopted, the numbering ledger and roadmap are updated in a
separate, explicitly authorised change before any #013 implementation begins.*
