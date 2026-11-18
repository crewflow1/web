-- ════════════════════════════════════════════════════════════════════════════
-- STAGED — APPROVAL REQUIRED — NOT A MIGRATION — DO NOT APPLY AS-IS
-- Reserved version if approved: 20261309000000
-- ════════════════════════════════════════════════════════════════════════════
-- DATA MINIMISATION: drop the orphan `public.waitlist` table.
--
-- It was the store for a marketing-era /api/waitlist endpoint that was removed on
-- 2026-10-19 (see the note in lib/supabase/middleware.ts). No route, action,
-- function, trigger or cron writes or reads it. Its shape (email, company_name,
-- phone, trade, employees, source, user_agent, ip_hash) is prospect personal
-- data plus device data — a table that exists only to be filled by mistake.
--
-- EVIDENCE: production has 0 rows (exact count, 2026-11-13). RLS is on with no
-- policies and no client grants (service-role only). Nothing references it by
-- foreign key (local catalogue check, 2026-11-13).
--
-- FOLLOW-UP EDITS REQUIRED IN THE SAME PR:
--   * regenerate lib/supabase/types.ts;
--   * __tests__/integration/rls/slice15-pr2-cclass-least-privilege.test.ts names
--     `waitlist` in its C-class table list — remove it from that list (the table
--     it asserts "no client grant" on no longer exists).
--
-- IRREVERSIBLE only in the trivial sense: the table is empty.

-- ── PRE-FLIGHT (read-only; run first) ────────────────────────────────────────
-- select count(*) from public.waitlist;                                                   -- expect 0  (STOP if not)
-- select count(*) from pg_constraint where confrelid = 'public.waitlist'::regclass;        -- expect 0

begin;

do $$
begin
  if (select count(*) from public.waitlist) > 0 then
    raise exception 'waitlist is not empty — refusing to drop; review the rows first';
  end if;
end $$;

drop table public.waitlist;

commit;
