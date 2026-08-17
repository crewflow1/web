# CrewFlow Correctness Guards

> **What this is.** CrewFlow carries a family of *meta-tests* — tests that do not
> exercise a feature but instead scan the source tree and fail CI when a whole
> **class** of defect reappears. Each was born from a real production-class bug
> found during the zero-trust audit waves; rather than fix the single instance,
> we fixed the instance **and** wrote a guard that makes the class
> unrepresentable going forward. This document is the durable rationale for every
> guard so any engineer (or a future maintainer with no session history) can
> understand what each protects, how it works, how it can legitimately fail, and
> how to satisfy it correctly rather than by weakening it.
>
> **Golden rule.** A guard is never made green by relaxing the guard. If a guard
> fails, either the code reintroduced the class (fix the code) or the code is a
> genuine, reasoned exception (add it to the guard's explicit allow-list *with a
> comment explaining why it is safe*). Deleting an assertion, widening a regex to
> nothing, or blanket-allow-listing a directory is a defect, not a fix.

All guards live in `__tests__/security/*.test.ts` and run in the `test:security`
CI tier ("trust boundaries"). At time of writing there are **292 security
tests**; the structural guards below are the load-bearing subset.

---

## 1. F-1 pagination family

**Class:** Supabase's PostgREST returns a **capped** number of rows by default
(1,000). A read written as `select(...)` with no explicit range, or with a
`.limit(N)` that is smaller than the true row count, **silently truncates**. In a
multi-tenant money app this is catastrophic: a VAT return computed over the first
1,000 invoices, a payroll run over the first 1,000 time-entries, a "total
outstanding" tile that stops counting — all wrong, all silent, all worse as a
tenant grows.

**Guards:**
- `f1-pagination-guard.test.ts` — the canonical class test.
- `f1-bare-select-guard.test.ts` — flags a `select` used for aggregation/enumeration that is **not** routed through `fetchAllRows(...)`.
- `f1-limit-clamp-guard.test.ts` — flags a `.limit(N)` on a read whose result is summed/counted, unless the call site is in the **`BOUNDARY_ALLOWLIST`**.

**How the fix looks:** use `fetchAllRows()` (paginates until the source is
exhausted) for any read whose full extent matters. A `.limit()` is only legal
when the query is genuinely bounded by design (e.g. "most recent 20 for a
prompt", "top 5 for a tile") — those are the allow-list entries.

**How it can legitimately fail (and the correct response):**
- You added a new aggregate read with a bare `select` → **route it through `fetchAllRows`.** Do not allow-list it.
- You added a genuinely-bounded read (a picker preview, a "recent N") → **add it to `BOUNDARY_ALLOWLIST` with a one-line reason.**
- You edited a file and shifted line numbers → the allow-list is keyed by `file:line`; **update the line number** (see the brittleness note in §_Maintainability debt_ below — this is the guard we most want to convert to structural matching).

**Known debt:** `BOUNDARY_ALLOWLIST` is keyed by `file:line`, so unrelated edits
that shift lines require allow-list maintenance. This is brittle by design-choice
(precision over convenience) and is the top candidate for conversion to an
AST/marker-comment scheme (see `MAINTAINABILITY.md`).

---

## 2. Active-org pin family (read + write + signed-URL)

**Class:** A user may belong to several organisations. Every tenant-scoped query
must be filtered by the user's **currently active org**, not by "any org they can
see" and never unfiltered. Miss the pin on a read and you leak another tenant's
data; miss it on a write and you mutate the wrong tenant; miss it on a
signed-URL mint and you hand out a cross-tenant download link.

**Guards:**
- `active-org-read-pin-guard.test.ts`
- `active-org-write-pin-guard.test.ts`
- `signed-url-active-org-pin-guard.test.ts`

**How the fix looks:** resolve the active org once (`getActiveOrgId`) and pass it
into every query's `.eq('org_id', activeOrgId)` (reads/writes) and into the
storage-object ownership check before minting a signed URL.

**Legitimate failure:** a new tenant-scoped read/write/signed-URL that the guard
detects is missing its pin → **add the pin.** Genuine org-agnostic surfaces
(the org-switcher itself, `me/actions.ts` which is user-scoped **by design**) are
the documented exceptions.

---

## 3. Composite tenant-FK integrity

**Class:** A child row (invoice line, finance row) references a parent (`job_id`)
by a bare id. A malicious/confused caller can point a child at a parent in
**another org**, injecting money into a tenant that never created it. A bare
single-column FK cannot prevent this; the database must enforce
`(id, org_id)` **composite** foreign keys so a child can only reference a parent
in its own org.

**Guard/pattern:** composite `(id, org_id)` FKs at the schema level plus
`verifyJobInOrg`-style checks in the action layer. Enforced by migration review
and the cross-org integrity tests under `__tests__/security/`.

---

## 4. SECDEF-org-RPC guard

**Class:** A `security definer` RPC runs with the definer's privileges and
**bypasses RLS**. If such an RPC does not itself re-check the caller's org, it is
a cross-tenant primitive. `secdef-org-rpc-guard` scans migration SQL for
`security definer` functions that touch tenant tables without an org predicate.

**Legitimate failure:** a new SECDEF RPC → **add the org check inside the
function** (derive the org from the authenticated caller, never trust a
parameter), or, for genuinely org-agnostic infra functions (claim/lease
dispatchers keyed by their own internal state), document why in the migration
header.

---

## 5. Loud-read ledger

**Class:** A read that fails should **fail loudly**, not return an empty set that
downstream code treats as "nothing here". A swallowed read error silently
under-reports money, jobs, or compliance items. The loud-read work asserts a
canonical `=== shape` result contract and an embed tripwire.

**Guard:** loud-read shape ledger tests (see `docs/loud-read-failures.md`).

---

## 6. Cron-fairness guard

**Class:** A per-org drain (bank-sync, telematics-sync, webhook dispatch) that
orders work purely chronologically lets one org's burst monopolise every pass,
starving tail orgs. `cron-fairness-guard.test.ts` requires per-org fair
interleaving (rank within org, then serve the oldest of every org first).

**Reference implementation:** `supabase/migrations/20261176000000_webhook_claim_fairness.sql`
— note the windowed `ranked` CTE computing `row_number() over (partition by
org_id ...)` **separately** from the `FOR UPDATE ... SKIP LOCKED` lock (window
functions and `FOR UPDATE` cannot share a query level), and the **two-path**
claimable set that preserves the stale-`delivering` lease-reclaim clause. This is
the canonical shape for any new per-org drain.

---

## 7. Constant-set parity guards

**Class:** The same business set is declared in two places (a TypeScript union
and a DB `CHECK`; two parallel TS constant lists) and they **drift**. A value
admitted by one and rejected by the other is a latent 500 or a silent
mis-classification.

**Guards:**
- `employee-migration-parity.test.ts`
- `org-branding-flat-column-guard.test.ts`
- `__tests__/fleet/compliance-constant-parity.test.ts` (pins `FLEET_COMPLIANCE_TYPES` ⟷ `COMPLIANCE_MAINTENANCE_TYPES` ⟷ the DB CHECK — the exact drift that let "tyres" through one list but not the other).

**Legitimate failure:** you widened one set → **widen every parallel set and the
DB CHECK in the same change.** The guard exists precisely because "I'll update
the other one later" is how the class recurs.

---

## 8. Destructive-target guard

**Class:** A destructive action (delete/clear) wired to the wrong target id, or a
delete that doesn't cascade its dependents, silently corrupts state.
`destructive-target-guard-wiring.test.ts` and `quote-delete-invoice-guard.test.ts`
pin the wiring.

---

## 9. Invoice-outstanding authority guard

**Class:** "Amount outstanding" must be computed from the single payment-ledger
authority, never re-derived divergently per surface.
`invoice-outstanding-authority-guard.test.ts` pins that every surface routes
through the one calculator. (Sibling authorities — VAT quarter, corp-tax — follow
the same single-authority discipline.)

---

## Maintainability debt (tracked, not hidden)

The guards keyed by `file:line` (`BOUNDARY_ALLOWLIST` in the F-1 clamp guard) are
**brittle**: a benign edit that shifts lines forces allow-list maintenance and
creates review noise. This is a deliberate precision-vs-convenience trade, but it
is debt. The planned remediation is to move from line-keyed allow-listing to
either (a) an **explicit marker comment** at the call site
(`// f1-safe: bounded picker preview`) that the guard greps for, or (b) a
lightweight **AST** match on the call expression. Either removes the line-number
coupling without weakening the guarantee. Tracked in `MAINTAINABILITY.md`.

---

## Adding a new guard

When an audit finds a production-class defect:
1. Fix the specific instance.
2. Write a **source-scanning** test that fails on the *class*, not the instance.
3. Prefer structural matching (AST / marker comment) over `file:line` keys.
4. Give every allow-list entry a one-line reason.
5. Document the guard here.

A defect class is only "closed" when the guard is green **and** would go red if
the class were reintroduced (non-vacuous). Prove non-vacuity by temporarily
reintroducing the defect locally and watching the guard fail.
