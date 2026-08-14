-- WhatsApp AI Assistant (P2) — inbound media store + assistant action log.
--
-- Extends the DARK WhatsApp channel with two additive, RLS-enabled tables and one
-- private storage bucket. Nothing here reads or writes until the Meta webhook is
-- live behind NEXT_PUBLIC_FEATURE_WHATSAPP (default OFF) AND WhatsApp media creds
-- are present — media fetch REFUSES-BEFORE-FETCH otherwise (see
-- server/services/whatsapp-media-pipeline.ts). Voice-note transcription stays
-- GOVERNOR-DARK: transcript columns exist but remain NULL until an STT provider is
-- bound (lib/ai/transcription.ts). NEVER a fabricated transcript.
--
-- Storage & evidence discipline mirrors tenant_attachments / the storage-evidence
-- wave VERBATIM:
--   * private bucket, org-first path `${org_id}/${wamid}/${media_id}.${ext}`;
--   * bytes written ONLY by the service role (no authenticated mutation policy);
--   * SHA-256 content_hash of the exact stored bytes, hex-64 CHECK;
--   * idempotency on the Meta media id so an at-least-once webhook stores once.
-- The global `tg_assert_storage_path_org` trigger (20261031) already binds the
-- first path segment to org_id for non-service roles; service-role writes are
-- exempt and supply the org-first path themselves.

-- ---------------------------------------------------------------------------
-- 1. Private bucket for inbound WhatsApp media bytes.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;

-- Org members may READ (sign URLs for) their own media; the org-first path's first
-- segment must equal one of the caller's orgs. Byte WRITES/DELETES have NO policy,
-- so only the service role can mutate objects (default-deny for authenticated),
-- exactly the storage-evidence-lockdown posture.
drop policy if exists whatsapp_media_read on storage.objects;
create policy whatsapp_media_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'whatsapp-media'
    and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
  );

-- ---------------------------------------------------------------------------
-- 2. Inbound media ledger — one row per inbound media object, idempotent.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_inbound_media (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  -- The message this media arrived on (Meta wamid.*).
  wamid             text not null,
  -- Meta's media id — the fetch handle AND the idempotency key.
  media_id          text not null,
  -- image | audio | voice | video | document | sticker
  message_type      text not null,
  mime_type         text,
  filename          text,
  caption           text,
  -- Meta-declared SHA-256 (from the inbound message), for a fetch cross-check.
  declared_sha256   text,
  -- SHA-256 of the EXACT bytes we stored, hex-64, immutable once set (evidence).
  content_hash      text check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes        integer,
  storage_path      text,
  -- pending  : row claimed, bytes not yet stored (retryable)
  -- stored   : bytes in the bucket, content_hash set
  -- refused  : media fetch refused before any network call (dark / no creds)
  -- failed   : a fetch/store error left it retryable
  status            text not null default 'pending'
                      check (status in ('pending', 'stored', 'refused', 'failed')),
  refused_reason    text,
  error_message     text,
  -- Voice-note transcription seam. GOVERNOR-DARK by default.
  -- none      : not a voice note, or transcription not attempted
  -- deferred  : voice note, but no STT provider bound (dark) — NEVER fabricated
  -- completed : a real provider returned a transcript
  -- failed    : transcription attempted and errored
  transcript_status text not null default 'none'
                      check (transcript_status in ('none', 'deferred', 'completed', 'failed')),
  transcript        text,
  created_at        timestamp with time zone not null default now(),
  stored_at         timestamp with time zone,
  -- Idempotency: an at-least-once webhook re-delivering the same media stores once.
  constraint whatsapp_inbound_media_org_media_uq unique (org_id, media_id)
);

create index if not exists whatsapp_inbound_media_org_idx
  on public.whatsapp_inbound_media (org_id, created_at desc);
create index if not exists whatsapp_inbound_media_wamid_idx
  on public.whatsapp_inbound_media (org_id, wamid);

comment on column public.whatsapp_inbound_media.content_hash is
  'SHA-256 of the exact stored bytes. NULL until status=stored. Evidence hash — a '
  'later byte swap is detectable against it.';
comment on column public.whatsapp_inbound_media.transcript is
  'Voice-note transcript. NULL while GOVERNOR-DARK (no STT provider bound). NEVER a '
  'fabricated transcript — a dark build leaves this NULL with transcript_status=deferred.';

alter table public.whatsapp_inbound_media enable row level security;

-- Tenant READ of their own media rows (loud reads / future UI); scoped to org.
drop policy if exists whatsapp_inbound_media_select on public.whatsapp_inbound_media;
create policy whatsapp_inbound_media_select on public.whatsapp_inbound_media
  for select to authenticated
  using (org_id in (select public.current_org_ids()));
-- NO insert/update/delete policy: the pipeline writes via the service role only.

-- Content-hash / storage-path write-once immutability (evidence discipline),
-- enforced for EVERY role including the service role, mirroring
-- tg_tenant_attachment_evidence_immutable (20261033).
create or replace function public.tg_whatsapp_media_evidence_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.content_hash is not null and new.content_hash is distinct from old.content_hash then
    raise exception 'whatsapp_inbound_media.content_hash is immutable once set';
  end if;
  if old.storage_path is not null and new.storage_path is distinct from old.storage_path then
    raise exception 'whatsapp_inbound_media.storage_path is write-once';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_whatsapp_media_evidence_immutable on public.whatsapp_inbound_media;
create trigger tg_whatsapp_media_evidence_immutable
  before update on public.whatsapp_inbound_media
  for each row execute function public.tg_whatsapp_media_evidence_immutable();

-- ---------------------------------------------------------------------------
-- 3. Assistant action log — what the assistant created from an inbound message.
-- ---------------------------------------------------------------------------
-- Every entity the assistant auto-creates from a WhatsApp message is recorded
-- here: WHAT was created, from WHICH message, and in what review state. Human-in-
-- the-loop actions (a variation draft, a task) land as 'pending_review'; evidence
-- actions (a note, a photo upload) land as 'created'. Idempotent per (message,
-- action_type) so a re-processed webhook never double-creates.
create table if not exists public.whatsapp_assistant_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  -- The source message (Meta wamid.*).
  wamid          text not null,
  -- The inbound enquiry this action was derived from, when known.
  enquiry_id     uuid references public.inbound_enquiries(id) on delete set null,
  -- note | task | variation_draft | photo_upload
  action_type    text not null
                   check (action_type in ('note', 'task', 'variation_draft', 'photo_upload')),
  -- The entity this action produced (e.g. table 'jobs', the created row id).
  target_table   text,
  target_id      uuid,
  -- created        : done, no human sign-off required (evidence: note / photo)
  -- pending_review : awaiting a human decision (a commitment: variation / task)
  -- skipped        : nothing to do (deterministic classifier found no action)
  -- failed         : the create errored
  status         text not null default 'created'
                   check (status in ('created', 'pending_review', 'skipped', 'failed')),
  detail         jsonb,
  error_message  text,
  created_at     timestamp with time zone not null default now(),
  constraint whatsapp_assistant_actions_org_msg_type_uq unique (org_id, wamid, action_type)
);

create index if not exists whatsapp_assistant_actions_org_idx
  on public.whatsapp_assistant_actions (org_id, created_at desc);

alter table public.whatsapp_assistant_actions enable row level security;

drop policy if exists whatsapp_assistant_actions_select on public.whatsapp_assistant_actions;
create policy whatsapp_assistant_actions_select on public.whatsapp_assistant_actions
  for select to authenticated
  using (org_id in (select public.current_org_ids()));
-- NO insert/update/delete policy: written via the service role only.
