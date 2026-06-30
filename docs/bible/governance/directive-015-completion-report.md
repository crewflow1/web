# CrewFlow — Directive #015 Completion Report (The Capability Registry)

> **Status:** Governance **record** — the permanent engineering record of a
> completed directive. Directive **#015** (Master Roadmap **D-05**), *The
> Capability Registry*, is **complete**: one declarative source of truth for
> employee authority (`hq_capabilities` + `hq_capability_grants`), its pure
> resolver + serving switch, and the **physical removal** of the scattered legacy
> authority columns are all merged into the `#011` integration branch — the build
> phase (R1→R4) and the full legacy-removal phase (the LR5 Proposal → LR1 → LR2 →
> LR3 → LR4 → LR5.1 → LR5.2 → LR5.3 → LR5.4A → **LR5.4B**) delivered in
> independently-reviewed increments, every gate green. The Capability Registry —
> **frozen contract #8** — has graduated **Reserved → Established** and is the
> **permanent production authority model**. This report records what was built,
> what was deliberately left, and what the platform learned, written so any
> engineer or AI employee can pick the work up cold.
>
> **Scope of "complete":** the registry schema, the backfill, the pure
> composition + serving law, the registry-native authoring surfaces, the migrated
> runtime *and* database read paths, the production-confidence audit, the retired
> mirror / rollback / parity scaffolding, and the **dropped legacy columns**
> (`ai_employees.tools_allowed` / `permissions`) are all on the integration
> branch, reviewed and approved by the CEO across the increment gates. The
> **cutover to `main` and the production migration are a separate, CEO-gated
> step** (see §2, §8) — "architecturally complete" is not "in production". Issued
> under CEO Directive **#015** (D-05); authority is [ADR
> 0010](../decisions/0010-capability-registry.md).

---

## 0. The directive in one paragraph

Before #015, an AI employee's authority — which tools it may use, whether it may
execute autonomously, whether it needs approval, what memory it sees — lived
**scattered** across `ai_employees.tools_allowed`, `ai_employees.permissions`,
`ai_employees.memory_scope` and `ai_employees.department`, read ad hoc by four
registration surfaces with no single declarative source and no inheritance model.
Directive #015 **consolidated** that scattered data into one declarative authority
model: the `hq_capabilities` catalogue (what authority *exists*) and the
`hq_capability_grants` table (who *holds* it, scoped `global ⊇ organization ⊇
department ⊇ employee`), resolved at runtime by a **pure, dependency-free**
composition law (deny-wins execution, the approval ratchet, effective-minimum
budget, most-specific memory scope) over a **default-deny floor**. The directive
ran in two halves under the strictest reading of *document-before-you-build* (ADR
0010, accepted ahead of any code): a **build** phase (R1 schema → R2 backfill +
parity gate → R3 pure resolver + SDK shadow → R4 runtime authority switch) stood
the registry up as a continuously-verified **shadow** of the legacy model, then
switched the runtime to serve it; and a **legacy-removal** phase, designed as a
reviewed proposal and then executed in ten independently-authorised increments,
that migrated every write path, every read path (application *and* database),
banked sustained production confidence, retired the mirror, the operator rollback
lever and the parity oracle, and — only once each independence face was
*separately demonstrated* — **physically dropped** the legacy columns. The
architectural promise — *employee #42 inherits exactly the same authority model as
employee #3* — is now made load-bearing by one declarative registry and one pure
resolver, not by four scattered columns and ad-hoc reads. Deletion came **last**,
as the confirmation of replacement, never the mechanism of it.

---

## 1. Objectives achieved

All objectives the CEO approved in ADR 0010 and across the increment reviews are on
the integration branch and verified.

| # | Objective | How it was met | Evidence |
|---|-----------|----------------|----------|
| 1 | **One declarative authority catalogue + grant model** (ADR Decisions 1, 3) | `hq_capabilities` (the token vocabulary, `kind`-classified) + `hq_capability_grants` (scoped holdings) replace the four scattered surfaces with a single source of truth | `supabase/migrations/20260806000000_*` (R1 schema); ADR 0010 §Decisions 1 & 3 |
| 2 | **The four-level inheritance model** (Decision 5) | `global ⊇ organization ⊇ department ⊇ employee`, composed by a pure law: tokens UNION, `can_execute` DENY-WINS, `requires_approval` the APPROVAL RATCHET, `budget_default` effective-MINIMUM, `memory_scope` most-specific-wins | `server/sdk/registry-resolver.ts` (`composeGrants`, `applicableGrants`) |
| 3 | **A default-deny floor as the fail-safe** (Decision 4) | Absence resolves to `AUTHORITY_FLOOR` (no tokens, `can_execute=false`, `requires_approval=true`, `memory_scope='isolated'`); approval only ratchets up, so no inheritance path can manufacture authority | `registry-resolver.ts` (`AUTHORITY_FLOOR`, `MEMORY_SCOPE_FLOOR`) |
| 4 | **A behaviour-preserving backfill + parity gate** (R2; the Behaviour Preservation Rule) | Every legacy row's authority folded into a registry grant; a parity oracle proved the registry-resolved authority *equalled* the legacy model for every employee before any switch | R2 backfill migration + `hq_capability_registry_parity()` (since retired in LR5.4B) |
| 5 | **A pure runtime resolver, stood up as a verified shadow** (R3; the Shadow Validation Rule) | The composition law shipped as a PURE module with no server-graph imports, continuously compared against the legacy model with **zero** runtime behaviour change | `registry-resolver.ts`; the server-only IO bridge `server/sdk/registry-parity.ts` |
| 6 | **The runtime authority switch — registry authoritative** (R4 → LR3; the Rollback Readiness + Registry Completeness Rules) | `resolveServedAuthority` serves EVERY dimension (tokens, posture, memory scope) from the registry, coherently from one source, with the floor as the automatic fail-safe | `registry-parity.ts` (`resolveServedAuthority`, `decideServedAuthority`) |
| 7 | **Registry-native authoring** (LR1/LR2; the Mirror Integrity Rule) | Both authoring RPCs (`hq_author_employee_capabilities`, `hq_author_employee_memory_scope`) re-pointed to seed registry grants from identity at the deny floor; the legacy write paths closed | `20260808000000_*`, `20260809000000_*`; re-pointed again in LR5.4B |
| 8 | **Every read path migrated — application AND database** (LR2/LR3 + LR5.4A; the Read Migration + Hidden Read Path Rules) | The admin Boardroom page + authoring audit read SERVED authority; the hidden `security definer` SQL reader `hq_memory_write` migrated to resolve `memory.write.shared` from the registry | `registry-parity.ts` (`resolveServedCapabilityView`, `readEmployeeGrantTokens`); `20260811000000_*` (LR5.4A) |
| 9 | **Sustained production confidence, measured not elapsed** (LR4; the Compatibility/Retirement Readiness Rules) | A read-only confidence audit classifies every employee's serving decision (registry-served / backfill-gap / registry-error) and folds it to one `registryOnlyReady` boolean — the §4.4 exit criterion | `server/sdk/registry-confidence.ts` (`auditRegistryConfidence`); [LR4 evidence ledger](./directive-015-lr4-production-confidence-evidence.md) |
| 10 | **The scaffolding retired in dependency order** (LR5.1→LR5.3; the Removal Sequencing / Rollback Independence / Data Removal Rules) | Writes (mirror) → rollback (the `CAPABILITY_AUTHORITY_SOURCE` lever + legacy-serving path) → then data — each retirement independently reviewed and validated before the next | `20260810000000_*` (retire mirror); LR5.3 (retire rollback) |
| 11 | **The legacy columns physically removed** (LR5.4B; the Data Removal + Final Removal Rules) | `ai_employees.tools_allowed` + `permissions` dropped, the obsolete parity oracle dropped FIRST (it names the columns), the compatibility helpers / legacy resolvers removed; `memory_scope` + `department` preserved | `supabase/migrations/20260812000000_lr5_4b_remove_legacy_authority_columns.sql`; `__tests__/security/capability-registry-remove-legacy-columns.test.ts` |
| 12 | **Contract #8 graduates Reserved → Established** | The registry is the SOLE runtime authority; no runtime surface references the removed columns; the floor is the fail-safe | [architecture-freeze.md](./architecture-freeze.md) §4 row 8; this report |

**Net result:** the Capability Registry meets the Architecture Freeze bar for a
*protected kernel contract* and graduates **Reserved → Established**. Sixteen
standing §2 standards were ratified across the #015 reviews (the 13th Single
Source of Authority through the **28th Final Removal Rule**), binding how every
future destructive migration on the platform must be sequenced and evidenced.

---

## 2. Objectives intentionally deferred

Nothing below blocks the directive's architectural completion; each is a bounded,
explicitly-deferred follow-up, named so it is not improvised later.

1. **Production cutover + the prod migration (CEO-gated).** Like #012/#013/#014,
   #015 lands on the `directive/011-governance-reconciliation` integration branch.
   The cutover to `main` and the application of the #015 migrations to the
   production database (the schema-creating R1 migration through the
   column-dropping LR5.4B migration) are **one CEO-reviewed step on a maintenance
   window**, never auto-applied — LR5.4B in particular is irreversible by design.
2. **Post-migration authoring of organization-scope grants.** The
   `organization` scope level exists in the model and the resolver but carries no
   per-employee key in the migrated data (the legacy model had no organization
   column), so organization grants compose to nothing until authored
   post-migration. The seam is live and tested; the data is a future operational
   task, not a #015 deliverable.
3. **A first-class authoring UI for grants.** #015 re-pointed the *authoring RPCs*
   and the admin *read* surfaces; a richer grant-authoring interface (beyond the
   existing capability editor) is a Boardroom-interface concern (contract #9),
   deferred to its own directive.
4. **Generated DB types for the HQ-internal registry tables.** `hq_capabilities`
   / `hq_capability_grants` are service-role-only and not in the generated
   `Database` types, so reads cast through minimal structural interfaces
   (`GrantReadClient` / `CatalogueReadClient`) — the same `as never`/cast idiom
   #012/#013 use for `hq_ai_tasks`. A generated-types pass removes the casts.

---

## 3. Architectural decisions

The full record is [ADR 0010](../decisions/0010-capability-registry.md) (accepted
ahead of implementation under the strictest reading of the
document-before-you-build rule, defining the nine areas the CEO required —
authority ownership · registry boundaries · grant model · inheritance model ·
migration strategy · runtime resolution model · interaction with the Tool Registry
· interaction with the SDK · interaction with the API Gateway — with one amendment,
the **Approval Ratchet Rule**). The load-bearing decisions:

- **The registry is a declarative database of authority; the runtime composes it**
  (Decision 2). Authority is *data*, not code: the runtime queries the registry and
  composes grants through a **pure, total** law (`composeGrants` /
  `decideServedAuthority`), unit-testable in isolation with no IO. The server-only
  bridge supplies the IO and the monitoring side effects; the law itself never
  touches the network.
- **Default-deny is the floor, and approval ratchets up, never down** (Decisions 4
  & 5, + the Approval Ratchet amendment). The base case grants nothing; inheritance
  can only *add* tokens and *tighten* approval. This is what makes an unreachable or
  unauthored registry **safe by construction** — a fail-safe can only ever grant
  *less*, never manufacture authority.
- **Build as a shadow, switch behind a gate, remove only on proven independence.**
  The directive never flipped behaviour and deleted in one motion. R2/R3 ran the
  registry as a continuously-verified shadow (parity == legacy); R4/LR3 switched
  the serve path; the legacy-removal phase then retired the scaffolding in
  dependency order and dropped the columns **last**, each independence face
  (behavioural, runtime, rollback, operational, confidence, validation) demonstrated
  *separately* before the irreversible step.
- **Database code is production code** (the Hidden Read Path Rule, 27th). Planning
  LR5.4 surfaced a live `security definer` SQL reader (`hq_memory_write`) the
  application-tier census had missed; the CEO ratified the halt and **split LR5.4**
  into LR5.4A (migrate the SQL reader, behaviour-preserving, no deletion) and
  LR5.4B (the physical removal), proving the census must reach into the database
  before any irreversible migration.
- **Deletion is the confirmation of replacement, never its mechanism** (the Final
  Removal Rule, 28th — set by the CEO on the LR5.4B completion review). The capstone
  standard the whole directive embodies: infrastructure is removed only after
  behavioural equivalence, runtime independence, rollback independence, operational
  independence, production confidence, and the full validation discipline have each
  been **independently demonstrated**.

---

## 4. Runtime contract summary

The authority model every employee now inherits, as built. **Authority is resolved
from the registry and composed by a pure law; the legacy columns are gone.**

| Dimension | Resolved by | Composition law | Floor (fail-safe) |
|---|---|---|---|
| `tokens` | the registry grants | UNION across applicable scopes (sorted-distinct) | `[]` (no tokens) |
| `canExecute` | the registry grants | **DENY-WINS** — true only if every applicable grant permits | `false` |
| `requiresApproval` | the registry grants | **APPROVAL RATCHET** — required if any grant requires | `true` |
| `budgetDefault` | the registry grants | **EFFECTIVE MINIMUM** (NULL ceilings ignored) | `null` |
| `memoryScope` | the registry grants | **MOST-SPECIFIC-WINS** over the `isolated` floor | `isolated` |
| `source` | the serving switch | `registry` when grants composed it; `floor` when the registry errored or was silent | `floor` |

**Invariants (frozen here, enforced by tests):**

- **The registry is the SOLE source of served authority.** There is no legacy
  baseline left to compare against or fall back to; `resolveServedAuthority` serves
  EVERY dimension (tokens, posture, memory scope) coherently from the one source
  `decideServedAuthority` chose — the registry can never serve tokens while another
  source serves posture.
- **The composition + serving law is PURE and TOTAL.** `composeGrants`,
  `decideServedAuthority`, `classifyServingConfidence`, `summarizeConfidence` take
  inputs to outputs with no IO; the same inputs always yield the same frozen result,
  so the law is unit-testable in isolation and the audit can never diverge from what
  the serve path does.
- **The fail-safe is the default-deny floor, reached only automatically.** A
  registry read error (`reason: "error"`) or a registry silent for a subject
  (`reason: "empty"` — a backfill gap) serves the frozen floor singleton; LR5.3
  retired the operator rollback lever, so `floor` is **never** an operator choice and
  **never** a legacy model.
- **Confidence is measured, not assumed.** The read-only audit folds every
  employee's serving decision into `registryOnlyReady` (every employee served the
  registry — no gap, no error); an empty roster is **not** ready.
- **Removal preserved the survivors.** `memory_scope` (the surviving identity mirror
  the memory SQL enforces against) and `department` (a registry scope key) were
  **never** dropped; the migration history and the production-confidence audit history
  remain intact.

---

## 5. Implementation summary

Delivered across the `directive/015-capability-registry` increment branches into
the `directive/011-governance-reconciliation` integration branch, each increment a
separately-reviewed PR. The arc:

**Build phase (the registry stood up as a verified shadow, then switched):**

| Increment | What shipped | Rule set on its review |
|---|---|---|
| **ADR 0010** | The Capability Registry decision (nine areas) — accepted ahead of any code | *Single Source of Authority Rule* (13th) — the #015 governing principle |
| **R1** — Registry Schema | `hq_capabilities` + `hq_capability_grants` + the catalogue seed | *Migration Parity Rule* (14th) |
| **R2** — Backfill + Parity Gate | Every legacy row folded into a grant; the parity oracle proved registry == legacy | *Behaviour Preservation Rule* (15th) |
| **R3** — Resolver + SDK shadow | The pure `registry-resolver.ts` + the server bridge, run as a continuous shadow | *Shadow Validation Rule* (16th) |
| **R4** — Runtime authority switch | The runner serves registry tokens; legacy retained for rollback | *Rollback Readiness Rule* (17th) |

**Legacy-removal phase (designed, then executed in independently-reviewed increments — removing nothing until each independence face was demonstrated):**

| Increment | PR | What shipped | Rule set on its review |
|---|---|---|---|
| **Legacy Removal Proposal** | — | The removal sequence design (criteria, conditions, order, validation) | *Evidence Before Deletion Rule* (18th) |
| **LR1** — registry-native authoring | #239 | Authoring writes the registry grant | *Mirror Integrity Rule* (19th) |
| **LR2** — registry-native memory scope / admin reads | #241 | Memory-scope authoring + admin read paths onto the registry | *Registry Completeness Rule* (20th) |
| **LR3** — runtime read-path migration | #243 | Every runtime dimension served by the registry | *Compatibility Layer Rule* (21st) |
| **LR4** — production-confidence audit | #245 | The read-only confidence sweep; evidence banked, removing nothing | *Retirement Readiness Rule* (22nd) |
| **LR5 Proposal** | #247 | The teardown sequence (writes → rollback → data → tooling → completion) | *Removal Sequencing Rule* (23rd, PR #248) |
| **LR5.1** — retire the mirror | #249 | Stop the compatibility writes; the legacy columns go inert | *Read Migration Rule* (24th) |
| **LR5.2** — migrate the legacy read paths | #251 | Every remaining consumer of the inert columns onto the registry | *Rollback Independence Rule* (25th) |
| **LR5.3** — retire the rollback mechanism | #253 | Retire the `CAPABILITY_AUTHORITY_SOURCE` lever + the legacy-serving path | *Data Removal Rule* (26th) |
| **LR5.4A** — migrate the hidden SQL reader | #256 | `hq_memory_write` resolves `memory.write.shared` from the registry (behaviour-preserving) | *Hidden Read Path Rule* (27th, set on the LR5.4 halt) |
| **LR5.4B** — remove the legacy columns | **#258** | Drop `tools_allowed` / `permissions` + the parity oracle; re-point the RPCs; preserve `memory_scope` / `department` / history | **Final Removal Rule** (28th, set on this completion review) |

**The final increment (LR5.4B, PR #258 — `5adf72a`):** 41 files, **+1501 /
−1524** (a net *deletion* directive). It dropped the obsolete parity oracle
`hq_capability_registry_parity()` **first** (it names the columns —
dependency-then-removal), then dropped `ai_employees.tools_allowed` +
`permissions`; re-pointed both authoring RPCs to read identity only and seed a
fresh grant at the deny floor; removed `verifyRegistryParity` /
`legacyServedAuthority` (the bridge has no parity comparator and no legacy
fallback — the floor is the fail-safe), the legacy resolvers
(`resolveEmployeeCapabilities` / `resolveEmployeePosture`), and every runtime
reference to the removed columns; and **preserved** `memory_scope` / `department`,
the migration history (808→812), and `auditRegistryConfidence`. The preceding
**LR5.4A** (PR #256 — `a60b512`): 3 files, **+513 / −66**, migrated the last
hidden reader with no schema deletion.

**Net result:** the platform gained one declarative authority registry, one pure
resolver, and a measurable confidence instrument, and **removed** four scattered
authority surfaces, two columns, a parity oracle, a rollback lever, a parity
comparator, and the legacy resolvers — capability *up*, bespoke authority
machinery *down*.

---

## 6. Validation summary

All six gates green; the figures below were re-verified on the integration branch
while preparing this report. CI has no database, so the live registry behaviour is
proven in the **integration tier** against local Postgres, and each increment's
**security tier** pins its migration's contract against source text (a hole that
silently re-opened would fail loudly there).

| Gate | Result |
|---|---|
| **Typecheck** (`tsc --noEmit`) | **clean** (exit 0) |
| **Lint** | **0 errors** (3 pre-existing warnings, unrelated to #015) |
| **Unit** (`vitest`, default config) | **149 files / 2829 tests** passing |
| **Security** (`vitest.security.config.ts`) | **50 files / 1089 tests** passing |
| **Integration** (live local Postgres) | **35 files / 214 tests** passing |
| **Production build** (`next build`) | **success** |

**The heaviest #015 coverage is proven against a live database, not just source.**
The integration tier drives the registry resolver, the backfill, the served-authority
switch, the confidence audit, and the service-layer RPC binding end-to-end against
real Postgres. The security tier independently pins each migration's contract:
LR5.4B's suite (`capability-registry-remove-legacy-columns.test.ts`) asserts the
oracle drops before the columns, the columns drop while `memory_scope` / `department`
survive, the RPCs re-point off the legacy columns, and **no runtime surface**
references the removed columns or shadow machinery. The two tiers are complementary
and both are required.

---

## 7. Technical debt

Tracked honestly; none of it is load-bearing on the platform's correctness.

- **Prod migration ledger lag (inherited, the dominant residual).** The #015
  migration chain — and especially the irreversible LR5.4B column drop — is not on
  prod. It applies at cutover as one CEO-reviewed push on a maintenance window;
  dry-run on a branch DB first. This is operational, not architectural.
- **`organization` scope is live but unpopulated.** The resolver matches
  organization grants, but none exist in the migrated data; until authored
  post-migration, organization contributes nothing. By design — the seam is correct
  and tested — but the data is absent.
- **Structural-cast shim for the HQ-internal registry tables.** `hq_capabilities`
  / `hq_capability_grants` are read through hand-written structural interfaces and
  casts because they are service-role-only and out of the generated `Database`
  types (the house idiom, inherited from #012/#013). A generated-types pass removes
  the shim.
- **The `LegacyEmployee` type name is now a misnomer.** LR5.4B reduced it to
  `{ slug, department? }` (no legacy authority fields remain), but the name is
  retained as the stable cross-module import surface. A rename is cosmetic,
  deliberately out of LR5.4B's minimal footprint.
- **Stale capability-mirror comments in `server/sdk/registry-authoring.ts`.** The
  module header and the `authorEmployeeCapabilities` doc-comment still describe
  mirroring the capability split "back to the retained legacy columns" — prose LR5.4B
  made obsolete when it dropped `tools_allowed` / `permissions`. The *code* is correct:
  the re-pointed RPC seeds a fresh grant's posture from the deny floor, and the
  `tools_allowed` it returns is a catalogue-kind split of the grant tokens (a display
  value), **not** a column read. Only the comments are stale; the surviving
  `memory_scope` mirror comments remain accurate (that column was preserved). Cosmetic,
  out of LR5.4B's minimal footprint — a comment-only housekeeping pass.
- **Doc-narrative slippage in `numbering.md` §5.** The §5 prose names the LR1–LR4
  rules one increment off the authoritative ordinal mapping in the ADR-0010
  acceptance paragraph (which the code comments agree with: 13th Single Source …
  20th Registry Completeness … 26th Data Removal … 27th Hidden Read Path). The
  ordinals themselves are sound; the loose prose is a housekeeping pass for a future
  doc-only edit, left out of this closure's footprint.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **The irreversible LR5.4B drop is applied to prod un-reviewed** | Low | High | Applied only at the CEO-gated cutover, on a maintenance window, dry-run on a branch DB first; the columns are gone with no undo, so this is the single most important operational gate |
| **A backfill gap strands an employee on the deny floor in prod** | Low | Medium | The confidence audit requires `backfillGaps === 0` before cutover; the floor denies safely (grants *less*, never more) so a gap is a visible, safe degradation, not a privilege leak |
| **A new SQL reader of authority is added without a registry path** | Low | Medium | The Hidden Read Path Rule (27th) is now standing canon — database code receives the same migration discipline as application code; the §2 record binds future authors |
| **Branch stacking** — #015 sits on the `#011` integration branch, not `main` | Low–Med | Medium | Cutover `#011 → main` promptly; the merges are clean today |
| **A future migration deletes before replacing** | Low | High | The Final Removal Rule (28th) is now standing canon: deletion is the confirmation of replacement, never its mechanism — six independence faces must be independently demonstrated first |

No **high-likelihood** risk remains open. The dominant residual risk is operational
(the gated, irreversible production cutover), not architectural.

---

## 9. Future recommendations for Directive #016

1. **Treat the Capability Registry as the established authority substrate — extend
   it by addition, never fork it.** Like every frozen contract, the registry widens
   through new grants / new catalogue tokens / new scope keys, not through a parallel
   authority store. Any change to the contract goes through an ADR + architectural
   review (Freeze §2).
2. **Author the organization-scope grants as an operational task before any
   directive relies on organization-level authority.** The seam is live; the data is
   not. Populate it deliberately, not as a side effect of #016 code.
3. **Carry the removal discipline forward verbatim.** The 23rd→28th standards
   (Removal Sequencing → Read Migration → Rollback Independence → Data Removal →
   Hidden Read Path → Final Removal) are now permanent: any #016 work that retires
   infrastructure follows the same independently-demonstrated, deletion-last
   sequence.
4. **Keep the document-before-you-build gate.** #015's cleanest property was that
   ADR 0010 (and the LR5 Proposal) were written and reviewed *before* the code, which
   is what let the increments land small and reviewable. Maintain the same ADR
   workflow, the same incremental implementation model, and the same per-increment
   review gates used throughout #014 and #015.
5. **Run the `numbering.md` §5 prose-alignment, the `LegacyEmployee` rename, and the
   `registry-authoring.ts` stale-comment cleanup as doc/cosmetic housekeeping passes**
   outside the critical path, so the canon's words match its authoritative ordinals and
   the code's names and comments match its post-removal shape.

---

## 10. Lessons learned

1. **Build as a shadow before you switch, and you can switch without fear.** Running
   the registry as a continuously-verified shadow of the legacy model (parity ==
   legacy) for two increments meant the R4 switch changed *nothing* observable — the
   risk was retired before the flip, not discovered after it.
2. **Sequence a teardown; never bundle behaviour change with deletion.** The
   Removal Sequencing Rule turned "remove the legacy authority" into five ordered,
   separately-reviewed steps (writes → rollback → data → tooling → completion). Each
   step was individually safe and individually reversible *until* the last; the
   irreversible step did nothing but confirm what the prior steps had already proven.
3. **A census of consumers must reach into the database.** The hidden
   `hq_memory_write` SQL reader proved that "all readers migrated" is false if the
   search stopped at the application tier. Database code is production code; the
   discipline does not weaken at the language boundary. Catching it *before* the drop
   (and splitting LR5.4) turned a latent production incident into a clean increment.
4. **Make the law pure and the IO thin.** Keeping composition / serving / confidence
   as pure, total functions (no IO) made the authority model unit-testable in
   isolation and guaranteed the audit can never diverge from the serve path — the
   bridge only supplies the registry read and the monitoring lines.
5. **Default-deny is what makes a fail-safe safe.** Because the floor grants nothing
   and approval only ratchets up, an unreachable or unauthored registry can only ever
   grant *less* — the switch is safe by construction, not by hoping the registry is
   always up.
6. **Deletion is the final confirmation of replacement. It is never the mechanism used
   to achieve replacement.** The directive's capstone lesson, now standing canon as the
   Final Removal Rule (28th): the registry *replaced* the legacy columns increments
   before they were dropped; dropping them only confirmed a replacement already complete
   and independently demonstrated on six faces.

---

*Governance record under CEO Directive #015 (Master Roadmap D-05). Documentation
only — this report changes no code, schema, or configuration. It records a completed
directive for the permanent engineering canon. Authority: [ADR
0010](../decisions/0010-capability-registry.md); canonical numbering:
[`numbering.md`](./numbering.md); the frozen contract: [`architecture-freeze.md`](./architecture-freeze.md)
§4 (#8); the standing standards set across its reviews (13th–28th):
[`kernel-contract-map.md`](./kernel-contract-map.md) §2; the production-confidence
evidence: [`directive-015-lr4-production-confidence-evidence.md`](./directive-015-lr4-production-confidence-evidence.md).
The Capability Registry is a protected kernel contract of the CrewFlow Operating
System and its permanent production authority model.*
