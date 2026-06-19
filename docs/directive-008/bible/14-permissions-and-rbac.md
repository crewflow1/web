# Chapter 14 — Permissions & RBAC (Canon)

## Purpose

This chapter is the OS's protection ring. It specifies the **single chokepoint** — `authorize()` — through which *every* consequential action passes, whether a human clicks it or an AI employee requests it as a tool call. It defines the **capability** (the fine-grained permission verb), the **role** (a bundle of capabilities), the **principal** (a human or an AI, granted roles uniformly), and **dual-control** (a second decision for dangerous actions). It is canon because every other chapter spends capabilities it defines: Ch.07's tool registry binds a `required_capability` to every tool; Ch.08's roster is a least-privilege map; Ch.13's approval policies route by capability and risk; Ch.15 audits `permission.*`. Change a capability here, change it nowhere else first.

The design is **additive over a working gate** (P2). Today HQ has one binary check — `isSuperAdminEmail()` → `requireHq()`/`requireHqPage()` (♻️ `server/auth/`). The OS does not replace it; it **layers a capability check inside it** and seeds every existing super-admin with a role that holds *every* capability, so on day one behaviour is identical and nothing breaks. Fine-grained roles are then introduced as needed, each grant an additive, reversible, audited event.

## Goals

- **One chokepoint, no bypass.** Every side-effect — human or AI — calls `authorize(principal, capability, ctx)`. There is no second authorization path and no ambient authority (P5).
- **Capabilities as the universal verb.** `domain.action` permissions that *both* humans and AIs hold via roles — so "anything a human can see, an appropriately-permissioned AI can act on" (Ch.01) is enforced by *one* model, not two.
- **Least privilege, dual-control for danger.** Principals hold the minimum capabilities for their job; `danger` capabilities require a second human decision (P5).
- **Fail closed.** Unknown capability, missing role, error in the check → **deny**. Safety is the default; access is the exception that must be granted.
- **Additive & reversible.** Existing super-admins keep full access via a seeded role; new roles ship behind flags; every grant/revoke is reversible and audited (P7).
- **Uniform principals.** A human (`HqActor`) and an AI employee (slug) are the same kind of thing to the gate — both are rows in `hq_principal_roles`.

**Non-goals:** the approval *workflow/inbox* (Ch.13 — this chapter decides *whether* a capability is held and *whether* it needs approval; Ch.13 runs the approval); tenant RLS (Ch.03/16 — unchanged); the employee dossiers' specific grants (Ch.08); authentication itself (♻️ Supabase Auth + the super-admin email allowlist, unchanged).

---

## Architecture

### The model: capability → role → principal

```
   hq_capabilities ──< hq_role_capabilities >── hq_roles ──< hq_principal_roles >── principal
   (the verb         (many-to-many)          (a bundle)   (a grant, time-boxable)   (human | ai_employee)
    catalogue,                                                       │
    danger flag)                                                     ├─ human:  HqActor.id  (♻️ email allowlist)
                                                                     └─ ai:     employee slug (Ch.08)
```

- A **capability** (`hq_capabilities`, Ch.03 §03.9) is a fine-grained verb: `billing.refund`, `org.suspend`, `email.send`, `memory.assert`. It carries a `domain` and a `danger` flag (dangerous ⇒ dual-control eligible).
- A **role** (`hq_roles`, §03.10) bundles capabilities and is typed `human` or `ai` (so an AI-shaped role and a human-shaped role can draw from the same catalogue without confusion).
- A **principal** holds roles via `hq_principal_roles` (§03.12): `(principal_type, principal_id, role_key)` with an optional `expires_at` for time-boxed grants. **Humans and AIs are both principals** — the gate does not care which.

### The chokepoint: `authorize()`

The whole chapter reduces to one function, called in exactly one place per side-effect:

```
                          ┌──────────────── authorize(principal, capability, ctx) ────────────────┐
 human click  ─▶ server   │ 1. resolve principal's effective capabilities (roles → caps, cached)   │
 (server      │  action ─▶│ 2. capability held?  no → DENY (fail closed)                            │
  action)     │           │ 3. is it `danger` / does policy require approval for this ctx?          │─▶ allow │
              │           │       no  → ALLOW                                                        │   deny  │
 AI tool call ─▶ runtime ─▶│       yes → return NEEDS_APPROVAL (Ch.13 creates hq_approval, pauses)   │   needs-│
 (Ch.07 gate) │           │ 4. sample-emit permission.capability_used for high-risk caps (Ch.15)    │ approval│
              │           └──────────────────────────────────────────────────────────────────────────┘
```

The two ingress paths — a human's **server action** and an AI's **tool call** — converge on the *same* `authorize()`. This is the architectural payoff of uniform principals: one implementation, one audit, one place to reason about safety. A server action guards with `requireCapability(actor, cap)` (the fine-grained successor to `requireHq()`); the AI runtime calls the identical check at its GATE phase (Ch.07). Neither can reach a side-effect without it.

### Where the gate sits

- **Inside the service layer**, not the UI. A page may *hide* a button the operator can't use (UX), but the *authority* is checked server-side at the action/tool, never trusted from the client (Ch.16). Hidden ≠ forbidden; `authorize()` is forbidden.
- **Before the side-effect, after intent is known.** The gate needs the *context* (which org, how much money) to evaluate policy, so it runs once the action's parameters are bound — the same point the AI runtime pauses for approval.
- **Exactly once per action.** Not in middleware (too coarse — middleware does the *page* gate, ♻️ `requireHqPage`), not sprinkled (un-auditable). One call, at the action boundary.

### Dual-control

A `danger` capability (e.g. `billing.refund`, `org.delete`, `permission.role_granted` for a danger cap) is not satisfied by a single grant. Holding it lets a principal *request* the action; **executing** it requires a second, distinct human to approve (Ch.13 `decision='dual_control'`). The two humans must differ (separation of duties); an AI can *initiate* but is never one of the two approvers. This is P5's "dual-control for danger" made mechanical — the most dangerous powers cannot be exercised by one actor, human or AI.

### Additive migration from the binary gate

| Today (♻️) | OS (additive) |
|---|---|
| `isSuperAdminEmail(email)` — binary | `super_admin` **role** holding *all* capabilities; every allowlisted email granted it on seed |
| `requireHq()` (server action guard) | unchanged as the *entry* gate; gains `requireCapability(actor, cap)` for the *action* |
| `requireHqPage()` (page guard) | unchanged (page-level coarse gate) |
| no concept of an AI principal | AI employees seeded as principals with least-privilege roles (Ch.08) |

On seed, **every current super-admin holds every capability** → identical behaviour, zero regression. Finer roles (a read-only auditor, a billing-only operator) are introduced later by *removing* capabilities from a *new* role and granting it to *new* principals — never by reducing an existing super-admin without an explicit, audited decision.

---

## Database design

Owned tables are catalogued in **Ch.03** (not redefined here): `hq_capabilities` (§03.9), `hq_roles` (§03.10), `hq_role_capabilities` (§03.11), `hq_principal_roles` (§03.12). All `RLS:hq` (service-role only). The **seed** is the load-bearing data:

- **Capability catalogue** — every capability any chapter references is seeded here with its `domain` and `danger` flag. The catalogue is the single source; a tool whose `required_capability` is not in it cannot be authorised (fail closed). Illustrative danger set: `billing.refund`, `billing.credit`, `org.suspend`, `org.delete`, `permission.role_granted`, `impersonation.start`, `content.publish`, `memory.grant`.
- **Roles** — `super_admin` (all caps, `kind='human'`, seeded to every allowlisted email); the twelve AI roles (one per employee, `kind='ai'`, least-privilege per Ch.08); later, human sub-roles (`auditor`, `billing_operator`, `support_lead`).
- **Grants** — `hq_principal_roles` rows; `granted_by`/`granted_at` for audit; `expires_at` for time-boxed access (a contractor, a break-glass grant).

**Access pattern.** The hot read is "principal → effective capabilities", resolved by joining `hq_principal_roles → hq_role_capabilities` and **cached** (per-request, with a short TTL and explicit bust on `permission.*`). Writes — grant/revoke — are rare, audited, and emit spine events. No tenant table is touched; this is HQ-side authority only.

---

## APIs

```ts
// server-only. The one gate. Returns a decision, never throws on "denied".
type AuthzDecision =
  | { effect: 'allow' }
  | { effect: 'deny'; reason: 'no_capability' | 'unknown_capability' | 'expired' | 'error' }
  | { effect: 'needs_approval'; risk: RiskTier; policyId: string };  // Ch.13 takes over

async function authorize(
  principal: Principal,                 // { type: 'human'|'ai_employee'; id: string }
  capability: CapabilityKey,            // typed against the seeded catalogue
  ctx?: { objectType?: string; objectId?: string; amount?: number; meta?: Json },
): Promise<AuthzDecision>;

// the server-action guard — the fine-grained successor to requireHq() (♻️).
// throws/redirects on deny exactly as requireHq does today, so call-sites barely change.
async function requireCapability(actor: HqActor, capability: CapabilityKey, ctx?: Ctx): Promise<void>;

// pure predicate for UI affordances (hide a button) — NEVER the authority itself.
function hasCapability(principal: Principal, capability: CapabilityKey): Promise<boolean>;

// administration — themselves capability-gated and audited.
async function grantRole(target: Principal, roleKey: string, opts: { grantedBy: HqActor; expiresAt?: Date }): Promise<void>;  // needs permission.role_granted
async function revokeRole(target: Principal, roleKey: string, by: HqActor): Promise<void>;                                    // needs permission.role_revoked
async function listEffectiveCapabilities(principal: Principal): Promise<CapabilityKey[]>;                                     // the "who can do what" read
```

- **`CapabilityKey` is a TypeScript union generated from the seeded catalogue** — an unregistered capability *won't compile*, mirroring Ch.04's `Verb` discipline ("one source", enforced by the type system, exactly as 007 enforced design tokens in ESLint).
- **Contracts.** `authorize` is total — it returns a decision for every input, including `deny` on error (fail closed). `requireCapability` is the throwing wrapper for ergonomic server actions. `grantRole`/`revokeRole` are themselves gated (`permission.role_granted`/`_revoked`) and, when the role contains a `danger` cap, are **dual-control**.
- **Versioning.** The capability catalogue is versioned like schema: adding a capability is a seed migration + an ADR (Ch.20); renaming one is a breaking change handled like a verb rename (Ch.04). Roles can change freely (data); capabilities cannot (contract).

---

## UI behaviour

A **Roles & Permissions** surface in Mission Control (Ch.09), not a separate console:

- **Who-can-do-what matrix.** Principals (humans + AI employees) × capabilities, showing granted/withheld; an AI employee's row is its dossier capability set (Ch.08) made visible. Filter by domain, by danger, by principal type.
- **Grant/revoke.** A guarded action (`permission.role_granted`); granting a role that contains a `danger` capability triggers dual-control (a second human) *and* a confirmation showing exactly which dangerous powers are being conferred. Time-boxed grants show a countdown.
- **Capability provenance.** Click a capability → every principal that holds it and via which role; click a principal → its effective capabilities and their source roles. Authority is never opaque.
- **States.** *Loading:* the matrix renders from the last snapshot. *Empty:* a fresh role with no capabilities is explicit ("grants nothing yet"). *Error:* the check service failing degrades **closed** in the UI (buttons disabled, with "permission unavailable"), never open. *Live:* a revoke reflects immediately (broadcast on `permission.*`, Ch.06) — an operator watching sees access change in real time.
- **Affordance vs authority.** The UI uses `hasCapability` to *hide* what you can't do (clean UX), but every action still calls `authorize` server-side — the hidden button and the forbidden action are independent layers.
- **Accessibility.** Danger grants are conveyed by icon + text + an explicit confirm step, never colour alone; the matrix is keyboard-navigable.

---

## Permissions (of this system itself)

| Action | Capability | Notes |
|---|---|---|
| Call any gated action | the action's own capability | the universal rule |
| View the permissions matrix | `permission.read` | broad among super-admins |
| Grant/revoke a non-danger role | `permission.role_granted` / `_revoked` | senior operators |
| Grant a role containing a `danger` capability | `permission.role_granted` **+ dual-control** | two distinct humans (Ch.13) |
| Edit the capability catalogue (add/rename) | `permission.admin` | rare; ADR-gated (Ch.20) |

**Default policy:** read-broad, grant-narrow, danger-dual-control. **No AI employee holds `permission.*`** — an AI can never widen its own or another's authority (the containment that makes injection survivable, Ch.07/16). Only humans grant capability, and granting danger needs two of them.

---

## Failure handling

- **Authorization service error / DB unreachable:** `authorize` returns `deny{reason:'error'}` — **fail closed**. A permission system that fails open is not a permission system. The UI shows "permission unavailable", the action does not proceed.
- **Unknown capability** (a tool references a cap not in the catalogue): `deny{unknown_capability}` — a typo or a drift cannot accidentally grant access; it denies and alerts (`system.alert_raised`).
- **Cache staleness after a revoke:** the cache TTL is short and **busted explicitly** on `permission.role_revoked`; worst case a revoked capability lingers for the TTL window (seconds), bounded and monitored. A revoke of a *danger* capability busts immediately (no TTL grace).
- **Expired grant:** `expires_at` in the past ⇒ the role contributes no capabilities; `authorize` denies as if never granted. Expiry is evaluated at check time, not by a sweep, so it is never "late".
- **Dual-control with one approver:** the action cannot execute; it waits or expires (Ch.13). A single human cannot satisfy both decisions even by trying twice (the second decision must be a *distinct* principal id).

## Edge cases

- **A principal with no roles:** holds no capabilities; every gated action denies. A new AI employee starts here (`foundation`, Ch.08) until granted.
- **Human and AI requesting the same capability:** identical evaluation; the *policy* (Ch.13) may differ by principal type (an AI's `email.send` requires approval where a senior human's is `auto`) — but the *capability check* is the same code.
- **Granting a role to a non-existent principal:** rejected (the principal id must resolve to a known human actor or a seeded employee slug) — no dangling grants.
- **Self-revocation lockout:** the last `super_admin` cannot revoke its own super_admin role (a guard prevents locking everyone out); revoking the penultimate is allowed. Break-glass re-grant is a documented runbook (Ch.19).
- **A capability used by a tool but never seeded:** caught by a CI test (every `required_capability` in the tool registry must exist in the catalogue) — drift fails the build, not production.

## Performance

- **`authorize` is O(1) on the hot path.** The principal→capability set is resolved once and cached per request; a check is a set membership test in memory, not a DB round-trip. A run that makes ten tool calls pays one resolution, ten lookups.
- **Grant/revoke is rare and cheap** — a single indexed write + a cache bust + one event.
- **At 1M companies.** Authorization cost is independent of company count — it depends only on the (small) number of capabilities and roles, which is bounded by design (a curated catalogue, a handful of roles). The gate that runs on *every* action must be ~free, and it is: a cached in-memory check. This is the Golden-Rule answer — the protection ring does not become a bottleneck because authority is modelled as a small, cacheable set, never a per-request query against tenant-scale data.

## Security

- **The gate is the trust boundary.** Every defense in Ch.16 assumes `authorize` is the only door; this chapter guarantees there is no other (no ambient authority, one chokepoint, fail closed).
- **Capability cannot be escalated by injection.** An AI talked into *wanting* `billing.refund` still hits the gate, which checks the *grant*, not the wish (Ch.07). No prompt grants a capability; only a human grant in `hq_principal_roles` does.
- **Separation of duties** is structural: danger ⇒ dual-control with distinct principals; no AI in the approver set; the granter of authority (`permission.*`) is itself a gated, audited, AI-forbidden capability.
- **Least privilege is enforced and tested** — the capability-minimality test (no principal exceeds its declared set) and the AI roster as a least-privilege map (Ch.08).
- **Every authority change is on the spine** — `permission.role_granted`/`_revoked` and sampled `permission.capability_used` for high-risk caps — so "who could do what, when" is reconstructable for any point in history (Ch.15, the SOC2 path).

## Testing

- **Deny-by-default tests:** a principal without a capability is denied for every gated action; a fresh principal can do nothing.
- **Fail-closed tests:** a forced error in resolution yields `deny`, never `allow` — asserted explicitly (the most important test in the chapter).
- **Dual-control tests:** a danger capability cannot execute with one approver; requires two distinct humans; an AI cannot be an approver.
- **Seed/back-compat test:** after seeding, every existing super-admin email resolves to the full capability set (zero regression vs `isSuperAdminEmail`).
- **Catalogue-coverage test:** every `required_capability` in the Ch.07 tool registry exists in the seeded catalogue (no drift).
- **Cache-invalidation test:** a revoke removes access within the TTL bound; a danger revoke removes it immediately.
- **RLS tests:** `hq_capabilities`/`hq_roles`/`hq_role_capabilities`/`hq_principal_roles` unreadable by anon/JWT (♻️ pattern).

## Monitoring

- **Events (Ch.04):** `permission.role_granted`, `permission.role_revoked`, `permission.capability_used` (sampled, high-risk caps only — full sampling would be noise).
- **Metrics (Ch.15):** grant/revoke rate, count of principals holding each danger capability (a *standing inventory* — "who can refund money right now"), denied-action rate (a spike may signal misconfiguration or an attack), dual-control completion latency.
- **Golden signals:** a *rising deny rate* (something is misconfigured or probing), a *grant of a danger capability* (always an audit-worthy event, surfaced to the operator), an *AI principal attempting `permission.*`* (should be impossible — if it ever happens, it is a `critical` alert).
- **Audit:** every grant/revoke in `admin_activity_log` with granter, target, role, and (for danger) both approvers — the authority ledger.

## Future expansion

- **Human sub-roles.** The model already supports them (`hq_roles.kind='human'`); introducing `auditor` (read-only), `billing_operator`, `support_lead` is pure data — new roles with capability subsets, granted to new principals, no code change.
- **Per-tenant-scoped authority.** Today capabilities are HQ-global; the seam for "operator X may act only on orgs in region Y" is a `ctx`-aware policy in `authorize` + a scope on the grant — additive, when the org grows to need it.
- **Time-boxed & break-glass.** `expires_at` already supports contractor and emergency grants; a formal break-glass flow (auto-expiring super_admin with heightened audit) is a documented procedure on this foundation.
- **Per-role event visibility.** The spine's `visibility` field (Ch.04) is the seam: when sub-admin roles exist, a role sees only its slice of the timeline/audit — `authorize` extended to *reads*, not just *writes*.
- **External attestation.** The grant ledger is structured for SOC2/ISO access-review export (Ch.15) — periodic "recertify who holds what" campaigns become a query over `hq_principal_roles`.
