# Chapter 05 — Services & APIs

## Purpose

This chapter specifies the **application layer** — the only code allowed to touch the system of record, run a mutation, talk to an external provider, or emit an event. It sits above the data model (Ch.03) and the event spine (Ch.04) and below the presentation plane (Ch.09/11) and the AI runtime (Ch.07).

CrewFlow already has a disciplined, half-formed version of this layer: 45 files under `server/services/*`, a sibling family of pure logic under `lib/hq/*`, one authorization gate (`server/auth/hq.ts`), one model adapter (`research-llm.ts`), one inbound webhook processor (`stripe-webhook-handler.ts`), one outbound email outbox (`lib/notifications/email.ts`), and nine cron drainers wired in `vercel.json`. The OS does not replace any of it. This chapter **names the patterns that already exist, standardises them as law, and defines the one new obligation** every mutation now carries: emit its canonical event in the same transaction (P1). Master Ch.03 + Ch.04 + this chapter and you can write any service in the system.

---

## Goals

- Define **the data-access pattern**: `server/services/*` are `import "server-only"`, use `createAdminClient()` (service-role, bypasses RLS), reach untyped HQ tables through the `q<T>()` shim, and delegate pure logic to `lib/hq/*`. ♻️ This already exists; here it becomes mandatory.
- Define the **three entry-point kinds** — React Server Components (read), Server Actions (mutation from UI), Route Handlers `app/api/*` (webhooks, cron) — and the gate each calls (`requireHqPage()` / `requireHq()` / `isCronAuthorised()`).
- Pin the **`emitEvent(tx, …)` producer contract** (Ch.04) into this layer and define the standard **"mutate + emit"** service shape that every state change obeys.
- Standardise **API contracts**: typed I/O, Zod validation at the boundary, a discriminated `Result` envelope, idempotency keys for side-effecting actions.
- Standardise **integration adapters** (the device drivers, Ch.02): Stripe inbound, the LLM provider, the email provider — each a single isolated module.
- Define the **Mission Control aggregator** as a service over precomputed read-models, generalising `hq-executive.ts`.
- Define **internal API stability**: how a service evolves without breaking its callers.

**Non-goals:** the event envelope/registry (Ch.04); table DDL (Ch.03); the real-time broadcast transport (Ch.06); the AI runtime FSM (Ch.07); the `authorize()` capability model (Ch.14). This chapter *consumes* those contracts; it does not define them.

---

## Architecture

### Two siblings: services (impure) and lib (pure)

The layer is split along the only line that matters for testing and reasoning — **does it touch the outside world?**

```
  app/  (RSC pages · Server Actions · Route Handlers)   ← the only callers
    │  every entry calls a gate first (requireHq* / isCronAuthorised)
    ▼
  server/services/*   "server-only"   ── the IMPURE shell
    │  • holds createAdminClient() (service-role)
    │  • does I/O: DB reads/writes, fetch(), provider SDKs
    │  • emits events (emitEvent) in the mutation's transaction
    │  • returns typed Result envelopes
    ▼ delegates every decision to ↓
  lib/hq/*   (and lib/sales/*, lib/research/*, lib/ai/*)  ── the PURE core
       • no imports of supabase, no fetch, no "server-only" needed
       • takes plain data in, returns plain data out
       • e.g. computeMetrics(), assembleExecutiveSections(), scoreCompany()
```

This is not aspirational — it is the current shape. `hq-executive.ts` (impure: `createAdminClient`, parallel queries) calls `assembleExecutiveSections` from `lib/hq/executive.ts` (pure: numbers in, card-set out) and `computeMetrics` from `lib/hq/metrics.ts`. `hq-research.ts` (impure orchestration) calls `scoreCompany` from `lib/research/score.ts` (pure). **The rule the OS makes binding:** *if a function makes a decision, it lives in `lib/*` and is unit-testable with no mocks; if a function causes an effect, it lives in `server/services/*` and is the only thing an integration test has to stand up.* A service that embeds a non-trivial calculation inline is a defect — extract it.

### The data-access pattern (THE standard, ♻️)

Every HQ service obtains the database exactly one way:

```ts
import "server-only";                                  // compile-time: never bundled to a browser
import { createAdminClient } from "@/lib/supabase/admin";
```

`createAdminClient()` returns a **service-role** client that **bypasses RLS** — this is correct and required, because every HQ table is `RLS:hq` (RLS on, zero policies, Ch.03): a JWT client reads *nothing*, and the service-role server is the only reader. The `"server-only"` directive is the enforcement that this client never reaches the browser bundle; importing such a module from a client component is a build error.

Many HQ tables are **not in the generated Supabase types** (`hq_sales_*`, `billing_*`, `hq_memories`, and every new `hq_*` table from Ch.03). The established workaround — used verbatim in `hq-executive.ts`, `hq-research.ts`, `hq-sales.ts`, `hq-memory.ts`, `stripe-webhook-handler.ts`, `notification-email-queue-stats.ts` — is a **minimal typed cast shim**, `q<T>()`:

```ts
// ♻️ server/services/hq-executive.ts (and siblings). One pattern, copied intentionally.
interface Q<T> extends PromiseLike<{ data: T[] | null; count: number | null; error: DbError }> {
  select(cols: string, opts?: { count?: "exact"|"planned"|"estimated"; head?: boolean }): Q<T>;
  eq(col: string, v: unknown): Q<T>;  gte(col: string, v: unknown): Q<T>;
  in(col: string, vs: ReadonlyArray<unknown>): Q<T>;  not(col: string, op: string, v: unknown): Q<T>;
  limit(n: number): Q<T>;
}
function q<T>(admin: AdminClient, table: string): Q<T> {
  return admin.from(table as never) as unknown as Q<T>;   // the cast, in ONE place per file
}
```

The shim is a **typing convenience, never duplicated business logic** (the comment `hq-research.ts` already carries). The OS keeps it and tightens one thing: 🔬 *should `q<T>()` be promoted from a per-file private to a single shared `lib/hq/db.ts` export, so the cast lives in exactly one place repo-wide (the 007 "one source" ethos applied to the shim itself)?* Recommended yes — but it is a CEO/lead call because it touches every service file (see Ch.20 open questions).

**Read discipline (load-bearing for the Golden Rule).** Every query is **bounded or `COUNT(head)`** — never an unbounded scan. `hq-executive.ts` reads small columns with `.limit(100_000)` and checks "how many enriched" with a separate head-COUNT so the heavy `jsonb` blob never crosses the wire; `hq-research.ts` caps every aggregate window (`.limit(200)`, `Math.min(limit, 50)`). This is the existing convention and it is **mandatory** for new services: a service that can issue a query whose result grows with company count is rejected at review.

### The OS addition: services are event producers

The one new responsibility this chapter introduces. Today a service mutates state and *separately* logs activity (`recordAdminActivity`) and *separately* fires a notification. The OS unifies the narrative: **every mutation service emits its canonical event (Ch.04) in the same transaction as the state change** (the transactional outbox, P1). The activity log and notifications become *consumers* of that event (projections, Ch.11/15), not parallel writes the author must remember. The service shape below makes this the path of least resistance.

---

## Database design

This chapter **owns no tables**; it is the code that touches the tables Ch.03 defines. It reads/writes, in order of frequency:

| Table (Ch.03) | This layer's role |
|---|---|
| `hq_events` | **Write** via `emitEvent()` inside mutation txns; never read directly here (projections read it, Ch.11/15). |
| `hq_metrics` / `hq_metric_definitions` | **Read** by the Mission Control aggregator; **written** by rollup cron services (Ch.15). |
| existing domain tables (`organizations`, `billing_invoices`, `hq_sales_*`, `hq_memories`, `ai_employee_*`) | the mutation surface — each owned by one service module. |
| `admin_activity_log` ♻️ | the audit projection; written today directly by `recordAdminActivity` (`hq-audit.ts`), tomorrow also derivable from the spine. |
| `notification_email_queue` ♻️ | the outbound email outbox the email adapter drains (below). |
| `ai_employee_runs` / `ai_employee_tool_calls` | written by the runtime services (Ch.07); the standard "mutate + emit" shape applies. |

**Access pattern, fixed:** service-role only, through `q<T>()`, bounded reads, mutation + event in one transaction. No service issues an unbounded `SELECT *`; no service writes an event outside the transaction of the state it describes.

---

## APIs

### The three entry-point kinds (and when to use each)

Every line of HQ code that the outside world can reach enters through exactly one of these. Choosing the wrong one is the most common architectural mistake; the rule is mechanical.

| Kind | File shape | Use it for | Gate (first line of the body) | Returns |
|---|---|---|---|---|
| **React Server Component** | `app/admin/**/page.tsx` (no `"use server"`/`"use client"`) | **Reading and rendering** a server snapshot. The default. | `await requireHqPage()` → `notFound()` for snoopers ♻️ | rendered RSC tree (HTML) |
| **Server Action** | `"use server"` fn in `app/admin/**/actions.ts` | **A mutation triggered by the operator** (form submit, button). | `await requireHq()` → `redirect("/dashboard")` ♻️ | a `Result` / form state; or `redirect()` |
| **Route Handler** | `app/api/**/route.ts` | **Non-human ingress**: provider webhooks, Vercel cron, machine callbacks. | webhook signature **or** `isCronAuthorised(request)` → 401 ♻️ | `NextResponse.json(...)` |

The two human gates are the *single existing chokepoint* (`server/auth/hq.ts`), and their difference is deliberate (Ch.14): **pages 404** to hide the HQ surface's existence; **actions redirect** as a POST bounce. Route handlers serve non-humans and so use a **secret/signature**, never the session gate — `research-drain` checks `isCronAuthorised` (Bearer `CRON_SECRET`); `stripe/route.ts` verifies the Stripe signature before handing the event to `processStripeEvent`.

**The decision tree:**
- Rendering data for a human to look at → **RSC**, `requireHqPage()`.
- A human is *changing* something → **Server Action**, `requireHq()`, audited, event-emitting.
- A *machine* (Stripe, cron, the AI runtime kicking a worker) initiates it → **Route Handler**, secret/signature-gated.
- The work is slow (>~10s) or must retry → the action/handler **enqueues a task and returns**; a **worker service** drained by cron does the work (the Research AI pattern: the action enqueues, redirects to a live page, the browser kicks the worker, and `research-drain` is the dead-worker safety net). Never block a request on an LLM call or a multi-step pipeline.

Concrete grounding (♻️ `app/admin/research/actions.ts`): `researchCompanyAction` calls `requireHq()`, validates the form, calls the `startResearch` service, stamps `recordAdminActivity`, and `redirect()`s — it does **not** run the 60s pipeline. That is the template every consequential action follows.

### The standard service shape — "mutate + emit"

Every mutation service is this shape. It is the single most-reused snippet in the OS; learn it once.

```ts
// illustrative — the canonical mutation service (server/services/<domain>.ts)
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitEvent } from "@/server/services/event-spine";   // the Ch.04 producer, lives in THIS layer
import { z } from "zod";

const SuspendInput = z.object({
  orgId: z.string().uuid(),
  reason: z.string().min(3).max(280),
  idempotencyKey: z.string().uuid().optional(),    // de-dupes a double-submit / retry
});
type SuspendInput = z.infer<typeof SuspendInput>;

export async function suspendOrg(
  raw: SuspendInput,
  actor: HqActor,                                   // ♻️ {id,email} from requireHq()
): Promise<Result<{ orgId: string }>> {
  const parsed = SuspendInput.safeParse(raw);
  if (!parsed.success) return err("invalid_input", parsed.error.flatten());
  const { orgId, reason, idempotencyKey } = parsed.data;

  const admin = createAdminClient();
  return withTx(admin, async (tx) => {                       // ONE transaction…
    if (idempotencyKey && await alreadyApplied(tx, idempotencyKey)) {
      return ok({ orgId });                                  // replay → no-op (P8)
    }
    const changed = await q(tx, "organizations")
      .update({ status: "suspended", suspended_reason: reason })
      .eq("id", orgId);                                        // …the STATE change…
    if (changed.error) throw new ServiceError("db_write", changed.error.message);

    await emitEvent(tx, {                                      // …and the EVENT, atomically (P1)
      actorType: "human", actorId: actor.id,
      verb: "org.suspended",                                  // typed against the Ch.04 registry
      objectType: "organization", objectId: orgId,
      correlationId: currentCorrelationId(),                  // propagated from the request edge
      severity: "warn",
      payload: { reason },                                    // identifiers + small metadata only (Ch.16)
    });
    return ok({ orgId });
  });
}
```

Five obligations, always in this order: **validate → open one transaction → guard idempotency → mutate state → emit the canonical event → return a `Result`.** Audit and notification are *not* written here — they are projections of `org.suspended` (Ch.11/15). The author writes one event; observability everywhere else is derived (the thesis: *exist once, observable everywhere*).

`emitEvent` is the Ch.04 producer, and it **lives in this layer** (`server/services/event-spine.ts`). `Verb` is a TypeScript union generated from the canonical registry, so an unregistered verb **fails compilation** — the "one source" rule enforced by the type checker, exactly as 007 enforced design tokens in ESLint.

### Result envelope & error model (the boundary contract)

Services return a **discriminated union**, never throw across the service boundary for *expected* outcomes. (They *do* throw inside a transaction to force a rollback, caught at the service edge.) The codebase already trends this way — `StartResearchResult`, `RunOutcome`, `ProcessResult` are all `{ ok: true; … } | { ok: false; … }`. The OS standardises one shape:

```ts
export type Result<T, E extends string = ErrorCode> =
  | { ok: true; data: T }
  | { ok: false; error: E; message?: string; details?: unknown };

export type ErrorCode =
  | "invalid_input" | "not_found" | "forbidden" | "conflict"
  | "rate_limited" | "dependency_unavailable" | "db_write" | "internal";

const ok  = <T>(data: T): Result<T> => ({ ok: true, data });
const err = (error: ErrorCode, message?: string, details?: unknown): Result<never> =>
  ({ ok: false, error, message, details });
```

Rules: (1) **validate at the boundary with Zod** — a service never trusts its caller's shape; the parsed type flows inward. (2) **Map errors to a stable `ErrorCode`** so callers (UI, other services, the AI runtime) branch on a closed set, not on a string match. (3) **Never leak provider internals** — a Stripe/LLM/DB error becomes `dependency_unavailable`/`db_write` with a logged (not returned) cause. (4) **The actor is an explicit parameter** (`HqActor` ♻️), never re-derived inside the service — the gate already proved identity; the service trusts and records it.

### Idempotency keys for side-effecting actions (P8)

Any action that causes an external or irreversible effect (charge, refund, email send, org suspend, AI tool execution) accepts an **`idempotencyKey`** (a client-minted UUID, or a natural key like a Stripe `event.id`). Before the effect, the service checks a dedupe record keyed by it inside the same transaction; a replay is a no-op that returns the original `Result`. This is not new — `stripe-webhook-handler.ts` already dedupes on `billing_events.event_id` (unique index → `23505` collision → `"duplicate"`), and `hq-research.ts`'s `claimTask` is a conditional `UPDATE … WHERE status='pending'` so a double-kick claims once. The OS generalises the practice into the standard shape so **every** side-effecting action is safe to retry.

### `emitEvent` — the producer contract (defined in Ch.04, hosted here)

```ts
// server/services/event-spine.ts — the ONLY way application code writes the spine
async function emitEvent(tx: Tx, e: {
  actorType: "human" | "ai_employee" | "system" | "tenant"; actorId?: string;
  verb: Verb;                                  // union generated from the Ch.04 registry
  objectType: string; objectId: string; targetType?: string; targetId?: string;
  correlationId: string; causationId?: number;
  severity?: "info" | "success" | "warn" | "critical"; payload?: Json;
}): Promise<{ id: number }>;
```

It takes a transaction handle, not a client — **the call site cannot accidentally emit outside the state transaction.** The `correlationId` is established once at the request edge (a webhook, an action, a cron tick) and propagated; for trigger-emitted events Postgres reads it from `current_setting('hq.correlation_id')` (Ch.04). Trigger-emitted events (AFTER triggers on key tables, ♻️ generalising `_record_activity()`/`notify_*`) cover table mutations automatically; `emitEvent` covers logic-level facts that no single row change captures.

---

## Integration adapters (the device drivers)

External dependencies are few (Ch.02) and each is **one isolated module** — the only code that knows the provider's wire format. Swapping a provider is a change to one file behind a stable internal signature.

### Stripe — inbound webhook ♻️

`app/api/webhooks/stripe/route.ts` (signature verification) → `server/services/stripe-webhook-handler.ts` (`processStripeEvent`). The route is thin; the handler is the side-effects layer, kept separate so tests hit it with synthetic events. Its contract is already exemplary and becomes the **reference inbound adapter**:

- **Idempotent ingress:** first action is `INSERT into billing_events (event_id …)`; a unique-index collision (`23505`) short-circuits to `{ status: "duplicate" }` and the route returns **200** (any non-200 makes Stripe retry).
- **Typed dispatch:** a `switch` over `event.type` to per-event handlers; unknown-but-known types are stored and marked `noop`; truly unhandled types are stored and skipped. **Forward-compatible** — a new Stripe event never crashes the endpoint.
- **Result envelope:** `{ status: "duplicate" } | { status: "skipped"; reason } | { status: "processed"; actions }`.
- **The OS upgrade:** where it today writes `billing_invoices`/`organizations` and calls `recordAdminActivity` + `emitNotifications`, it will **additionally `emitEvent(tx, 'invoice.payment_failed', …)`** in the same transaction (the dunning flow's ingress, Ch.02 §1). Audit + notification become consumers of that spine event; the handler's own logic is unchanged. Additive, never destructive (P2).

### LLM provider — the model adapter ♻️

`server/services/research-llm.ts` is the **only** place Research AI calls a model, and it is the template for the OS-wide adapter:

- **Anthropic primary → OpenAI fallback**, both via **dynamic import** (`await import("@anthropic-ai/sdk")` / `await import("openai")`) so the heavy SDK is loaded only when a key is present — keeping the dependency surface explicit (Ch.16 supply-chain).
- **Graceful degradation is a first-class return, not an error:** no key, timeout (`AbortSignal.timeout(22_000)`), or unparseable output → `return null`; the caller proceeds on deterministic evidence and stamps provenance `deterministic`. "Unknown is acceptable" applied to the model itself.
- **JSON re-validated** after the call (`parseAnalysis`/`parseSalesPrep`) — model output is **untrusted data**, never executed (Ch.16 prompt-injection rule).
- **The OS generalisation:** lift this into a provider-neutral `callModel({ system, user, schema, tier })` that adds (a) **model tiering** — haiku for routine, sonnet/opus for hard reasoning (Ch.17) — and (b) **token/cost accounting** written to `ai_employee_runs` (Ch.07, P9). The two-provider fallback, timeout, dynamic-import, and validate-on-return contracts are kept verbatim. `researchAiEnabled()`/`isAiConfigured()` stays the "is a provider present?" predicate the runtime branches on.

### Email — the outbound provider (corrected from prior framing)

**Grounding note:** `notification_email_queue` is **not** an undrained stub. `lib/notifications/email.ts` already implements `queueNotificationEmail` (insert `queued`), `sendNotificationEmail` (one row → Resend → `sent`/`failed`/`skipped`), and `drainNotificationEmailQueue` (batched cron entry), wired to **`/api/cron/notifications-drain` every 15 min** in `vercel.json`, with exponential-backoff retries (1m→5m→15m→1h→4h→24h, max 6) and `cleanupOldEmailRows` housekeeping. This is a **complete, working outbox** for *tenant notification* email, and it is the **reference outbound adapter**.

What the OS needs is therefore **not** a new sender but a **generalisation of this one drainer** so that an AI employee's `email.send` tool (Ch.07) enqueues into the *same* outbox and is delivered by the *same* drainer — one sender, forever (P1), no second email path:

- **Seam:** widen `notification_email_queue` (or a sibling `hq_outbound_email` view over it) to accept rows whose origin is an `ai_employee_run` + an approved `hq_approvals` id, not only a tenant `notification_id`. The drainer logic (`sendEmail` via Resend, backoff, skip-on-no-key) is reused unchanged.
- **The gate stays upstream:** an AI never enqueues outbound email until its `email.send` tool call has crossed `authorize()` + the approval policy (Ch.13/14); the outbox is a *delivery* mechanism, not a *decision* point.
- **On send, emit `email.sent`** (Ch.04) so the timeline, the org's feed, and the run's trace all reflect it (the dunning flow's act step, Ch.02 §8).

🔬 **Open question (Ch.20):** the existing queue is keyed to a tenant `org_id`/`notification_id`. Do we (a) extend that table additively with nullable `run_id`/`approval_id` columns, or (b) stand up a parallel `hq_outbound_email` table for AI-originated mail that shares the drainer? (a) honours "one source" more strictly; (b) keeps tenant and HQ mail physically separate for audit. Recommended (a). Needs a CEO/lead call because it touches a live tenant table.

---

## The Mission Control aggregator

Today `server/services/hq-executive.ts` (`getExecutiveDashboard()` / `gatherExecutiveInput()`) gathers every Command Centre figure in **one parallel batch** of bounded/COUNT queries and hands the raw numbers to the pure `assembleExecutiveSections` (`lib/hq/executive.ts`). It is excellent — *and it scans on every request*. The OS generalises it into a **`mission-control` service** that reads **precomputed read-models** instead of re-aggregating live:

```ts
// server/services/mission-control.ts — the OS homepage aggregator (generalises hq-executive.ts)
export async function getMissionControl(): Promise<MissionControlSnapshot> {
  const admin = createAdminClient();
  const [vitals, workforce, pulse, approvals, alerts] = await Promise.all([
    readMetrics(admin, ["mrr","arr","active_orgs","trials","churn_rate","conversion_rate"]), // hq_metrics rollups — O(1)
    readWorkforceTiles(admin),         // ai_employee_runs latest per employee + deriveHealth() ♻️
    readRecentEvents(admin, 50),       // a bounded recent slice of the spine (Ch.11)
    readPendingApprovals(admin, 20),   // hq_approvals WHERE status='pending' (Ch.13)
    readOpenAlerts(admin),             // ♻️ hq-alerts / hq-health
  ]);
  return assembleMissionControl({ vitals, workforce, pulse, approvals, alerts }); // pure (lib/hq/*)
}
```

The shift is from **request-time aggregation** to **read-model reads**: `readMetrics` selects a handful of rows from `hq_metrics` (refreshed by rollup cron + invalidated by events, Ch.15), not a scan of `organizations`/`hq_sales_companies`. The **service shape is preserved** — parallel batch in, pure assembler out, `generatedAt` stamp — so the call site and the streaming-skeleton UI (`command-centre/page.tsx`) carry over. The page renders this snapshot server-side, then a client island subscribes for live deltas (Ch.06). First paint is a cheap O(1) read; liveness is a subscription.

The existing `getExecutiveDashboard()` stays working during the transition (P2); `getMissionControl()` is added beside it behind a flag and becomes the homepage when the read-models are populated and verified.

---

## UI behaviour

This is a services chapter; UI specifics belong to Ch.09/11. The layer's *obligations to the UI*:

- **States are first-class in the return type.** A service distinguishes *loading* (the page's `Suspense` boundary, not the service's concern), *empty* (`ok` with an empty array — Research AI's "honest zeros" / Foundation baseline, never a fabricated number), and *error* (`{ ok: false, error }` the UI maps to a message). Mission Control renders Foundation baselines, not blanks, when an employee has never run.
- **Mutations return enough to update optimistically.** A Server Action returns the changed entity's id/new-status so the island can patch in place before the realtime delta arrives, then reconcile.
- **No service renders.** Services return data; components render. A service that builds HTML or a class string is a layering violation.
- **Every number is a doorway.** Aggregator outputs carry the ids needed to deep-link (click MRR → the events that moved it), so the UI can pivot without a second round-trip.

---

## Permissions

- **Two human gates, one chokepoint** (Ch.14): RSC pages call `requireHqPage()` (404 on fail); Server Actions call `requireHq()` (redirect on fail). Both are `server/auth/hq.ts` ♻️ — the *only* implementation, replacing the ~15 byte-identical `requireAdmin()` clones the directive forbids.
- **Defence in depth:** actions re-assert the gate even though the `/admin` layout already gates the route (♻️ the research actions do this) — a stolen action URL still hits the wall.
- **Route handlers use secrets, not sessions:** `isCronAuthorised(request)` (Bearer `CRON_SECRET`) for cron; Stripe signature for the webhook. No human session exists for these callers.
- **The evolution seam (Ch.14):** `requireHq()` returns `HqActor`; the OS adds `authorize(actor, capability, resource)` as the *single* place a fine-grained capability is checked, called by both human actions and the AI execution gate (Ch.07 step 3). Until then, a super-admin implicitly holds all capabilities (back-compatible). Services receive the `actor` and pass it to `authorize()`; they never invent their own permission logic.
- **AI callers:** when a service is invoked by the AI runtime rather than a human, `actorType` is `ai_employee` and the call must already have passed the tool gate. Services do not distinguish caller identity beyond stamping it on the event — the gate upstream is authoritative.

---

## Failure handling

| Dependency fails | Behaviour | Mechanism |
|---|---|---|
| **Postgres write** (mutation) | whole txn rolls back — **state and event both absent**, never half (P1) | single transaction; throw-inside, catch-at-edge → `{ ok:false, error:"db_write" }` |
| **Postgres read** (aggregator) | degrade that tile to 0 / last-known, never crash the page | ♻️ `runCount` returns 0 on error; aggregator composes partial results |
| **LLM provider** | fall back Anthropic→OpenAI; then `null` → deterministic path | ♻️ `research-llm.ts` try/catch per provider + `AbortSignal.timeout` |
| **Email provider (Resend)** | row → `failed`, retried with backoff; no key → `skipped`; never throws | ♻️ `sendNotificationEmail` absorbs every failure into the row |
| **Stripe duplicate / replay** | ack 200, no double effect | ♻️ unique `event_id` → `23505` → `"duplicate"` |
| **Slow work / dead worker** | task left claimable; cron re-runs it | ♻️ `STUCK_RUNNING_MS` re-queue + `research-drain` safety net |
| **A consumer poisons on one event** | dead-letter that event, advance offset, raise `system.alert_raised` | Ch.04 dead-events table; one bad event never blocks the stream |

The invariant across all of them: **an effect is either fully recorded on the spine or it did not happen.** Retries are safe because every side-effecting path is idempotent (P8). Degradation is graceful because reads compose partial results and the spine/read-models are unaffected when an integration is down (Ch.02 system-level failure handling).

---

## Edge cases

- **Action runs longer than the function budget.** Vercel serverless caps duration. Rule: any action that *might* exceed ~10s **enqueues and returns**; the worker (cron-drained) does the work. The research action redirecting instead of blocking on a 60s pipeline is the canon (♻️).
- **Double-submit / network retry of a mutation.** The `idempotencyKey` makes the second apply a no-op returning the first `Result`. Without a key, natural-key dedupe (unique index) is the fallback (♻️ Stripe).
- **Caller passes a malformed shape.** Zod `safeParse` at the boundary → `{ ok:false, error:"invalid_input", details }`; the service never proceeds on unvalidated data.
- **Event emitted but no consumer exists yet** (new verb before its projection ships). Harmless — the event is stored and read later; consumers ignore verbs they don't handle (Ch.04 forward-compat). Additive (P2).
- **Aggregator reads a stale read-model.** Acceptable by design — `hq_metrics` is eventually-exact (event counters + reconciling rollups, Ch.15); the snapshot carries `generatedAt` so the UI can show freshness.
- **`.env.local` is empty on this machine** (a known operational fact, Ch.02). Services that branch on a key (`researchAiEnabled`, `env.RESEND_API_KEY`) take the degraded path locally; full verification is in CI/Vercel preview. Tests must not assume a provider is configured.
- **`object_id` is `text` across types** (Ch.03). Services pass ids as strings into `emitEvent`; integrity is enforced at the producer (the service knows the type), not by a polymorphic FK.

---

## Performance

- **Budgets.** RSC page TTFB target < 300ms p95 (server snapshot of read-models); a Server Action mutation < 200ms p95 (one txn: state write + one indexed event insert); a route-handler webhook < 500ms (the Stripe insert + dispatch). The spine insert is a single indexed append on an already-open transaction — **negligible** overhead on the mutation it accompanies (Ch.03/04).
- **Bounded everything.** Every read is `limit`/`COUNT(head)`/covering-index (♻️ the existing convention). The aggregator reads a *fixed* number of `hq_metrics` rows + a bounded recent-events slice, regardless of company count.
- **Parallel batch, pure assemble.** Aggregators issue independent reads with `Promise.all` and hand off to a pure function (♻️ `gatherExecutiveInput` + `assembleExecutiveSections`) — the pure half is free and trivially tested.
- **Heavy work off the request path.** Aggregation moves into rollup cron (Ch.15); LLM calls and multi-step pipelines move into cron-drained workers. A request never waits on either.
- **The Golden Rule — at 1M companies.** The old `getExecutiveDashboard()` reads small company columns with `.limit(100_000)` — fine at 100k, a liability at 1M. The `mission-control` service answers the rule by **reading precomputed `hq_metrics` rollups (a handful of rows) and a bounded recent-events slice — O(1) in company count** — and subscribing for deltas whose cost scales with *active operators*, not data volume. The expensive aggregation is amortised in background rollups over partitioned storage. **This is the architecture *because of* the Golden Rule, not despite it:** the homepage of a million-company OS still reads a fistful of rows and a bounded stream. Any new service that cannot state its bound at 1M companies does not ship.

---

## Security

- **Trust boundary by construction (Ch.16):** `import "server-only"` + service-role client means HQ data and the service-role key **never reach a browser bundle**; importing a service from a client component is a build error. JWT clients read zero HQ rows (RLS-on/zero-policy, Ch.03).
- **Tenant isolation absolute:** the OS reads tenant data *only* through this audited service-role aggregator; no HQ surface, event, or search result is reachable by a customer's JWT. The boundary is existing and load-bearing — this chapter does not move it.
- **Validate at the boundary; never trust the caller's shape:** Zod parse on every entry; the parsed type flows inward. External text (tenant content, tool-fetched pages, model output) is **untrusted data, never instructions** (Ch.16) — model JSON is re-validated, never `eval`'d (♻️ `research-llm.ts`).
- **Secrets are env-only** (`lib/env.ts`, Zod-validated) and read server-side; provider SDKs are dynamically imported so keys gate the import (♻️). Per-tool credential scoping (Ch.16) means an adapter holds only the key it needs.
- **No PII in event payloads beyond identifiers** (Ch.04/16) — services put ids + small metadata on the spine; sensitive detail stays in the domain table, fetched under service-role only when rendering. A lint check on `emitEvent` payload shapes enforces it.
- **Effects only through gated tools:** AI-originated side-effects reach a service only after `authorize()` + approval (Ch.13/14); the service stamps the actor on the event for the audit trail (the OS *increases* security posture — more is permissioned, audited, contained).

---

## Testing

The pure/impure split (above) is what makes the layer testable; the strategy follows it (Ch.18).

- **Unit (the bulk):** `lib/*` pure functions — `computeMetrics`, `assembleExecutiveSections`, `scoreCompany`, the `Result`/error mappers — tested with plain data, **no mocks**. Fast, deterministic, the majority of coverage.
- **Service integration:** `server/services/*` against a real test Postgres. Assert the **"mutate + emit" invariant**: after `suspendOrg`, the org row changed **and** exactly one `org.suspended` event exists with the right `correlation_id` — and on a forced DB error, **neither** exists (the rollback test). Assert idempotency: calling twice with one key produces one effect and one event.
- **Adapter tests with the provider stubbed deterministically:** the Stripe handler against synthetic events (♻️ the module is split from the route precisely for this) — duplicate, unhandled, and each handled type; the LLM adapter forced to no-key/timeout/garbage to prove the deterministic fallback (♻️ Research AI already models on this).
- **Contract tests (Ch.04):** every emitted verb has a fixture pinning its `payload` shape; a producer that drifts fails CI. The `Verb` union failing to compile on an unregistered verb is itself a test.
- **Route-handler auth tests:** unauthenticated/non-allowlisted → 404 (page) / redirect (action) / 401 (cron); a missing `CRON_SECRET` or bad Stripe signature is rejected before any effect.
- **CI gates:** the validation triplet (`tsc` / lint / tests) + the Vercel build, exactly as 007. Because `.env.local` is empty locally, tests must run the degraded path, not assume providers.

---

## Monitoring

- **Events emitted (Ch.04):** every mutation service emits its domain verb (`org.suspended`, `invoice.payment_failed`, `email.sent`, `ai.tool_called`); these *are* the audit and the trace. Route handlers emit `system.webhook_received` / `system.cron_ran` / `system.cron_failed`.
- **Golden signals (Ch.15):** action latency p95 & error-rate (by `ErrorCode`); webhook processing latency & duplicate-rate; **drainer health** per cron (♻️ `withCronTelemetry` → `cron_runs`); LLM call latency, fallback-rate, and **token/$ per run** (P9); email queue depth, send-rate, and `permanent_failures` (♻️ `getEmailQueueStats`).
- **Tracing falls out for free:** one `correlation_id` from the request edge through every emitted event makes the whole chain (action → mutation → event → projection → side-effect) a single trace, reconstructable in the observability surface (Ch.15) with no per-call instrumentation.
- **SLOs:** webhook endpoint ≥ 99.9% 2xx (a non-2xx triggers Stripe retries); action success-rate (excluding `invalid_input`) ≥ 99.5%; aggregator p95 within budget. Rising **consumer lag** (Ch.04) is the canary that a projection feeding the homepage is falling behind before an operator notices.

---

## Versioning & stability of internal APIs

These are *internal* APIs — one repository, no external consumers — so we do not version with URLs or headers. Stability is enforced by **types and additive evolution**:

- **The signature is the contract.** A service's exported function signature + its `Result` type is what callers depend on. `tsc` is the gate: a breaking change to a signature fails the build at every call site, surfacing the blast radius immediately (the same mechanism that flushed out the 15 `requireAdmin()` clones).
- **Evolve additively (P2).** Add **optional** parameters and **new** `Result` variants; never repurpose an existing field or silently change a return shape. New `ErrorCode` values are additive (callers have a `default` branch). A genuinely incompatible change is a **new function** beside the old, callers migrated, the old one removed only when unreferenced — exactly how `getMissionControl()` is added beside `getExecutiveDashboard()`.
- **Verbs and capabilities are the highest-stakes contracts.** A `verb` (Ch.04) or `capability` (Ch.14) name is a forever-stable string; renaming one is a migration with an ADR (Ch.20), not a refactor. The generated `Verb` union means a producer cannot emit an unregistered verb and a consumer cannot be silently desynced.
- **Adapters hide provider versions.** The Stripe/LLM/email modules absorb provider SDK upgrades behind their internal signature; a provider version bump is a one-file change with its own adapter tests, never a ripple through services.
- **Deprecation is observable.** A superseded service path logs a `system.flag_changed`/deprecation event when hit, so we can confirm zero traffic before deletion. One source, forever — applied to the functions, not just the data.

---

## Future expansion

The layer is designed so the next decade is *more services at the existing seams*, not a reshaping:

- **A new domain** adds a `server/services/<domain>.ts` (impure shell), a `lib/<domain>/*` (pure core), its verbs in the Ch.04 registry, and a projection — touching no other service. The "mutate + emit" shape and the gate are inherited.
- **A new integration** adds one adapter module behind a stable internal signature; the dynamic-import + degrade-gracefully + validate-on-return contract is copied from the LLM/Stripe references.
- **Graduating a subsystem** (broker, search engine, vector store, `pgmq`) swaps the implementation *behind* an existing service abstraction (`emitEvent`, `searchHq`, the queue) without touching call sites (P6, Ch.17) — the service boundary is the swap point.
- **Promoting `q<T>()` to a shared `lib/hq/db.ts`** (the open question above) and generating typed table accessors as the Supabase types catch up would let the cast shim shrink toward zero — a cleanup the seam already anticipates.
- **The `authorize()` chokepoint** (Ch.14) slots into the gate the services already call, turning binary super-admin into fine-grained capability without a second auth path — the foundation is laid here, the capability model arrives there.
