-- ============================================================================
-- FEATURE: Universal customer search.
-- ============================================================================
-- CrewFlow's customer-matching was name-prefix biased and formatting-literal:
--   * the customers list + Cmd/K route ran a SINGLE whole-term `ILIKE '%term%'`
--     across name/email/phone/address, so a two-word query ("smith malone")
--     matched only when those exact words sat adjacent in ONE column — never
--     "surname + street" across columns;
--   * phone matched the raw stored string, so "07700 900123" could not find a
--     customer stored as "+44 7700 900123"; and
--   * postcode matched the raw stored string, so "bt91ab" could not find
--     "BT9 1AB".
-- Tradespeople search by any fragment of a name, address, town, postcode, phone
-- or email, in any order, however it is punctuated.
--
-- This migration is the DATA + QUERY foundation for the shared, reusable
-- customer-search capability (lib/customers/search.ts + /api/customers/search +
-- the CustomerCombobox + the customers list page). It is ADDITIVE ONLY:
--   1. two STORED generated columns that normalise phone (digits only) and
--      postcode (upper, alphanumerics only) so formatting-tolerant matching is a
--      plain indexed column comparison, defined ONCE in the schema;
--   2. pg_trgm GIN indexes on those two columns (name/email/phone/address are
--      already trigram-covered by 20260709000000 + 20261042000000); and
--   3. a SECURITY DEFINER search RPC that does the multi-token, partial-anywhere,
--      case-insensitive, normalisation-aware matching + deterministic ranking +
--      a SAFE capped, paginated result with an exact total — the single matching
--      implementation every surface shares.
--
-- No table/column/constraint/policy is dropped or weakened; `if not exists`
-- everywhere; safe to roll forward without a data backfill (STORED generated
-- columns are computed for every existing row on add).
-- ROLLBACK:
--   drop function if exists public.search_customers(uuid, text, text, int, int);
--   drop index if exists public.customers_postcode_normalized_trgm;
--   drop index if exists public.customers_phone_normalized_trgm;
--   alter table public.customers drop column if exists postcode_normalized;
--   alter table public.customers drop column if exists phone_normalized;
-- ============================================================================

create extension if not exists pg_trgm;

-- ── Normalised, matching-only columns ──────────────────────────────────────
-- Both are STORED generated columns so the normalisation rule lives in exactly
-- ONE place and is maintained automatically on every insert/update — a trigger
-- or an app-side backfill could drift. Both use IMMUTABLE functions only
-- (regexp_replace / upper), as STORED generated columns require. NULL (not '')
-- when nothing is left, so the trigram index stays sparse and a token never
-- matches an empty normalised value by accident.
--
-- phone_normalized: digits only — "+44 7700 900123", "07700 900123" and
--   "(07700) 900 123" all normalise so a digit substring of the query finds the
--   row regardless of how either side is punctuated.
-- phone_sig: the UK "significant" digits — phone_normalized with a leading
--   country code (44) or trunk 0 stripped, so the national-dialled "07700900123"
--   and the stored international "+447700900123" reconcile to one value
--   ("7700900123"). Matching tries BOTH columns, so typing the number in either
--   form (or just a middle chunk) finds the customer.
-- postcode_normalized: upper-case, alphanumerics only — "BT9 1AB" / "bt9-1ab" /
--   "bt91ab" all normalise to "BT91AB", so a partial postcode matches.
alter table public.customers
  add column if not exists phone_normalized text
    generated always as (nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')) stored;

alter table public.customers
  add column if not exists phone_sig text
    generated always as (
      nullif(
        case
          when regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') like '44%'
            then substr(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 3)
          when regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') like '0%'
            then substr(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 2)
          else regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
        end,
        ''
      )
    ) stored;

alter table public.customers
  add column if not exists postcode_normalized text
    generated always as (nullif(upper(regexp_replace(coalesce(postcode, ''), '[^A-Za-z0-9]', '', 'g')), '')) stored;

-- These two derived columns carry NO information beyond the already-exposed
-- phone/postcode, and the search RPC (SECURITY DEFINER) reads them regardless of
-- client grants, so no explicit GRANT is added for them. Trigram GIN indexes so
-- the `like '%frag%'` normalised comparisons are index-backed at scale (note:
-- created WITHOUT `concurrently` — Supabase wraps each migration in a txn, which
-- disallows concurrent index builds; the build lock is immaterial at launch
-- volumes, exactly as 20261042000000 documents).
create index if not exists customers_phone_normalized_trgm
  on public.customers using gin (phone_normalized gin_trgm_ops);
create index if not exists customers_phone_sig_trgm
  on public.customers using gin (phone_sig gin_trgm_ops);
create index if not exists customers_postcode_normalized_trgm
  on public.customers using gin (postcode_normalized gin_trgm_ops);

-- ── The shared search RPC ──────────────────────────────────────────────────
-- SECURITY DEFINER (bypasses RLS) → a member of the secdef-org-RPC class that
-- __tests__/integration/rls/secdef-org-rpc-guard.test.ts introspects. The FIRST
-- act authorises the caller against p_org_id via public.current_org_ids() and
-- raises 42501 for a non-member, so a Data-API caller with the public anon key
-- can NEVER read across the tenant boundary. This MIRRORS the customers RLS
-- SELECT policy exactly ("members can select": org membership, ANY role) — the
-- RPC widens neither the tenant NOR the role boundary beyond direct table
-- access. The management-only *product* framing for customer existence stays
-- where it already lives (the customers list capability gate + the /api/search
-- role filter); this RPC is never more permissive than the picker/list surfaces
-- it powers. service_role (no JWT) skips the membership check and is STILL
-- org-filtered by p_org_id inside, exactly as the sibling RPCs do.
--
-- MATCHING. The sanitised query is split into whitespace tokens (capped at 10).
-- A row matches when EVERY token matches SOMEWHERE (AND across tokens, OR across
-- fields) — so "smith malone bt9" finds a customer named Smith on Malone Road in
-- BT9 even though no single column holds all three. Each token is matched:
--   * case-insensitively, partial-anywhere, against name / email / address
--     line1+line2 / city / county / legacy notes (ILIKE, LIKE-special chars in
--     the token escaped so a stray % / _ can't broaden the match);
--   * as digits-only against phone_normalized (formatting-tolerant); and
--   * as upper/alphanumeric against postcode_normalized (partial postcode).
-- An empty query returns the org's customers unfiltered (the list-page browse),
-- ordered newest-first with a stable id tiebreak — byte-identical to the
-- existing list ordering.
--
-- RESULT. A deterministic relevance rank (exact name > name prefix > name
-- contains > postcode prefix > other-field) then newest-first, capped at a SAFE
-- limit (1..200) with an offset, plus an exact `total_count` window so the list
-- page keeps true-total pagination. Every value returned is already
-- customer-visible; no money/secret column is selected.
create or replace function public.search_customers(
  p_org_id uuid,
  p_query  text default null,
  p_type   text default null,
  p_limit  int  default 20,
  p_offset int  default 0
)
returns table (
  id                 uuid,
  name               text,
  email              text,
  phone              text,
  customer_type      text,
  address_line1      text,
  address_line2      text,
  city               text,
  county             text,
  postcode           text,
  country            text,
  parent_customer_id uuid,
  created_at         timestamptz,
  relevance          int,
  total_count        bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit  int    := least(greatest(coalesce(p_limit, 20), 1), 200);
  v_offset int    := greatest(coalesce(p_offset, 0), 0);
  v_type   text   := case when p_type in ('individual', 'business') then p_type else null end;
  v_q      text   := btrim(coalesce(p_query, ''));
  v_pc     text   := nullif(upper(regexp_replace(coalesce(p_query, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_tokens text[];
  -- WHOLE-QUERY phone forms. A user who writes a UK mobile the natural way —
  -- "+44 7700 900123" — splits into whitespace tokens ["+44","7700","900123"].
  -- The per-token AND then fails on "+44": its digits are "44", its UK-
  -- significant form is EMPTY (44 stripped), so a nationally-stored "07700
  -- 900123" (which contains no "44") makes that token unmatchable and the row is
  -- excluded. To keep the documented promise ("either form finds the customer"),
  -- when the query is phone-only (no letters, >=7 digits) we ALSO let a row
  -- qualify if the query's whole digit string — or its UK-significant form —
  -- is a substring of the row's phone. This only ever BROADENS phone-only
  -- queries; it never relaxes the tenant filter (the org_id predicate is
  -- unconditional) and never affects mixed name+number queries.
  v_qdigits text := nullif(regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g'), '');
  v_qsig    text := nullif(
    case
      when regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g') like '44%'
        then substr(regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g'), 3)
      when regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g') like '0%'
        then substr(regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g'), 2)
      else regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g')
    end, '');
  v_phone_only boolean := (v_q <> '' and v_q !~ '[A-Za-z]'
                           and length(regexp_replace(v_q, '[^0-9]', '', 'g')) >= 7);
begin
  -- Canonical org-membership guard — MUST be the first act (SECURITY DEFINER
  -- bypasses RLS). A non-member via the Data API is refused with 42501 before a
  -- single row is read; service_role skips it and is org-filtered by p_org_id.
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- Whitespace tokens, empties dropped, capped so a pathological query can't
  -- explode the per-row AND check.
  if v_q = '' then
    v_tokens := array[]::text[];
  else
    v_tokens := (
      select coalesce(array_agg(tok), array[]::text[])
      from (
        select tok
        from unnest(regexp_split_to_array(v_q, '\s+')) as tok
        where tok <> ''
        limit 10
      ) s
    );
  end if;

  return query
  with toks as (
    -- Pre-compute each token's match forms ONCE. The ILIKE pattern escapes the
    -- LIKE metacharacters (\ % _) so a token can only ever match literally;
    -- digits/sig/pc are restricted to [0-9] / [A-Za-z0-9] so they carry none.
    --   digits: the phone form — ONLY for a token with no letters, so a token
    --     like "bt9" never leaks a stray digit into a phone match; NULL for an
    --     alphabetic token disables its phone branch entirely.
    --   sig:    digits with a leading 44 / 0 stripped (UK significant number),
    --     matched against phone_sig so national and international forms reconcile.
    --   pc:     the postcode form (upper, alphanumeric).
    select
      '%' || replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%' as like_any,
      d.digits,
      nullif(
        case
          when d.digits like '44%' then substr(d.digits, 3)
          when d.digits like '0%'  then substr(d.digits, 2)
          else d.digits
        end, '') as sig,
      nullif(upper(regexp_replace(tok, '[^A-Za-z0-9]', '', 'g')), '') as pc
    from unnest(v_tokens) as tok
    cross join lateral (
      select case
               when tok ~ '[A-Za-z]' then null
               else nullif(regexp_replace(tok, '[^0-9]', '', 'g'), '')
             end as digits
    ) d
  ),
  base as (
    select c.*
    from public.customers c
    where c.org_id = p_org_id
      and (v_type is null or c.customer_type = v_type)
      -- "every token matches somewhere" == "no token fails to match". With an
      -- empty query `toks` is empty, so this is vacuously true → all rows.
      -- A phone-only query ALSO qualifies a row whose phone contains the whole
      -- query's digit string or its UK-significant form — so the spaced
      -- international form ("+44 7700 900123", which tokenises the "+44" into an
      -- unmatchable country-code fragment) still finds a nationally-stored
      -- number. Phone-only guard + the unconditional org_id filter above mean
      -- this broadens nothing but phone matching and crosses no tenant boundary.
      and (
        (v_phone_only and (
          (c.phone_sig is not null and v_qsig is not null
             and c.phone_sig like '%' || v_qsig || '%')
          or (c.phone_normalized is not null and v_qdigits is not null
             and c.phone_normalized like '%' || v_qdigits || '%')
        ))
        or not exists (
        select 1
        from toks t
        where not (
          -- coalesce every text column to '' so a NULL column yields FALSE, not
          -- NULL: a NULL inside the OR would make the whole match NULL, `not
          -- NULL` is NULL (never TRUE), the failing-token check would miss it and
          -- EVERY row would leak through. The phone/postcode branches are already
          -- NULL-guarded to FALSE, so they stay as-is.
          coalesce(c.name, '')          ilike t.like_any escape '\'
          or coalesce(c.email::text, '')   ilike t.like_any escape '\'
          or coalesce(c.address_line1, '') ilike t.like_any escape '\'
          or coalesce(c.address_line2, '') ilike t.like_any escape '\'
          or coalesce(c.city, '')          ilike t.like_any escape '\'
          or coalesce(c.county, '')        ilike t.like_any escape '\'
          or coalesce(c.notes, '')         ilike t.like_any escape '\'
          or (t.digits is not null and c.phone_normalized is not null
                and c.phone_normalized like '%' || t.digits || '%')
          or (t.sig is not null and c.phone_sig is not null
                and c.phone_sig like '%' || t.sig || '%')
          or (t.pc is not null and c.postcode_normalized is not null
                and c.postcode_normalized like '%' || t.pc || '%')
        )
        )
      )
  ),
  ranked as (
    select
      b.*,
      case
        when v_q = '' then 0
        when lower(b.name) = lower(v_q)                              then 5
        when b.name ilike (replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\' then 4
        when b.name ilike ('%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\' then 3
        when v_pc is not null and b.postcode_normalized is not null
             and b.postcode_normalized like v_pc || '%'             then 2
        else 1
      end as rel
    from base b
  )
  select
    r.id,
    r.name,
    r.email::text,
    r.phone,
    r.customer_type,
    r.address_line1,
    r.address_line2,
    r.city,
    r.county,
    r.postcode,
    r.country,
    r.parent_customer_id,
    r.created_at,
    r.rel                 as relevance,
    count(*) over()       as total_count
  from ranked r
  -- Deterministic: relevance, then newest-first, then a unique id tiebreak so
  -- paging never drops or repeats a row at a page boundary.
  order by r.rel desc, r.created_at desc, r.id desc
  limit v_limit offset v_offset;
end;
$$;

-- Guarded, not revoked — real members must be able to call it (mirrors the
-- invoice/quote/counter/top-customers RPCs).
grant execute on function public.search_customers(uuid, text, text, int, int) to authenticated;
