-- ---------------------------------------------------------------------------
-- FEATURE 2 — Universal document-to-form autofill: the extraction draft table
-- ---------------------------------------------------------------------------
--
-- One row per "import": the operator uploaded a document next to a create
-- button, a vision model proposed values for that form type, and this row holds
-- those PROPOSED values until the operator carries them into the real creation
-- form and saves through the normal validated workflow.
--
-- NOTHING HERE IS A RECORD. A draft never becomes a customer / job / RAMS / etc.
-- by itself — it is a bag of suggestions. The existing create action is the only
-- thing that writes a real record, after the operator has reviewed and (often)
-- edited every value. That is the "never silently create or modify records"
-- rule, expressed structurally: this table has no foreign key INTO any domain
-- table and no trigger that writes one.
--
-- WHAT IS AND IS NOT STORED (a deliberate privacy boundary):
--   * STORED: the STRUCTURED proposed values (`extracted`, a small JSON object
--     of string fields that map to the form), plus confidence / uncertainty /
--     missing metadata and a pointer to the uploaded file. These are needed to
--     render the review UI and prefill the form.
--   * NOT STORED: the document's raw OCR text or any free-form model output. The
--     vision model's text response is parsed into the strict schema and then
--     discarded in-process — only the validated fields survive. The original
--     bytes live solely in the private `form-imports` bucket (migration
--     20261264000000), under retention.
--   * The AI invocation itself (tokens, cost, a SHA-256 of the bytes — never the
--     bytes) is audited by the governor ledger `ai_invocations`, so a sensitive
--     extraction is accountable without this table duplicating the content.
--
-- RETENTION: a draft is transient. `purgeExpiredFormImports`
-- (server/services/document-autofill.ts) deletes the bucket object and blanks
-- `storage_path` for rows older than the retention window, and removes
-- consumed/discarded rows outright. The `created_at` index exists for that
-- sweep. Wiring it into the cron fleet is a stated Phase-2 follow-up; until
-- then the rows are small, org-scoped, and self-scoped.

create table if not exists public.form_import_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Which create form these values target. CHECK, not an FK, because the set is
  -- a code-side registry (lib/imports/autofill/registry.ts); the two are pinned
  -- against each other by __tests__/imports/autofill-registry.test.ts so a form
  -- type added in code without a matching CHECK (or vice versa) fails CI.
  form_type text not null check (form_type in (
    'customer',
    'lead',
    'supplier',
    'job',
    'site',
    'risk_assessment',
    'permit',
    'toolbox_talk',
    'snag',
    'diary',
    'compliance_document',
    'itp',
    'staff_invite',
    'stock_item',
    'vehicle',
    'asset'
  )),
  status text not null default 'extracted' check (status in (
    'extracted',  -- values proposed, awaiting the operator
    'consumed',   -- operator carried them into the create form
    'discarded'   -- operator rejected the suggestions
  )),
  -- The proposed values: a flat JSON object of string fields matching the form.
  -- Validated against the per-form zod schema before it is written, so it can
  -- never carry a key the form does not have (no mass-assignment via a crafted
  -- extraction) and never a value that fails the form's own validation.
  extracted jsonb not null default '{}'::jsonb,
  -- Model self-reported confidence for the extraction as a whole, 0-100, capped.
  overall_confidence smallint not null default 0
    check (overall_confidence between 0 and 100),
  -- Field keys the model flagged as uncertain, and keys it could not find. Both
  -- drive the review UI's "check this" / "not found" markers. Subsets of the
  -- form's keys; never free text.
  uncertain_fields text[] not null default '{}',
  missing_fields text[] not null default '{}',
  -- Whether a model actually ran ('vision') or the governed path degraded and no
  -- AI touched the document ('none' — dark provider, over ceiling, duplicate,
  -- or unsupported file). An honest record of whether the suggestions are AI's
  -- or simply empty; the review UI says so.
  extraction_engine text not null default 'none'
    check (extraction_engine in ('vision', 'none')),
  -- The uploaded document in the private bucket: `{org_id}/{id}/{filename}`.
  -- Nulled by the retention sweep once the object is purged.
  storage_path text,
  source_filename text,
  source_mime text,
  source_bytes integer check (source_bytes is null or source_bytes >= 0),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- Grants — the 30-Oct-2026 Data-API rule: a NEW client-reachable table must
-- carry its own explicit grant (see __tests__/security/
-- migration-data-api-grant-guard.test.ts). The tenant client reads its own
-- drafts (prefill) and writes them (create / discard), so `authenticated` gets
-- CRUD; `anon` gets nothing (no anonymous surface touches this table).
grant select, insert, update, delete on public.form_import_drafts to authenticated;

alter table public.form_import_drafts enable row level security;

-- RLS: org-scoped AND self-scoped. A draft is personal to the operator who
-- created it within their org — only its creator reviews it and carries it into
-- the form. `created_by = auth.uid()` on every policy means one member cannot
-- read, edit, or discard another member's in-flight import, and
-- `org_id in current_org_ids()` is the tenant boundary. The MODULE capability
-- ("can this user create a customer / job / ...") is enforced in the server
-- action before a row is inserted — RLS cannot know the form type, so the
-- per-type authorisation lives where it can.
drop policy if exists "form_import_drafts: self read" on public.form_import_drafts;
create policy "form_import_drafts: self read" on public.form_import_drafts
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and created_by = auth.uid());

drop policy if exists "form_import_drafts: self insert" on public.form_import_drafts;
create policy "form_import_drafts: self insert" on public.form_import_drafts
  for insert to authenticated
  with check (org_id in (select public.current_org_ids()) and created_by = auth.uid());

drop policy if exists "form_import_drafts: self update" on public.form_import_drafts;
create policy "form_import_drafts: self update" on public.form_import_drafts
  for update to authenticated
  using (org_id in (select public.current_org_ids()) and created_by = auth.uid())
  with check (org_id in (select public.current_org_ids()) and created_by = auth.uid());

drop policy if exists "form_import_drafts: self delete" on public.form_import_drafts;
create policy "form_import_drafts: self delete" on public.form_import_drafts
  for delete to authenticated
  using (org_id in (select public.current_org_ids()) and created_by = auth.uid());

-- The operator's own drafts, newest first (review list + prefill lookup).
create index if not exists form_import_drafts_org_creator_idx
  on public.form_import_drafts (org_id, created_by, created_at desc);
-- The retention sweep scans by age.
create index if not exists form_import_drafts_created_at_idx
  on public.form_import_drafts (created_at);

drop trigger if exists form_import_drafts_set_updated_at on public.form_import_drafts;
create trigger form_import_drafts_set_updated_at
  before update on public.form_import_drafts
  for each row execute function public.tg_set_updated_at();
