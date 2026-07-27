-- Durable, cross-instance rate-limit counters.
--
-- The app-layer limiter (lib/security/rate-limit.ts) was an in-memory Map:
-- per-Lambda, fixed-window, fail-open. On serverless that is near-useless — a
-- spammer hitting cold starts gets a fresh counter on each instance. This table
-- plus the atomic `rate_limit_hit` RPC give every instance ONE shared counter,
-- so the abuse-prone unauthenticated surfaces (auth email-send, customer-portal
-- token routes, public quote accept/decline, waitlist) are actually throttled.
--
-- Storage is tiny and self-healing: one row per key, expired windows reset in
-- place on the next hit, and `rate_limit_sweep()` can prune idle keys via cron.
-- This is NOT tenant data and carries no org_id.

create table if not exists public.rate_limit_counters (
  key          text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now(),
  reset_at     timestamptz not null
);

comment on table public.rate_limit_counters is
  'Shared fixed-window rate-limit counters. Written only via the rate_limit_hit() RPC from the service role. Not tenant data.';

-- Lock it down: RLS on, NO policies → anon/authenticated cannot read or write.
-- Only the service role (RLS-exempt) and the SECURITY DEFINER RPCs touch it.
alter table public.rate_limit_counters enable row level security;

-- Supports the cleanup sweep below.
create index if not exists rate_limit_counters_reset_at_idx
  on public.rate_limit_counters (reset_at);

-- Atomic check-and-increment for one request against one key.
--   - Expired window (reset_at <= now): start a fresh window at count = 1.
--   - Otherwise: increment.
-- Returns whether THIS hit is within the limit, the remaining allowance, and
-- when the window resets. Atomic via a single INSERT ... ON CONFLICT DO UPDATE.
create or replace function public.rate_limit_hit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_count integer;
  v_reset timestamptz;
begin
  insert into public.rate_limit_counters as r (key, count, window_start, reset_at)
  values (p_key, 1, v_now, v_now + make_interval(secs => p_window_seconds))
  on conflict (key) do update
    set count        = case when r.reset_at <= v_now then 1 else r.count + 1 end,
        window_start = case when r.reset_at <= v_now then v_now else r.window_start end,
        reset_at     = case when r.reset_at <= v_now
                            then v_now + make_interval(secs => p_window_seconds)
                            else r.reset_at end
  returning r.count, r.reset_at into v_count, v_reset;

  return query select (v_count <= p_limit), greatest(0, p_limit - v_count), v_reset;
end;
$$;

-- Only the service role may execute it (the app calls it via the admin client).
revoke all on function public.rate_limit_hit(text, integer, integer) from public;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- Optional housekeeping: prune counters whose window ended over a day ago.
-- Safe to call from cron; not required for correctness.
create or replace function public.rate_limit_sweep()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limit_counters where reset_at < now() - interval '1 day';
$$;

revoke all on function public.rate_limit_sweep() from public;
grant execute on function public.rate_limit_sweep() to service_role;
