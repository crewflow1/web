-- users.phone / employment_type / start_date: a colleague's personal details are no
-- longer readable through the Data API (least-privilege enforcement — UI finding S-2).
--
-- THE HOLE
-- --------
-- `users: members can read profiles of co-workers` lets every member read the `users`
-- row of every colleague — needed so names render on shared jobs, diaries, rotas and
-- sign-offs. RLS is row-level, so the same policy handed any `staff` member each
-- colleague's phone number, employment type and start date (via /staff, /staff/<id>,
-- or one PostgREST call).
--
-- THE FIX — a column ACL
-- ----------------------
-- For client roles, table-level SELECT is replaced by a column-level grant on
--     id, email, full_name, avatar_url, created_at, updated_at
-- (plus any other column that is not one of the three private ones). KEPT on purpose:
-- a colleague's name, work e-mail and avatar, which staff screens show on shared work.
-- phone / employment_type / start_date carry no client SELECT grant at all — not even
-- for the row's owner — and are read server-side with the service role after an
-- explicit check: the member themselves, or an owner/admin of an org they belong to
-- (server/services/private-columns.ts; server/services/holiday-balance.ts).
--   * `users` has no client write grant (20261295) — writes are service-role already.
--   * RLS policies are untouched. service_role (SMS routing, HQ, invites) unaffected.
--   * `anon` keeps the same narrowed column grant (no policy path to a row; ST-12).
--
-- NEW COLUMNS: see 20261341 — guarded by rls/private-column-acl.test.ts.
--
-- data-api:exempt: narrows an existing grant; adds no table.
-- Idempotent.
--
-- Safe to apply before the code deploys: NO — deploy the code first (or together).
--   The pre-change /settings, /me, /staff pages select these columns with the user JWT
--   and would error (42501) until the new code is live.
-- Production precondition: none.
--
-- Rollback: grant select on public.users to authenticated, anon;   (reopens S-2)

do $$
declare
  cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into cols
    from pg_attribute a
   where a.attrelid = 'public.users'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname <> all (array['phone', 'employment_type', 'start_date']);

  execute 'revoke select on public.users from anon, authenticated';
  execute format('grant select (%s) on public.users to anon, authenticated', cols);
end $$;

comment on column public.users.phone is
  'Personal data. NOT client-readable (20261342): read server-side for the member '
  'themselves or an owner/admin of their org.';
comment on column public.users.employment_type is
  'Personal data. NOT client-readable (20261342).';
comment on column public.users.start_date is
  'Personal data. NOT client-readable (20261342).';
