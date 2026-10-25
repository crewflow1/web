# CrewFlow AI architecture rules (ratified)

Standing rules governing how CrewFlow uses AI. Ratified by CEO decision alongside the
AI cost-reduction audit (2026-10). They constrain all four tiers of the cost governor
(`docs/ai-cost-governor.md`, `lib/ai/governor/*`) and every AI workload in the estate.

## 1. Deterministic authority
Money, tax (VAT/CIS), legal, health & safety, permissions, approvals, scheduling authority,
and business-state transitions remain **deterministic**. AI may **explain, draft, or
recommend**, but model output is **never authoritative** — it cannot post a cost, change a
figure, approve anything, or advance a business state on its own. (Already enforced: e.g.
the HQ boardroom narratives are narrate-only and cannot change a number; the `ai_invocations`
CHECK makes a "deterministic spend" row structurally unrepresentable.)

## 2. Cheapest acceptable intelligence
Prefer, in order: **deterministic → local/open model → cheap hosted → premium hosted** —
but only where **benchmarked** quality makes the cheaper rung safe for that workload. A
cheaper engine is never adopted on price alone; it must pass the workload's quality/validation
bar first (see the benchmark harness, `docs/ai/benchmark/`).

## 3. Premium models remain allowed
Premium (frontier) models stay allowed where their quality creates genuine customer or
business value. The goal is to **remove waste, not chase £0 at the expense of quality**.

## 4. Licensing
For initial **production** candidates, prefer **MIT / Apache-2.0** licensed runtimes and
models. Anything under a custom / non-commercial / research-only licence (e.g. Llama Community
Licence, Gemma Terms, Mistral Research Licence, CC-BY-NC) requires **separate CEO review**
before any production use.

## Observability (Phase 0 — this is the measurement these rules are governed by)
The `ai_invocations` ledger + the service-role `ai_cost_window` rollup
(`server/services/ai-cost-report.ts`, surfaced on `/admin/ai-costs`) answer, without manual
maths: **AI cost today / this week / this month, by tenant / feature / provider / model /
engine**, with **input / output / cached tokens, latency, and fallback events**. Telemetry is
privacy-safe: the ledger stores a content *fingerprint* (SHA-256), never prompts or customer
data, and estate-wide spend is service-role-only (no tenant can read it).
