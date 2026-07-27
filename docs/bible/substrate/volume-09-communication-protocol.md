# Volume IX — AI Communication Protocol

> **Substrate Block, document 1 of 5.** Architecture only. Read
> `./README.md` first — this volume references the shared primitives
> (P1 envelope, P2 correlation model, P3 output envelope, P4 autonomy test,
> P5 service-role doctrine, P6 conventions) defined there and does not redefine
> them.
>
> *Provisional numbering "IX" per the CEO directive; collides with the existing
> Engineering Standards volume. Tracked in the canonical renumber (README §
> "A note on volume numbering").*

---

## 1. Purpose & scope

**The job, in one sentence:** let one AI employee *address* another, *ask* it to
do something, *hand over the context* it needs, and *get an answer or an
escalation back* — reliably, in order, fully audited, and with a guaranteed exit
when the other side never answers.

Today CrewFlow's two executing employees (Research AI, Lead Qualification AI)
**cannot talk to each other.** Lead Qualification reads a fit score that
Research AI persisted — a *shared-table handshake*, not a conversation. That is
fine for two employees pinned in a fixed pipeline; it does not scale to a
*workforce* where a CEO AI delegates to a CTO AI who consults a Security AI who
asks a Research AI for a fact. The Communication Protocol is the addressed,
lifecycle-managed, escalating message layer that makes "delegate, consult, hand
off, report back" a first-class, reusable operation.

**In scope:** message schema; conversation/thread lifecycle; addressing &
routing (direct, by-role, by-capability, broadcast); context passing by
reference; delivery guarantees; retry; timeout & failure handling; the
escalation ladder; the SQL + SDK interface; observability.

**Explicitly out of scope (owned elsewhere):** the transport itself — messages
*ride on the Event Bus* (XI); the context payloads — they live in Shared Memory
(X) and are passed by reference; the work a message asks for — that becomes a
Task (XII); who is *allowed* to send/receive and as whom — the SDK's identity &
permission model (XIII). This volume specifies the **protocol**, not those
substrates.

---

## 2. Where it sits

```
   CEO AI ──"research this company"──▶  Research AI
     │  (a request message)                 │
     │                                      │ produces a P3 output envelope,
     │  ◀──"here's the report (ref)"────────┘ persists it to Memory (X),
     │     (a response message,               replies with a context-ref
     │      context passed by REFERENCE)
     ▼
   continues its own task (XII)

   every send/deliver/ack/handle/escalate  ──emits──▶  hq_events (XI)
   every context handoff                    ──ref────▶  hq_memories (X)
   an unanswered request                     ──opens──▶  approval/role task (XII)
```

- **Depends on:** Event Bus (XI) for delivery and audit; Shared Memory (X) for
  context-by-reference; Task Engine (XII) for escalation-to-task and for the
  work a message requests; AI SDK (XIII) for identity, addressing permissions,
  and the capability registry that powers by-capability routing.
- **Depended on by:** every multi-employee workflow; the AI Boardroom
  orchestration layer (which *consumes* this protocol, per the directive, rather
  than implementing its own messaging).

---

## 3. Built vs. to-build

| Capability | State | Note |
|------------|-------|------|
| Append-only audit of every message event | **Built** | `hq_events` + `hq_emit_event`; messaging emits `ai.message.*` verbs. |
| At-least-once delivery + idempotent handling machinery | **Built (reuse)** | The spine drainer/offset/retry/DLQ pattern (`hq_drain_consumer`) is the exact delivery engine; the message router is a *consumer* of `ai.message.sent`. |
| Correlation/causation propagation | **Built (reuse)** | `correlation_id`/`causation_id` are first-class on `hq_events` already (P2). |
| Directed message store (`hq_ai_messages`) | **To build** | New table — the outbox/inbox of record. |
| Thread/conversation lifecycle | **To build** | New table `hq_ai_threads` (or thread state derived). |
| By-capability routing | **To build** | Queries the capability registry `hq_ai_capabilities` (XIII). |
| Escalation ladder | **To build** | New logic; terminal rungs open Tasks (XII). |
| SDK comms surface (`comms.*`) | **To build** | Part of the AI SDK (XIII). |

**Net:** the *transport, ordering, retry, DLQ and audit are already shipped* in
the Event Spine. This volume adds the **addressed message record**, the
**conversation lifecycle**, and the **escalation policy** on top of that engine.

---

## 4. Conceptual model — events vs. messages

The substrate has two complementary primitives. Keeping them distinct is the
single most important idea in this volume.

| | **Event** (XI) | **Message** (IX) |
|--|----------------|------------------|
| Tense | Past: *"a thing happened"* | Imperative/interrogative: *"please do / here is / did you?"* |
| Audience | Broadcast; anyone may consume | **Addressed** to a recipient (or role/capability/broadcast) |
| Expectation | None — fact of record | Often expects **handling** and sometimes a **response** |
| Lifecycle | Immutable point | Has **states** (pending→delivered→…→handled) |
| Storage | `hq_events` (append-only) | `hq_ai_messages` (a row with a mutable status) |
| Ordering | The global `id` total order | Per-thread causal order |

**They are layered, not parallel.** A message is *persisted* in `hq_ai_messages`
and *announced* by an event (`ai.message.sent`) emitted in the **same
transaction** (the transactional-outbox rule, P1). The Event Bus then *delivers*
the message by routing that event to the recipient. So: **messages are the
contract; events are the wire.** Every message therefore inherits the bus's
at-least-once delivery, idempotency, retry, DLQ, replay and audit for free.

---

## 5. Data model

### 5.1 `hq_ai_threads` — the conversation

A thread is one coherent exchange about one subject, possibly spanning many
employees. It is the unit a human reviews ("show me the conversation that led to
this decision") and the unit the escalation ladder acts on.

```sql
create table if not exists public.hq_ai_threads (
  id              uuid primary key default gen_random_uuid(),

  -- The saga this conversation belongs to (P2). Many threads can share one
  -- correlation_id (a big workflow); a thread never spans two sagas.
  correlation_id  uuid not null,

  subject         text not null check (char_length(subject) between 1 and 300),
  -- What the conversation is about, by reference (P-context, §7). Optional —
  -- a thread may be about a company, a task, a memory, or nothing concrete.
  subject_kind    text check (subject_kind in
                    ('company','task','memory','event','employee','none')),
  subject_id      text,

  -- Who opened it (an employee slug or a human actor id) + their type.
  opener_type     text not null check (opener_type in ('ai_employee','human','system')),
  opener_id       text not null,

  state           text not null default 'open'
                  check (state in (
                    'open',              -- live; messages may flow
                    'awaiting_response', -- a request is outstanding
                    'resolved',          -- answered/closed cleanly
                    'escalated',         -- handed to a manager/human (see ladder)
                    'abandoned',         -- expired with no resolution
                    'failed'             -- undeliverable / poisoned
                  )),
  priority        text not null default 'normal'
                  check (priority in ('low','normal','high','urgent')),

  -- Lifecycle timing for SLA + expiry.
  last_message_at timestamptz,
  expires_at      timestamptz,          -- abandon if still open past this
  resolved_at     timestamptz,

  message_count   integer not null default 0,

  metadata        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.hq_ai_threads enable row level security; -- RLS:hq (P5/P6)

create index if not exists hq_ai_threads_corr_idx   on public.hq_ai_threads (correlation_id);
create index if not exists hq_ai_threads_state_idx  on public.hq_ai_threads (state, priority, last_message_at desc);
create index if not exists hq_ai_threads_subject_idx on public.hq_ai_threads (subject_kind, subject_id)
  where subject_id is not null;
-- The SLA sweep reads exactly this: open/awaiting threads past their deadline.
create index if not exists hq_ai_threads_expiry_idx on public.hq_ai_threads (expires_at)
  where state in ('open','awaiting_response');
```

### 5.2 `hq_ai_messages` — the directed message (the outbox/inbox of record)

```sql
create table if not exists public.hq_ai_messages (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid not null references public.hq_ai_threads(id) on delete cascade,

  -- Trace (P2). correlation_id is denormalised from the thread for direct
  -- WHERE-by-saga reads; causation_id is the hq_events.id that triggered this
  -- send (the event/task/message that caused it).
  correlation_id  uuid   not null,
  causation_id    bigint,

  -- Addressing (§6). sender is always a concrete live actor; recipient may be a
  -- concrete employee, a role/department, a capability slug, or 'broadcast'.
  sender_type     text not null default 'ai_employee'
                  check (sender_type in ('ai_employee','human','system')),
  sender_id       text not null,                 -- an employee slug / user id
  recipient_mode  text not null default 'direct'
                  check (recipient_mode in ('direct','role','capability','broadcast')),
  recipient_id    text,                          -- slug / role / capability; null for broadcast

  -- After routing resolves a non-direct recipient to a concrete employee, the
  -- delivered copy stamps the chosen employee here (see §6.3 fan-out).
  resolved_recipient_id text,

  kind            text not null
                  check (kind in (
                    'request',     -- please do X (may or may not expect a response)
                    'response',    -- here is the answer to your request
                    'inform',      -- FYI; no handling required
                    'ack',         -- I received/accepted your request
                    'error',       -- I could not handle it (carries reason)
                    'escalation'   -- I am escalating this (see ladder)
                  )),

  -- A verb slug naming WHAT is asked/told (e.g. 'research.company',
  -- 'qualify.lead', 'review.security'). Routed against the capability registry
  -- for recipient_mode='capability'. Validated by the SDK's intent registry.
  intent          text check (intent is null or intent ~ '^[a-z0-9_.]{1,80}$'),
  subject         text check (subject is null or char_length(subject) <= 300),

  -- The body is a P3 AI-output envelope (for a 'response') OR a request spec.
  -- Large content is NEVER inlined — see context_refs (§7). body holds the
  -- small, structured ask/answer; context_refs point at the heavy data.
  body            jsonb not null default '{}'::jsonb,

  -- Context passed BY REFERENCE (§7) — pointers into Memory (X)/Tasks/Events.
  context_refs    jsonb not null default '[]'::jsonb,

  -- Threading.
  in_reply_to     uuid references public.hq_ai_messages(id) on delete set null,
  requires_response boolean not null default false,

  status          text not null default 'pending'
                  check (status in (
                    'pending',      -- written, not yet delivered
                    'delivered',    -- routed to recipient's inbox
                    'acknowledged', -- recipient accepted it
                    'handled',      -- recipient finished handling it
                    'responded',    -- a response message was sent back
                    'failed',       -- undeliverable after retries (DLQ)
                    'expired'       -- deadline passed with no handling
                  )),
  priority        text not null default 'normal'
                  check (priority in ('low','normal','high','urgent')),

  -- Deadlines drive the escalation ladder (§8). Two distinct SLAs:
  ack_deadline    timestamptz,     -- by when the recipient must ACK
  handle_deadline timestamptz,     -- by when handling must complete

  delivered_at      timestamptz,
  acknowledged_at   timestamptz,
  handled_at        timestamptz,

  -- Delivery bookkeeping (the router increments; mirrors the spine's retries).
  attempts        integer not null default 0,
  last_error      text,

  created_at      timestamptz not null default now()
);
alter table public.hq_ai_messages enable row level security; -- RLS:hq

-- The recipient's inbox read: what's addressed to me and still actionable.
create index if not exists hq_ai_messages_inbox_idx
  on public.hq_ai_messages (resolved_recipient_id, status, priority, created_at)
  where status in ('delivered','acknowledged');
create index if not exists hq_ai_messages_thread_idx  on public.hq_ai_messages (thread_id, created_at);
create index if not exists hq_ai_messages_corr_idx    on public.hq_ai_messages (correlation_id);
create index if not exists hq_ai_messages_reply_idx   on public.hq_ai_messages (in_reply_to) where in_reply_to is not null;
-- The SLA sweep: outstanding messages past a deadline.
create index if not exists hq_ai_messages_ack_sla_idx
  on public.hq_ai_messages (ack_deadline)
  where status = 'delivered' and ack_deadline is not null;
create index if not exists hq_ai_messages_handle_sla_idx
  on public.hq_ai_messages (handle_deadline)
  where status in ('delivered','acknowledged') and handle_deadline is not null;
-- Idempotent fan-out + dedupe: one delivered row per (message, resolved recipient).
create unique index if not exists hq_ai_messages_delivery_uq
  on public.hq_ai_messages (in_reply_to, resolved_recipient_id)
  where in_reply_to is not null and resolved_recipient_id is not null;
```

### 5.3 The verbs this volume adds to the Event Bus

These are `hq_events.verb` values the protocol emits (registered in the verb
catalogue, XI §Event schema):

| Verb | When | Severity |
|------|------|----------|
| `ai.thread.opened` | a new conversation starts | info |
| `ai.message.sent` | a message row is written (the **delivery trigger**) | info |
| `ai.message.delivered` | router placed it in a recipient inbox | info |
| `ai.message.acknowledged` | recipient accepted | info |
| `ai.message.handled` | recipient finished | success |
| `ai.message.responded` | a response was sent | success |
| `ai.message.retried` | a delivery attempt failed, will retry | warn |
| `ai.message.failed` | undeliverable after N attempts (DLQ) | critical |
| `ai.message.expired` | deadline passed, escalating | warn |
| `ai.thread.escalated` | escalation ladder fired | warn |
| `ai.thread.resolved` | conversation closed cleanly | success |
| `ai.thread.abandoned` | expired with no resolution | warn |

---

## 6. Addressing & routing

A sender names a recipient in one of four **modes**. Routing resolves the mode
to one or more concrete, *live* employees, then delivers a copy to each.

### 6.1 The four modes

1. **`direct`** — `recipient_id` is an employee **slug** (e.g. `research-ai`).
   Resolve to that employee if it exists and is not `disabled`/`error`.
2. **`role`** — `recipient_id` is a department or role (e.g. `engineering`,
   `executive`). Resolve to the employee(s) holding that role; if several, pick
   by the load policy (§6.4) unless `kind='inform'`/broadcast intent.
3. **`capability`** — `recipient_id` is an **intent/capability slug** (e.g.
   `research.company`). Ask the **capability registry** (`hq_ai_capabilities`,
   XIII): *who can handle this intent?* Resolve to the best-scoring capable
   employee (§6.4). This is how a sender says *"whoever can do this"* without
   knowing the org chart — the key to a growing workforce.
4. **`broadcast`** — every live employee whose subscription matches the intent.
   Used for `inform` (announcements), never for `request` that needs one answer.

### 6.2 Resolution order & failure

Routing is itself an idempotent consumer step (it runs when `ai.message.sent` is
drained). Resolution:

```
resolve(message):
  candidates =
    direct      → [employee(slug=recipient_id)]
    role        → employees(department=recipient_id, status≠disabled)
    capability  → registry.lookup(intent=recipient_id)  -- capable + enabled
    broadcast   → employees(subscribed_to(intent), status≠disabled)
  candidates = filter(candidates, live ∧ within_send_permission(sender))
  if candidates is empty:
     → emit ai.message.retried (warn); after N empty resolutions →
       ai.message.failed (DLQ) and escalate the thread (§8). A request that
       nobody can handle is a first-class, surfaced condition — never a silent drop.
  if kind ∈ {request,ack,response,error} and |candidates|>1 and not broadcast:
     pick one by the load policy (§6.4); record resolved_recipient_id.
  else (broadcast/inform):
     fan out one delivered copy per candidate (the delivery_uq index keeps it idempotent).
```

### 6.3 Fan-out is idempotent

For broadcast/role-to-many, the router writes one **delivered child copy** per
recipient (same `in_reply_to`/origin, distinct `resolved_recipient_id`), guarded
by `hq_ai_messages_delivery_uq`. A redelivery (the bus is at-least-once) hits the
unique index and no-ops — *effectively-once* fan-out, the spine's exact doctrine.

### 6.4 The load policy (which capable employee)

When several employees can handle an intent, pick deterministically:
`score = capability_confidence (registry) − current_load (live task count) −
recent_failure_penalty`, tie-broken by employee `sort_order`. Load and failure
counts come from the Task Engine metrics (XII) and `ai_employee_task_metrics`.
The policy is pluggable; the default keeps work off overloaded/erroring employees.

---

## 7. Context passing — by reference, never by value

**Rule:** a message **never inlines heavy context.** A request to "qualify this
lead" does not embed the 8 KB research report; it carries a *pointer*. This is
the single discipline that keeps messages small, the bus fast, memory the one
source of truth, and permissions enforceable at *read* time.

`context_refs` is an array of typed references:

```jsonc
[
  { "kind": "memory",  "id": "uuid", "note": "research report v3" },
  { "kind": "task",    "id": "uuid" },
  { "kind": "event",   "id": 12345 },
  { "kind": "company", "id": "uuid" }
]
```

The recipient resolves references **through the SDK** (XIII), which calls the
Memory read API (X) — so the recipient only ever sees context **it is permitted
to see** (P5; X's permission matrix). A reference the recipient cannot read
resolves to a permission error the recipient must handle (typically by replying
`kind='error'` or escalating), *not* a silent empty.

Why by-reference matters across the substrate:

- **One source of truth** — the report lives once, in `hq_memories`; the message
  points at it. No divergent copies (Directive 003).
- **Permission at read** — visibility is enforced when the recipient *reads*,
  not gambled at send time.
- **Replay-safe** — replaying `ai.message.sent` re-delivers a pointer; the
  pointed-at memory is itself immutable/versioned (X), so replay is deterministic.
- **Cheap bus** — events stay tiny; the spine's throughput budget is unaffected.

---

## 8. Conversation lifecycle, failure & the escalation ladder

### 8.1 Message state machine

```
        send()                 router               recipient.ack()
 (pending) ───emit ai.message.sent──▶ (delivered) ─────────────▶ (acknowledged)
     │                                   │                              │
     │  router: no candidate / error     │ ack_deadline passes          │ recipient.handle()
     │  → retry → (failed=DLQ)            ▼                              ▼
     │                              escalate (§8.3)               (handled)
     │                                                                  │
     │  handle_deadline passes anywhere ▶ (expired) ─▶ escalate         │ if requires_response
     └──────────────────────────────────────────────────────────       ▼
                                                              reply() → (responded)
```

Terminal states: `handled` (no response needed), `responded`, `failed`,
`expired`. Each transition emits its `ai.message.*` event (§5.3) in the same
transaction as the status update.

### 8.2 Thread state machine

```
 (open) ──request sent, requires_response──▶ (awaiting_response)
   │                                              │ matching response handled
   │  all messages handled, none outstanding      ▼
   └──────────────────────────────────────▶ (resolved)
   │
   │  escalation ladder exhausted ─▶ (escalated) ─human closes─▶ (resolved)
   │  expires_at passes, still open ─▶ (abandoned)
   └  unrecoverable delivery failure ─▶ (failed)
```

### 8.3 The escalation ladder (the guaranteed exit)

The protocol's promise: **a request never just hangs.** When an outstanding
request breaches a deadline, the substrate climbs a fixed ladder. Each rung
emits `ai.thread.escalated` with the rung name and is fully audited.

| Rung | Trigger | Action |
|------|---------|--------|
| **0 · Retry** | `ack_deadline` passed, attempts < N | Re-deliver to the same recipient (backoff §9). The recipient may simply be busy. |
| **1 · Re-route to a peer** | retries exhausted, the intent has *another* capable employee | Resolve the next-best candidate (§6.4) and deliver to it. *"Someone else who can do this."* |
| **2 · Escalate to a manager** | no peer, or peer also silent | Send a new `kind='escalation'` message to the recipient's **manager** (the department's `executive`/lead employee per the org in `ai_employees`). The manager decides: reassign, do it, or push to a human. |
| **3 · Human approval task** | no manager, or `handle_deadline` breached at any rung, or the original action fails P4 (autonomy test) | Open a `waiting_approval` **Task** (XII) in HQ carrying the full thread by reference. A human resolves it. The thread goes `escalated`; closing the task resolves the thread. |
| **4 · Abandon** | `expires_at` passes with the human task still unactioned | Thread → `abandoned`; a `critical` `ai.thread.abandoned` event raises the standing alert (XI golden signals). Nothing is silently lost — abandonment is loud. |

Ladder rungs are **configurable per intent** (an urgent `review.security` may
skip straight to rung 3; a low-priority `inform` may never escalate past rung 0).
Defaults live with the intent in the SDK registry (XIII).

### 8.4 Where the SLA sweep runs

A periodic sweep (a Task Engine recurring task, *not* a bespoke poller — C3)
reads the two SLA indexes (`hq_ai_messages_ack_sla_idx`,
`hq_ai_messages_handle_sla_idx`) and the thread expiry index, and advances the
ladder for anything overdue. It is an **idempotent consumer-style step**: acting
twice on the same overdue message is a no-op (the status has already moved).

---

## 9. Delivery guarantees, idempotency & retry

The protocol makes the same honest promise the Event Spine makes — **at-least-
once + idempotent = effectively-once** — and inherits the exact machinery:

- **Transactional outbox.** `send()` writes the `hq_ai_messages` row **and**
  emits `ai.message.sent` in one transaction. Either both commit or neither does;
  a message can never exist unannounced, and an announcement can never exist
  without its message.
- **Delivery = a bus consumer.** The router is a registered consumer of
  `ai.message.sent` drained by `hq_drain_consumer`. It gets the spine's strict
  id-order, single-active-drainer lock (`FOR UPDATE SKIP LOCKED`), per-event
  retry counter (`hq_consumer_retries`), poison threshold and DLQ
  (`dead_events`) **for free**.
- **Idempotent handling.** A recipient's handler is keyed by `message.id`:
  handling the same message twice is a no-op (the status guard `delivered →
  acknowledged → handled` only advances once; re-entry sees the advanced state
  and returns). Fan-out is guarded by `hq_ai_messages_delivery_uq`.
- **Retry/backoff.** Failed deliveries retry with exponential backoff + jitter
  (the cron drain interval is the natural backoff, as on the spine). After N
  attempts the message is **dead-lettered** (`status='failed'`, a `dead_events`
  row, `ai.message.failed` critical event) and the **thread escalates** (§8.3 —
  a DLQ'd request is never just lost; it climbs the ladder).
- **Ordering.** Per-thread causal order is the `created_at`/`id` order within a
  `thread_id`; the global order is the spine's `hq_events.id`. We do **not**
  promise cross-thread ordering — different conversations are independent.

> We never claim *exactly-once* (a fiction, per the spine's P8). A redelivery
> re-applies the same `message.id` as a no-op.

---

## 10. Interfaces

### 10.1 SQL entry points (P5: `SECURITY DEFINER`, `search_path=''`, service-role-only)

```
hq_ai_thread_open(p_correlation_id uuid, p_subject text, p_subject_kind text,
                  p_subject_id text, p_opener_type text, p_opener_id text,
                  p_priority text) returns uuid
    -- inserts the thread, emits ai.thread.opened. Returns thread_id.

hq_ai_message_send(p_thread_id uuid, p_sender_type text, p_sender_id text,
                   p_recipient_mode text, p_recipient_id text, p_kind text,
                   p_intent text, p_subject text, p_body jsonb,
                   p_context_refs jsonb, p_in_reply_to uuid,
                   p_requires_response boolean, p_priority text,
                   p_ack_deadline timestamptz, p_handle_deadline timestamptz)
    returns uuid
    -- THE OUTBOX WRITE. Inserts the message (status='pending') AND emits
    -- ai.message.sent in the SAME transaction. Stamps correlation_id from the
    -- thread; sets causation_id to the current ambient event if provided.
    -- Bumps thread.message_count/last_message_at. Returns message_id.

hq_ai_message_route(p_message_id uuid) returns jsonb
    -- THE DELIVERY STEP (called by the router consumer). Resolves recipient(s)
    -- per §6, writes delivered copies (idempotent via delivery_uq), sets
    -- status='delivered', emits ai.message.delivered. Returns a routing summary.

hq_ai_message_ack(p_message_id uuid, p_employee_id text) returns void
hq_ai_message_handle(p_message_id uuid, p_employee_id text, p_result jsonb) returns void
hq_ai_message_respond(p_in_reply_to uuid, p_sender_id text, p_body jsonb,
                      p_context_refs jsonb) returns uuid
    -- guarded status transitions (P9 idempotency); each emits its event.

hq_ai_thread_sla_sweep(p_now timestamptz default now(), p_limit int default 500)
    returns jsonb
    -- the periodic escalation driver (§8.4). Idempotent. Returns counts per rung.

hq_ai_comms_golden_signals() returns jsonb
    -- §12 observability.
```

All: `revoke … from public, anon, authenticated; grant execute … to service_role`.

### 10.2 TypeScript SDK surface (the only thing employee code touches — XIII)

```ts
interface Comms {
  // Open or continue a conversation. correlation_id is inherited from the
  // ambient task context (P2) — callers never pass it.
  openThread(opts: { subject: string; subjectRef?: Ref; priority?: Priority }): Promise<ThreadId>;

  // Send a request. `to` is { employee } | { role } | { capability } | 'broadcast'.
  send(opts: {
    thread?: ThreadId;
    to: Recipient;
    intent: string;                 // validated against the SDK intent registry
    body: RequestSpec;              // small, structured ask
    context?: Ref[];                // passed BY REFERENCE (§7)
    requiresResponse?: boolean;
    ackWithin?: Duration; handleWithin?: Duration;
    priority?: Priority;
  }): Promise<MessageId>;

  reply(inReplyTo: MessageId, body: AIOutputEnvelope, context?: Ref[]): Promise<MessageId>;
  inform(opts: { to: Recipient; intent: string; body: unknown; context?: Ref[] }): Promise<void>;

  // The recipient side. inbox() returns delivered-to-me, unhandled messages.
  inbox(): Promise<InboundMessage[]>;
  acknowledge(id: MessageId): Promise<void>;
  handle(id: MessageId, run: (m: InboundMessage) => Promise<HandleResult>): Promise<void>;
  // handle() wraps the run in the idempotent status guard + emits ai.message.handled.

  resolveContext(ref: Ref): Promise<ResolvedContext>; // → Memory (X), permission-checked
}
```

`pure lib/*` shared by SQL callers, the router consumer, the SDK and tests —
the repo's established layering (writers in `server/services/*`, types/logic in
`lib/*`). No business logic in the SQL beyond the atomic guards.

---

## 11. Worked flows

### 11.1 Delegate-and-respond (the common case)

```
1. CEO AI (running task T) → comms.send({ to:{capability:'research.company'},
     intent:'research.company', body:{companyId}, context:[{company,id}],
     requiresResponse:true, ackWithin:5m, handleWithin:1h })
   → hq_ai_message_send: row(status=pending) + emit ai.message.sent  (one txn)
   → thread.state = awaiting_response
2. Bus drains ai.message.sent → router → resolves capability → research-ai
   → delivered copy(status=delivered) + emit ai.message.delivered
3. Research AI inbox() → acknowledge() (status=acknowledged, emit ack)
4. Research AI runs its task (XII), writes the report to Memory (X) as a memory,
   gets memory_id back.
5. Research AI → comms.reply(msgId, <P3 envelope>, context:[{memory, memory_id}])
   → response message(kind=response) + emit ai.message.responded
   → original message.status = responded
6. CEO AI handles the response: comms.resolveContext({memory, memory_id})
   → reads the report (permission-checked) → continues task T
   → thread.state = resolved, emit ai.thread.resolved
```

Every step is one `hq_events` row; the whole exchange shares one
`correlation_id`; a human can reconstruct it with `WHERE correlation_id = X
ORDER BY id`.

### 11.2 The recipient never answers (escalation)

```
1–2 as above; Research AI is disabled/stuck and never acks.
3. ack_deadline (5m) passes → SLA sweep → rung 0: retry deliver. Still silent.
4. retries exhausted → rung 1: another employee holds research.company? If yes,
   re-route to it (deliver, emit ai.thread.escalated rung=peer). If it answers,
   thread resolves normally.
5. No peer → rung 2: escalation message to the executive/manager employee.
6. handle_deadline (1h) breached → rung 3: open waiting_approval Task (XII) in HQ
   carrying the thread by reference; thread.state = escalated. A human picks it up.
7. If the human task is itself ignored past thread.expires_at → rung 4:
   thread.state = abandoned; critical ai.thread.abandoned event → standing alert.
```

---

## 12. Observability

`hq_ai_comms_golden_signals()` returns, cheaply (bounded aggregates over the hot
indexes), the canaries an operator and the Pulse dashboard watch:

- **Outstanding requests** — `awaiting_response` threads, and the oldest.
- **Inbox lag** — delivered-but-unacknowledged count per employee; oldest.
- **Escalation rate** — `ai.thread.escalated` per hour, by rung.
- **Dead messages** — `status='failed'` count + oldest (DLQ standing alert).
- **Abandonment** — `abandoned` threads in the last 24h (should be ~0).
- **Round-trip time** — median `responded_at − sent_at` per intent (the health
  of each capability's responsiveness).

These ride the spine's existing golden-signal pattern and surface on The Pulse
(XI / Module 1 PR5).

---

## 13. Security & permissions (P5 applied here)

- **No spoofing.** The SDK stamps `sender_id` from the *authenticated employee
  identity* (XIII); employee code cannot send "as" another employee. The SQL
  entry point trusts only the service-role caller, which the SDK mediates.
- **Send permission.** An employee may only address recipients its permissions
  allow (e.g. a junior employee may not directly task the CEO AI; it must go via
  its manager). Enforced in `within_send_permission(sender)` (§6.2), backed by
  the SDK permission model and capability registry (XIII).
- **Read-time context permission.** `context_refs` are resolved through the
  Memory permission matrix (X); a recipient cannot read context it isn't granted,
  even if the sender could. The reference, not the data, crosses the wire.
- **Everything audited.** Every send/deliver/ack/handle/escalate is an
  `hq_events` row (the system of record, C5). Threads + messages are RLS:hq —
  invisible to every customer/staff JWT (P5). No customer-facing surface is
  touched.

---

## 14. Testing (the six gates)

| Gate | What it proves for the protocol |
|------|---------------------------------|
| 1 typecheck | The SDK `Comms` surface and message/thread types are sound. |
| 2 lint | British spelling, conventions. |
| 3 unit | Routing resolution (all four modes), the load policy, the message/thread FSM transitions and guards, escalation-ladder rung selection — pure `lib/*`, no DB. |
| 4 integration (real Postgres) | The transactional outbox (row + event atomic), idempotent fan-out (`delivery_uq`), at-least-once + idempotent handling (deliver the same message twice → one handle), the SLA sweep advancing the ladder, DLQ on poison delivery — proved against a real DB, like the spine. |
| 5 security | `hq_ai_*` are RLS:hq (anon/authenticated denied at the parent); entry-point `EXECUTE` revoked from JWT roles; no-spoofing guard; pinned in source text. |
| 6 e2e | The HQ surface that shows a conversation/escalation behind the auth wall (mirrors the qualification/research e2e: anonymous → 307 to /login, surface never paints). |

---

## 15. Conflicts resolved & open questions

**Resolves:**
- **C3 ("nothing polls")** — the SLA sweep and the router are *event-bus
  consumers / recurring tasks*, not bespoke pollers. Messaging is push-shaped on
  the spine.
- **C5 (parallel audit logs)** — all message lifecycle is `hq_events`; no new
  log. The message table is state, not a second truth.
- Contributes to **C1** — by-capability routing means a sender names *what it
  needs*, not *who*, so adding/renaming employees never breaks callers.

**Open questions for a future directive:**
1. **Synchronous request/response sugar.** Some flows want "ask and await". Do we
   offer an SDK `await comms.request(...)` that blocks the calling task until a
   response or timeout (implemented as task-suspend/resume on the response
   event), or keep everything strictly asynchronous? *Recommendation: async-first;
   add suspend/resume in the Task Engine (XII) rather than a blocking call.*
2. **Cross-tenant messaging.** All messaging here is HQ-internal (AI⇄AI). If a
   future customer-facing AI must message a tenant user, that crosses the RLS
   boundary and needs its own volume — explicitly **not** in this substrate.
3. **Message-body schema registry.** `body` is `jsonb`; do we register a JSON
   Schema per `intent` and validate at send? *Recommendation: yes, in the SDK
   intent registry (XIII), so malformed asks fail fast at the sender.*

---

*Volume IX of the AI Substrate. Architecture only — no code, no production
change, no PR. Continues into Volume X (Shared Memory Architecture), which this
volume's context-by-reference depends on.*
