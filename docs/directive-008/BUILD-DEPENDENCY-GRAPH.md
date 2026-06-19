# CrewFlow OS — Build Dependency Graph

**CEO Directive #003.5 ("Lock the Foundation") · Part 3 of 7 · Nothing is built out of sequence**

> For every feature in the frozen architecture, this document answers four questions: **what must exist before it, what depends on it, can it be built independently, and what does it touch** (billing, AI, permissions, database, mobile). The output is a directed acyclic graph and a set of legal build orders — so no engineer can start a feature whose foundations aren't poured. It is derived from [Ch.19's eight rollout phases](bible/19-rollout-plan.md) and the [Ch.03 migration plan](bible/03-data-model.md); where they disagree with this graph, *they* are canon and this is corrected.

---

## How to read this graph

The unit is a **feature** — a buildable system, mostly one per chapter, with the phased chapters (Mission Control, the roster) split into their read-only/live and onboard/graduate stages because they land in different rollout phases. Eighteen features in all.

For each feature, four facts:

1. **Prerequisites** — what must be in production (or at least merged-and-flagged) *before* this feature's code is written. A prerequisite is a hard edge: building ahead of it is building on air.
2. **Dependents** — what cannot be built until this feature exists. The blast radius of a slip.
3. **Independent?** — can it be built in isolation, or is it a *composition* that only makes sense once its inputs exist?
4. **Touch flags** — does it touch **💷 billing/money**, **🤖 AI**, **🔑 permissions**, **🗄️ DB (new tables/columns/migrations)**, **📱 mobile/responsive surface**? These are the review-trigger flags: a feature that touches billing or permissions gets a heavier review; one that touches the DB gets a migration review; one with a mobile surface gets a responsive-layout pass.

> **On "mobile":** CrewFlow's OS is a **web** operating system — the operator surface is `/admin` (Next.js, responsive web). There is **no separate native mobile app** in this architecture, and I will not invent one. The 📱 flag therefore means *"has an operator-facing surface that needs a responsive-layout pass"* (Mission Control, approvals inbox, search, timeline) — **not** native mobile work. The infrastructure features (spine, gate, runtime, memory, broadcaster backend) have **no** mobile surface at all.

---

## 1. The master dependency table

Ordered by rollout phase (= the legal build order). "Prerequisites" lists the hard edges; "Dependents" lists what this unblocks. Touch flags use the legend above.

| # | Feature | Rollout phase | Prerequisites (must exist first) | Dependents (unblocked by it) | Independent? | Touch flags |
|---|---|---|---|---|---|---|
| F1 | **Event spine + verb registry** (Ch.04 + Ch.03 core) | P0 | — *(root)* | F2–F18 (almost everything) | ✅ root — build first | 🗄️ 🤖 |
| F2 | **Permission gate** `authorize()` (Ch.14) | P0 | F1 (spine `permission.*` verbs; the 4 tables) | F11, F12, F13, F14, F15, F17; tile-gating in F8/F10 | ⚠️ needs F1 | 🔑 🗄️ 💷¹ |
| F3 | **Service-layer scaffold** (Ch.05) | P0 | F1, F2 | every feature that exposes an action | ⚠️ needs F1–F2 | 🗄️ |
| F4 | **Feature-flag switchboard** (`hq_settings`) (Ch.19/03) | P0 | — *(reuses existing `hq_settings`)* | every phase's flag | ✅ near-root | 🗄️ |
| F5 | **Observability + audit** (Ch.15) | P1 | F1 (spine to observe), F4 | every later feature is *observed* via it | ⚠️ needs F1 | 🗄️ 🤖² |
| F6 | **Event Timeline** (Ch.11) | P2 | F1, F5 | F8 (Mission Control reads a slice) | ✅ once F1+F5 exist | 🗄️ 📱 |
| F7 | **Global Search + ⌘K** (Ch.10) | P2 | F1, F3 | F8 (palette), AI grounding (F12) | ✅ once F1+F3 exist | 🗄️ 📱 |
| F8 | **Mission Control — read-only** (Ch.09a) | P2 | F2, F5, F6 *(composition)* | F10 (its live form) | ❌ composition of F2/F5/F6 | 📱 🔑³ |
| F9 | **Real-time broadcaster + islands** (Ch.06) | P3 | F1, F17 (the broadcast boundary review) | F10, F14 (live inbox) | ⚠️ needs F1 + security | 🤖² 📱 |
| F10 | **Mission Control — live** (Ch.09b) | P3 | F8, F9 | F14's inbox zone surfaces here | ❌ composition of F8+F9 | 📱 🔑³ |
| F11 | **Memory graph** (Ch.12) | P4 | F1 (`memory.*` verbs; the tables) | F12 (AI recall) | ✅ once F1 exists | 🗄️ 🤖 |
| F12 | **AI framework runtime** (Ch.07) | P5 | F2 (the gate), F5 (cost from run 1), F11 (recall) | F13, F14 (drafts to route), F15 | ❌ needs F2+F5+F11 | 🤖 🔑 🗄️ 💷⁴ |
| F13 | **AI roster — onboard ×12 `locked()`** (Ch.08a) | P5 | F12 | F15 (graduation candidates) | ❌ needs F12 | 🤖 🔑 💷⁵ |
| F14 | **Approvals + inbox** (Ch.13) | P6 | F2 (`needs_approval` branch), F12 (drafts), F9 (live inbox) | F15 (execution routes through it) | ❌ needs F2+F12 | 🤖 🔑 💷¹ 🗄️ 📱 |
| F15 | **Graduated execution** (Ch.08b — activate) | P7 | F12, F13, F14, F5 (the watch) | — *(the payoff; nothing depends on it)* | ❌ needs F12–F14 | 🤖 🔑 💷⁵ |
| F16 | **Scalability triggers armed** (Ch.17) | P8 | F1–F15 (steady state) | — | ❌ presupposes a running OS | 🗄️⁶ |
| F17 | **Security hardening + reviews** (Ch.16) | P0 + gates every phase | F2 (the gate is its spine) | gates F9 and F15 especially | ⚠️ layers onto all | 🔑 |
| F18 | **Testing + CI-Postgres harness** (Ch.18) | P0 + gates every phase | F1 (+ a real Postgres in CI — [OQ-16](bible/20-glossary-conventions-decision-log.md)) | gates *every* feature's "done" | ⚠️ layers onto all | 🗄️⁷ 🤖² |

**Footnotes (the nuance the flags compress):**
1. **💷¹** — F2 *defines* the `billing.refund` capability and F14 *routes* it `dual_control`; neither moves money, but both are the governance around money movement, so they carry the heaviest review.
2. **🤖²** — F5/F9/F18 don't run AI, they *serve* it: cost observation, live surfacing, and evals respectively. Marked to show the AI dependency, not AI execution.
3. **🔑³** — Mission Control renders **tiles filtered by capability** (F2); it consumes permissions, it doesn't define them.
4. **💷⁴** — F12's "billing" touch is **LLM cost governance** (budgets, circuit-breakers), *not* customer money. Distinct from 💷¹/💷⁵.
5. **💷⁵** — the roster includes finance/billing-adjacent employees (dunning, billing-read); `billing.refund` itself **never graduates to AI execution** (stays dual-control human-only).
6. **🗄️⁶** — F16 *arms monitors*; the schema changes (pgmq, external search) only land if a measured trigger trips — none on adoption.
7. **🗄️⁷** — F18's DB touch is the **test harness needing a real Postgres**, the one true pre-flight gap.

---

## 2. The touch-flag matrix (review triggers)

A focused view: which features trip which review. This is the table a reviewer scans to know *what kind of scrutiny* a PR needs before it merges.

| Feature | 💷 Money | 🤖 AI | 🔑 Permissions | 🗄️ DB migration | 📱 Mobile/responsive |
|---|:---:|:---:|:---:|:---:|:---:|
| F1 Event spine | | ● serves | | ● **new** (`hq_events` + partitions) | |
| F2 Permission gate | ○ defines `billing.refund` | ● gates | ● **defines** | ● new (4 tables) | |
| F3 Service scaffold | | ○ | ○ consumes | ● contracts | |
| F4 Flag switchboard | | | | ○ reuses `hq_settings` | |
| F5 Observability | | ○ observes cost | | ● new (metrics/runs/spans) | |
| F6 Timeline | | | ○ | ● projection | ● operator feed |
| F7 Search + ⌘K | | ○ grounds AI | | ● search index | ● palette |
| F8 Mission Control (read) | | | ● **renders by capability** | ○ `hq_operator_dashboard` | ● **home surface** |
| F9 Realtime broadcaster | | ○ surfaces AI | ○ authorises audience | | ● live islands |
| F10 Mission Control (live) | | | ● by capability | | ● **home surface** |
| F11 Memory graph | | ● **AI recall** | ○ memory grants | ● new (vector col + edges) | |
| F12 AI framework | ○ LLM cost | ● **the runtime** | ● spends capabilities | ● new (run tables) | |
| F13 Roster onboard | ○ budgets | ● **the workforce** | ● holds roles | | |
| F14 Approvals | ○ routes refunds | ● gates AI acts | ● `needs_approval` | ● new (approvals/policies) | ● **inbox surface** |
| F15 Graduated execution | ○ finance employees | ● **AI acts** | ● grants per-capability | | |
| F16 Scalability triggers | | | | ○ only if triggered | |
| F17 Security | ○ protects money | ● AI defences | ● **the gate's keeper** | | |
| F18 Testing | | ● AI evals | ● RLS tests | ● **needs real Postgres** | |

● = primary / defining touch · ○ = secondary / consuming touch · blank = no touch.

**What the matrix says about review load:**
- **Heaviest review (money + permissions + AI):** F2, F14, F15 — the gate, approvals, and graduated execution. These are the three features where a mistake moves money or grants power. They get security review *and* CEO sign-off.
- **Migration review (🗄️ ●):** F1, F2, F5, F11, F12, F14 — six features add tables. Each gets the additive/forward-only/non-destructive migration check (Ch.03 discipline) before merge.
- **Responsive-layout pass (📱):** only the five operator surfaces (F6, F7, F8, F10, F14). Everything else is server infrastructure with no screen.
- **No feature touches a tenant schema.** Across all eighteen, the only tenant-table contact is the AI-email seam ([OQ-6](bible/20-glossary-conventions-decision-log.md), additive nullable columns on `notification_email_queue`) — a deliberate, CEO-gated decision, not a default.

---

## 3. The dependency DAG

Every arrow means **"must precede."** Read top-to-bottom; nothing on a lower row may start until its upstream arrows are satisfied. Cross-cutting F17 (security) and F18 (testing) wrap the whole graph and are drawn to the side because they gate *every* node's completion, not a single edge.

```
                         GATE: PR #171 in production & stable
                                       │
   ┌───────────────────────────────────┼───────────────────────────────────┐
   │  P0 FOUNDATIONS                    ▼                                    │
   │   F1 Event spine + verbs ──┬──────────────────────────────────────┐    │
   │   F4 Flag switchboard      │                                       │    │
   │            │               ▼                                       │    │
   │            │        F2 Permission gate authorize() ──┐             │    │
   │            │               │                          │            │    │
   │            │               ▼                          │            │    │
   │            │        F3 Service scaffold               │            │    │
   └────────────┼───────────────┼──────────────────────────┼────────────┘   │
                │               │                          │                 │
   ┌────────────┼───────────────┼──────────────────────────┼─────────────┐  │   ╔══════════════╗
   │ P1         ▼               │                          │             │  │   ║  F17 SECURITY ║
   │   F5 Observability + audit ─┼──────────────► (observes everything)   │  │   ║  reviews      ║
   └────────────┬───────────────┼──────────────────────────┼─────────────┘  │   ║  every phase; ║
                │               │                          │                 │   ║  gates F9,F15 ║
   ┌────────────┼───────────────┼──────────────────────────┼─────────────┐  │   ╠══════════════╣
   │ P2         ▼               │                          │             │  │   ║  F18 TESTING  ║
   │   F6 Timeline    F7 Search │                          │             │  │   ║  + CI-Postgres║
   │        └────────┬─────────┘                           │             │  │   ║  gates every  ║
   │                 ▼                                      │             │  │   ║  feature's    ║
   │        F8 Mission Control (read-only) ◄── F2 ──────────┘             │  │   ║  "done"       ║
   └─────────────────┬──────────────────────────────────────────────────┘  │   ╚══════════════╝
                     │
   ┌─────────────────┼──────────────────────────────────────────────────┐  │
   │ P3  F9 Realtime broadcaster ◄── F17 (boundary review)               │  │
   │                 │     │                                             │  │
   │                 ▼     ▼                                             │  │
   │        F10 Mission Control (live)                                   │  │
   └─────────────────┬──────────────────────────────────────────────────┘  │
                     │
   ┌─────────────────┼──────────────────────────────────────────────────┐  │
   │ P4  F11 Memory graph (◄── F1)                                       │  │
   └─────────────────┬──────────────────────────────────────────────────┘  │
                     ▼
   ┌────────────────────────────────────────────────────────────────────┐  │
   │ P5  F12 AI framework runtime ◄── F2 (gate) + F5 (cost) + F11 (recall)│  │
   │            │                                                        │  │
   │            ▼                                                        │  │
   │     F13 Roster onboard ×12 locked()                                 │  │
   └────────────┬───────────────────────────────────────────────────────┘  │
                │
   ┌────────────┼───────────────────────────────────────────────────────┐  │
   │ P6  F14 Approvals + inbox ◄── F2 + F12 + F9 (live)                  │  │
   └────────────┬───────────────────────────────────────────────────────┘  │
                ▼
   ┌────────────────────────────────────────────────────────────────────┐  │
   │ P7  F15 Graduated execution ◄── F12 + F13 + F14 + F5 (watched) ◄── F17 │
   │        CEO-gated · one employee · one capability · lowest-risk first │  │
   └────────────┬───────────────────────────────────────────────────────┘  │
                ▼
   ┌────────────────────────────────────────────────────────────────────┐  │
   │ P8  F16 Scalability triggers armed (◄── all prior, steady state)     │◄─┘
   └────────────────────────────────────────────────────────────────────┘
```

---

## 4. The critical path (and what can run in parallel)

**The critical path — the longest chain of hard dependencies, the one that sets the floor on programme length:**

```
F1 spine → F2 gate → F11 memory → F12 runtime → F14 approvals → F15 execution
   (P0)      (P0)       (P4)         (P5)          (P6)            (P7)
```

This is the **road to AI execution**, and it is irreducible: you cannot route an AI action for approval (F14) without a runtime to produce it (F12), you cannot trust the runtime without the gate (F2) and recall (F11), and you cannot have any of it without the spine (F1). Every other feature hangs off this spine and can be *parallelised around it* — but this chain cannot be compressed, only de-risked. It is why execution is structurally the **last** thing that happens.

**What can run in parallel (off the critical path):**

| Parallelisable cluster | Why it's free of the critical path | When |
|---|---|---|
| **F6 Timeline ∥ F7 Search** | Both are pure projections off the spine; neither depends on the other. | P2, simultaneously |
| **F5 Observability** | Depends only on F1; can be built the moment the spine emits — and *must* lead, so later work is observed. | P1, ahead of everything |
| **F9 Realtime** | Depends only on F1 (+ a security review); independent of the AI chain. Can be built while F11/F12 are in progress. | P3, alongside memory prep |
| **F8/F10 Mission Control** | A *composition* — it integrates F2/F5/F6 then F9. Its tiles can be stubbed and wired as providers land (registration, not surgery). | P2→P3 |
| **F17 Security ∥ F18 Testing** | Cross-cutting; layer onto every feature continuously rather than sitting on one edge. | continuous |

**The single most important parallel task is F18's CI-Postgres harness** ([OQ-16](bible/20-glossary-conventions-decision-log.md)): it is *off* the feature critical path but *on* the **quality** critical path — until a real Postgres runs in CI, the RLS and event-contract tests that protect the spine and the gate cannot truly gate a merge. It should be started **during the RC soak window, before Phase 0**, so it is ready the day F1 lands.

---

## 5. The "nothing out of sequence" guarantee

This graph turns "build in the right order" from a hope into a checkable rule. Three guarantees fall out of it:

**1. Every legal build order is a topological sort of this DAG — and they all start the same way.** Because F1 (spine) is the root and F2 (gate) is its only structural child on the critical path, *every* valid order begins `F1 → F2 → …`. There is no legal order in which a feature precedes its prerequisites. An engineer who wants to start F12 (the AI runtime) can read straight off the table that F2, F5, and F11 must already be in production — and if they aren't, the work doesn't start. The order isn't a matter of opinion; it's a property of the graph.

**2. The phase flags enforce the edges at runtime, not just on paper.** Each feature ships behind its `hq_settings` flag (default off), and a feature cannot be *activated* until its prerequisites are active — because, by construction, it has nothing to read or call otherwise (F14's inbox is empty with no F12 drafts; F10 can't go live with no F9 broadcaster). The dependency graph and the [flag mechanics](bible/19-rollout-plan.md) are the same safety expressed twice: once as a diagram, once as a switch.

**3. A slip's blast radius is exactly its dependent set — and it's bounded.** If F11 (memory) slips, the *only* things blocked are F12 → F13 → F14 → F15 (the AI chain); the entire observability/timeline/search/Mission-Control/real-time stack (F5–F10) is already shipped and unaffected, because it sits *upstream* of memory, not downstream. The graph localises risk: a delay never cascades sideways into already-delivered value, only forward into not-yet-started work. That is the structural payoff of front-loading the foundations and back-loading the autonomy.

> **The rule, stated once:** *a feature may begin only when every one of its prerequisites is in production and green.* This document is the list of prerequisites. There is no feature in the architecture whose foundations this graph leaves unstated — so there is no excuse to build one out of sequence.

---

*Derived from [Ch.19 Rollout Plan](bible/19-rollout-plan.md) and [Ch.03 Migration plan](bible/03-data-model.md) (canon — they govern; this graph conforms). Companion documents: [CEO Review Pack](CEO-REVIEW-PACK.md) · [Prioritisation Matrix](PRIORITISATION-MATRIX.md) · [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md) · [Implementation Rules](IMPLEMENTATION-RULES.md) · [CEO Gate](CEO-GATE.md).*
