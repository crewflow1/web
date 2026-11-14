-- ════════════════════════════════════════════════════════════════════════════
-- STAGED — APPROVAL REQUIRED — NOT A MIGRATION — DO NOT APPLY AS-IS
-- Reserved version if approved: 20261310000000
-- ════════════════════════════════════════════════════════════════════════════
-- DATA MINIMISATION: one-off removal of rate-limit counters written BEFORE the
-- keyed-digest change (branch privacy/data-register-and-policy, commit 253aece3).
--
-- Until that change, public.rate_limit_counters.key was '<route>:<identifier>'
-- VERBATIM, where the identifier is a visitor's raw IP address, a raw sign-in
-- email address, or a raw customer-portal bearer token. rate_limit_sweep() was
-- never called, so the rows never expired.
--
-- EVIDENCE (production, aggregate, 2026-11-13): 11 rows; at the earlier sample
-- all 10 then present had a closed window; the oldest window started 115 days
-- earlier.
--
-- THIS FILE IS OPTIONAL. The same branch adds a daily call to rate_limit_sweep()
-- (from /api/cron/cron-runs-prune), which deletes any counter whose window
-- closed more than a day ago — i.e. every pre-change row within ~24h of deploy.
-- Apply this only if the rows should be gone before/independently of that.
--
-- SAFE: deleting a counter can only ever make the limiter MORE permissive for
-- one window; new-format rows ('<route>:h1_<40 hex>') are deliberately untouched.

-- ── PRE-FLIGHT (read-only; run first) ────────────────────────────────────────
-- select count(*) filter (where key !~ ':h1_[0-9a-f]{40}$') as verbatim_rows,
--        count(*) filter (where key  ~ ':h1_[0-9a-f]{40}$') as digest_rows
--   from public.rate_limit_counters;

begin;

delete from public.rate_limit_counters
 where key !~ ':h1_[0-9a-f]{40}$';

commit;
