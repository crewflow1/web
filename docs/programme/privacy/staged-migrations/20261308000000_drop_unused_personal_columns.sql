-- ════════════════════════════════════════════════════════════════════════════
-- STAGED — APPROVAL REQUIRED — NOT A MIGRATION — DO NOT APPLY AS-IS
-- Reserved version if approved: 20261308000000
-- ════════════════════════════════════════════════════════════════════════════
-- DATA MINIMISATION: drop three personal-data columns that nothing needs.
--
--   1. time_entries.gps_lat / gps_lng   precise worker location at clock-in.
--        No UI ever captured it; geolocation is denied by the Permissions-Policy;
--        the clock-in action stopped accepting it on branch
--        privacy/data-register-and-policy (commit d1c86403).
--   2. users.avatar_url                 OAuth profile-picture URL. Never read by
--        any screen/export/email; the bootstrap stopped writing it (fdf847dd).
--   3. demo_requests.user_agent         Never written by any code path.
--
-- EVIDENCE (production, aggregate counts, 2026-11-13):
--   time_entries: 0 rows (0 with gps) · users: 4 rows, 2 with avatar_url ·
--   demo_requests: 3 rows, 0 with user_agent.
-- Catalogue check (local, 2026-11-13): no view, function, index, policy or
-- constraint depends on any of the four columns.
--
-- ORDER OF OPERATIONS (expand/contract — this is the CONTRACT step):
--   a. The branch above must be DEPLOYED first, so no running code selects or
--      writes these columns. (Old code selecting gps_lat would 500 on /me.)
--   b. Then apply this file.
--
-- FOLLOW-UP EDITS REQUIRED IN THE SAME PR:
--   * regenerate lib/supabase/types.ts;
--   * __tests__/integration/rls/public-api-expansion.test.ts seeds gps_lat /
--     gps_lng to prove the public DTO excludes them — remove those two seed
--     fields (the column no longer exists to leak) and drop them from the
--     `forbidden` lists there and in __tests__/security/public-api-expansion.test.ts;
--   * lib/public-api/time.ts header comment mentions the columns.
--
-- IRREVERSIBLE: the two avatar URLs are destroyed. They are re-obtainable from
-- the OAuth provider and have no product use, so no backup step is proposed.

-- ── PRE-FLIGHT (read-only; run first, expect the values shown) ──────────────
-- select count(*) filter (where gps_lat is not null or gps_lng is not null) as gps_rows from public.time_entries;        -- expect 0
-- select count(*) filter (where user_agent is not null) as ua_rows from public.demo_requests;                           -- expect 0
-- select count(*) filter (where avatar_url is not null) as avatar_rows from public.users;                               -- informational
-- select count(*) from pg_depend d join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
--   join pg_class c on c.oid=d.refobjid
--  where c.relname in ('time_entries','users','demo_requests')
--    and a.attname in ('gps_lat','gps_lng','avatar_url','user_agent') and d.deptype <> 'a';                              -- expect 0

begin;

alter table public.time_entries  drop column if exists gps_lat;
alter table public.time_entries  drop column if exists gps_lng;
alter table public.users         drop column if exists avatar_url;
alter table public.demo_requests drop column if exists user_agent;

commit;
