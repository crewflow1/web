# O3 — Operational stock

Migrations `20261063000000` – `20261065000000`, hardened by `20261069000000`
(transfer-leg corrections) and `20261071000000` (residual hardening: the two
cross-lane FKs, the write-path gate, the derived fulfilment RPC). Surface:
`/stock`, plus a "put into stock" affordance on the purchase-order page.

---

## THE ACCOUNTING BOUNDARY — read this first

**The base ledger is an operational QUANTITY ledger. On top of it sits a
weighted-average COST valuation that posts to no accounts.** Stock movements —
quantity and cost alike — **never** post to `public.finances`.

Purchased materials are *already* expensed when the supplier's bill is recorded
(`recordSupplierBill` → `finances`, migration `20261009000000`). That is the
**single authoritative expensing** of materials into the company P&L, and it
lands exactly once. Issuing 10 boards to Job A records *"10 boards moved Depot →
Job A"* and **no new expense** in the accounts. A second posting to `finances`
would **double-count** the same spend — once when the supplier invoiced, once
when the boards left the shelf — and would silently inflate the cost of sale on
every affected job. Invisible until year end.

### D1 is DECIDED: weighted-average cost (migration `20261180000000`)

*"Should stock be capitalised as an asset and released to cost when it is
issued?"* was **CEO decision D1**. It is now **DECIDED: weighted-average cost.**
It is implemented as a **management-accounting overlay** on the quantity ledger,
built so it is double-count-safe by construction:

- **Capitalise on receipt, release on issue** — but in a *valuation ledger*, not
  the General Ledger. A receipt capitalises value (`cost_effect > 0`); an issue
  releases it as COGS (`cost_effect < 0`). Both happen on the movement row, never
  in `finances`.
- **No new P&L posting.** Because the overlay writes nothing to `finances`, the
  company's cost of sale is byte-identical with or without it — so a company
  total can **never double-count**. This is *the* double-count-safety argument.
- **Cost basis** = the delivery line's *ordered* unit price
  (`goods_received_lines → purchase_order_line_items.unit_price`), the same basis
  the three-way match values received goods at. Recomputed to a running
  weighted-average per `(item, org)` as receipts arrive.
- **COGS-on-issue → job costing** is surfaced as an **allocation** stream
  (`buildStockCogsCostRows`, `lib/stock/valuation.ts`), composed into job
  profitability exactly as labour is. It **re-classifies** the depot-replenishment
  spend onto the consuming job; it is not a second expense. Its **one assumption**
  (flagged, not hidden): stock-replenishment supplier bills are booked to the
  depot (`finances.job_id` null) while job-specific direct purchases are not also
  issued from stock — so a job's material cost is *either* a direct bill *or* a
  stock issue, never both. The allocation is exposed as a **distinct, labelled
  stream** so a job that carried both stays auditable rather than silently
  doubled, and it is **not auto-injected** into live job margins by the
  migration.
- **No stored average.** The weighted-average is *derived* (`book_value =
  Σ cost_effect`, `avg = book_value / costed_qty`), held to the same standard as
  the balance: a stored running total is a second source of truth that lies the
  first time a write is lost. The `stock_valuation` view is `security_invoker`.
- **Historical safety.** Every pre-`20261180` movement has `cost_effect` NULL and
  is treated as **uncosted** — outside both sums, so it never drags the average
  toward zero and never divides by zero. The report shows physical on-hand *and*
  the uncosted quantity separately: *"N units at unknown cost"*, never *"worth
  £0"*.

There is still **no VAT anywhere** in stock — VAT is reclaimable and belongs to
the supplier bill, not to a quantity or a cost of sale.

**Enforced, not merely stated.** `__tests__/security/operational-stock.test.ts`
asserts that no file in this milestone — the valuation overlay included —
contains an executable reference to `finances`, performs no insert/update/delete
against it, and creates no trigger on it; that the quantity ledger inlines no
money; that the average is derived (no stored aggregate); and that the cost
trigger stamps the row but writes no other table.

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

### Only a stock write path may insert a movement (`20261071000000`)

Members held a bare INSERT policy on `stock_movements`, because the write RPCs
are `SECURITY INVOKER` and need the caller's own insert right. That was recorded
as **one** accepted residue — "can drive a balance negative". Probed as a plain
`staff` member with an ordinary JWT straight against PostgREST, it was **four**,
and three of them are authority bypasses rather than self-harm:

| # | direct insert | result before `20261071` |
|---|---|---|
| 1 | `issue` 1000 against a site holding 10 | accepted, **balance −990** |
| 2 | `adjustment_out` | accepted — **the admin-only adjustment gate bypassed** |
| 3 | bare `transfer_in` 500 | accepted — **stock manufactured from nothing** |
| 4 | `receipt` off a **draft** GRN line | accepted — **posted-evidence check bypassed** |

Defect 2 walks straight past the gate that `20261065000000` §4 argues for at
length ("the write that can conceal a loss, and the reason a stock system is
believed or not"). Defect 3 is the same class `20261069000000` fixed for
transfer-leg corrections, by a plainer route.

**The fix keeps every RPC `SECURITY INVOKER` and makes the insert right
conditional on being inside one.** A transaction-local marker
(`crewflow.stock_write`, set to the org id) is required by the insert policy and
by a `BEFORE INSERT` trigger; each of the five write paths sets it immediately
before its `INSERT` and clears it immediately after. This is the idiom
`20261067000000` already uses for `crewflow.mr_fulfilment`.

**Why not the two options that were written down:**

- **A balance constraint trigger** fixes only defect 1 — it polices the *number*,
  not the *authority*, and three of the four are authority. It is not sound alone
  either (a per-row re-sum is not serialised without the same advisory lock the
  direct path skipped). And the cost is **unbounded**: measured on this schema,
  200 reps per figure, one `(item, site)` pair —

  | movements at the pair | balance `SUM` | bare `INSERT` | ratio |
  |---|---|---|---|
  | 1 000 | 0.125 ms | 0.047 ms | **2.7×** |
  | 10 000 | 0.709 ms | 0.035 ms | **20.3×** |

  The insert is flat; the aggregate grows linearly with an append-only ledger, so
  it only ever gets worse.
- **`SECURITY DEFINER` write paths** would give up the caller's RLS, every guard
  trigger and every composite FK on the path — the "none of these is a privileged
  back door" property the milestone was built around — and would need tenancy
  re-implemented in five places.

**`service_role` stays trusted, deliberately.** It is not a tenant principal, and
every authority check in this schema is JWT-gated the same way (the adjustment
gate, `tg_ra_lifecycle`, `tg_goods_received_note_lifecycle`,
`tg_material_request_transition`). A negative balance is still *constructible* by
trusted server-side code; it is no longer constructible by any user of the
product.

**Mutation proof** (one transaction, rolled back; role `authenticated` with a real
JWT `sub`, so `auth.uid()` and `current_org_ids()` behave as in production):

```
3a  gate PRESENT   member direct `issue` 1000        → ERROR 42501 (write-path gate)
3b  gate PRESENT   same member via record_stock_issue → ok, balance 6.00
3c  gate REMOVED   issue 1000 + adjustment_out 5 + transfer_in 500
                   → all three INSERT 0 1, balance_without_the_gate = -495.00
3d  gate RESTORED  member direct `issue` 1000        → ERROR 42501 again
```

### The two cross-lane FKs, closed (`20261071000000`)

`stock_movements.material_request_line_id` and
`material_request_lines.stock_item_id` were plain uuids with no integrity in
either direction — the two lanes were built in parallel and neither table existed
on the other's branch. Both candidate keys (`material_request_lines_id_org_key`,
`stock_items_id_org_key`) were added at the time so this could be closed without
touching either table's shape.

Until now the refusal of a crafted cross-org line id was the **seam's active-org
read filter**, which never stopped the write. Both are now composite,
org-binding, `NO ACTION DEFERRABLE INITIALLY DEFERRED` (never `RESTRICT` — that
can never be deferred, and a cascade that removes one side first would abort
tenant teardown, which is exactly how the `20261052000000` P1 happened).

Added **`NOT VALID` then `VALIDATE` in a handler**, so the migration cannot fail
on dirty data. Neither column can be repaired in place: `stock_movements` refuses
every UPDATE for every role, and request lines freeze once submitted — a repair
would mean disabling another milestone's guard triggers to rewrite ledger
history. Clean data validates (local pre-check: **0 violations on both**); dirty
data leaves the constraint `NOT VALID`, still enforcing every new write, with a
`WARNING` naming the count instead of a failed release.

**Mutation proof** (same rolled-back transaction):

```
1a  FK PRESENT   org-B movement carrying org-A's line id  → ERROR 23503
1b  FK DROPPED   the same write                           → INSERT 0 1, orphan_rows_written = 1
1c  FK NOT VALID every NEW write                           → ERROR 23503
1d  FK NOT VALID `VALIDATE CONSTRAINT` with the orphan     → ERROR 23503
                 ^ why the migration splits add from validate
2a  FK PRESENT   org-A line naming org-B's stock item      → ERROR 23503
2b  FK DROPPED   the same line                             → INSERT 0 1, cross_org_lines = 1
```

### Material-request fulfilment is derived *in the database* (`20261071000000`)

M4 shipped `advance_material_request_fulfilment(request, org, p_fulfilled jsonb)`
taking the quantities from its caller, because on its own branch only the app
could read a stock schema that was not frozen yet. Its own header named the debt
and the fix. Confirmed live: **a plain member called it with a fabricated
`p_fulfilled` and moved their own org's request to `partially_fulfilled` with zero
issue movements in existence.**

The 3-argument form is now **dropped, not ignored** — an inert parameter that
still looks authoritative is how a trust boundary gets quietly restored. The RPC
derives the quantities itself, using the same rule the app-side reader uses:
sum `qty` over `movement_type = 'issue'` carrying each line id, **excluding any
issue that has been reversed** (`not exists (correction where
corrects_movement_id = m.id)`), because `record_stock_correction` does not copy
the line id onto the correction row — so a naive sum over-reports a reversed issue
and would leave a stripped site reading "fulfilled". It stays `SECURITY INVOKER`,
so the derivation is RLS-filtered *and* pinned to `p_org_id`.

`server/services/material-fulfilment.ts` therefore passes **two ids and nothing
else**, and `reconcileRequestFulfilment` no longer needs a `stockModulePending`
guard: the sum is now measured inside the same transaction as the write, over
tables this migration hard-depends on, so "we could not see the stock lane" is not
a state that path can be in.

### `fulfilled` is a cache, so it can be corrected (`20261071000000`)

M4 froze `fulfilled` as terminal and made the RPC forward-only, so correcting the
issues behind a fully-fulfilled request fixed the derived display while the
`status` column went on saying `fulfilled` for ever. That column is not
decoration: it drives the office queue's filters, the badge, and
`isMaterialRequestOverdue` (which treats `fulfilled` as "nobody is waiting"). A
site whose cement was booked out and then reversed silently dropped off the
office's radar.

**Why this is not a loosening.** `status` is a cache of a derivation — both
`20261067000000` and the seam say so — and a cache that can only move one way is
a cache that can be wrong. Now that the derivation lives in the database, the
cache can simply follow it, and the question *"who may walk it back?"* dissolves:
nobody may, because it is not a human act. It is a re-derivation, requested
through the same single writer, gated by the same transaction marker, computed
from the same ledger. The graph gains exactly **one** edge.

**The invariant, and it is tested:** `status = 'fulfilled'` ⟹ the derived position
is `full`.

Scope kept narrow:

- `rejected` and `cancelled` stay **hard terminal** — human decisions, no
  carve-out.
- The walk-back lands on `partially_fulfilled`, never on `approved`, even when the
  derivation drops to `none`. "Open, and something happened here" is exactly true
  after a reversal, and it preserves the existing rule that an issue which
  happened cannot un-happen from this side. The precise position (`none` vs
  `partial`) is what every surface renders, derived live.
- A **hand-set** move out of `fulfilled` is still refused — with the same
  `% is final` message it always had, so the derived path is not advertised.
  Proven for an *admin*, the strongest tenant role.

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
| ~~**`material_request_line_id` FK**~~ | **CLOSED by `20261071000000`** — both cross-lane FKs are now composite, org-binding and validated | — |
| ~~**Direct-insert residue**~~ | **CLOSED by `20261071000000`** — the write-path marker; and it was four defects, not one (see above) | — |
| **Van / mobile stock** | custody ≠ fungible quantity (above) | a `sites` kind or a mobile-location concept, decided with the fleet lane |
| **Return from job** | "did it come back or was it never used" is a stock-take question this milestone does not ask | a return affordance once stock-takes exist |
| **`service_role` can still construct a negative balance** | it bypasses RLS and the write-path gate is JWT-gated, matching every other authority check in this schema. Making it unrepresentable needs the balance constraint trigger whose cost is measured above (20.3× the insert at 10k movements, growing) and which would still only cover *one* of the four defects | revisit only if untrusted code ever holds the service key — at which point far more than stock is exposed |
| **Movement paging** | `listStockMovements` reads up to `STOCK_MOVEMENT_LIMIT` (5000) and folds in-process, because the same rows drive both the balances and the history | if a tenant outgrows it: the `stock_balances` view for totals + a paged history |
| **Site delete message** | a site holding stock is protected by a *deferred* FK, so the refusal arrives at COMMIT as a raw `23503` rather than the friendly `tg_sites_delete_guard` message | extending that guard means redefining another milestone's function — see `20261061000000`'s own warning about last-writer-wins |
| **Stock-item delete message** | same shape, newly introduced: deleting an item a *request line* names is now refused by `material_request_lines_item_org_fkey` at COMMIT as a raw `23503`. The app never offers item deletion (deactivate instead), so no user path reaches it | a friendly pre-check in the delete action if item deletion is ever surfaced |

## Escalations for the CEO

1. **D1 — stock valuation. DECIDED: weighted-average cost** (migration
   `20261180000000`). Built as a double-count-safe management-accounting overlay
   (see the boundary section above). **One CEO/finance policy question remains for
   activation:** turning the stock-COGS **job allocation** on in live job margins
   assumes stock-replenishment supplier bills are booked to the depot
   (`finances.job_id` null), not to a job. That convention holds today for
   depot→issue flows; confirm it (or adopt capitalise-on-receipt in `finances`
   itself) before `buildStockCogsCostRows` is composed into the live dashboard.
   The valuation report itself needs no such decision and is live now.
2. **Negative-stock tolerance.** Currently refused outright, and since
   `20261071000000` refused on *every* path a user can reach rather than only the
   RPCs. If merchants' habits make that impractical, it becomes a per-org setting
   applied in the four RPCs — which are now genuinely the only way in.
3. **Should `correction` be admin-gated?** `20261069000000` decided *no*, on three
   grounds that all held only because a correction has a counterparty, is floored,
   and cannot be silent. That reasoning is unchanged and now rests on firmer
   ground (a member can no longer insert a correction directly at all). Recorded
   here because it is a policy question, not a technical one.
