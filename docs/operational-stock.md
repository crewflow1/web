# O3 — Operational stock

Migrations `20261063000000` – `20261065000000`. Surface: `/stock`, plus a
"put into stock" affordance on the purchase-order page.

---

## THE ACCOUNTING BOUNDARY — read this first

**This milestone is an operational QUANTITY ledger. It records where things
are, never what they are worth.**

Stock movements **never** post to `public.finances`.

Purchased materials are *already* expensed when the supplier's bill is recorded
(`recordSupplierBill` → `finances`, migration `20261009000000`). Issuing 10
boards to Job A records *"10 boards moved Depot → Job A"* and **no new expense**.
A second posting would **double-count** the same spend — once when the supplier
invoiced, once when the boards left the shelf — and would silently inflate the
cost of sale on every affected job. Invisible until year end.

So there is:

- no inventory asset value,
- no COGS-on-issue posting,
- no VAT anywhere,
- **no unit cost column at all** — a valuation cannot be computed even by
  accident, because the number does not exist.

**Why the boundary exists rather than being an oversight:** *"should stock be
capitalised as an asset and released to cost when it is issued?"* is **CEO
decision D1** and it is **UNDECIDED**. This is the authorised safe interim.
Whichever way D1 lands, nothing recorded here has to be unwound: a movement
history is a strict prerequisite for a valuation layer, never a contradiction of
one.

**Enforced, not merely stated.** `__tests__/security/operational-stock.test.ts`
asserts that no file in this diff contains an executable reference to
`finances`, performs no insert/update/delete against it, creates no trigger on
it, and that the schema carries no money column and no money RPC parameter.

---

## What a builder can now do

1. **Name the things they keep a count of** — `/stock/items`. Cement, fixings,
   cable, membrane. Each carries its own unit (free text: `bag`, `m3`,
   `pack of 100`), an optional code, an optional reorder level and target.
2. **Take a booked-in delivery straight into stock** — on the purchase order,
   under each posted GRN line. A human picks the catalogue item and the place;
   the quantity comes from the delivery evidence. Idempotent: a double tap in a
   yard writes one movement.
3. **See what they hold and where** — `/stock` (overview, low-stock, per-location
   holdings, recent movements), `/stock/items/[id]` (balances by site + full
   history + provenance links), `/stock/locations/[id]` (one yard's holdings).
4. **Issue stock out**, optionally naming the job it went to. The job link is
   *provenance*, not a cost — see the boundary above.
5. **Move stock between two of their own places**, in one transaction, with the
   pair recoverable for ever via `transfer_group_id`.
6. **Record a stock-take** (admin only): type what you counted, CrewFlow works
   out the difference, and a reason is required.
7. **Reverse a mistake** with a `correction` that names the movement it reverses.
   Nothing is ever edited or deleted; both entries stay visible.
8. **Be told when something runs low** — a Daily Briefing line at `medium`,
   lifting to `high` only when something is actually at zero.

---

## Design decisions and their evidence

### Balance is derived. There is no stored quantity, anywhere.

`stock_balance(org, item, site)` sums `effect`; `stock_balances` is a
`security_invoker` view over the same sum; `lib/stock/balance.ts` does the
identical fold in TypeScript for surfaces that already hold the rows. A stored
running total is a second source of truth, and the day it disagrees with the
ledger — a lost write, a restored backup, a trigger that did not fire — it lies
silently and for ever.

### `effect`: the signed quantity, assigned by trigger, then frozen

`qty` is always positive (`CHECK qty > 0`). The direction comes from
`movement_type`:

| type | effect |
|---|---|
| `receipt`, `transfer_in`, `adjustment_in` | `+qty` |
| `issue`, `transfer_out`, `adjustment_out` | `−qty` |
| `correction` | `−(effect of the movement it corrects)` |

The first six are pure functions of the type and are mirrored exactly in
`lib/stock/movements.ts`. `correction` is the one direction that is *not* a
function of its own row, so it is resolved once at insert by
`tg_stock_movements_derive` and **stored** — which keeps the balance a plain
`sum(effect)` with no correlated lookup. The write-once trigger then freezes it
like every other column. It is a per-movement immutable derived fact, not a
running balance.

### Negative stock is REFUSED (default posture; escalated)

You cannot issue 10 from a site holding 6. Same shape of decision as the
over-receipt block in `20261060000000`: a tolerance is a real operational
decision with consequences (a negative balance means either the count is wrong
or something walked, and silently permitting it destroys the one signal that
would have told you), and nobody has made it. The honest path is an
`adjustment_in` with a reason, which leaves a record.

**ESCALATED**: if builders routinely issue ahead of booking deliveries in, this
becomes a per-org tolerance setting, and the four RPCs are the single place it
would be applied.

### The per-(item, site) advisory lock — PROVEN, not reasoned about

The refusal is a read-then-write and is only sound under a lock. Every outbound
path takes `pg_advisory_xact_lock(hashtext('stock_balance'),
stock_lock_key(item, site))` **before** it reads. Narrowest granularity that
makes the check sound: two issues of different items, or the same item at
different sites, never block each other. Only the FROM side of a transfer is
locked (the TO side only ever gains), which also removes the A→B/B→A deadlock.

**Two real psql sessions, last 10 units, both issuing 10:**

```
WITH the lock                                   WITHOUT the lock (counterfactual)
─────────────────────────────────────────────   ─────────────────────────────────────────
A: record_stock_issue(...,10) → ok              A: record_stock_issue_nolock(...,10) → ok
B: blocks on the advisory lock                  B: reads "10 available" too → ok
A: COMMIT                                       A: COMMIT
B: unblocks, re-reads balance 0                 B: COMMIT
   ERROR: not enough Blocks: 0.00 in stock
   at this site, 10.00 requested
final_balance = 0.00, issues = 1                final_balance = -10.00, issues = 2
```

**Transfer conservation under the same race** (depot holds 10; A moves 10 to the
yard, B concurrently moves 10 to the lock-up):

```
A: record_stock_transfer(depot → yard, 10) → ok, COMMIT
B: ERROR: not enough Blocks: 0.00 in stock at the site it is leaving, 10.00 requested
company_total: 10.00 before → 10.00 after      depot 0.00 · yard 10.00 · lock-up (no rows)
```

### The GRN void rule: **refuse the void while the stock receipt stands**

Once a delivery line has been taken into stock, voiding its GRN could mean
either (a) auto-correct the stock receipt, or (b) refuse the void until the
receipt has been corrected explicitly. **This milestone chose (b).**

1. **The goods are real.** The commonest void reason is "booked against the
   wrong order" — the lorry still came, the blocks are still in the yard.
   Auto-reversing would tell the storeman that 40 blocks he can see do not
   exist, which is a worse lie than the one being corrected.
2. **It would break the ledger's own invariant.** If some of those blocks have
   already been issued, the auto-correction drives the balance negative — so the
   void would either fail anyway (with a baffling message from two layers down)
   or violate the negative-stock rule. A rule with an exception for the
   convenient case is not a rule.
3. **It matches the house doctrine.** Every correction in this codebase is an
   explicit, reasoned, attributed act. A stock correction that happened as a
   side effect of an unrelated action would be the only silent one.

The operator's path: correct the stock receipt (recording why), then void the
GRN. `tg_grn_void_stock_guard` says exactly that. Once the GRN is voided and a
corrected one is posted, its **new** line ids are freely receivable — the two
models compose cleanly.

Implemented as a **separate trigger**, not an edit to
`void_goods_received_note()`: whichever migration replaces a shared function
*last* silently wins (the reasoning `20261061000000` states explicitly), and a
dedicated validator also covers a direct PostgREST PATCH.

### Idempotency: one receipt movement per delivery line, ever

`stock_movements_grn_line_receipt_uniq` — a partial unique index on
`(grn_line_id) where movement_type = 'receipt'`.

**Deliberate deviation from the brief**, which specified `… and not corrected`.
That predicate is not expressible without a **mutable** `corrected` column on an
append-only ledger, which is precisely what the ledger exists to refuse. It is
also unnecessary — every operational need it would serve is already served:

| situation | route |
|---|---|
| wrong **site** | `record_stock_transfer` — the goods are real and already in the system |
| wrong **quantity** | a `correction`, then an adjustment stating the true figure |
| never **arrived** | a `correction`, then void the GRN; the replacement GRN's new line ids are receivable |

So "not corrected" lands in the **void guard**, where it is a question about
another row and belongs, instead of in an index, where it would have cost the
ledger its immutability.

### What is NOT a stock location

**Vehicles are not.** `asset_assignments` models *custody of a serialised
asset* — one specific drill, one open assignment, enforced by
`asset_assignments_one_open_idx`. That is an identity model. Stock is a
*fungible quantity* model: 400 blocks are not 400 identities. Bolting fungible
balances onto the custody table would break its one-open invariant; bolting
custody onto this ledger would give a drill a balance of 1. **Van stock is a
real need and is deferred debt** — the honest way in is a `sites` kind or a
first-class "mobile location", decided with the fleet lane, not a `vehicle_id`
column smuggled into this table.

**Jobs are not.** `sites` deliberately excludes job sites
(`20261061000000`: ownership, lifecycle, cardinality, authority). An **issue to
a job is consumption with job provenance**, not a transfer into a job-shaped
location: the quantity leaves and does not come back, `job_id` records why, and
a job never has a balance nobody can be asked to count.

### RLS: `stock_items` follows `suppliers`, not `sites`

The two reference-data precedents disagree, deliberately:

| table | posture | justification |
|---|---|---|
| `sites` (20261061) | members read / **admins** write | blast radius — renaming a depot re-labels every van and custody record |
| `suppliers` (20260623) | members read / **members** write, admins delete | cadence — added constantly, mid-job, by whoever is buying |

A stock item is the **suppliers** shape on both counts. The person standing at
the lorry must be able to name a new product and put it away; an admin-only
register dead-ends the receive-into-stock flow for exactly the person doing the
work. And renaming an item re-labels its own movements and nothing else.

`stock_movements` gets SELECT + INSERT for members and **no** UPDATE or DELETE
policy at all — the triggers refuse both for every role, and omitting the
policies means a JWT caller is refused twice over.

### Adjustments are admin-only

Every other movement has a counterparty that constrains it: a receipt is capped
by a posted delivery line, an issue by the balance, a transfer conserves. An
adjustment has none — it creates or destroys quantity on somebody's say-so
alone. It is the write that can conceal a loss. `is_org_admin` is the house
boundary for that class (`cis_subcontractors`, `supplier_payments`). JWT-gated
(the `20261034000000` asymmetry) so the trusted service role can still seed.

---

## A Next.js finding, recorded because it cost real time

**`revalidatePath` inside a `useActionState` server action can stop the action's
state from ever committing.**

Symptom: issuing stock wrote the movement, the POST returned **200**, and the
form sat on "Saving…" for ever. The URL never moved, no error appeared, and a
real operator would have issued the same stock twice. This is the Next 15.5
deep-swap commit race in its *action-weight* form — the response carries a
re-rendered RSC tree for every revalidated route, and the client never commits.

Bisect (each step a full `next build` + the e2e journey):

| revalidated paths in the action | result |
|---|---|
| `/stock`, `/stock/items`, `/stock/items/[id]` | hang |
| `/stock/items/[id]` only (`"page"` form) | hang |
| none | whole journey green in **1.9s** |

The fix is also the correct simplification: **every route this milestone touches
is rendered on demand** (`force-dynamic`, or dynamic because it reads cookies),
so there was no cache entry to invalidate in the first place — and every stock
write ends in `window.location.assign`, a full document navigation that fetches
the destination fresh anyway. `app/(app)/stock/actions.ts` therefore performs no
revalidation at all, says why at length, and
`__tests__/security/operational-stock.test.ts` fails if it comes back.

---

## Deferred debt

| item | why it is deferred | where it lands |
|---|---|---|
| **`material_request_line_id` FK** | the M4 lane's `material_request_lines` table does not exist yet (they own slots 66/67) | the first M4 migration; the exact DDL is in the `20261064000000` column comment |
| **Van / mobile stock** | custody ≠ fungible quantity (above) | a `sites` kind or a mobile-location concept, decided with the fleet lane |
| **Return from job** | "did it come back or was it never used" is a stock-take question this milestone does not ask | a return affordance once stock-takes exist |
| **Direct-insert residue** | `stock_movements` grants members INSERT because the RPCs are SECURITY INVOKER, so a direct PostgREST write can bypass the lock and drive a balance negative. Closing it means either SECURITY DEFINER (losing RLS + every guard — a worse trade) or a full re-sum constraint trigger (still unserialised) | revisit if a tolerance setting is ever added |
| **Movement paging** | `listStockMovements` reads up to `STOCK_MOVEMENT_LIMIT` (5000) and folds in-process, because the same rows drive both the balances and the history | if a tenant outgrows it: the `stock_balances` view for totals + a paged history |
| **Site delete message** | a site holding stock is protected by a *deferred* FK, so the refusal arrives at COMMIT as a raw `23503` rather than the friendly `tg_sites_delete_guard` message | extending that guard means redefining another milestone's function — see `20261061000000`'s own warning about last-writer-wins |

## Escalations for the CEO

1. **D1 — stock valuation.** Should stock be an asset released to cost on issue?
   Until decided, this stays a quantity ledger. (No action needed to keep
   shipping; the ledger is a prerequisite either way.)
2. **Negative-stock tolerance.** Currently refused outright. If merchants'
   habits make that impractical, it becomes a per-org setting applied in the
   four RPCs.
