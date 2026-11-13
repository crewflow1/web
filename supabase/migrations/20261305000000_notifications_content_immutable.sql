-- 20261305000000 — notifications: content is immutable to tenant users (INJ-01).
--
-- FINDING (live catalogue, verified 2026-11-13 on prod + local): `notifications`
-- carries the Supabase default table-wide UPDATE grant for anon + authenticated.
-- The RLS policy `notifications_update` decides WHICH ROWS a member may touch
-- (their own targeted rows + the org-wide rows they can see) but RLS never
-- restricts COLUMNS. The application only ever writes `read_at` / `dismissed_at`
-- from a user session (server/services/notifications-service.ts,
-- app/(app)/_components/notifications-actions.ts) — every content write goes
-- through the service role. So the table grant was strictly wider than any
-- legitimate caller, and any member could PATCH /rest/v1/notifications directly:
--
--   • a non-admin staff member could rewrite `action_url` / `title` / `body` on
--     an org-wide row every other member (incl. the owner) sees. `action_url`
--     is rendered as the deep link in the bell + /notifications and appended to
--     `https://crewflow.uk` in the digest + notification emails — so a value of
--     `@evil.example/login` became a first-party-sent phishing link;
--   • a member could promote their OWN targeted row to an org-wide broadcast
--     (`user_id` → null, `audience_scope` → 'all') with forged content.
--
-- Proven exploitable (pre-fix RED) and closed (post-fix GREEN) by
-- __tests__/integration/rls/notifications-column-immutability.test.ts.
--
-- FIX: column-restrict the client UPDATE grant to the two read-state columns the
-- app legitimately writes. Same idiom as 20261231000000 §C (marketplace_partners)
-- and 20261086000000 (api_keys). RLS is UNCHANGED and remains the row gate; this
-- only narrows what a permitted row-update may set. The service role bypasses
-- grants, so every server-side writer (notifications-service `admin()`, the
-- delivery ledgers, HQ actions) is unaffected. The BEFORE UPDATE trigger
-- `notifications_touch` still stamps `updated_at` (column privileges are checked
-- against the statement's SET list, not trigger assignments).
--
-- anon never satisfies the RLS predicate (auth.uid() is null, current_org_ids()
-- is empty), so its UPDATE grant was pure latent exposure — revoked outright.
--
-- Forward-only, idempotent, no data change.

revoke update on table public.notifications from anon, authenticated;

grant update (read_at, dismissed_at)
  on public.notifications to authenticated;
