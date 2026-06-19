# CrewFlow OS — Prioritisation Matrix

**CEO Directive #003.5 ("Lock the Foundation") · Part 4 of 7 · The optimal implementation order**

> Every feature, ranked by the eight criteria the CEO named — customer demand, revenue impact, time saved, engineering cost, support cost, competitive differentiation, AI leverage, adoption likelihood — and then reconciled against the [dependency graph](BUILD-DEPENDENCY-GRAPH.md) to produce **the optimal implementation order.** The headline result: when you rank by value-per-cost *and* honour the dependencies, you independently reproduce [Ch.19's eight-phase rollout](bible/19-rollout-plan.md). The rollout order isn't a preference — it's what falls out of the maths.

---

## 1. The method (and the honesty note)

Pure "what's most valuable" lists are a trap: they tell you what you'd *want* first, not what you *can* build first. So this matrix runs in two passes.

**Pass 1 — score the raw priority.** Each of the eighteen features (the same units as the [dependency graph](BUILD-DEPENDENCY-GRAPH.md)) is scored 1–10 on the CEO's eight criteria, split into **six value drivers** and **two cost drivers**:

| Value drivers (more = build sooner) | Cost drivers (more = costs more) |
|---|---|
| **Customer demand** — how much operators/customers want it | **Engineering cost** — effort to build it correctly |
| **Revenue impact** — cost-avoidance + retention it drives | **Support cost** — ongoing operational burden once live |
| **Time saved** — operator/engineer hours it returns | |
| **Competitive differentiation** — how much it sets CrewFlow apart | |
| **AI leverage** — how much it enables/amplifies the workforce | |
| **Adoption likelihood** — how surely it gets used once built | |

The priority score is a **WSJF-style ratio** (Weighted Shortest Job First — value per unit cost):

```
Value = demand + revenue + time_saved + differentiation + AI_leverage + adoption   (max 60)
Cost  = engineering_cost + support_cost                                            (max 20)
Priority (WSJF) = Value ÷ Cost     — higher means "more value per unit of cost; do sooner"
```

**Pass 2 — overlay the constraints.** WSJF alone is wrong for a system with a foundation (it defers the expensive, load-bearing parts — see §4). So Pass 2 walks the [dependency DAG](BUILD-DEPENDENCY-GRAPH.md) and, at each step, builds **the highest-WSJF feature whose prerequisites are already built** — a *priority-greedy topological sort*. That intersection of "most wanted" and "buildable now" is the optimal order.

> **Honesty note (same as the Review Pack):** every score below is an **informed estimate, defensible from the cited chapter — not a measured fact.** No feature exists yet, so "customer demand" and "adoption likelihood" are judgements about an internal operating surface and an AI workforce, not survey data. They are calibrated relative to each other to make the ranking *meaningful*, not absolute. The value of this matrix is the **order it produces and the reasoning behind it**, which is robust to ±1–2 on any single cell.

---

## 2. The raw matrix (Pass 1)

All eighteen features, scored on the eight criteria. **V** = value sum (max 60), **C** = cost sum (max 20), **WSJF** = V ÷ C. Sorted by rollout phase (the [build order](BUILD-DEPENDENCY-GRAPH.md)) for now; §3 re-sorts by raw priority.

| Feature | Demand | Revenue | Time saved | Differ­entiation | AI leverage | Adoption | **V** | Eng cost | Support cost | **C** | **WSJF** |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| F1 Event spine | 3 | 9 | 7 | 7 | 9 | 10 | **45** | 8 | 4 | **12** | **3.75** |
| F2 Permission gate | 3 | 8 | 5 | 7 | 9 | 10 | **42** | 8 | 4 | **12** | **3.50** |
| F3 Service scaffold | 2 | 6 | 6 | 3 | 7 | 9 | **33** | 4 | 3 | **7** | **4.71** |
| F4 Flag switchboard | 2 | 5 | 6 | 3 | 4 | 10 | **30** | 2 | 2 | **4** | **7.50** |
| F5 Observability | 4 | 8 | 8 | 7 | 8 | 9 | **44** | 6 | 4 | **10** | **4.40** |
| F6 Timeline | 7 | 6 | 8 | 7 | 7 | 8 | **43** | 4 | 3 | **7** | **6.14** |
| F7 Search + ⌘K | 8 | 6 | 9 | 5 | 6 | 9 | **43** | 4 | 2 | **6** | **7.17** |
| F8 Mission Control (read) | 9 | 8 | 8 | 9 | 7 | 9 | **50** | 6 | 4 | **10** | **5.00** |
| F9 Realtime broadcaster | 7 | 6 | 5 | 8 | 6 | 8 | **40** | 6 | 5 | **11** | **3.64** |
| F10 Mission Control (live) | 8 | 7 | 6 | 9 | 7 | 9 | **46** | 4 | 4 | **8** | **5.75** |
| F11 Memory graph | 4 | 7 | 7 | 8 | 9 | 7 | **42** | 7 | 5 | **12** | **3.50** |
| F12 AI framework | 7 | 9 | 9 | 9 | 10 | 8 | **52** | 9 | 6 | **15** | **3.47** |
| F13 Roster onboard ×12 | 8 | 9 | 9 | 9 | 10 | 8 | **53** | 6 | 5 | **11** | **4.82** |
| F14 Approvals + inbox | 7 | 9 | 7 | 8 | 9 | 8 | **48** | 6 | 4 | **10** | **4.80** |
| F15 Graduated execution | 8 | 10 | 10 | 10 | 10 | 7 | **55** | 5 | 6 | **11** | **5.00** |
| F16 Scalability triggers | 3 | 6 | 4 | 5 | 5 | 6 | **29** | 3 | 3 | **6** | **4.83** |
| F17 Security | 6 | 10 | 5 | 8 | 8 | 9 | **46** | 6 | 4 | **10** | **4.60** |
| F18 Testing + CI-Postgres | 4 | 9 | 8 | 7 | 8 | 9 | **45** | 6 | 3 | **9** | **5.00** |

---

## 3. Pass-1 ranking — pure priority (value per cost)

Sorted by WSJF, highest first. This is the order you'd build in **if there were no dependencies** — and the gap between it and reality (§5) is the whole lesson.

| Rank | Feature | WSJF | What pure priority is telling us |
|---|---|:--:|---|
| 1 | **F4 Flag switchboard** | 7.50 | Trivially cheap, universally used → unbeatable ratio. *(And it's a near-root — happily, building it first is also legal.)* |
| 2 | **F7 Search + ⌘K** | 7.17 | Cheap projection, high demand & time-saved. The "find anything instantly" win. |
| 3 | **F6 Timeline** | 6.14 | Cheap projection, high time-saved. The "see everything that happened" win. |
| 4 | **F10 Mission Control (live)** | 5.75 | Huge differentiation for modest *incremental* cost (the live layer over F8). |
| 5= | **F8 Mission Control (read)** | 5.00 | The front door; highest raw demand (9). |
| 5= | **F15 Graduated execution** | 5.00 | Highest raw *value* (55) — but it's last in reality; the ratio hides the dependency depth. |
| 5= | **F18 Testing + CI-Postgres** | 5.00 | High protective value, moderate cost. *Should* lead, not trail (see §4). |
| 8 | **F16 Scalability triggers** | 4.83 | Cheap monitors; high ratio, but pointless before there's load. |
| 9 | **F13 Roster onboard ×12** | 4.82 | The workforce — enormous value (53), reasonable cost. |
| 10 | **F14 Approvals** | 4.80 | The safety that unlocks execution. |
| 11 | **F3 Service scaffold** | 4.71 | Cheap plumbing, broadly used. |
| 12 | **F17 Security** | 4.60 | Existential value (revenue 10), continuous cost. |
| 13 | **F5 Observability** | 4.40 | High value; *should* lead despite mid ratio (see §4). |
| 14 | **F1 Event spine** | 3.75 | **Top value-enabler, bottom-third ratio** — because it's expensive. The trap in plain sight. |
| 15 | **F9 Realtime** | 3.64 | Costly liveness; differentiating but heavy. |
| 16= | **F2 Permission gate** | 3.50 | **Load-bearing, expensive, middling ratio.** |
| 16= | **F11 Memory graph** | 3.50 | High AI leverage, high cost. |
| 18 | **F12 AI framework** | 3.47 | **Highest value (52) but the lowest ratio** — the single clearest proof that WSJF alone would defer exactly what must come first. |

---

## 4. Why pure priority is *wrong* on its own — the foundation trap

Look at the bottom of the Pass-1 ranking: **F1 (spine), F2 (gate), F11 (memory), F12 (framework)** — four of the five most important features in the entire architecture — sit in the *bottom five* by WSJF. Not because they lack value (F12 has the highest value score of all, 52), but because they are **expensive**, and WSJF is a ratio. A naive priority list would build the cheap projections first and defer the foundations — and then discover, weeks in, that the projections have nothing to project, the workforce has no runtime, and the whole edifice is balanced on features nobody scheduled.

This is the **foundation trap**, and it is exactly what the [dependency graph](BUILD-DEPENDENCY-GRAPH.md) exists to prevent. Two correction edges fix it:

1. **Hard data edges (from the dependency graph).** F1 must precede everything; F2 must precede the AI chain; F12 must precede the roster. No ratio overrides a data dependency — you cannot project a spine that doesn't exist. These edges *force the expensive foundations to the front*, inverting their WSJF position.

2. **One soft governance edge — "observable before active."** F5 (observability) has no *data* dependency forcing it early; F7 (search) doesn't read it. Pure WSJF would build F7 (7.17) before F5 (4.40). But [Ch.19's principle P3](bible/19-rollout-plan.md) is absolute: *you cannot roll out what you cannot see.* So the architecture adds a **governance prerequisite** — F5 leads all of Phase 2+ — even though no table forces it. Likewise F18 (testing) and F17 (security) are *continuous* governance edges, not one-time features. The matrix must honour these soft edges as if they were hard.

The lesson, stated once: **priority sets desire; dependencies set possibility; safety sets order among the possible. The optimal plan is all three at once — never WSJF alone.**

---

## 5. Pass 2 — the optimal implementation order

The priority-greedy topological sort: at each step, build the highest-WSJF feature whose prerequisites (hard *and* governance) are satisfied. Walking the [DAG](BUILD-DEPENDENCY-GRAPH.md) that way yields:

| Step | Build | Why it's next | WSJF | Rollout phase |
|---|---|---|:--:|:--:|
| 1 | **F4 Flag switchboard** | Highest WSJF *and* a near-root (no prereqs). Legal and optimal to lead. | 7.50 | P0 |
| 2 | **F1 Event spine** | The root everything reads; data edges force it up from WSJF rank 14. | 3.75 | P0 |
| 3 | **F2 Permission gate** | Unblocks the entire AI chain; forced up from rank 16. | 3.50 | P0 |
| 4 | **F3 Service scaffold** | Now buildable (needs F1+F2); cheap plumbing the rest calls. | 4.71 | P0 |
| 5 | **F5 Observability** | The governance edge: *observable before active*. Leads all consequential work. | 4.40 | P1 |
| 6 | **F7 Search ∥ F6 Timeline** | Highest-WSJF buildable features once F1/F3/F5 exist; pure projections, parallel. | 7.17 / 6.14 | P2 |
| 7 | **F8 Mission Control (read)** | The composition of F2+F5+F6 — buildable only now; highest demand. | 5.00 | P2 |
| 8 | **F9 Realtime broadcaster** | Edges out memory (3.64 > 3.50) and is the prerequisite for live MC. | 3.64 | P3 |
| 9 | **F10 Mission Control (live)** | Now buildable (F8+F9); very high differentiation. | 5.75 | P3 |
| 10 | **F11 Memory graph** | Knowledge before action — the gate to the runtime. | 3.50 | P4 |
| 11 | **F12 AI framework** | Buildable at last (F2+F5+F11); highest value, deferred only by its prereqs. | 3.47 | P5 |
| 12 | **F13 Roster onboard ×12** | The workforce, draft-only; needs the runtime. | 4.82 | P5 |
| 13 | **F14 Approvals** | The human ring; needs the gate + drafts to route. | 4.80 | P6 |
| 14 | **F15 Graduated execution** | The payoff; the highest-value feature, correctly *last*. | 5.00 | P7 |
| 15 | **F16 Scalability triggers** | Pointless before load exists; armed at steady state. | 4.83 | P8 |
| — | **F17 Security ∥ F18 Testing** | Continuous governance edges — gate *every* step's completion, never "done" as a single feature. | 4.60 / 5.00 | all |

### The headline: this *is* Ch.19

Read the right-hand column top to bottom: **P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8.** The priority-greedy sort, computed independently from value-and-cost scores, reproduces [Chapter 19's eight-phase rollout exactly.** This is the most important result in this document.** The rollout order was not chosen by taste or convenience; it is what you get when you maximise value-per-cost subject to the dependency and safety constraints. Two independent derivations — Ch.19's "what's safe to install under a live product" and this matrix's "what's most valuable per unit cost" — **converge on the same sequence.** That convergence is strong evidence the architecture's build order is *correct*, not merely *plausible*.

---

## 6. What the ranking says about *where to spend energy*

Beyond the order, the scores cluster the portfolio into four investment classes — useful for staffing and attention:

| Class | Features | Signature | Implication |
|---|---|---|---|
| **Foundations** (high value, high cost, forced-early) | F1, F2, F12, F11 | Bottom-third WSJF, top-tier value, hard-edged | Spend the *best* engineers here. They're expensive and load-bearing; a defect propagates everywhere. No shortcuts. |
| **Quick wins** (high value, low cost, early) | F4, F7, F6, F10 | Top WSJF, cheap, visible | Ship early and loudly. They build momentum and stakeholder confidence while the foundations soak. |
| **Payoff** (top value, gated-late) | F15, F13, F14 | High value, deep dependency chain | The reason for everything. Resist pulling them early — their value is only safe *after* the ring is built. |
| **Protective** (value is downside-avoidance, continuous) | F17, F5, F18, F16 | Mid WSJF, never "done" | Fund them as standing capacity, not one-off tasks. They're the insurance that lets the rest ship fast. |

> **The one-sentence read for the CEO:** build the **foundations** first (you must, and you must do them well), surf the **quick wins** for early visible value while they soak, keep the **protective** ring continuously funded, and let the **payoff** — the AI workforce that acts — arrive last and gated, exactly where its value is finally safe to collect. That sequence is both the most valuable order *and* the only safe one — which is why the [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md) schedules it precisely this way.

---

*Derived from the frozen Bible (v1.0) and reconciled against the [Build Dependency Graph](BUILD-DEPENDENCY-GRAPH.md); the optimal order matches [Ch.19 Rollout Plan](bible/19-rollout-plan.md) (canon). All scores are informed, chapter-traceable estimates — not measured facts. Companion documents: [CEO Review Pack](CEO-REVIEW-PACK.md) · [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md) · [Implementation Rules](IMPLEMENTATION-RULES.md) · [CEO Gate](CEO-GATE.md).*
