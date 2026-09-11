# HQ Shared Memory — privacy, DSAR posture, and real erasure (E2)

_Last updated: 2026-09-11 (migration `20261228000000_hq_memory_purge.sql`)._

## What the memory estate is, in data-protection terms

The `hq_memories` estate (plus its children: `hq_memory_versions`,
`hq_memory_events`, `hq_memory_relationships`, `hq_memory_employee_links`,
`hq_memory_access_grants`, and the embedding ledger `hq_embedding_runs`) is
**CrewFlow-controller data**. It carries no `org_id`, is HQ-internal,
RLS-locked with zero policies (service-role only), and is never reachable from
a tenant JWT.

Consequently the **tenant** GDPR machinery — the org-scoped export census
(`lib/gdpr/export-tables.ts`) and erasure partition (`lib/gdpr/erase-tables.ts`),
both strictly scoped to `KNOWN_ORG_SCOPED_TABLES` — does not and **must not**
reach these tables. Wiring an org-scoped erasure to a global HQ table would be
a category error: memories are not owned by an organisation even when they
mention one (`organisation_id` is a denormalised snapshot, not an FK).

## The DSAR capability for requests made to CrewFlow

For a data-subject request addressed to CrewFlow (the controller of HQ
memory), the deliverable is a **locate-and-erase capability**:

1. **Locate** — `/admin/memory/search`: weighted full-text search over the
   generated `search_tsv` (title/summary/body) plus every structured facet
   (type, department, tag, source, status, visibility). Super-admin only.
2. **Erase** — the purge primitive (below), invoked from the memory detail
   page (`/admin/memory/[id]`) after typing an explicit confirmation.

## Forget vs Purge — two different verbs, deliberately

| | `hq_memory_forget` (20260728) | `hq_memory_purge` (20261228) |
|---|---|---|
| Actor | An AI employee, on memory it owns | A human super-admin, any memory |
| Effect | `status='archived'`, content + vector **retained**, version snapshotted | Content + vector + snapshots **destroyed**; immutable tombstone |
| Reversible | Yes (status flip) | **No** (SQL-level one-way guard) |
| Use | Default operator/AI action | Genuine erasure (DSAR, sensitive-content mistake) |

## What a purge scrubs and what survives

**Scrubbed (gone from the database):** `title` → `[purged]`, `summary`/`body`
→ `''` (the generated `search_tsv` empties with them — lexical search
disappearance is structural), `tags`/`keywords` → `{}`, `organisation_name`,
`embedding_placeholder`, the `embedding` vector and all nine embedding
metadata fields, every `hq_memory_versions` snapshot's title/summary/body/tags
(the versions table is where content would otherwise survive), and inbound
`hq_memory_relationships.entity_label` values that may quote the title.

**Kept (the audit evidence, content-free):** the row id, `status='purged'`,
`purged_at` / `purged_by` / `purge_reason`, structural facts (type, class,
department, visibility, importance, confidence, timestamps, version counter),
the full `hq_memory_events` timeline including the new `purged` event
(`{reason, from_status, had_embedding, versions_scrubbed}`), and an
`admin_activity_log` row (`action='memory.purged'`) — none of which contain
memory content.

## Resurrection-proofing (why a purged memory stays purged)

- The drift-requeue trigger (`_hq_memories_embed_requeue`) skips rows whose
  new status is `purged`, so the scrub itself cannot re-enqueue the tombstone
  for a paid embed of `[purged]`.
- `hq_embedding_claim_batch`, `hq_embedding_enqueue_stale` and
  `hq_embedding_reset_failed` all exclude purged rows explicitly; a worker
  holding a pre-purge lease no-ops (`lease_lost`) because purge clears the
  lease.
- A `BEFORE UPDATE` guard trigger makes the tombstone immutable: leaving the
  `purged` status, restoring content, or writing an embedding **raises** at the
  SQL layer for every caller.
- `hq_memory_recall` filters every channel (lexical, structural, pinned,
  own-experience, semantic ANN) on `status='active'`, and the vector is NULL
  (outside the partial HNSW index) — purged content can never surface.

All of the above is proven on real Postgres in
`__tests__/integration/memory/purge-path.test.ts`, and the migration's source
contract is pinned by `__tests__/security/memory-purge-invariants.test.ts`.

## Erasure boundary — what a purge does NOT reach

A purge erases the memory row, its version snapshots, and its relationship
labels. `admin_activity_log` is append-only by trigger for every role — a
deliberate audit-immutability control that outranks redaction — so purge
does not touch it; instead, as of 2026-09-11 the memory actions write
CONTENT-FREE metadata there (shape only: `title_chars`, class, visibility),
so nothing needing erasure enters the audit trail. Bounded residue: rows
written before 2026-09-11 may carry a memory's title (a short label, never
the body); at the time of this change production held exactly two such
rows, both naming still-live memories. Purge deliberately does **not**
cascade into records that are their own artefacts:

- **Consolidation lessons** — a `long_term` memory synthesised FROM several
  sources is a separate record; if it quotes purged content, locate and
  purge it separately (it is findable via `/admin/memory/search`).
- **AI task outputs / drafts** that quoted recalled content before the
  purge — governed artefacts with their own review and retention paths.
- **`hq_sales_*` rows sharing provenance** — the `memory_id` link is set
  NULL by the FK; the sales record's own content persists and is erased
  through the sales/GDPR paths, not through memory purge.

A data-subject erasure should therefore search for the subject across
memories AND consolidations, purging each hit — the locate-and-erase loop,
not a single cascade.

## Backups and point-in-time windows

Purged content persists in database backups until those backups age out:
the dated off-platform dumps (retained per the ops backup policy) and any
provider point-in-time-recovery window. This is the standard UK-GDPR
backup posture: erasure is effective in the live system immediately and in
backups on their rotation schedule; a restore performed while a backup
still contains purged content must be followed by re-running the recorded
purges (`admin_activity_log` `action='memory.purged'` is the replay list).
