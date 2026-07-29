-- AI Quote Writer — the tenant-side draft artifact.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A NEW TABLE, after auditing every existing seam (Engineering Rule 1)
-- ═══════════════════════════════════════════════════════════════════════════
-- Four candidates were considered and three were rejected on structural
-- grounds, not on taste:
--
--   1. `quotes` ITSELF, with a status. REJECTED, and this is the important one.
--      A quotes row is not an inert container: creating one burns a number from
--      the org's `next_quote_number` sequence, puts the row in /quotes and in
--      the dashboard money tiles, allocates a `public_token` that makes it
--      publicly addressable at /q/<token>, and — decisively — makes it
--      REACHABLE by requestQuoteApproval → reviewQuote → sendQuote. The single
--      hardest requirement on this feature is that no model output can reach a
--      customer without a person putting it there. Storing drafts as quotes
--      would make the send path structurally available to them, and no amount
--      of application-layer care would make that safe again.
--
--   2. `expense_drafts` (20260623). REJECTED. It is the right SHAPE of idea —
--      a tenant-side AI draft awaiting human approval — and the wrong columns
--      entirely: amount / vat_rate / supplier_name / invoice_date / finance_id.
--      A quote draft is a scope of works with an array of line items; it would
--      have to be stuffed into a jsonb column that table does not have, on a
--      table whose status enum ('extracted','approved','rejected') means
--      something else, mixing two domains under one RLS policy for no gain.
--
--   3. `hq_drafts` (20260731). REJECTED. HQ infrastructure: RLS-enabled with
--      ZERO policies (service-role only, no tenant can read it), keyed to a NOT
--      NULL `ai_employees(id)` a tenant quote has no analogue for, and WRITE-
--      ONCE immutable — while the whole point here is that a human EDITS the
--      draft before applying it. Structurally incompatible in three directions.
--
--   4. Not persisting at all — hand the draft to the browser and forget it.
--      REJECTED for two reasons. A generation costs the org real money once
--      activated, and losing it to a page refresh means paying twice, which the
--      governor's own event-driven doctrine calls out as the waste to avoid.
--      More importantly there would be NO RECORD that AI drafted a quote at
--      all: the one question a customer, an insurer or an auditor will ask is
--      "did a person write this?", and "we didn't keep that" is not an answer.
--
-- So this migration adds ONE object: a place to hold a generated quote draft as
-- a first-class, org-scoped, lifecycle-tracked artifact that records BOTH what
-- the model proposed AND what the human actually applied.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE TABLE IS CORRECT AND EMPTY IN PRODUCTION
-- ═══════════════════════════════════════════════════════════════════════════
-- Nothing generative is authorised: every cost tier maps to NO model (see
-- lib/ai/governor/registry.ts), so no draft can be produced and no row can be
-- written. Like `ai_invocations` before it, this substrate lands BEFORE the
-- capability it holds, because a control retrofitted around a system that has
-- learned to spend is not a control. On a fresh production database this table
-- is EMPTY, and that is the expected state.
--
-- Additive, idempotent, reversible. To roll back:
--   drop trigger if exists ai_quote_drafts_org_integrity on public.ai_quote_drafts;
--   drop function if exists public.tg_ai_quote_draft_org_integrity();
--   drop trigger if exists ai_quote_drafts_lifecycle on public.ai_quote_drafts;
--   drop function if exists public.tg_ai_quote_draft_lifecycle();
--   drop table if exists public.ai_quote_drafts;

create table if not exists public.ai_quote_drafts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  -- Who asked for the draft. NULLABLE and `on delete set null`: a departed
  -- employee's deletion must not erase the record that AI drafted a quote the
  -- firm may still be relying on. The lifecycle trigger below cuts an explicit,
  -- narrow hole for that FK-driven update.
  created_by   uuid references public.users(id) on delete set null,

  -- WHAT the draft is for. A draft is raised either against an existing quote
  -- (re-scoping) or against a lead (before any quote exists) — the second is
  -- the common case, which is exactly why the drafts could not live on `quotes`.
  --
  -- `quote_id` cascades: a deleted quote's drafts are meaningless. `lead_id`
  -- sets null: the draft outlives a tidied-up lead because it is the record of
  -- what was proposed.
  quote_id     uuid references public.quotes(id) on delete cascade,
  lead_id      uuid references public.leads(id) on delete set null,

  -- Lifecycle. `draft` is the ONLY mutable state; the other two are terminal
  -- and the trigger enforces it. DISCARD IS A STATUS, NOT A DELETE — "the
  -- operator threw the AI's suggestion away" is the single most useful fact
  -- this table can record about a model's quality, and deleting the row would
  -- destroy exactly the evidence that a review process is working.
  status       text not null default 'draft'
                 check (status in ('draft', 'applied', 'discarded')),

  -- ── the two contents, and why there are two ────────────────────────────────
  -- `content` is what the MODEL produced, validated against
  -- lib/ai/quote-draft-schema.ts. It NEVER changes after insert.
  -- `applied_content` is what the HUMAN actually applied, stamped once at the
  -- draft→applied transition.
  --
  -- One column could not answer the question that matters. "How much did the
  -- operator have to change?" is the measurement that tells a firm whether AI
  -- drafting is earning its cost, and it is unanswerable if the human's edits
  -- overwrite the model's output in place.
  content          jsonb not null,
  applied_content  jsonb,

  -- ── provenance ─────────────────────────────────────────────────────────────
  -- NOTE WHAT IS ABSENT: 'deterministic'. Every other governed capability has a
  -- computable fallback — a regex, an empty draft, a fixed acknowledgement — so
  -- its rows can be produced without a model. A scope of works cannot be
  -- computed from a customer's description of their bathroom. There is no
  -- deterministic leg, so a row in this table can ONLY exist because a model
  -- produced it, and the CHECK says so structurally rather than by convention.
  provenance   text not null check (provenance in ('anthropic', 'openai')),

  -- The model that actually ran, in the vendor's own naming.
  model        text not null check (length(trim(model)) between 1 and 120),

  -- Prompt provenance — the version key (`quote_writer:v1`) plus a SHA-256 of
  -- the exact assembled prompt. Together they make prompt drift detectable and
  -- every draft traceable to the template that built it. The idiom is
  -- hq_drafts' (20260731); the checksum is hex-shaped for the same reason
  -- ai_invocations.content_hash is.
  prompt_version   text not null check (length(trim(prompt_version)) between 1 and 60),
  prompt_checksum  text not null check (prompt_checksum ~ '^[0-9a-f]{64}$'),

  -- Which output-schema revision `content` conforms to. An old row is never
  -- re-read as a new one.
  schema_version   integer not null check (schema_version >= 1),

  -- True when the draft only survived because malformed line items were
  -- dropped. Persisted so a repaired draft can NEVER present itself as a clean
  -- one — not in the UI, not in a later analysis, not to whoever asks why a
  -- room is missing.
  degraded     boolean not null default false,

  -- ── the disclosure record ──────────────────────────────────────────────────
  -- WHICH FIELDS OF THE DISCLOSURE CONTRACT (lib/ai/quote-context.ts) were
  -- actually populated when this draft was built. Not the values — the KEYS.
  --
  -- Storing the values would duplicate the customer's free text into a second
  -- table for no benefit; storing the keys answers the question that is
  -- actually asked in a data-protection review ("what left, for this draft?")
  -- and costs nothing. The prompt checksum pins the exact text alongside it.
  context_fields   text[] not null default '{}',

  -- ── the tie to the cost ledger ─────────────────────────────────────────────
  -- The SHA-256 fingerprint the governor computed for this invocation — the
  -- same value it writes to `ai_invocations.content_hash`, which is indexed
  -- (ai_invocations_dedupe_idx). Joining on it recovers the exact ledger row.
  --
  -- DELIBERATELY NOT A FOREIGN KEY TO ai_invocations.id. `recordInvocation` is
  -- BEST-EFFORT BY DESIGN — a telemetry write failure is logged and swallowed
  -- so an accounting problem can never break a customer-facing feature. A NOT
  -- NULL FK would therefore let a lost telemetry row destroy a draft the org
  -- paid for, and a nullable FK would be null precisely when accounting failed,
  -- which is when the link matters most. The hash is known BEFORE the call, is
  -- always available, and is the invocation's identity either way.
  invocation_hash  text check (invocation_hash is null or invocation_hash ~ '^[0-9a-f]{64}$'),

  applied_at   timestamp with time zone,
  applied_by   uuid references public.users(id) on delete set null,
  discarded_at timestamp with time zone,
  discarded_by uuid references public.users(id) on delete set null,

  created_at   timestamp with time zone not null default now(),
  updated_at   timestamp with time zone not null default now(),

  -- A draft with no anchor is unreachable from any screen — it would be a row
  -- nobody can find and nobody can delete except by teardown.
  constraint ai_quote_drafts_anchor_check
    check (quote_id is not null or lead_id is not null),

  -- The terminal states carry their stamps; `draft` carries neither. Stated as
  -- a CHECK as well as in the trigger so the two states cannot drift: a
  -- constraint holds for every role including service_role, and no procedural
  -- code can bypass it.
  constraint ai_quote_drafts_terminal_stamp_check check (
       (status = 'draft'     and applied_at is null and discarded_at is null and applied_content is null)
    or (status = 'applied'   and applied_at is not null and discarded_at is null and applied_content is not null)
    or (status = 'discarded' and discarded_at is not null and applied_at is null and applied_content is null)
  )
);

-- ── indexes ──────────────────────────────────────────────────────────────────
-- Every read is org-pinned in code (RLS's current_org_ids() spans EVERY org a
-- user belongs to, so the application scopes to the ACTIVE org as well — the
-- defect class #456/#468 closed). The indexes lead with org_id to match.
create index if not exists ai_quote_drafts_org_created_idx
  on public.ai_quote_drafts (org_id, created_at desc);
-- The review surface's read: "open drafts for this quote / this lead".
create index if not exists ai_quote_drafts_quote_idx
  on public.ai_quote_drafts (org_id, quote_id, created_at desc)
  where quote_id is not null;
create index if not exists ai_quote_drafts_lead_idx
  on public.ai_quote_drafts (org_id, lead_id, created_at desc)
  where lead_id is not null;
-- "How many drafts were applied vs discarded" — the quality measurement.
create index if not exists ai_quote_drafts_status_idx
  on public.ai_quote_drafts (org_id, status, created_at desc);

-- ── cross-tenant link integrity ──────────────────────────────────────────────
-- RLS checks only the ROW's own org_id, never the org of the quote or lead it
-- points at. Without this, a member of org A could POST a draft (via PostgREST,
-- bypassing the app entirely) anchored to org B's quote — the row would stay in
-- org A, but org A's screens would then be reading and writing against another
-- tenant's commercial record. The established fix in this codebase is a
-- BEFORE INSERT/UPDATE guard rather than a composite FK, because these links
-- are ON DELETE SET NULL / CASCADE and org_id is NOT NULL — see
-- tg_completion_certificate_org_integrity (20261024), mirrored here.
create or replace function public.tg_ai_quote_draft_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.quote_id is not null then
    select org_id into v_org from public.quotes where id = new.quote_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'ai quote draft: quote % is not in this org', new.quote_id
        using errcode = 'check_violation';
    end if;
  end if;
  if new.lead_id is not null then
    select org_id into v_org from public.leads where id = new.lead_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'ai quote draft: lead % is not in this org', new.lead_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists ai_quote_drafts_org_integrity on public.ai_quote_drafts;
create trigger ai_quote_drafts_org_integrity
  before insert or update on public.ai_quote_drafts
  for each row execute function public.tg_ai_quote_draft_org_integrity();

-- ── lifecycle + provenance integrity ─────────────────────────────────────────
-- Three rules, enforced where no caller can bypass them (the service role
-- reaches this table through the admin client, which BYPASSES RLS — so a guard
-- that lived only in TypeScript would be a convention, not an architecture):
--
--   1. WHAT THE MODEL SAID IS IMMUTABLE. `content`, its provenance, the prompt
--      that produced it, the disclosure record and the invocation fingerprint
--      never change. This row is the evidence; evidence that can be edited
--      after the fact is not evidence. Same doctrine as the write-once storage
--      wave (20261031–37) and the RAMS draft→terminal integrity (20261034).
--
--   2. TERMINAL IS TERMINAL. draft → applied and draft → discarded, once. An
--      applied draft cannot be re-applied (which would let the same generation
--      be re-used to overwrite a human's later edits) and a discarded draft
--      cannot be resurrected.
--
--   3. THE HUMAN'S VERSION IS WRITTEN EXACTLY ONCE, at the moment of applying.
--
-- ONE DELIBERATE HOLE, and it is an erasure path rather than an edit: the three
-- user columns are `on delete set null`, which Postgres implements as an
-- UPDATE. A blanket refusal would make this table BLOCK USER DELETION outright
-- and leave personal data undeletable — the exact failure ai_invocations
-- (20261062) documents and 20261052 was written to fix. The hole is cut as
-- narrowly as it can be: those columns may go non-null → null only when every
-- other column is byte-identical.
create or replace function public.tg_ai_quote_draft_lifecycle()
returns trigger language plpgsql as $$
declare
  v_anonymised public.ai_quote_drafts%rowtype;
begin
  -- (0) The FK anonymisation hole. Checked FIRST, before updated_at is touched,
  -- so the "everything else identical" comparison can actually hold.
  if (old.created_by   is not null and new.created_by   is null)
  or (old.applied_by   is not null and new.applied_by   is null)
  or (old.discarded_by is not null and new.discarded_by is null) then
    v_anonymised := old;
    if old.created_by   is not null and new.created_by   is null then v_anonymised.created_by   := null; end if;
    if old.applied_by   is not null and new.applied_by   is null then v_anonymised.applied_by   := null; end if;
    if old.discarded_by is not null and new.discarded_by is null then v_anonymised.discarded_by := null; end if;
    -- IS NOT DISTINCT FROM, never `=`: row equality involving a NULL field
    -- yields NULL rather than false, which an `if` treats as "not equal" and
    -- which would refuse every legitimate anonymisation of a row that happens
    -- to have a null lead_id or invocation_hash.
    if new is not distinct from v_anonymised then
      return new;
    end if;
  end if;

  -- (1) What the model said, and how, is frozen.
  if new.org_id          is distinct from old.org_id
  or new.quote_id        is distinct from old.quote_id
  or new.lead_id         is distinct from old.lead_id
  or new.created_by      is distinct from old.created_by
  or new.content         is distinct from old.content
  or new.provenance      is distinct from old.provenance
  or new.model           is distinct from old.model
  or new.prompt_version  is distinct from old.prompt_version
  or new.prompt_checksum is distinct from old.prompt_checksum
  or new.schema_version  is distinct from old.schema_version
  or new.degraded        is distinct from old.degraded
  or new.context_fields  is distinct from old.context_fields
  or new.invocation_hash is distinct from old.invocation_hash
  or new.created_at      is distinct from old.created_at then
    raise exception 'ai_quote_drafts: the model output and its provenance are immutable — apply or discard the draft, never rewrite it'
      using errcode = 'check_violation';
  end if;

  -- (2) Terminal states are terminal.
  if old.status <> 'draft' then
    raise exception 'ai_quote_drafts: draft % is already %, and a terminal draft cannot change', old.id, old.status
      using errcode = 'check_violation';
  end if;

  -- (3) The human's version is written exactly once, and only on apply.
  if new.status = 'applied' then
    if new.applied_content is null then
      raise exception 'ai_quote_drafts: applying a draft must record what the operator actually applied'
        using errcode = 'check_violation';
    end if;
  elsif new.applied_content is distinct from old.applied_content then
    raise exception 'ai_quote_drafts: applied_content may only be written by the draft -> applied transition'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ai_quote_drafts_lifecycle on public.ai_quote_drafts;
create trigger ai_quote_drafts_lifecycle before update on public.ai_quote_drafts
  for each row execute function public.tg_ai_quote_draft_lifecycle();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- SELECT / INSERT / UPDATE for org MEMBERS, matching `quotes` itself: anyone who
-- can write a quote can draft one. Gating generation to owners/admins — i.e.
-- deciding who may spend the org's AI budget — is a PRODUCT decision, not an
-- engineering one, and it is deliberately left open rather than quietly
-- answered here; the £100/month ceiling is the cost control in the meantime.
--
-- There is NO DELETE POLICY, and that is the substantive choice. Discarding is
-- a status transition, so the record of "AI proposed this and a human rejected
-- it" survives. Teardown still works: `organizations ... on delete cascade`
-- reaches these rows through the service role, which no policy constrains.
alter table public.ai_quote_drafts enable row level security;

create policy ai_quote_drafts_select on public.ai_quote_drafts
  for select using (org_id in (select public.current_org_ids()));

create policy ai_quote_drafts_insert on public.ai_quote_drafts
  for insert with check (org_id in (select public.current_org_ids()));

create policy ai_quote_drafts_update on public.ai_quote_drafts
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));

comment on table public.ai_quote_drafts is
  'AI Quote Writer drafts. Model output is immutable; applied/discarded are terminal; discard is a status, never a delete. No provider is bound, so this table is correct and EMPTY in production.';
comment on column public.ai_quote_drafts.content is
  'What the MODEL produced, schema-validated. Never changes after insert.';
comment on column public.ai_quote_drafts.applied_content is
  'What the HUMAN actually applied. Written exactly once, at the draft -> applied transition. The pair answers "how much did the operator have to change?".';
comment on column public.ai_quote_drafts.context_fields is
  'Which disclosure-contract fields (lib/ai/quote-context.ts) were populated for this draft. Keys, never values.';
comment on column public.ai_quote_drafts.invocation_hash is
  'SHA-256 fingerprint matching ai_invocations.content_hash. Not an FK: the ledger write is best-effort by design, so an FK would let a lost telemetry row destroy a paid-for draft.';
