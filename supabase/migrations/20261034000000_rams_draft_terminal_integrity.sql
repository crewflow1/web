-- Security wave S4 — RAMS draft->terminal forgery integrity fix.
--
-- The audit found the same P0-class forgery bypass in RAMS that the toolbox wave (20261030)
-- closed for toolbox talks: tg_ra_lifecycle only gates draft->issued (readiness + provenance
-- pin), and tg_ra_immutable_when_issued (20261022) early-returns on old.status='draft'. So a
-- draft has NO guard against a direct PATCH straight to 'withdrawn'/'superseded' — a JWT
-- member could mint a terminal "evidence" record with a forged/back-dated reference, spoofed
-- issued_by, and NO assessor/hazard (never passing the issue gate). The honest app path is
-- safe (transition() filters .eq("status","issued")), but the DB is the real backstop.
--
-- This is an INTEGRITY fix, not a role-policy change: it enforces the EXISTING lifecycle
-- (a draft may only be issued, per canTransition), which the app already assumes. It does
-- NOT change who may perform a transition — RAMS lifecycle transitions remain member-level in
-- both app and DB, exactly as today (the member-vs-owner/admin question is a separate product
-- decision, deliberately NOT decided here).
--
-- CREATE OR REPLACE of tg_ra_lifecycle only (body identical to 20261021 plus the one guard);
-- the trigger is already bound. JWT-gated (auth.uid() present) so the trusted service role
-- (fixtures/migrations that seed historical superseded records) stays exempt — the same
-- asymmetry as born-draft/issue-gate. Additive + reversible: restore the 20261021 body.

create or replace function public.tg_ra_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Born a draft (unconditional — even the service role must start as a draft).
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a risk assessment is created as a draft, then issued';
    end if;
    return new;
  end if;

  -- [S4] A draft may only be delivered (->issued) or kept a draft. A direct
  -- draft->withdrawn/superseded PATCH would skip the issue gate below (no assessor/hazard,
  -- forged/back-dated provenance), minting terminal forged evidence — the toolbox P0 class.
  -- JWT-gated; the trusted service role is exempt.
  if old.status = 'draft' and auth.uid() is not null and new.status not in ('draft', 'issued') then
    raise exception 'a draft risk assessment can only be issued, not moved directly to %', new.status;
  end if;

  -- Draft -> issued (JWT): re-enforce readiness (named assessor + >=1 hazard) and PIN
  -- provenance server-side so issued_by/issued_at cannot be forged or back-dated.
  if old.status = 'draft' and new.status = 'issued' and auth.uid() is not null then
    if new.assessor_id is null then
      raise exception 'cannot issue: a risk assessment needs a named assessor';
    end if;
    if (select count(*) from public.risk_assessment_hazards
        where risk_assessment_id = new.id) = 0 then
      raise exception 'cannot issue: a risk assessment needs at least one hazard';
    end if;
    new.issued_by := auth.uid();
    new.issued_at := now();
  end if;

  return new;
end;
$$;
