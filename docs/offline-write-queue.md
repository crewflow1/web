# Offline Write Queue — the first offline WRITE in CrewFlow

Before this, "offline mode" meant **offline READ**. Programme E cached authorised drawing
bytes in IndexedDB; Programme F added a service worker and a real offline application
shell so a cold, no-signal launch opened CrewFlow's own page instead of Chrome's error
screen. Both are genuinely good. Both are read-only. A foreman standing in a basement
could open a drawing he had downloaded — and do **nothing else**. No diary entry, no
snag, no photo. In UK construction, basements and steel frames have no signal and
"works offline" is a purchase criterion, so the honest description of the product was
that it did not work offline; it *displayed* offline.

This milestone builds the missing half: a **write queue (outbox)** with real idempotency,
real shared-device safety, and honest UI — plus **exactly one** vertical wired end to
end to prove it. Nothing else becomes offline-writable, and that is a decision the
registry records rather than a limitation the code merely happens to have.

## What ships

| File | What it is |
|---|---|
| `lib/offline/registry.ts` | **The writable-entity registry.** One table, one place. What may be authored offline, and why everything else may not. |
| `lib/offline/write-queue.ts` | The outbox: IndexedDB store, partitioned by `userId::orgId`, ordered, bounded, purgeable. Sibling of `lib/blueprints/offline-store.ts`. |
| `server/services/offline-writes.ts` | The **shared write core** (used by the online form *and* the queued replay) + the queued-write trust boundary. |
| `app/(app)/offline-sync-actions.ts` | The one server action the queue calls. Thin: `requireOrgContext()` then dispatch. |
| `app/(app)/_components/offline-outbox.tsx` | The app-wide status strip: saved-on-device / syncing / not-accepted. Flushes the queue. |
| `app/(app)/diary/_form.tsx` | The diary form, now with an offline branch (create only). |
| `supabase/migrations/20261077000000_offline_write_queue.sql` | `client_write_key` + `offline_authored_at` on `site_diary_entries`, and the partial unique index that **is** the idempotency guarantee. |

Zero new dependencies, zero new infrastructure, zero server idle cost. No background
sync API, no push, no queue service, no Redis.

## Scope: infrastructure generic, one vertical enabled

**Which entities become offline-writable is a product decision, not an engineering one.**
So the queue is generic and the *permission* is a small, explicit registry.

**Enabled: `site_diary.create`.** Chosen because a diary entry is the one write in the
product that can be replayed hours later without anybody having to invent a policy:

- **append-only** — it creates a row, never mutates one somebody else may have changed;
- **single-author** — one person recording their own day, so no realistic concurrent editor;
- **no financial consequence** — nothing prices, invoices, allocates stock or pays anyone;
- **no sequencing** — it neither depends on nor invalidates another queued write.

A diary entry is also exactly what a foreman loses today. It is the record that settles
progress disputes, and it is written on site, at the end of the day, where the signal is.

**Everything else stays read-only offline**, with per-entity reasons recorded in the
registry: snags (lifecycle + photos are binary), timesheets (payroll — a duplicate is
money paid), expenses (money out + receipt image), quotes/invoices/POs (the number *is*
identity; offline numbering forks the sequence), stock movements (the ledger is
order-dependent by design — 20261069/71), H&S sign-offs and permits (a signature has
force at the moment it is given), toolbox talks (attendance evidence with a provenance
chain from 20261031-37).

### Enabling a second entity takes three deliberate acts

1. **A migration** adding `client_write_key` + a partial unique index on that table.
2. **A registry row** in `lib/offline/registry.ts`.
3. **A server handler** in `server/services/offline-writes.ts`.

A no-drift test asserts (2) and (3) stay in lockstep and that the enabled entity has (1).
Nothing becomes offline-writable by accident, and the database gate cannot be opened from
application code at all.

## Idempotency — the part that must not be JavaScript

A queued write that is retried must not create a duplicate. Retries are not exotic: a lost
response, a reinstalled service worker, a restored browser profile, two open tabs, a
double-tap with gloves on.

**The guarantee is a partial unique index:**

```sql
create unique index site_diary_entries_client_write_key_uidx
  on public.site_diary_entries (org_id, client_write_key)
  where client_write_key is not null;
```

The key is generated **once** on the device (`crypto.randomUUID()`), persisted **with** the
queued item, and never regenerated on retry. A replay raises `23505`; the write core
answers it by looking the row up by `(org_id, client_write_key)` — pinned to the active
org — and reporting `duplicate` with the original id. The outbox treats `duplicate`
exactly like `accepted`: the item is done, not lost, not retried forever.

### Why the key is on the row, not in a receipts table

The obvious generic design is a side table (`offline_write_receipts`) written next to the
entity. It is a data-loss machine:

```
insert receipt;   ← succeeds
insert entity;    ← connection dies
```

leaves a receipt with no entity. The next replay sees the receipt, reports "already
recorded", and the foreman's day is gone with a green tick on it. Those two statements are
only safe inside one transaction, and supabase-js issues one statement per call — so that
design forces a `SECURITY DEFINER` RPC purely to buy atomicity, i.e. a privileged write
path bolted onto a feature whose entire security argument is *"no privileged bypass path"*.

Putting the key on the row makes the write **one statement**, so atomicity is structural:
either the row and its key exist, or neither does. The cost — a migration per entity — is
the gate described above, not a drawback.

### Proof

`__tests__/integration/rls/offline-write-idempotency.test.ts`, against real Postgres, on
the **authenticated user client** (the path the app actually writes through):

- the same item replayed twice → **one row**, second insert `23505`;
- five further replays, including a **mutated payload** → still one row, and the **first**
  row is the survivor (a replay never overwrites);
- the surviving row is findable by `(org_id, client_write_key)` under the user's own client;
- the index is **org-scoped**: the same key in another org is a separate row;
- NULL keys never collide (pre-existing rows unaffected);
- and — deliberately uncomfortable — **the database alone does not prevent re-homing**, which
  is why the application pins the org (below).

`e2e/offline-diary-queue.spec.ts` proves the same thing in a real browser by putting the
stored item **back** into IndexedDB after it synced and letting it flush again: still one row.

## Shared-device safety — the highest-severity risk in this lane

Site tablets get passed between people. Queued writes are **unsent user data**: leaving
them is a leak, deleting them silently is data loss. Four independent controls:

1. **Partition.** Every item is keyed `userId::orgId::clientKey` and read only through its
   partition, with a body-level guard (`queuedWriteMatchesPartition`) so a forged key can't
   slip a foreign record into a flush. User B's outbox cannot see user A's work.
2. **Server-trusted identity.** The outbox and the diary form receive `userId`/`orgId` from
   the page's own `requireOrgContext()` — **never** from the client-side offline identity
   marker. Attributing newly authored words to whoever the device last remembered is an
   attribution hazard; reading already-downloaded bytes is not.
3. **Foreign-partition purge.** `purgeForeignUsers()` runs on every outbox mount, **before**
   any flush, and deletes every item that is not the signed-in user's. This covers what a
   logout purge cannot: a session that merely expired, or a tablet closed and handed over.
4. **Logout purge, with a warning.** `SignOutButton` purges the queue **before**
   `signOut()` — but first counts what is unsent and, if anything is, asks:

   > *2 entries have not been sent to CrewFlow yet. Signing out deletes them from this
   > device for good… Cancel, get a signal, and let them sync first — or press OK to sign out
   > and lose them.*

   Cancelling aborts the sign-out and keeps the work. This is the only honest resolution:
   the person who wrote the entries is the only one who can weigh it, and they cannot weigh
   it if they are not told. The unsent count is also badged on the Sign out button itself.

The pre-existing drawing-cache purge is unchanged and still runs before `signOut()`.

## No privileged path — a queued write is not a special write

`syncQueuedWrite` establishes identity with the same `await requireOrgContext()` every
online action uses, then hands off. The checks, cheapest first:

1. **envelope shape** — a hand-crafted request is not a queued write;
2. **registry gate** — naming `invoices.create` achieves nothing;
3. **active-org pin** — the write lands in the org that was active when it was authored,
   or it does not land. **Refused, never re-homed.** A diary entry written for Company A must
   not become Company A's evidence filed under Company B because the user touched the org
   switcher before the van found signal;
4. **the entity's own Zod schema** — the same object the online action validates with;
5. **the shared write core**, on the **tenant (user-JWT)** client, under the unchanged
   `site_diary_entries` RLS policies.

No service-role client, no RPC, no `SECURITY DEFINER`, no batch/admin variant, no argument
that changes attribution — `created_by` is the session user. The migration adds no policy,
no grant, no function, and weakens no RLS. Asserted in
`__tests__/security/offline-write-queue.test.ts`; the live-DB half (a non-member and anon
are still refused even carrying an idempotency key) is in the integration suite.

**One core, two entry points.** `createDiaryEntryRecord` is called by the online form action
*and* by the queued replay. The online path mints its own key server-side, so every row
carries one and there is a single write path to reason about. If the two had separate insert
statements they would eventually drift — and the offline path is precisely the one nobody
would notice drifting.

### A cross-org hardening that fell out of this

`site_diary_entries.job_id` has **no** database-level org guard, and `current_org_ids()`
admits every org a multi-org member belongs to, so a form post (or a queued item authored
before an org switch) could file this org's diary against another org's job. The picker was
org-scoped; the write was not. The shared core now validates `job_id` against the active
org before inserting, which fixes **both** paths at once and turns "the parent job was
deleted" into a clean permanent rejection instead of an opaque FK error.

## Honest UI — saved-on-device is not saved

Three states, never conflated:

- **"Saved on this device."** In IndexedDB. The server has never seen it. Shown on the form
  the moment it is queued, with *"Not sent yet"* and *"don't sign out until it has"*. The
  submit button relabels itself **"Save on this device"** while offline, so nobody discovers
  there was no signal only after tapping Save.
- **"Synced."** The server accepted it. The app-wide strip confirms the count.
- **"Not accepted."** The server **permanently** refused it.

### What happens to a permanently-rejected item

It is **kept**, marked `rejected`, and **never retried**. The outbox shows the reason in
plain words and renders the item's **full content** so the words can be read back and
copied. Only an explicit per-item **Discard** — behind a confirm that says the text will be
gone for good — deletes it. Nothing is ever silently destroyed.

Rejection is an **explicit allowlist** of Postgres codes (`23503`, `23514`, `22P02`,
`42501`) plus the app's own refusals (`unknown_kind`, `invalid_payload`, `org_mismatch`,
`malformed_item`). **Everything unrecognised is a retry.** An expired cookie makes
`requireOrgContext()` redirect, which surfaces to the outbox as a thrown action — treated
as transient, so a signed-out moment can never destroy queued work.

## Ordering and boundedness

- **Ordering** is `seq`, allocated inside the same readwrite transaction as the insert, so
  two concurrent enqueues cannot collide. The flush drains in `seq` order and **stops on
  the first transient failure**, so order is preserved and a dead network does not burn
  through 200 doomed requests. Device clocks are never used to order anything.
- **Bounded, and loud.** `MAX_QUEUED_WRITES` (200/partition), `MAX_QUEUED_ITEM_BYTES` (64 KB),
  `MAX_QUEUE_BYTES` (4 MB/device), plus a `navigator.storage.estimate()` headroom check.
  Every limit returns a typed error with a specific user-facing message, **nothing is ever
  evicted to make room**, and the form is deliberately **not** reset on failure so the words
  are still on screen. A test proves a maximum-length diary entry always fits, so the
  ceiling can never refuse a legitimate entry.

## Deliberately NOT built

- **Conflict resolution.** No merge policy, no vector clocks, no last-write-wins. That is
  why the enabled vertical is append-only and single-author: this milestone cannot honestly
  settle a conflict policy, so it enables nothing that needs one. `site_diary.update` and
  `delete` stay online-only.
- **Photos / binary uploads.** The queue carries JSON payloads only. Offline photos mean
  queuing multi-megabyte Blobs against a shared origin quota, resumable Storage uploads, and
  an attachment row that must land atomically with bytes it cannot see. It deserves its own
  milestone — and it is the reason **snags** are not enabled, since a snag without its photo
  is a worse record than no snag.
- **Cold-launch offline AUTHORING.** The public `/offline` shell shows the unsent **count**
  (a foreman relaunching in a basement needs to know his day is not lost) and nothing more:
  no content, no dates, no author. It has no form. Authoring requires a page the server
  rendered while authenticated — see control 2 above. So the covered journey is *load the
  form in the van, lose signal, write the entry* — not *launch the app cold with no signal
  and write one*. That gap is real and is stated rather than glossed.
- **Background Sync API.** The flush runs on mount, on `online`, on tab
  focus (a phone waking in a pocket fires no `online` event) and on a **Sync now** button.
  A true background sync would send work while the app is closed, which needs the service
  worker to hold a session — a much larger security question.
- **Catching a lying `navigator.onLine`.** One bar of signal, or site wifi with no route out,
  reports **online**, so the form posts and the post fails — the behaviour this page already
  had. Fixing it means routing the successful online save through client-driven submission
  too, changing how every diary save navigates (and touching the Next 15.5 deep-swap
  navigation race). That is a bigger change than this milestone should make to a working
  path. The clean no-signal case is what is covered.

## What the CEO must decide to widen the writable set

Each of these is a policy question, not a technical blocker:

1. **Snags offline — with or without photos?** Enabling snags without binary upload ships a
   snag with no evidence photo. Is a text-only snag better than none, or does it devalue the
   record? (Binary upload is the dependency.)
2. **Timesheets offline.** A replayed or mis-attributed time entry becomes money paid. Does
   an offline-authored timesheet need an explicit approval step before it reaches payroll?
3. **H&S sign-offs and permits offline.** Is a signature captured at 14:00 and recorded at
   19:00 — under a RAMS that may have changed at 16:00 — a signature your insurer accepts?
   This is a legal question before it is a product one.
4. **Numbered documents (quotes, invoices, POs).** Offline creation forks the number
   sequence. Is a provisional/local number acceptable, or must numbering stay online-only?
5. **Cold-launch authoring on a shared tablet.** Allowing it means attributing work
   authored on a page no server session rendered. Acceptable on a personal phone; on a
   shared tablet it can attribute one person's words to the next person who signs in. Split
   by device type, or leave it closed?
6. **The unsent-work-versus-logout trade-off.** Today the user is warned and chooses. The
   alternative — refusing to sign out until the queue drains — is safer for the data and
   worse on a tablet being handed over right now. Confirm the current choice.

## Testing

- **Unit — `__tests__/offline/write-queue.test.ts` (35):** partition keys and guards,
  registry + schema gates, unknown-key stripping (a credential cannot be smuggled into the
  store), key persistence across retries, per-partition monotonic `seq` including concurrent
  enqueues, `queue_full`/`quota_exceeded` refusing **without eviction**, transient vs
  permanent status transitions with content intact, `purgeForeignUsers`, `clearForUser`,
  logout `clearAll`, graceful degradation with no IndexedDB, and a forged-partition record
  proven ineligible for a flush.
- **Unit — `__tests__/offline/registry.test.ts` (13):** exactly one entity enabled; no money
  / lifecycle / signature / numbered document; no update or delete; registry ↔ handler
  no-drift both ways; the enabled entity has the DB index; the rationale for each
  not-enabled entity is actually recorded.
- **Security — `__tests__/security/offline-write-queue.test.ts` (40):** `requireOrgContext`
  before dispatch; no service-role/RPC/`SECURITY DEFINER`; tenant client for the entity
  write; org pin refuses (behavioural, calling `dispatchOfflineWrite` directly); `created_by`
  from the session; duplicate lookup org-pinned; registry gate ordering; retry-by-default
  failure classification; rejected items retained and recoverable; logout purge ordering +
  the warning; the public shell exposes a count only; migration additive, no new FK, no
  RESTRICT, no policy change.
- **Integration — `__tests__/integration/rls/offline-write-idempotency.test.ts` (11):** the
  idempotency proofs above, plus RLS unchanged for anon and non-members, and **org teardown
  still cascades** with the new column and index in place (the 20261052 lesson).
- **E2E — `e2e/offline-diary-queue.spec.ts` (5), real offline:** offline → *Saved on this
  device* → IDB row with a key → online → auto-sync → **exactly one** entry; a
  browser-level **replay** still yields one entry; 375px glove-usability (no sideways scroll,
  44px targets); sign-out **warns** then purges; cancelling keeps both the session and the work.

### Playwright notes

This spec does **not** enable the service worker. `pwa-offline.spec.ts` needs it because it
tests a cold launch; this feature does not depend on it at all, and enabling it would import
its one-time claim-and-reload race for no coverage. Going offline still cuts **both** threads
(`setOffline(true)` *and* `context.route("**/*", abort)`) — the lesson from the PWA work — and
every wait is on a condition the app asserts about itself (`[data-offline-notice]`,
`[data-offline-queued]`, `[data-outbox-synced]`), never a sleep. Where a test needs an entry
to stay *unsent while online* (the sign-out warning), it blocks **only** the sync request by
matching the diary text in the POST body, rather than racing the automatic flush.
