# Chapter 13 — Approvals & Human Oversight

## Purpose

This chapter is the OS's **execution model for AI side-effects**, not a feature bolted onto it. P4 states the rule plainly: *every consequential AI action crosses an approval gate; autonomy is granted, capability by capability, as trust is measured — never assumed.* This chapter is where that rule becomes machinery. It owns the **policy engine** that routes a requested action to `auto` / `require_human` / `dual_control`; the **approval inbox** where an operator sees the queue of decisions waiting; the **projected effect** — the exact human-readable sentence ("Refund £240 to Acme") shown *before* anyone clicks; the **decision** (approve / reject / edit); **expiry** (a stale request lapses and the run resumes with *no* side-effect); and **dual-control** (two distinct humans for the most dangerous powers, with an AI never an approver).

The framing is the blast radius. At one company, an ungated AI refund is a mistake you reverse. At one million companies, an ungated AI action is a category of catastrophe — a refund storm, a mass suspension, a privacy breach replicated ten-thousand-fold before a human notices. P4 exists because of that number. Approvals are therefore the *gate the AI workforce runs through to touch the world*, the human counterweight to the autonomy of Ch.07. The runtime pauses (Ch.07 GATE → `awaiting_approval`); Ch.14's `authorize()` decides *whether* a capability is held and *whether* this context needs approval; **this chapter runs the approval itself.**

## Goals

- **Make oversight the default, not a setting.** Every consequential side-effect routes through a policy that can demand a human. The path from "AI wants to act" to "the world changed" passes through a decision a person can see, understand, and veto.
- **A policy engine, not hard-coded `if`s.** Routing reads `hq_approval_policies` (Ch.03 §03.8) by `capability` × `risk_tier` × `monetary_threshold` × employee — so "Finance AI may auto-refund under £50 but needs a human above it" is *data*, tunable without a deploy.
- **The projected effect is sacred.** No human approves an opaque payload. Every approval carries `projected_effect`: the exact, human-readable consequence, rendered from the *same payload that will execute* — what you approve is what happens.
- **The inbox is a live projection, never a second source of truth.** The operator's queue is a view over `hq_approvals` + the spine, live via server-authorised broadcast (Ch.06). It is rebuildable; it stores nothing the tables don't already own.
- **Dual-control for danger (P5).** The most dangerous capabilities require **two distinct humans**, separation of duties enforced structurally; an AI may *initiate* but is **never** one of the two approvers.
- **No side-effect from a stale decision.** An unanswered approval expires; the run resumes at RECORD with the world unchanged. Time is a safety mechanism, not a leak.

**Non-goals:** the capability *catalogue* and the `authorize()` internals that emit `needs_approval` (Ch.14); the run FSM and how a run *pauses/resumes* (Ch.07); the event envelope and the `approval.*` verb shapes (Ch.04); the inbox's pixels and the Mission Control shell (Ch.09); the audit log's immutability mechanics (Ch.15). This chapter owns the **workflow**: policy → request → inbox → decision → resume/expire.

---

## Architecture

### Where approvals sit in the run

The approval is the hinge between *intent* and *effect*. The AI runtime (Ch.07) reaches its GATE phase with a bound tool call; `authorize()` (Ch.14) returns one of three verdicts; only `needs_approval` enters this chapter.

```
 Ch.07 run ──▶ GATE ──▶ authorize(principal, capability, ctx)  (Ch.14)
                          │
            allow ────────┼──────────────▶ ACT (tool runs immediately)        no approval
            deny  ────────┼──────────────▶ run fails (ai.run_failed)           no side-effect
            needs_approval┘
                          ▼
              ┌──────────────── THIS CHAPTER ────────────────┐
              │  policy engine: route(capability, risk, $)    │  reads hq_approval_policies
              │     → auto            → (treated as allow)     │
              │     → require_human   → 1 approval row         │
              │     → dual_control    → 1 row, 2 distinct      │
              │  create hq_approvals { projected_effect,       │
              │     payload, expires_at, status='pending' }    │
              │  emit approval.requested ──▶ broadcast ──▶ INBOX│
              │  run parks in awaiting_approval (Ch.07)        │
              └───────────────┬───────────────────────────────┘
                              ▼  operator (or expiry) decides
   approve ─▶ approval.granted  ─▶ run resumes at ACT (the SAME payload executes)
   edit    ─▶ approval.edited   ─▶ payload amended, then granted ─▶ run resumes with the edit
   reject  ─▶ approval.rejected ─▶ run resumes at RECORD, NO side-effect, done("rejected")
   expire  ─▶ approval.expired  ─▶ run resumes at RECORD, NO side-effect, done("expired")
```

The crucial property: **between request and decision, nothing has happened.** The tool has not run. The payload is captured but inert. Approval is the *gate before the act*, so a reject or an expiry costs nothing — the world is exactly as it was.

### The policy engine

Routing is a pure decision over data. Given the bound action — `(employee_slug, capability, risk_tier, amount?)` — the engine selects the **most specific enabled** policy from `hq_approval_policies` and returns a `decision`.

```
 resolvePolicy(employee_slug, capability, risk_tier, amount)
   candidates = policies WHERE enabled
        AND (employee_slug = $slug OR employee_slug IS NULL)   -- null = applies to all
        AND (capability    = $cap  OR capability    IS NULL)
        AND (risk_tier     = $tier OR risk_tier     IS NULL)
   rank by specificity: exact employee > all; exact cap > null; exact tier > null
   pick the top candidate
   if candidate.monetary_threshold IS NOT NULL and amount <= threshold:
        return 'auto'                 -- under the line → no human
   else:
        return candidate.decision     -- 'require_human' | 'dual_control' | 'auto'
   if NO candidate: return 'require_human'   -- fail safe (see Failure handling)
```

Three properties make this safe:

- **Specificity, deterministically.** A per-employee, per-capability, per-tier policy beats a blanket one; ties cannot occur because the ranking is total. The chosen policy is recorded on the approval (provenance), so "why did this need a human?" is always answerable.
- **The monetary threshold is a floor for autonomy, not a ceiling on safety.** `monetary_threshold` only ever *relaxes* to `auto` *below* the line; it never escalates a `dual_control` down. Above the line, the policy's stated `decision` stands.
- **Absence is `require_human`, never `auto`.** A capability with no matching policy is treated as needing a human (fail safe). Autonomy must be *granted by a row*; it is never the default — the data-model mirror of P4.

This is the *dial* Ch.07 names: a measured trust score can, over time, add or widen `auto` policies for an employee — autonomy granted *on evidence*. The engine reads the dial; it does not set it.

### The inbox as a projection (♻️ the broadcast model, Ch.06)

The **approval inbox** is the operator's queue of pending decisions. It is not a table — it is a **projection over `hq_approvals` (the pending rows) joined to the spine** (the originating run, its correlation chain, the employee). It is delivered live exactly as every other surface: an `approval.requested` event triggers the broadcaster (Ch.06), which authorises for the HQ audience and pushes a minimal, vetted delta onto the `hq:approvals` channel; the island prepends it. A granted/rejected/expired elsewhere removes it from every operator's inbox in real time. No refresh, no second store (P1, P10).

```
hq_approvals (pending) ──┐
                         ├─▶ inbox projection ──broadcast(hq:approvals)──▶ operator queue (live)
spine: approval.* +      │      • projected_effect (the headline)
       the run's chain ──┘      • employee, capability, risk, amount, age, expires_in
                                • the correlation link → full story (Ch.11)
```

Because the inbox is a projection, it survives a crash trivially (re-query the pending rows), and an operator landing fresh sees the exact same queue as one who has been watching — *observable everywhere* (the thesis).

### The decision as a compare-and-set

A single approval is decided **once**. The decision is a **conditional update** on `hq_approvals.status`:

```sql
-- illustrative: the decision is a compare-and-set; only a pending row transitions.
update hq_approvals
   set status = 'approved', decided_by = $human_id, decided_at = now(), reason = $reason
 where id = $approval_id
   and status = 'pending'          -- the guard: loses the race if already decided
returning id;
```

Two operators clicking "approve" at the same instant both issue this update; Postgres serialises them; **the first wins (one row updated), the loser updates zero rows and is told "already decided."** This is the same single-row compare-and-set Ch.07 §Edge-cases and Ch.14 promise — race resolved by the database, not by a lock the application has to remember to take. The run resumes exactly once, on the winning grant.

### Components & where they live

| Component | Location | Responsibility |
|---|---|---|
| The policy engine | `lib/approvals/policy.ts` *(new, pure)* | `resolvePolicy()` — data-in, decision-out; unit-testable without a DB |
| The approval service | `server/approvals/service.ts` *(new, `server-only`)* | create/decide/expire `hq_approvals`; emit `approval.*`; CAS the status |
| The projected-effect renderer | `lib/approvals/projected-effect.ts` *(new, pure)* | payload → human sentence, one renderer per capability |
| The inbox projection | `server/approvals/inbox.ts` *(new)* | the pending-queue read + the broadcast delta shape |
| The expiry sweeper | ♻️ the Vercel cron drainer pattern | lapse `expires_at` rows → `approval.expired` |
| The gate caller | ♻️ Ch.14 `authorize()` / Ch.07 runtime GATE | the *only* producer of approval requests |
| Audit | ♻️ `admin_activity_log` (`recordAdminActivity`) | every decision, with `decided_by`, immutable (Ch.15) |

Pure logic (policy resolution, projected-effect rendering, the FSM of an approval's `status`) lives in `lib/approvals/*` so it is testable in isolation; `server/approvals/*` is the `import "server-only"` shell that touches Supabase under service-role and emits to the spine (♻️ the services discipline, Ch.05).

---

## Database design

This chapter **owns no new table**. Its two tables are catalogued in **Ch.03** and are reproduced below *for grounding only* — quoted, not redefined; the canonical DDL is Ch.03 §03.7–03.8 and a change is made there first, with an ADR (Ch.20), exactly as Ch.10/12/15 treat the tables they read. Both are **`RLS:hq`** (service-role only; no JWT client reads a single approval row, Ch.16).

```sql
-- ♻️ EXISTING — Ch.03 §03.7. Quoted for grounding; do not redefine.
-- hq_approvals — human approval for an AI side-effect.
create table hq_approvals (
  id            uuid primary key default gen_random_uuid(),
  requested_by_employee text references ai_employees(slug),
  run_id        uuid references ai_employee_runs(id),
  capability    text not null,              -- the action requiring approval
  risk_tier     text not null,              -- 'low'|'medium'|'high'|'critical'
  payload       jsonb not null,             -- EXACTLY what will execute
  projected_effect text not null,           -- human-readable ("Refund £240 to Acme")
  status        text not null default 'pending', -- pending|approved|rejected|expired
  decided_by    text, decided_at timestamptz, reason text,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index on hq_approvals (status, created_at) where status = 'pending';
```

```sql
-- ♻️ EXISTING — Ch.03 §03.8. Quoted for grounding; do not redefine.
-- hq_approval_policies — the rules that route auto vs human vs dual-control.
create table hq_approval_policies (
  id            uuid primary key default gen_random_uuid(),
  employee_slug text,                        -- null = applies to all
  capability    text, risk_tier text,
  decision      text not null,              -- 'auto'|'require_human'|'dual_control'
  monetary_threshold numeric,                -- e.g. auto under £50
  approver_role text,                        -- which human role decides (Ch.14)
  enabled       boolean not null default true
);
```

**Notes on use (not new schema):**

- **The partial index `where status = 'pending'`** is the inbox's hot path: the queue is precisely "the pending rows," and the index makes that O(pending), independent of historical approval volume or company count (see Performance).
- **`payload` is the executable, `projected_effect` is its rendering.** They are written together at request time; the renderer is deterministic over the payload, so the sentence cannot drift from the action. On `edit`, *both* are rewritten atomically.
- **`status`** is a tiny FSM: `pending → {approved | rejected | expired}` — terminal in one hop, never reopened. The CAS guard (`and status = 'pending'`) is what enforces single-decision.
- **`approver_role`** names *which human role* (Ch.14) may decide a given policy's approvals — so a billing approval can require a `billing_operator` (or `super_admin`), not just any operator. For `dual_control`, the two approvers must each hold the role *and* be distinct principals.
- **`decided_by`** is a single column today; **dual-control's second approver** 🔬 is recorded as a second decision — captured either by a `decided_by_2`/`approved_by` extension column (an additive Ch.03 change, ADR-gated) or by two `approval.granted` events on the spine keyed to distinct humans, with `status` flipping only on the second. The spine already carries both decisions either way; the open question is whether the *column* shape needs the extra field or the events suffice for the inbox's read. (Logged for Ch.20.)

**Access pattern.** All reads/writes are service-role. Writes are: one insert at request (the gate), one CAS update per decision, one update per expiry sweep — all rare relative to run volume and all single-row, single-index. The dominant read is the pending-queue projection (the partial index) and, per decision, a point lookup by `id`.

---

## APIs

The approval service is an internal server contract (no external API); the *stable* contracts are the `approval.*` **verbs** (Ch.04) and the capability/risk inputs (Ch.14), changed only by ADR.

```ts
// server/approvals/service.ts — server-only. Created ONLY by the gate (Ch.07/14).
async function requestApproval(input: {
  employeeSlug: string;            // the requesting AI (never a human requester)
  runId: string;                   // the paused ai_employee_runs row (Ch.07)
  capability: CapabilityKey;       // typed against the catalogue (Ch.14)
  riskTier: 'low' | 'medium' | 'high' | 'critical';
  payload: Json;                   // EXACTLY what will execute — captured, inert
  amount?: number;                 // feeds the monetary_threshold branch
  correlationId: string;           // inherited from the run → the whole story (Ch.04)
}): Promise<{ approvalId: string; decision: 'auto' | 'require_human' | 'dual_control' }>;
// on 'auto' → no row persisted as pending; returns immediately so the run proceeds to ACT.
// otherwise → inserts hq_approvals(status='pending'), emits approval.requested, run parks.

// the decision — the compare-and-set. Returns the loser's verdict, never throws on a race.
type DecisionResult =
  | { ok: true; status: 'approved' | 'rejected'; resumes: 'act' | 'record' }
  | { ok: false; reason: 'already_decided'; finalStatus: 'approved'|'rejected'|'expired' }
  | { ok: false; reason: 'not_authorised' | 'same_human' };   // dual-control guards

async function decideApproval(input: {
  approvalId: string;
  human: HqActor;                  // the deciding human (Ch.14 principal)
  verdict: 'approve' | 'reject';
  reason?: string;
}): Promise<DecisionResult>;

// edit-then-approve: amend the payload, re-render the projected effect, then grant.
async function editApproval(input: {
  approvalId: string; human: HqActor; newPayload: Json; reason?: string;
}): Promise<DecisionResult>;        // emits approval.edited then approval.granted

// the inbox projection (read) + the live delta shape (Ch.06).
async function getApprovalInbox(opts?: { domain?: string; riskTier?: string })
  : Promise<ApprovalCard[]>;        // the pending rows, decorated, sorted by urgency

// the sweeper — lapses pending rows past expires_at (♻️ the cron drainer).
async function expireLapsedApprovals(): Promise<{ expired: number }>;
```

**Contracts & error shapes.**

- **`requestApproval` is the only creator.** There is no human-initiated approval; a human *decides*, never *requests*. (A human acting directly is gated by `requireCapability` in Ch.14, not by this chapter.) This keeps the inbox honestly "decisions the AI workforce needs."
- **`decideApproval` is total** — it returns a `DecisionResult` for every input including the race-loser (`already_decided`) and the dual-control guards (`same_human`, `not_authorised`); it never throws on a contested decision.
- **`resumes`** tells the runtime where the parked run re-enters: `'act'` on approve (the payload executes), `'record'` on reject (straight to RECORD, no side-effect). The runtime (Ch.07) keys resumption on the `approval.granted`/`rejected` event, so the service's job ends at emitting it.
- **Idempotency.** A redelivered decision for an already-terminal approval is the CAS no-op (`already_decided`) — harmless (P8). A redelivered `approval.requested` consumer event re-finds the same `(run_id)` pending row rather than creating a duplicate.
- **`editApproval`** re-renders `projected_effect` from `newPayload` *before* granting, so the audit and the operator's last-seen sentence match what executes; the edit and the grant are one transaction emitting `approval.edited` then `approval.granted`.

---

## UI behaviour

The operator surface is the **approval inbox** in Mission Control (Ch.09) — the queue of what the workforce needs decided — plus the inline **approval card** on a run/employee view (Ch.07/08).

- **The queue.** A live list of pending approvals, each a card headed by its **`projected_effect`** ("Refund £240 to Acme Ltd") — the consequence in plain English, *first*, before any expandable detail. Secondary line: the employee (avatar/accent), the capability, the risk tier (badge), the amount, the age, and a **countdown to `expires_at`**. Sorted by urgency (risk × time-to-expiry). The most dangerous, soonest-to-lapse decisions float to the top.
- **The detail.** Expanding a card shows the full payload (read-only), the originating run and its correlation chain (a click into the timeline, Ch.11 — *why* the AI wants this), and the policy that routed it here ("Finance AI · billing.refund · > £50 → require_human"). Authority is never opaque; neither is the *reason a human was asked*.
- **The decision.** **Approve** / **Reject** (with an optional reason) / **Edit** (amend the payload — e.g. correct the amount — which re-renders the projected effect and requires a re-confirm of the new sentence). For **dual-control**, the card shows "1 of 2 approvals" after the first human acts, names who approved first, and presents the second human a card that **cannot be approved by the same principal** (the button is disabled with "you initiated/approved this — a second person is required").
- **States.** *Loading:* the queue renders from the last snapshot (SSR-first, ♻️). *Empty:* an honest "no approvals waiting" — a good state, not an error. *Error:* the projection service failing degrades **closed** in the UI (decisions disabled, "approvals unavailable"), never auto-approving. *Live:* a decision made by another operator, or an expiry, removes the card in real time (broadcast on `approval.*`, Ch.06); a new request prepends with a subtle pulse.
- **Keyboard & accessibility.** `a` / `r` approve/reject the focused card (♻️ the Ch.07 employee-page binding); `e` opens edit; the queue is fully keyboard-navigable. Risk is conveyed by **icon + text + badge**, never colour alone (♻️ the 007 design-system discipline); a new arrival and an imminent expiry are announced via ARIA live regions; the countdown is text, not just a shrinking bar.

---

## Permissions

This chapter consumes Ch.14; it does not fork it. The relevant capabilities:

| Action | Capability | Notes |
|---|---|---|
| View the approval inbox | `approval.read` | broad among operators |
| Decide a `require_human` approval | `approval.decide` (+ the policy's `approver_role`) | a single distinct human |
| Decide a `dual_control` approval | `approval.decide` + the `approver_role`, **× 2 distinct humans** | separation of duties |
| Edit an approval's payload before granting | `approval.edit` | re-renders the projected effect; itself audited |
| Configure approval policies | `approval.policy_admin` | rare; tuning the `auto`/`require_human`/`dual_control` dial |

- **An AI is never an approver.** No AI employee holds `approval.decide` (it is human-only by catalogue, mirroring Ch.14's "no AI holds `permission.*`"). An AI may *initiate* (it is the `requested_by_employee`) but the deciding principal is always a human. This is the containment that makes a successful prompt-injection survivable (Ch.07/16): the worst an injected AI achieves is a *request* a human still vetoes.
- **Dual-control distinctness is structural.** The two approvers must be distinct `principal_id`s, both holding the role; the service rejects a second decision from the first human (`same_human`). A single operator cannot satisfy both halves even by trying twice — the guard is on principal identity, not a UI nicety (P5).
- **The requester is never an approver of its own request.** Even where a human *could* both request a direct action and approve an AI's, the same-principal guard and the AI-can't-approve rule make self-approval impossible for the AI path; for dual-control the *initiator* (if human) is excluded from the approver set.
- **Default policy: read-broad, decide-roled, danger-dual-control.** Viewing the queue is widely held; deciding is gated by the policy's `approver_role`; the dangerous capabilities (the `danger` set in Ch.14 — `billing.refund`, `org.suspend`, …) route to `dual_control`. Configuring policies (`approval.policy_admin`) is itself a senior, audited capability.

---

## Failure handling

- **No matching policy.** `resolvePolicy` returns `require_human` (fail safe) and emits `system.alert_raised` — a capability reaching the gate with no policy is a configuration gap, surfaced, never silently auto-approved. Safety is the default exactly as Ch.14 fails *closed*; here the safe default is "ask a human."
- **The approval service / DB is unreachable at request time.** The gate cannot create the row, so the run **cannot proceed to ACT** — it fails or retries, but it never acts ungated. A broken approval system degrades to *no side-effect*, never to *unchecked side-effect* (the approvals analogue of fail-closed).
- **The decision write fails after the operator clicked.** The CAS update is a single transaction; if it fails it simply didn't happen — the approval stays `pending`, the operator sees an error and can retry. No half-decided state, because the status flip and its `approval.*` emit commit together (P1).
- **Approval never answered (the headline case).** `expires_at` lapses; the sweeper flips `pending → expired`, emits `approval.expired`; the run resumes at RECORD with **no** side-effect and a `done` state annotated "expired" (Ch.07 §Failure-handling). The world is never changed by a stale decision — time is a safety mechanism.
- **The sweeper itself is down.** Expiry is *also* evaluated lazily: a decision attempt on a row already past `expires_at` is treated as expired (the CAS guard can include `and expires_at > now()`), so a missed sweep can never let a stale approval be granted late; the cron is the bulk-cleaner, not the sole enforcer (♻️ the "lazy at check time" pattern from Ch.14 expiry).
- **The broadcaster is down.** The inbox degrades to poll/snapshot of the pending rows; decisions still work (they don't depend on the broadcast); only *liveness* degrades, never *correctness* — the broadcaster is a reader, never in the decision path (♻️ Ch.06).
- **Run gone when the grant arrives** (the run was failed/cleaned). The grant is recorded, but the resume finds no resumable run and no-ops with a `system.alert_raised`; because the tool never ran, there is still no orphaned side-effect.

## Edge cases

- **Two approvers decide simultaneously.** The compare-and-set on `status` serialises them: one row updated (winner), zero rows updated (loser → "already decided"). The run resumes exactly once. (The canonical resolution promised in Ch.07/14.)
- **Approve then the run can't execute** (e.g. the underlying entity changed — the invoice was already refunded by a human). The grant resumes the run at ACT; the *tool* re-validates its preconditions and fails cleanly (`ai.run_failed`) rather than double-acting — approval authorises the attempt, the tool owns its own idempotency (Ch.07).
- **The world changed between request and decision** (the £240 became £200). The operator sees a *stale* projected effect. Resolution: **Edit** re-renders from a fresh payload before granting; or the policy's risk tier keeps such volatile actions short-`expires_at` so they lapse rather than execute stale. Documented as a renderer-freshness concern 🔬 (when to re-derive `projected_effect` at decision time vs request time) for Ch.20.
- **Dual-control, second approver never comes.** The approval expires like any other → `approval.expired`, no side-effect. One approval is not "half-granted"; status only leaves `pending` on the *second* distinct grant or on expiry.
- **An edit that changes the risk tier** (raising the amount past a `dual_control` threshold). The edit re-runs `resolvePolicy`; if the new payload now requires dual-control, the single grant is insufficient and a second human is demanded — the policy is re-evaluated against the *amended* action, never the original.
- **`auto` policy on a `danger` capability.** Rejected at policy-config time: a `dual_control`-eligible (danger) capability (Ch.14) **cannot** be set to `auto` — the `approval.policy_admin` guard refuses it, so the dial cannot be turned to bypass dual-control for a dangerous power.
- **Approval for an employee since suspended.** The grant still resumes the run, but the runtime's own suspended-check (Ch.07) may refuse to ACT; the approval and the run-state are independent gates and both must pass.

## Performance

- **The inbox read is O(pending), not O(history).** The partial index `where status = 'pending'` (§03.7) means the queue query touches only the open approvals — a small set bounded by operator throughput, *not* by the millions of approvals decided over the system's life. A decided/expired approval leaves the index instantly.
- **The decision is a single-row CAS** — one indexed update + one event emit, sub-millisecond, with no application lock and no read-modify-write window.
- **Policy resolution is in-memory.** `resolvePolicy` runs over the (small, curated) `hq_approval_policies` set, cached per-request like the capability set (♻️ Ch.14's cache discipline); a gate evaluation is a ranked filter over a handful of rows, not a query against tenant-scale data.
- **At 1M companies.** The number of *pending* approvals at any instant is governed by how fast humans decide and how many AI actions are in flight — both bounded by operator capacity and the budget governor (Ch.07), **not** by company count. A million companies generate more *decided* approvals (which fall out of the hot index and cold-store with the spine), but the operator's working set — the inbox — stays small and the decision stays O(1). This is the Golden-Rule answer: approvals scale because the *queue* is bounded by human throughput and the *index* is partial, so the hot path never grows with the tenant base. If pending volume ever genuinely outpaces human decision capacity, that is a *staffing/policy* signal (widen `auto` on evidence, or add approvers), surfaced by the approval-latency metric — not a database scaling problem.

## Security

- **Approvals are the containment boundary for AI side-effects.** Every Ch.16 defence assumes that a consequential AI action cannot reach the world without crossing this gate; this chapter guarantees the gate exists, fails safe (no policy → human), and cannot be self-approved by the AI. The blast radius of a compromised or injected employee is bounded to *requests a human vetoes*.
- **What-you-approve-is-what-happens.** `projected_effect` is rendered from the *same* `payload` that executes; there is no separate "preview" the AI could diverge from the real action. An edit re-renders before granting. This closes the "approve a benign-looking summary, execute something else" attack.
- **No AI in the approver set, ever** — enforced by the catalogue (no AI holds `approval.decide`) and by the same-principal/distinctness guards for dual-control. Separation of duties is structural, not procedural.
- **`RLS:hq`, service-role only.** No JWT client reads or writes an approval; the inbox reaches operators solely via authorised broadcast (Ch.06/16). Payloads obey the no-PII-beyond-identifiers policy (Ch.03) — the `projected_effect` sentence names entities, not secrets.
- **Every decision is on the spine and in the audit.** `approval.requested/granted/rejected/edited/expired/escalated` (Ch.04) plus an immutable `admin_activity_log` row with `decided_by` (and both approvers for dual-control) — "who approved what, when, and why" is reconstructable for any point in history (Ch.15, the SOC2 path).
- **The policy dial is itself gated.** Widening autonomy (`approval.policy_admin`) is a senior, audited capability; an `auto` on a danger capability is refused; so the path that *reduces* oversight is as controlled as the actions oversight protects.

## Testing

- **Policy-routing tests.** A table of `(employee, capability, risk, amount)` → expected `decision`, asserting specificity ordering, the monetary-threshold branch (auto under, policy-decision over), and the **no-policy ⇒ require_human** fail-safe. The most important row: an unconfigured capability never returns `auto`.
- **CAS / race tests.** Two concurrent `decideApproval` calls on one row: exactly one succeeds, the other returns `already_decided`; the run resumes exactly once (asserted via the emitted `approval.granted` count = 1).
- **Dual-control tests.** One human cannot satisfy two decisions; a second *distinct* human is required; the same-principal second attempt returns `same_human`; **an AI principal can never decide** (asserted explicitly — the chapter's analogue of Ch.14's fail-closed test).
- **Projected-effect fidelity.** For each capability's renderer, a fixture payload → exact expected sentence (the byte-identical-oracle style from 007's token tests); and an edit re-renders to match the amended payload — so the human never approves a sentence the action contradicts.
- **Expiry tests.** A pending approval past `expires_at` lapses to `expired`, emits `approval.expired`, and the run resumes with **no** side-effect (a spy asserts the tool's `run()` was never called); a decision attempt on an already-lapsed row is treated as expired (lazy enforcement), never granted late.
- **Fail-safe / fail-closed tests.** A forced policy-resolution error yields `require_human`, never `auto`; an approval-service outage at request time prevents ACT, never permits an ungated side-effect.
- **Event-contract & RLS tests.** Each `approval.*` verb's payload shape pinned (Ch.04); `hq_approvals`/`hq_approval_policies` unreadable by anon/JWT, readable only by service-role (♻️ the existing pattern).

## Monitoring

- **Events emitted (Ch.04):** `approval.requested`, `approval.granted`, `approval.rejected`, `approval.edited`, `approval.expired`, `approval.escalated` — the only `approval.*` verbs, and the complete lifecycle of a decision from the spine alone.
- **Metrics (Ch.15):** **approval latency p50/p95** (request → decision — the headline operator-responsiveness signal), pending-queue depth (and oldest-pending age), **approval rate split auto vs human vs dual-control** (the autonomy mix — is the dial set right?), reject rate and edit rate (are the AI's proposals trusted?), expiry rate (decisions falling through the floor — a staffing or threshold problem), dual-control completion latency.
- **Golden signals:** a *rising pending depth or p95 latency* (the workforce is out-pacing human decision capacity — widen `auto` on evidence or add approvers), a *rising expiry rate* (consequential actions are silently lapsing — investigate thresholds), a *high reject rate for one employee* (a config/eval problem upstream in Ch.07/08), and — a `critical` alert — **any AI principal appearing as a decider** (should be impossible; if it ever happens, the containment failed). Each has an SLO; a non-zero "ungated side-effect" count would be a sev-1 (it must always be zero by construction).
- **Audit:** every decision in `admin_activity_log` with `decided_by` (both approvers for dual-control), the capability, the risk tier, the projected effect, and the reason — the human-oversight ledger that proves, for compliance, that consequential AI actions were authorised by named people (Ch.15).

## Future expansion

- **Learned autonomy — the dial, on evidence.** A measured trust score (evals + approval history, Ch.07/08) can *add or widen* `auto` policies for an employee — never silently, always as an audited `hq_approval_policies` change, and never for a `danger` capability. The table is the seam; the eval suite is the evidence; P4 holds throughout (autonomy granted, never assumed).
- **Escalation chains.** `approval.escalated` is reserved (Ch.04) for "the first approver punts to a more senior role / a manager human": a pending approval that an operator escalates re-targets its `approver_role` upward rather than deciding. The verb exists today; the routing graph (who escalates to whom) lands when human sub-roles do (Ch.14).
- **Approval bundling.** When a burst produces many near-identical low-risk approvals (e.g. a dunning wave), a future "approve all matching" affordance lets one human decide a *filtered set* in one action — still one CAS per row, still individually audited, but one operator gesture. The projection already groups by capability/employee; the bundling is a UI + a batched-decision service call.
- **Time-boxed standing approvals.** A human pre-authorising "auto-approve Finance AI refunds under £100 for the next 24h" is an `expires_at`-bounded `auto` policy — the existing policy row plus a TTL, a break-glass-in-reverse (temporarily *widening* autonomy with heightened audit), on the same foundation.
- **Per-role inbox slices.** The spine's `visibility` field (Ch.04) and Ch.14's per-role event visibility are the seam for "a billing operator sees only billing approvals" — the inbox projection filtered by the role's slice, additive when sub-admin roles arrive.
