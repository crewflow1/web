# Chapter 10 — Global Search

## Purpose

One box. You type three letters of a company name, a customer's surname, an invoice number, the slug of an AI employee, or the verb "suspend", and CrewFlow finds the thing — ranked, typo-tolerant, deep-linked — and, where the thing is *actionable*, lets you act on it without leaving the box. This chapter specifies that box: the **cross-entity global search** and the **⌘K command palette** that fronts it.

Search is the universal entry point of the OS. In a collection of pages you *navigate* to find things; in an operating system you *summon* them. The palette is to CrewFlow what Spotlight is to macOS — the fastest path from intent to thing-or-action, the same keystroke whether you are on Mission Control (Ch.09), an org page, or a timeline.

**The problem is greenfield.** Today HQ has *per-entity* full-text search: `searchMemories()` runs `.textSearch("search_tsv", term, {type:"websearch", config:"english"})` over `hq_memories`, and the Sales-AI services do the same over `hq_sales_*` (♻️ `server/services/hq-memory.ts`, `server/services/hq-sales.ts`). There is **no cross-entity search** — nothing that searches an org, a customer, a job, an invoice, an employee, a memory, a ticket and an event in one query, ranked against each other. `pg_trgm` is not yet used anywhere. We build that here, additively.

---

## Goals

- **One query, every entity.** A single call ranks results across organisations, customers, jobs, invoices, AI employees, memories, support tickets and events — one ranked list, not eight separate ones.
- **Instant.** p95 end-to-end (keystroke → ranked results painted) **< 150 ms** at a debounced ~120 ms cadence; the ranked SQL itself **< 30 ms** at p95.
- **Typo-tolerant.** "Aceme", "jonh smith", "invoce 4012" still find the right rows — `pg_trgm` trigram similarity backs the exact `tsvector` match.
- **Actionable.** The palette runs verbs ("suspend org…", "approve…", "open employee…"), each capability-gated (Ch.14) — search is a finder *and* an action launcher.
- **Live.** A newly-created org is searchable within seconds; the index is maintained event-driven (Ch.04), never on a nightly batch.
- **Swappable.** A `searchHq()` service boundary hides the backend, so Postgres can graduate to a dedicated engine on evidence (P6, Ch.17) without a UI change.

**Non-goals.** Tenant-facing search (this is HQ-only; tenants keep their own surfaces). A new web crawler or document store. Replacing the per-entity searches that already serve their pages — those stay; we add a *cross-entity* layer beside them (P2). Semantic/vector search is specified as an *option* here and owned by Ch.12.

---

## Architecture

Three components, one read-model.

```
 source tables ──AFTER trigger / spine consumer──▶  hq_search_index  (one row per entity, Ch.03 §03.13)
 (organizations,                                      ├─ search_tsv  : weighted tsvector  (GIN)
  customers, jobs,                                    └─ title       : trigram index      (GIN gin_trgm_ops)
  invoices, ai_employees,                                     │
  hq_memories,                                                ▼
  support_tickets, hq_events)                          searchHq(query, scopes)   ← the one service boundary
                                                              │  blends FTS rank + trigram sim + recency + type boost
                                                              ▼
                                                   ⌘K command palette  (finder + action launcher)
                                                              │  results deep-link;  verbs run through authorize() (Ch.14)
                                                              ▼
                                                        navigate  or  execute action (server action, Ch.05)
```

1. **The index** — `hq_search_index` (Ch.03 §03.13), a denormalised read-model with **one row per searchable entity**, keyed `(entity_type, entity_id)`. It carries display fields (`title`, `subtitle`, `body`, `url`), a weighted `search_tsv`, and `updated_at`. It is a *projection* (P1): rebuildable, never a source of truth.
2. **The maintainer** — keeps the index live, **additively**, from source tables via AFTER triggers and/or the `search_index` spine consumer (Ch.04). It never touches tenant RLS or source schemas (P2).
3. **The service** — `searchHq(query, scopes)` runs one ranked SQL query over the index and returns typed, deep-linked results. The palette and any future surface call only this.

The index is the seam that lets cross-entity search exist without a single change to a tenant table: source rows are *read* by triggers/consumers and *projected* into one HQ-owned, service-role-only table.

---

## Database design

The table is owned by **Ch.03 §03.13** — reproduced here for grounding, not redefined (one source, Ch.03 is canon):

```sql
-- 03.13 hq_search_index — denormalised cross-entity search. RLS:hq (service-role only).
create table hq_search_index (
  entity_type text not null,            -- 'organization'|'customer'|'job'|'invoice'|
                                        -- 'ai_employee'|'memory'|'support_ticket'|'event'
  entity_id   text not null,
  title       text not null,            -- the primary label ("Acme Plumbing Ltd")
  subtitle    text,                     -- disambiguator ("trial · 12 users · acme.co")
  body        text,                     -- searchable detail (notes, address, line items)
  url         text not null,            -- the deep link ("/hq/organizations/{id}")
  search_tsv  tsvector,
  updated_at  timestamptz not null default now(),
  primary key (entity_type, entity_id)
);
create index on hq_search_index using gin (search_tsv);              -- ranked FTS
create index on hq_search_index using gin (title gin_trgm_ops);      -- pg_trgm fuzzy
```

**The weighted tsvector** (♻️ exactly the `hq_memories` shape — `setweight … 'A'/'B'/'C'`, GIN over the generated column; see `supabase/migrations/20260713000000_hq_shared_memory.sql`). Generated, so it can never drift from its source columns:

```sql
alter table hq_search_index
  add column search_tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title,    '')), 'A') ||  -- name / id: most weight
    setweight(to_tsvector('english', coalesce(subtitle, '')), 'B') ||  -- key attributes
    setweight(to_tsvector('english', coalesce(body,     '')), 'C')     -- detail
  ) stored;
```

**Trigram extension** (additive, standard on Supabase, Ch.03 conventions; *new* to this codebase):

```sql
create extension if not exists pg_trgm;   -- 🔬 not yet used anywhere today (greenfield)
-- title carries gin_trgm_ops above; subtitle gets one too where fuzzy disambiguation matters:
create index on hq_search_index using gin (subtitle gin_trgm_ops);
```

**What each entity projects** (the maintainer's mapping — the single place that knows how a row becomes searchable):

| `entity_type` | `title` | `subtitle` | `body` | `url` |
|---|---|---|---|---|
| `organization` | org name | plan · user count · domain | slug, `stripe_customer_id`, notes | `/hq/organizations/{id}` |
| `customer` | customer name | org name · phone | email, address | `/hq/organizations/{org}/customers/{id}` |
| `job` | job title/ref | status · customer | property address, description | deep link to the job |
| `invoice` | `#{number}` · amount | status · org | line-item descriptions | deep link to the invoice |
| `ai_employee` | display name | department · mandate | role description | `/hq/ai-employees/{slug}` |
| `memory` | memory title | type · department | summary | `/hq/memory/{id}` (♻️ already searchable; now also global) |
| `support_ticket` | subject | status · org | first message | deep link to the ticket |
| `event` | verb · object | actor · severity | payload summary | the timeline anchor (Ch.11) |

**Access pattern.** Every read is a single bounded `LIMIT`ed query against the two GIN indexes — never a scan. **Writes** are the trigger/consumer upserts (below). The table is `RLS:hq` (service-role only): no JWT client can read a row (Ch.16).

---

## APIs

### The service boundary — `searchHq()`

The whole of search lives behind one server-only function (Ch.05). This is the swap point (P6).

```ts
// illustrative — server-only service contract (server/services/hq-search.ts)
type SearchScope =
  | 'organization' | 'customer' | 'job' | 'invoice'
  | 'ai_employee' | 'memory' | 'support_ticket' | 'event';

interface SearchHit {
  entityType: SearchScope;
  entityId:   string;
  title:      string;
  subtitle?:  string;
  url:        string;          // the deep link
  score:      number;          // the blended rank (see below)
  matched:    'exact' | 'fuzzy';
}

async function searchHq(
  query: string,
  opts?: { scopes?: SearchScope[]; limit?: number; perType?: number },
): Promise<SearchHit[]>;
```

### The ranked query

One statement blends four signals so the *right* result is first, not merely *a* match. Exact FTS and fuzzy trigram are **UNION**-ed (so typos still surface) and ranked together:

```sql
-- illustrative — bounded, ranked, typo-tolerant; runs entirely on the two GIN indexes
with q as (select $1::text as raw, websearch_to_tsquery('english', $1) as tsq)
select s.entity_type, s.entity_id, s.title, s.subtitle, s.url,
       ( 0.55 * ts_rank(s.search_tsv, q.tsq)            -- relevance (♻️ the proven FTS signal)
       + 0.25 * similarity(s.title, q.raw)              -- pg_trgm fuzzy / typo tolerance
       + 0.10 * exp(-extract(epoch from now()-s.updated_at)/2592000)  -- recency (30-day half-life)
       + 0.10 * type_boost(s.entity_type)               -- org/employee > event, tuned
       ) as score
from   hq_search_index s, q
where  (s.search_tsv @@ q.tsq                            -- exact, weighted
        or s.title % q.raw)                              -- fuzzy (trigram threshold)
  and  ($2::text[] is null or s.entity_type = any($2))   -- scope filter
order  by score desc
limit  $3;                                               -- bounded — always
```

- `websearch_to_tsquery` mirrors the existing `{type:"websearch"}` calls (♻️) so operators get the same quote/AND/OR grammar they already know.
- `%` is the `pg_trgm` similarity operator; `set_limit(0.3)` (or `pg_trgm.similarity_threshold`) tunes fuzziness — high enough to reject noise, low enough to catch one-character typos.
- `type_boost()` is a tiny `CASE` (immutable) encoding "an org outranks an event of equal text score". All weights live in **one** place and are tunable from telemetry (Ch.15).
- **Per-type capping**: to keep the list balanced, the service may wrap this in a `rank() over (partition by entity_type)` and keep the top `perType` of each, then re-merge — so 500 matching events can't bury the one matching org.

### The action layer (the palette is also a launcher)

The palette resolves the typed query into two result classes, merged into one ranked list:

```ts
type PaletteItem =
  | { kind: 'result'; hit: SearchHit }                       // a thing — navigates
  | { kind: 'action'; verb: CommandVerb; label: string;      // a verb — executes
      requiredCapability: string; target?: SearchHit };       // gated (Ch.14)

// command verbs are a curated registry, mirroring the event-verb discipline (Ch.04)
type CommandVerb =
  | 'org.suspend' | 'org.unsuspend' | 'approval.approve'
  | 'ai_employee.open' | 'ai_employee.pause' | 'timeline.open' | 'search.scope';
```

Running an action does **not** mutate from the client. The palette dispatches to the relevant **server action** (Ch.05), which passes through the single `authorize()` chokepoint (Ch.14); dangerous verbs (`org.suspend`) route to **Approvals** (Ch.13) rather than executing inline. The palette is a *thin caller* — it never holds authority.

### Index maintenance — the upsert contract

```sql
-- illustrative AFTER trigger (per source table) — additive, never alters the source
create function reindex_organization() returns trigger as $$
begin
  insert into hq_search_index(entity_type, entity_id, title, subtitle, body, url)
  values ('organization', new.id::text, new.name,
          format('%s · %s users', new.plan, /*count*/ 0), new.stripe_customer_id,
          '/hq/organizations/'||new.id)
  on conflict (entity_type, entity_id)
    do update set title=excluded.title, subtitle=excluded.subtitle,
                  body=excluded.body, url=excluded.url, updated_at=now();
  return new;
end $$ language plpgsql security definer;
```

Equivalently, the **`search_index` spine consumer** (Ch.04) subscribes to `org.*`, `customer.*`, `job.*`, `invoice.*`, `ai.*`, `memory.*`, `support.*` and upserts the same row from the event — preferred where the source mutation already emits a spine event (one write path, P3). Deletes/archives **soft-delete** from the index (a `DELETE` on the projection or an `archived` flag), never the source.

---

## UI behaviour

A **keyboard-first ⌘K command palette** (⌘K on macOS, Ctrl-K elsewhere), summonable from anywhere in HQ — Mission Control (Ch.09), any entity page, the timeline (Ch.11). It is a controlled overlay, not a route.

- **States.** *Idle* (palette open, empty): shows recent items + suggested actions. *Loading*: the previous results stay visible, dimmed, with a subtle spinner (never a blank flash). *Results*: grouped by `entity_type` with a verb section pinned on top when the query matches a command. *Empty*: "No matches for 'x…'" + the nearest fuzzy suggestion ("did you mean *Acme*?"). *Error*: "Search is degraded" + a retry; the box never crashes the page.
- **Keyboard.** ↑/↓ moves; ⏎ activates (navigate or run); ⌘⏎ opens in a new context; `Esc` closes; typing `>` forces *action* mode, `@` scopes to a type (`@org acme`), `#` scopes to events. Every result and action is reachable without the mouse.
- **Liveness.** Results reflect index freshness (seconds, event-driven). Open palette does not subscribe to realtime — it re-queries on keystroke; the *index* is what is live, not the overlay.
- **Accessibility.** A proper `role="combobox"` + `aria-activedescendant` listbox; focus trapped while open and restored on close; results announced via an `aria-live` region; full-contrast, motion-reduced variants (♻️ the 007 design-system tokens). 44px hit targets for pointer users.
- **Latency feel.** Debounced ~120 ms; a stale-while-revalidate cache keyed by query string so backspacing is instant; the first keystroke pre-warms the connection.

---

## Permissions

Search obeys least privilege (P5), in two layers (Ch.14):

- **Finding.** All HQ surfaces run service-role server-side, so the *index* read is uniformly authorised at the page boundary (♻️ `requireHqPage()` / `isSuperAdminEmail()`). The `visibility` seam (Ch.04) reserves per-role result scoping for when sub-admin roles arrive (Ch.14) — until then, every super-admin sees every entity, exactly as today.
- **Acting.** Every palette *verb* declares a `requiredCapability` and is gated by the single `authorize()` chokepoint (Ch.14). A verb the principal can't run is **hidden** (not shown-then-denied). Dangerous verbs (`org.suspend`, `billing.refund`) are *eligible for dual-control* and route through Approvals (Ch.13); the palette only *requests*, it never *decides*.
- **AI principals.** `searchHq()` is the same function an AI employee calls to locate an entity before acting on it (Ch.07) — so the workforce and the operator share one finder. The AI's *actions* are gated identically; finding is not a side-effect.

Default policy: read-the-index is available to every authenticated super-admin; every action defaults to *deny* and is granted capability-by-capability.

---

## Failure handling

- **Index consumer lags / a trigger missed a row.** The result is *staleness*, never corruption: an entity is briefly missing or shows an old title. The spine is the backstop — a **full rebuild via replay** (Ch.04) re-derives every row from history; a targeted re-index re-reads one source table. The cron drainer (♻️ the `research-drain` pattern, Ch.04) guarantees the consumer catches up within a minute even if a `pg_notify` wakeup is lost.
- **Trigram extension absent on a preview.** `searchHq()` falls back to FTS-only (drop the `or s.title % q.raw` clause); recall narrows to exact matches, but nothing errors (graceful degradation, mirrors the embedding-nullable posture in Ch.03).
- **A verb's server action fails mid-execution.** The palette surfaces the error inline and the action is, by contract, idempotent (P8) — re-running is safe. Nothing partial is left because the mutation lives in one server action / transaction.
- **The whole search query times out** (pathological input). A statement timeout caps it; the UI shows the degraded state and keeps the page alive (search is never in a critical write path).

## Edge cases

- **Empty / whitespace query** → no query issued; show recents + suggested actions.
- **Very short query (1–2 chars)** → trigram noise is high; require ≥ 2 chars before fuzzy, ≥ 1 for prefix-on-`title`; cap results hard.
- **Numeric / id queries** ("4012", an invoice number, a slug) → matched against `title`/`body` exactly; ids are projected into `body` precisely so id lookups hit.
- **Homograph entities** (two orgs named "Smith Ltd") → `subtitle` disambiguates (domain, user count); both returned, ranked by recency + type boost.
- **A command verb and a thing share a token** ("suspend" as both an action and part of a memory title) → both shown, the *action* section pinned above results so intent is one keystroke away.
- **Entity archived/deleted** → removed from the index by the maintainer; a stale deep link resolves to a "no longer exists" page (the index, not the link, is the source of presence).
- **Duplicate upsert race** (two updates to one org in the same instant) → `on conflict … do update` is idempotent; last-writer-wins on `updated_at`; the row is never duplicated (PK is `(entity_type, entity_id)`).
- **Massive `body`** (an invoice with 400 line items) → projected `body` is truncated to a bounded length; full detail lives in the source table, fetched on navigation (no blobs in the index, mirroring Ch.03's payload policy).

## Performance

This section answers the Golden Rule explicitly.

- **Every read is bounded.** `searchHq()` is always `LIMIT`ed (default 20, ≤ 50) and always served by the two GIN indexes (`search_tsv` and `title gin_trgm_ops`) — never a sequential scan, regardless of table size. Budget: **ranked SQL < 30 ms p95**, end-to-end keystroke-to-paint **< 150 ms p95**.
- **The 1,000,000-company analysis.** A million orgs, ~30 customers and a handful of jobs/invoices each, plus memories, tickets and a rolling window of searchable events ⇒ roughly **40–60 million rows** in `hq_search_index`. A GIN `tsvector` lookup is O(matching-postings), not O(rows): a selective query touches thousands of postings, not tens of millions, and returns the top-N in single-digit milliseconds. The trigram index is likewise posting-list-bounded. The blend's recency/boost terms are arithmetic over the already-tiny candidate set. So search cost scales with **selectivity, not corpus size** — the defining property that makes this design pass the Golden Rule.
- **Index size & freshness.** GIN indexes on 40–60 M short text rows are large but routine for Postgres; `fastupdate` smooths write amplification, and the generated `tsvector` adds negligible cost to each source upsert (one indexed write appended to a transaction the source already runs).
- **Write path.** Maintenance is one upsert per source mutation — O(1), piggy-backed on a write that already happens. No fan-out, no N+1.
- **Caching.** Stale-while-revalidate per query string on the client; a short server-side LRU for the hottest prefixes; both are pure accelerators (the index stays the source).
- **The graduation trigger** (Ch.17): when measured p95 ranked-SQL exceeds budget *despite* tuning, or index maintenance contends with OLTP, graduate the *backend* to **Typesense/Meilisearch** behind the unchanged `searchHq()` boundary — the index table becomes the engine's source of truth (fed by the same consumer), the UI is untouched (P6). We graduate on evidence, not on a hunch.

## Security

- **The index is `RLS:hq`** (service-role only) — no JWT client reads a single search row (Ch.16). The palette never queries Postgres directly; it calls server actions that run service-role behind `requireHqPage()`.
- **No new data exposure.** The index *denormalises* fields the operator can already see on the entity's page; it surfaces *no* field a super-admin couldn't already read. It holds **no secrets** — `staff_secrets`, tokens, payment credentials are never projected (the maintainer's mapping explicitly excludes them; mirrors Ch.03's no-PII-beyond-identifiers policy).
- **Injection.** The query is parameterised; `websearch_to_tsquery` and the trigram operator take the raw string as *data*, never interpolated SQL. Command verbs are a closed registry — the palette cannot synthesise a verb the way it cannot synthesise an event verb (Ch.04).
- **Action abuse / confused deputy.** Because actions flow through `authorize()` (Ch.14) and dangerous ones through Approvals (Ch.13), the palette cannot become a privilege-escalation path: it can only request what the principal already holds. Capability use on high-risk verbs emits `permission.capability_used` (sampled, Ch.04) for audit.
- **AI prompt-injection consideration** (Ch.16): when an AI employee uses `searchHq()`, returned `title`/`body` text is untrusted content — it is data for the AI to reason over, never instructions; the runtime treats it accordingly.

## Testing

- **Ranking oracle tests** — a fixture corpus + a table of `(query → expected top result)`; asserts the blend puts the right entity first (the byte-identical-oracle style from 007's token tests, ♻️). Weight changes are caught by this suite.
- **Typo tolerance tests** — "Aceme→Acme", "invoce→invoice", "jonh→john" return the correct row above threshold; below-threshold noise is rejected.
- **Scope & cap tests** — `@org` scoping filters correctly; per-type capping prevents one noisy type from burying others.
- **Index-maintenance tests** — insert/update/archive a source row, assert the projection upserts/removes; assert idempotency (apply the same change twice → identical index).
- **Replay/rebuild test** — drop the index, replay the spine, assert it reconstructs to an oracle (proves the projection is rebuildable, Ch.04).
- **RLS tests** — assert `hq_search_index` is unreadable by anon/JWT and readable only by service-role (♻️ the existing pattern).
- **Permission tests** — a principal lacking a capability never sees its verb in the palette; a dangerous verb routes to Approvals, not inline execution.
- **Performance test** — a seeded large fixture asserts ranked SQL stays within budget on the GIN indexes (a representative slice of the 1 M analysis).

## Monitoring

Emits and watches via the spine (Ch.04) and the metric registry (Ch.15):

- **Events.** `permission.capability_used` for high-risk palette actions; palette actions that mutate emit their own domain verb (`org.suspended`, etc.) like any other caller — search is not a special-cased event source.
- **Metrics / golden signals.** Search latency (p50/p95, ranked-SQL and end-to-end); **zero-result rate** (the canary for index gaps or bad ranking); query volume; click-through position (are people picking result #1?); **index consumer lag** (♻️ shared with Ch.04's consumer-lag signal — a rising lag means stale search before users notice); index row count vs source row count (drift detector).
- **Alerts.** Zero-result rate spike, p95 over budget, consumer lag over threshold, index/source row-count divergence beyond tolerance.
- **SLO.** 99% of searches return ranked results within 150 ms; index freshness (source change → searchable) within 10 s at p95.

## Future expansion

- **Semantic / hybrid search (the option).** Reuse the memory graph's pgvector embeddings (Ch.12 — `hq_memories.embedding`, HNSW) to add a "find related / similar" mode: blend keyword `score` with cosine similarity for conceptual recall ("the org that complained about onboarding"), not just lexical match. The `searchHq()` signature already admits a `mode: 'keyword' | 'semantic' | 'hybrid'` parameter; the index gains an optional `embedding` column or joins to the memory vectors. This is the seam, deliberately left open — owned by Ch.12.
- **The engine graduation** (above; Ch.17) — Typesense/Meilisearch behind the same boundary, fed by the same consumer.
- **Per-role result scoping** — the `visibility` seam (Ch.04) filters results by capability when sub-admin roles land (Ch.14).
- **Richer palette verbs** — the command registry grows like the event registry: add a verb + its `requiredCapability` + its server action; the palette renders it with no UI change. Over time the palette becomes the command line of the whole OS — every action a human or AI can take, one keystroke away.

---

🔬 **Open questions** (for Ch.20):
1. **Ranking-weight ownership** — should the four blend weights (`0.55/0.25/0.10/0.10`) and `type_boost()` be hard-coded, in `hq_settings`, or learned from click-through telemetry? Learned ranking is powerful but adds a feedback loop to audit.
2. **Trigram threshold** — one global `pg_trgm.similarity_threshold` vs per-entity-type thresholds (ids want tighter, names looser). Needs measurement once real query logs exist.
3. **Searchable-event window** — events are unbounded; what rolling window of `hq_events` is projected into the index before older events are findable only via the timeline's own search (Ch.11)?
