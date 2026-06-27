# CrewFlow Governance — Runtime Employee Identity (the record, and its D-03 resolution)

> **Status:** Governance **record + resolution**. §§1–6 are the original D-01 record: the
> *current* runtime identities of the seeded AI employees and the places where they
> disagree with the Bible specs and the SDK volume — a record that deliberately made **no
> canonical decision** and renamed nothing. **§7 is the resolution:** D-03 / #013 has since
> **settled** the canonical decision, and — by choosing the slug already stamped — it too
> renames nothing in code, seed, or spine.
>
> **The canonical runtime-identity decision — deferred here under D-01 — is now settled by
> the RunContext Runtime Contract directive** (Master Roadmap **D-03** = canonical
> **#013**), as part of the runtime contract and *before* the AI SDK envelope (D-04 / #014)
> is assembled over it (see **§7** and
> [ADR 0007](../decisions/0007-runcontext-runtime-contract.md) Decision 5). (The CEO-approved
> [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md) moved
> the identity decision ahead of the SDK; it was previously bundled with D-04.) Record
> issued under CEO Directive **#011** (*Governance, Numbering & Scope Reconciliation*; D-01);
> resolution recorded under CEO Directive **#013** (D-03).

---

## 1. Why this is a record and not a fix

A runtime slug is not a label in a document — it is the **`actor_id` stamped on every
event, message, and task the employee emits** into the append-only spine. Renaming a
slug is therefore a **data migration** (re-stamping or aliasing historical rows), not a
documentation edit, and it must be designed alongside the identity/`RunContext`
contract that every employee will inherit.

For that reason D-01 (a documentation-only directive) **does not standardise runtime
identities.** It records the current state and the inconsistencies so the RunContext Runtime
Contract directive can decide the canonical scheme once, with full knowledge of the
divergence.

---

## 2. Three identity layers

The same employee is named in up to three places, which today are allowed to differ:

| Layer | Where | Authority today |
|---|---|---|
| **Runtime slug** | `ai_employees.slug` (seed migrations) + the services that look it up | **Authoritative for running code** — this is the `actor_id` actually stamped on spine rows |
| **Bible spec slug** | `docs/bible/workforce/employees/NN-*.md` (the 42-employee roster) | Aspirational / design intent |
| **SDK volume identity** | `docs/bible/substrate/volume-13-ai-sdk.md` | Aspirational / design intent |

Where they disagree, **the runtime slug is what the database and the audit trail
actually contain.** The specs and the SDK volume describe the intended naming.

---

## 3. Current seeded runtime identities (14)

The `ai_employees` table seeds **14** rows on this branch (11 framework + 3
individually seeded). "Spec match" compares the runtime slug to the matching
`workforce/employees/NN-*.md` file's slug.

| Runtime slug | Role | Executes? | Matching spec | Identity consistency |
|---|---|---|---|---|
| `ceo-ai` | CEO AI | framework | `01-ceo-ai.md` | ✅ consistent |
| `cto-ai` | CTO AI | framework | `03-cto-ai.md` | ✅ consistent |
| `design-ai` | Design AI | framework | **none** | ⚠️ **Reserved** (see §5) |
| `documentation-ai` | Documentation AI | framework | `10-documentation-ai.md` | ✅ consistent |
| `finance-ai` | Finance AI | framework | `21-finance-ai.md` | ✅ consistent |
| `marketing-ai` | Marketing AI | framework | `17-marketing-ai.md` | ✅ consistent |
| `operations-ai` | Operations AI | framework | `23-operations-ai.md` | ✅ consistent |
| `product-ai` | Product AI | framework | `05-product-ai.md` | ✅ consistent |
| `qa-ai` | QA AI | framework | `07-qa-ai.md` | ✅ consistent |
| `sales-ai` | Sales AI | framework | `16-sales-ai.md` | ✅ consistent |
| `support-ai` | Support AI | framework | `19-support-ai.md` | ✅ consistent |
| `research-ai` | Company Research AI | ✅ executing | `13-research-ai.md` | ✅ consistent |
| `lead-qualification` | Lead Qualification AI | ✅ executing | `14-qualification-ai.md` | ❌ **three-way split** (see §4) |
| `outreach-ai` | Outreach AI | framework (seeded #010 Ph.1) | `15-outreach-ai.md` | ✅ consistent |

---

## 4. The qualification three-way split (the proven divergence)

The Lead Qualification AI is named **three different ways**:

| Layer | Identifier | Source |
|---|---|---|
| Runtime slug (seed + service) | **`lead-qualification`** | `supabase/migrations/20260721000000_lead_qualification_employee.sql`; `server/services/hq-qualification.ts` (`QUALIFICATION_AI_SLUG`) |
| Bible spec slug | **`qualification-ai`** | [`../workforce/employees/14-qualification-ai.md`](../workforce/employees/14-qualification-ai.md) — and the spec explicitly claims this is "the `actor_id` on every event/message/task it emits" |
| SDK volume identity | **`lead-qualification-ai`** | [`../substrate/volume-13-ai-sdk.md`](../substrate/volume-13-ai-sdk.md) |

The conflict is real and load-bearing: the spec asserts the actor is `qualification-ai`,
but the **running code stamps `lead-qualification`**. A reader reconstructing "everything
this employee did" must query `actor_id = 'lead-qualification'` today — *not* the value
the spec names. **No change was made in this record**; D-03 / #013 has since **chosen
`lead-qualification` as the canonical identifier** — the stamped value wins (§7) — so that
query stays correct by rule rather than by accident.

---

## 5. `design-ai` — Reserved for future implementation

`design-ai` is seeded as a framework row (`'Design AI', 'design-ai', … 'idle'`, from the
original Directive #001 seed) but has **no specification** among the 42-employee roster
(`workforce/employees/` has no `design-ai` file). It is a legacy placeholder the newer
42-employee architecture does not carry a spec for.

Per CEO direction, `design-ai` is **neither adopted nor deprecated**. It is recorded as
**Reserved for future implementation**: its existence is acknowledged, but no
architectural assumption is made about its responsibilities, scopes, or runner. If and
when a Design employee is built, its spec and contract are defined then — under the
RunContext Runtime Contract directive's identity rules.

---

## 6. The deferral (what the RunContext Runtime Contract directive decides)

> **Settled (D-03 / #013).** The deferral below has been resolved — see **§7**. The list
> that follows is the original D-01 statement of *what* D-03 was to decide; §7 records
> *what it decided*.

The **RunContext Runtime Contract directive (D-03 / #013)** owns the canonical
runtime-identity decision, because identity is the first field of the `RunContext` every
employee inherits — and the
[dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md) sequences
the runtime contract *ahead* of the AI SDK (D-04 / #014) and the Capability Registry
(D-05 / #015) precisely because identity must settle before either can rely on it. It
will decide, once and for all:

- the canonical identifier per employee (e.g. resolve `lead-qualification` vs
  `qualification-ai` vs `lead-qualification-ai`);
- whether divergent historical `actor_id`s are migrated, aliased, or frozen (a data
  decision, not a doc decision);
- the rule that the runtime slug, the spec slug, and the SDK identity must agree from
  that point forward;
- the disposition of Reserved rows like `design-ai`.

**Until then:** the runtime slug is authoritative for code and audit; the specs and SDK
volume are intent. Cite [`numbering.md`](./numbering.md) for directive numbering and this
file for identity state.

---

## 7. Resolution — settled by D-03 / #013 (ADR 0007, Decision 5)

The RunContext Runtime Contract directive settled the decision §6 deferred. The authority is
[ADR 0007](../decisions/0007-runcontext-runtime-contract.md) **Decision 5**, accepted by the
CEO; this section records its outcome in the identity ledger.

- **Canonical slug = the slug already stamped.** Each employee's canonical identifier is the
  `actor_id` the database and the append-only spine already carry — the "authoritative for
  running code" layer of §2. For the proven three-way split (§4), **`lead-qualification` is
  canonical**; the spec slug `qualification-ai` and the SDK-volume identity
  `lead-qualification-ai` reconcile *to it*.
- **History frozen, not re-stamped.** Per ADR 0007 Decision 5 (*alias or freeze over
  re-stamping append-only spine rows*) and the CEO's **no-employee-migration** authorisation,
  **zero** historical `actor_id`s change. Choosing the already-stamped slug as canonical is
  exactly what makes the settlement a no-op on the spine: of the 14 seeded rows (§3),
  `lead-qualification` was the lone three-way split, `design-ai` is Reserved (§5), and the
  other twelve were already consistent — so nothing needs re-stamping.
- **Forward rule — the three layers agree.** From #013 onward runtime slug = spec slug = SDK
  identity. `EmployeeIdentity.slug` — the first field of every `RunContext` — carries that
  single canonical value: required, typed, resolved, non-optional (`server/sdk/tasks.ts`).
  The live services resolve it from the seeded row (`QUALIFICATION_AI_SLUG =
  "lead-qualification"`, `RESEARCH_AI_SLUG = "research-ai"`).
- **Reserved rows unchanged.** `design-ai` (§5) stays **Reserved** — neither adopted nor
  deprecated; its identity is defined if and when a Design employee is built.

The spec and SDK-volume documents that still spell `qualification-ai` /
`lead-qualification-ai` are now the *divergent* layer against this canonical rule; aligning
their **prose** to `lead-qualification` is doc-only follow-up — it touches no code, seed,
event, or migration, and sits outside #013's minimal footprint.

---

*§§1–6: documentation only — no slug, seed, event `actor_id`, or migration was changed by
the record; adopted under CEO Directive #011 (Master Roadmap D-01). §7: the canonical
resolution, settled by CEO Directive #013 (D-03) under
[ADR 0007](../decisions/0007-runcontext-runtime-contract.md) Decision 5 — which, by choosing
the already-stamped slug, likewise changed no slug, seed, `actor_id`, or migration.*
