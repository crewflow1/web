-- W3 — External Worker H&S Sign-off Portal (token-gated, no tenant membership).
--
-- An EXTERNAL / subcontract operative (NOT a CrewFlow user, NOT an org member)
-- receives a share link, opens the H&S materials for ONE job (its RAMS, permits
-- and toolbox talks), and signs them off. The evidence must be immutable and
-- answer who, WHICH ISSUED VERSION, when, from where — exactly like the internal
-- operative sign-off (public.safety_acknowledgements, 20261020000000) and the
-- site induction register (public.site_inductions, 20261140000000), which this
-- table pair is modelled on.
--
-- WHY A NEW TABLE PAIR, NOT safety_acknowledgements. safety_acknowledgements can
-- only be signed by an AUTHENTICATED user AS THEMSELVES (RLS `user_id =
-- auth.uid()`, and its trigger forbids signing on another worker's behalf and
-- requires org membership). An external worker has NO login, NO membership and
-- NO auth.uid() — the whole point of this feature. So the worker path is a
-- separate, token-authenticated evidence store that mints NO membership.
--
-- TRUST BOUNDARY — this is a NEW external-access surface, so isolation is
-- structural, not merely code-enforced:
--
--   * The token in the URL is high-entropy + opaque and is stored ONLY as a
--     SHA-256 hash (`token_hash`). The plaintext never touches the DB, so a DB
--     read (or a leaked backup) cannot reconstruct a working link.
--
--   * A token is ORG + JOB scoped and EXPIRES; it can be admin-REVOKED. Both the
--     app loader AND this schema's validate trigger fail closed on expired /
--     revoked.
--
--   * A worker_acknowledgement derives its org_id AND job_id from the TOKEN
--     (never from client input), then REFUSES any subject that is not in that
--     token's own org AND its own job. So a token can only ever reach its own
--     org's job H&S materials — a cross-org (or cross-job) subject_id is
--     structurally unwritable, mirroring the safety_ack trigger's org-derive.
--
--   * Composite FKs `(id, org_id)` bind the token to jobs(id, org_id) and the
--     acknowledgement to worker_signoff_tokens(id, org_id) + jobs(id, org_id) —
--     the strongest cross-tenant guarantee (the stock_movements / site_inductions
--     idiom): a poisoned foreign id pointing at another tenant is unwritable.
--
-- Additive, RLS enabled, reversible:
--   drop table if exists public.worker_acknowledgements;
--   drop table if exists public.worker_signoff_tokens;
--   drop function if exists public.tg_worker_ack_validate();
--   drop function if exists public.tg_worker_ack_no_update();

-- ===========================================================================
-- 1. worker_signoff_tokens — the issued link. One row per link a staff member
--    hands to an external worker. Org + job scoped, hashed-at-rest, expiring,
--    revocable.
-- ===========================================================================
create table if not exists public.worker_signoff_tokens (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,

  -- The job/site the link grants access to. NOT NULL — a worker link is
  -- meaningless without a job to scope it to. Composite FK to jobs(id, org_id):
  -- the job MUST belong to this org (a poisoned cross-org job_id is unwritable).
  job_id        uuid not null,

  -- SHA-256 hex of the opaque, high-entropy (256-bit) URL token. The plaintext
  -- is shown to staff ONCE at issue time and never stored — knowledge of it is
  -- the entire credential. UNIQUE so a hash resolves to at most one link.
  token_hash    text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),

  -- WHO the link was issued to — informative provenance only (a name + firm the
  -- staff member typed), never an identity that grants anything. No login, no
  -- membership, no user_id: this is deliberately NOT a CrewFlow account.
  worker_name    text not null check (length(trim(worker_name)) between 1 and 160),
  worker_company text check (worker_company is null or length(trim(worker_company)) <= 160),

  -- Expiry is MANDATORY — every worker link lapses. The loader + the ack
  -- validate trigger both fail closed once now() >= expires_at.
  expires_at    timestamptz not null,

  -- Admin revoke. NULL = live; set = permanently dead (revocation is one-way —
  -- re-issue mints a fresh token rather than un-revoking, so a leaked link can
  -- never be resurrected).
  revoked_at    timestamptz,
  revoked_by    uuid references public.users(id) on delete set null,

  -- Telemetry only (debounced touch by the loader) — never authority.
  last_used_at  timestamptz,

  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),

  -- Composite candidate key so child evidence binds by (token, org) — a token
  -- can never be re-pointed at another tenant's org.
  constraint worker_signoff_tokens_id_org_key unique (id, org_id),

  -- The job must be in THIS org (strongest cross-tenant guarantee). set null /
  -- cascade is wrong here: an org teardown cascades via org_id; a standalone job
  -- delete is refused at commit while a live link references it (deferred).
  constraint worker_signoff_tokens_job_org_fkey
    foreign key (job_id, org_id)
    references public.jobs (id, org_id)
    on delete no action deferrable initially deferred,

  -- A revoke stamp implies who/when consistency: revoked_by only with revoked_at.
  constraint worker_signoff_tokens_revoke_consistent
    check (revoked_by is null or revoked_at is not null)
);

create index if not exists worker_signoff_tokens_org_idx
  on public.worker_signoff_tokens (org_id, created_at desc);
create index if not exists worker_signoff_tokens_job_idx
  on public.worker_signoff_tokens (org_id, job_id);
-- Live-link lookups (loader resolves by hash; this supports the org's link list).
create index if not exists worker_signoff_tokens_live_idx
  on public.worker_signoff_tokens (org_id, expires_at)
  where revoked_at is null;

-- ===========================================================================
-- 2. worker_acknowledgements — append-only signed evidence produced through a
--    token. Immutable, version-anchored, org + job derived from the token.
-- ===========================================================================
create table if not exists public.worker_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,

  -- The token this signature was produced through. Composite FK to
  -- worker_signoff_tokens(id, org_id): the token MUST be in this org.
  token_id        uuid not null,

  -- The job the token is scoped to — carried on the evidence so a query never
  -- has to re-join the token to know which site it belongs to. Trigger-derived
  -- from the token (never client input); composite FK to jobs(id, org_id).
  job_id          uuid not null,

  -- The H&S document that was signed. Polymorphic subject (a composite FK can't
  -- span three parent tables), so cross-tenant + cross-job integrity is enforced
  -- by the validate trigger, not an FK — the safety_acknowledgements idiom.
  subject_type    text not null check (subject_type in ('risk_assessment', 'permit_to_work', 'toolbox_talk')),
  subject_id      uuid not null,
  -- The version anchor: the subject's ISSUED reference (RA-/PTW-/TBT-NNNN) at
  -- sign time. Re-issuing the document leaves this record historical.
  subject_version text not null check (length(trim(subject_version)) > 0),

  acknowledged_at timestamptz not null default now(),

  -- The attestation wording + version, and the typed-name signature (whoever
  -- physically signs — an external operative with no account).
  statement         text not null check (length(trim(statement)) > 0),
  statement_version text not null default 'v1',
  signed_name       text not null check (length(trim(signed_name)) between 1 and 160),

  -- Optional drawn signature (P2 e-signature) + provenance, set ON INSERT only.
  -- Stored in the private `signatures` bucket under an org-first key.
  signature_image_bucket text,
  signature_image_path   text,
  -- Salted one-way hash of the client IP (lib/security/ip-hash) — WHO-ish +
  -- integrity, never the raw IP. NULL when the salt secret is unset.
  ip_hash         text,
  user_agent      text,

  created_at      timestamptz not null default now(),

  -- One acknowledgement per token, per issued version of a subject — re-signing
  -- the same version through the same link is an idempotent 23505.
  constraint worker_ack_unique unique (token_id, subject_type, subject_id, subject_version),

  -- The token binding, in this org.
  constraint worker_ack_token_org_fkey
    foreign key (token_id, org_id)
    references public.worker_signoff_tokens (id, org_id)
    on delete no action deferrable initially deferred,

  -- The job binding, in this org.
  constraint worker_ack_job_org_fkey
    foreign key (job_id, org_id)
    references public.jobs (id, org_id)
    on delete no action deferrable initially deferred,

  -- Org-first storage path (defence-in-depth, mirrors safety_ack_image_path_org_first).
  -- org_id is trigger-derived in a BEFORE trigger, which runs before CHECKs.
  constraint worker_ack_image_path_org_first check (
    signature_image_path is null
    or split_part(signature_image_path, '/', 1) = org_id::text
  )
);

create index if not exists worker_ack_token_idx
  on public.worker_acknowledgements (token_id, acknowledged_at desc);
create index if not exists worker_ack_subject_idx
  on public.worker_acknowledgements (org_id, subject_type, subject_id);
create index if not exists worker_ack_job_idx
  on public.worker_acknowledgements (org_id, job_id);

-- ---------------------------------------------------------------------------
-- Validate + org/job-derive (BEFORE INSERT).
--
-- SECURITY DEFINER so it reads the token + subject's TRUE owning org, not the
-- subset RLS exposes. This is THE isolation gate for the external surface:
--   1. Resolve the token → its org, job, expiry, revoke state (fail closed).
--   2. Derive org_id + job_id from the TOKEN — client-supplied values are
--      overwritten, so they can never widen scope.
--   3. Reject an expired or revoked token (defence-in-depth with the loader).
--   4. Resolve the subject's org + job + reference + status. The subject MUST be
--      in the token's org AND the token's job — a cross-org OR cross-job
--      subject is refused. Then it must be LIVE + signable, and the version
--      anchor must match the subject's issued reference.
--   5. Pin the evidence timestamps server-side (no client backdating).
-- ---------------------------------------------------------------------------
create or replace function public.tg_worker_ack_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t_org     uuid;
  t_job     uuid;
  t_expires timestamptz;
  t_revoked timestamptz;
  s_org     uuid;
  s_job     uuid;
  s_ref     text;
  s_status  text;
  s_from    timestamptz;
  s_until   timestamptz;
begin
  -- 1. Resolve the token. A missing token reveals nothing beyond "not found".
  select org_id, job_id, expires_at, revoked_at
    into t_org, t_job, t_expires, t_revoked
    from public.worker_signoff_tokens
   where id = new.token_id;
  if t_org is null then
    raise exception 'sign-off link not found';
  end if;

  -- 2. org_id + job_id are AUTHORITATIVE from the token — a spoofed org/job on
  --    the insert can never cross a tenant or job boundary.
  new.org_id := t_org;
  new.job_id := t_job;

  -- 3. The link must be live: not revoked, not expired.
  if t_revoked is not null then
    raise exception 'this sign-off link has been revoked';
  end if;
  if t_expires <= now() then
    raise exception 'this sign-off link has expired';
  end if;

  -- 4. Resolve the subject, scoped to the token's ORG and JOB. The `and org_id =
  --    t_org and job_id = t_job` in each lookup is the load-bearing isolation:
  --    a subject in another org, or in this org but a DIFFERENT job, resolves to
  --    NULL and is rejected as "not available on this job" — the token can only
  --    ever reach its own job's materials.
  if new.subject_type = 'risk_assessment' then
    select org_id, job_id, reference, status into s_org, s_job, s_ref, s_status
      from public.risk_assessments
     where id = new.subject_id and org_id = t_org and job_id = t_job;
  elsif new.subject_type = 'permit_to_work' then
    select org_id, job_id, reference, status, valid_from, valid_until
      into s_org, s_job, s_ref, s_status, s_from, s_until
      from public.permits_to_work
     where id = new.subject_id and org_id = t_org and job_id = t_job;
  elsif new.subject_type = 'toolbox_talk' then
    select org_id, job_id, reference, status into s_org, s_job, s_ref, s_status
      from public.toolbox_talks
     where id = new.subject_id and org_id = t_org and job_id = t_job;
  else
    raise exception 'unknown subject_type %', new.subject_type;
  end if;
  if s_org is null then
    raise exception 'that document is not available on this job';
  end if;

  -- 5. The document must be LIVE + signable.
  if new.subject_type = 'risk_assessment' then
    if s_status is distinct from 'issued' then
      raise exception 'cannot acknowledge a % risk assessment', coalesce(s_status, 'missing');
    end if;
  elsif new.subject_type = 'toolbox_talk' then
    if s_status is distinct from 'issued' then
      raise exception 'cannot acknowledge a % toolbox talk', coalesce(s_status, 'missing');
    end if;
  else
    if s_status not in ('issued', 'active') then
      raise exception 'cannot acknowledge a % permit', coalesce(s_status, 'missing');
    end if;
    if (s_from is not null and now() < s_from) or (s_until is not null and now() >= s_until) then
      raise exception 'cannot acknowledge a permit outside its validity window';
    end if;
  end if;

  -- 6. Version anchor must match the subject's issued reference.
  if new.subject_version is distinct from s_ref then
    raise exception 'version mismatch: subject is at % not %', coalesce(s_ref, 'unissued'), new.subject_version;
  end if;

  -- 7. Pin the evidence timestamps server-side — sign time can't be backdated.
  new.acknowledged_at := now();
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists tg_worker_ack_validate on public.worker_acknowledgements;
create trigger tg_worker_ack_validate
  before insert on public.worker_acknowledgements
  for each row execute function public.tg_worker_ack_validate();

-- ---------------------------------------------------------------------------
-- Append-only: a signed acknowledgement is evidence and can never be edited.
-- Blocks UPDATE even for the service role (RLS alone would not). Re-signing is a
-- NEW row (a new version), never an edit of the old one.
-- ---------------------------------------------------------------------------
create or replace function public.tg_worker_ack_no_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'worker acknowledgements are append-only and cannot be modified';
end;
$$;

drop trigger if exists tg_worker_ack_no_update on public.worker_acknowledgements;
create trigger tg_worker_ack_no_update
  before update on public.worker_acknowledgements
  for each row execute function public.tg_worker_ack_no_update();

-- ===========================================================================
-- RLS
-- ===========================================================================
-- worker_signoff_tokens — the STAFF surface. Org members read + issue; admins
-- may revoke (UPDATE limited to revoke columns is enforced app-side; RLS gates
-- the row to admins). The external worker never touches this table through RLS —
-- the loader resolves it on the service-role client, gated by the hashed token.
alter table public.worker_signoff_tokens enable row level security;

create policy worker_signoff_tokens_select on public.worker_signoff_tokens
  for select using (org_id in (select public.current_org_ids()));
create policy worker_signoff_tokens_insert on public.worker_signoff_tokens
  for insert with check (public.is_org_member(org_id));
-- Revoke is the only permitted mutation, and it is admin-gated. The app-layer
-- action further pins the UPDATE to revoke columns + the active org.
create policy worker_signoff_tokens_update on public.worker_signoff_tokens
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
-- No DELETE policy → a link row (and the evidence trail it anchors) is not
-- destroyable through RLS; org teardown cascades via org_id.

-- worker_acknowledgements — org members READ the evidence. There is NO insert
-- policy for authenticated users: worker acknowledgements are written ONLY by
-- the token-gated portal on the service-role client (RLS-bypassing), after the
-- validate trigger has proved token + org + job + subject. An authenticated
-- member therefore cannot forge a worker signature, and an external worker has
-- no session at all.
--
-- IMMUTABILITY — stated accurately (matches the safety_acknowledgements /
-- site_inductions precedent; deliberately NOT a divergent no-delete trigger):
--   * UPDATE is blocked by the tg_worker_ack_no_update trigger for ALL roles,
--     the service role included (RLS alone would not stop the service role).
--   * DELETE is prevented by RLS: there is NO delete policy, so no authenticated
--     member can delete a row. The service role bypasses RLS, so a hard delete
--     is possible only from a privileged service-role path (reserved for a
--     future controlled GDPR-erasure flow); ordinary org teardown removes rows
--     via the org_id cascade, never a hand DELETE here.
alter table public.worker_acknowledgements enable row level security;

create policy worker_ack_select on public.worker_acknowledgements
  for select using (org_id in (select public.current_org_ids()));

comment on table public.worker_signoff_tokens is
  'External-worker H&S sign-off links: org+job scoped, high-entropy token stored only as SHA-256 hash, mandatory expiry, admin-revocable. Mints no membership. See 20261185000000.';
comment on table public.worker_acknowledgements is
  'Append-only external-worker H&S sign-off evidence, produced through a worker_signoff_token. Version-anchored, immutable-on-update, org_id + job_id derived from the token (never client input). See 20261185000000.';
