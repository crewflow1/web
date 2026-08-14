-- P2 Signature — private storage bucket for drawn e-signature images.
--
-- One private `signatures` bucket holds the canvas-drawn PNGs for BOTH
-- quote/variation acceptance and H&S operative sign-off. It follows the
-- job-docs / blueprints storage discipline exactly:
--   * PRIVATE bucket (public=false) — bytes are only ever reachable through a
--     short-lived signed URL minted server-side after an org-ownership check;
--   * org-first key: `${org_id}/${scope}/${subject_id}/${sigId}.png`, so the
--     first path segment is the tenant and storage RLS can scope on it;
--   * PNG only, small size cap (a canvas signature is a few KB–low hundreds).
--
-- BYTE-MUTATION LOCKDOWN (20261032): every write to storage.objects is
-- SERVICE-ROLE-ONLY. Both write paths (quote-accept + H&S sign-off) already
-- upload through server/services/signature-capture.ts via createAdminClient(),
-- and deletion (orphan cleanup + admin removal) goes the same way. So this
-- bucket gets NO tenant INSERT/UPDATE/DELETE policy — only an org-scoped READ
-- so a member's browser can load the operator-facing audit-trail image.
--
-- IDEMPOTENT create; the bucket is NEVER dropped by a down-migration (that
-- would fail on existing objects or permanently delete signed evidence).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signatures', 'signatures', false, 2097152, array['image/png'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public             = excluded.public;

-- Members of the owning org may READ (org-scoped by the org_id first path
-- segment). Signed URLs are also minted server-side via the admin client, so
-- this SELECT policy is defence-in-depth, not the only read path. No write
-- policy — byte mutation stays service-role-only (20261032 lockdown).
drop policy if exists "signatures: members can read" on storage.objects;
create policy "signatures: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'signatures'
         and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));
