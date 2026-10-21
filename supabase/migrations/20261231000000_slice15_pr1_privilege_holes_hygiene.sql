-- Slice 1.5 — PR 1 of 5: confirmed privilege holes + least-privilege hygiene.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- CONTEXT. Slice 1.5 removes CrewFlow's dependence on Supabase's historical
-- automatic Data-API grants. The five-PR sequence is: (1) THIS — the concrete,
-- audit-confirmed privilege HOLES + the over-grants with a clear fix; (2) the
-- service/internal (C-class) table revokes; (3) the authenticated (B-class)
-- explicit least-privilege backfill; (4) the future-migration enforcement guard;
-- (5) the Supabase CLI bump. This PR changes NO RLS policy logic and leaves
-- service_role untouched.
--
-- VERIFICATION. Every item below was verified on 2026-10-21 against (a) the LIVE
-- PROD catalogue (read-only pg_catalog / aclexplode) and (b) the application
-- call-paths — user-JWT `createClient()` (anon/authenticated, RLS+grants) vs the
-- service-role `createAdminClient()` (bypasses both). Each revoke was proven not
-- to break a legitimate path; the per-section notes record the evidence.
--
-- DEFAULT-PRIVILEGE TRAP. This project runs
--   alter default privileges in schema public grant all ... to anon, authenticated
-- so new objects are granted to anon+authenticated DIRECTLY, not only via PUBLIC.
-- Every revoke here therefore names `public, anon, authenticated` explicitly. A
-- revoke of an absent privilege is a no-op, so this migration is idempotent.
--
-- KEEP-LIST (anon EXECUTE deliberately PRESERVED, untouched): current_org_ids,
-- is_org_admin, is_org_member — the membership primitives ~every RLS policy
-- calls. Nothing below references them.
--
-- Additive / idempotent. No schema or data change. Rollback of any line is a
-- single inverse GRANT/REVOKE (grants are metadata; no rows are touched).

-- ═══ A. demo_requests — vestigial anon INSERT exposure ═══════════════════════
-- FINDING (live): anon + authenticated hold full table grants AND an INSERT
-- policy "demo_requests: anyone insert" (with check true). But the PUBLIC demo
-- form does NOT use the anon key — app/(public)/_book-demo-modal.tsx POSTs to
-- app/api/demo/route.ts, which inserts via the SERVICE-ROLE admin client; every
-- other demo_requests path (app/admin/demos/*) is service-role too, and there is
-- no client SELECT policy ("only service role reads them", 20260528000000). So
-- the client grant + policy are vestigial and let anyone holding the public anon
-- key insert straight into the CEO approval queue and set the funnel/Stripe
-- lifecycle columns (approved_at, linked_org_id, stripe_*). FIX: drop the dead
-- policy and revoke all client grants → demo_requests is service-role-only (its
-- documented design). The public form is unaffected (it uses the service role).
drop policy if exists "demo_requests: anyone insert" on public.demo_requests;
revoke all privileges on table public.demo_requests from anon, authenticated;

-- ═══ B. marketplace_listings — self-approval via INSERT ══════════════════════
-- FINDING (live): the authenticated UPDATE grant already withholds `status`
-- (20261195000000:253-258) and a BEFORE UPDATE trigger enforces the status
-- transition graph — but the INSERT grant was left table-level (every column),
-- and the guard trigger is UPDATE-only. So an org admin could INSERT a listing
-- with status='approved' directly through PostgREST: the owner-insert RLS admits
-- an admin of the partner's org, and the discovery policy then shows the row to
-- every authenticated user — bypassing the review gate the migration's own
-- comment (20261195000000:221-223) claims INSERT enforces. createListing()
-- (user-JWT) never sends status/review_*/submitted_at — status defaults to
-- 'draft'. FIX: column-restrict the INSERT grant to the author-settable columns
-- (exactly what createListing writes, plus the editable-metadata set), so a
-- tenant cannot set status/review_notes/submitted_at/reviewed_* at creation.
-- Approval stays a service-role decision (marketplace_review_listing). Service
-- role bypasses grants, so seeds/reviews are unaffected.
revoke insert on table public.marketplace_listings from authenticated;
grant insert (partner_id, slug, name, short_description, description, category,
              logo_url, requested_scopes, webhook_url, webhook_events, created_by)
  on public.marketplace_listings to authenticated;

-- ═══ C. marketplace_partners — self-status (self-un-suspend) ═════════════════
-- FINDING (live): status ∈ {active, suspended}, DEFAULT 'active', and there is
-- NO partner-review RPC — a partner is active on creation BY DESIGN (do not
-- change that default; doing so would break the intended create behaviour).
-- Unlike listings, the partners UPDATE grant was never column-restricted, so an
-- org admin could UPDATE status='active' to self-un-suspend after a platform
-- suspension. createPartner() (user-JWT) writes only org_id/name/slug/
-- contact_email/website_url/created_by — never status. FIX: column-restrict
-- INSERT+UPDATE to exclude `status` (and other non-metadata columns). `status`
-- is then never tenant-writable: it keeps its intended 'active' default on
-- create, and only the service-role (platform) can suspend/reactivate. This
-- closes the hole WITHOUT changing the default-active create behaviour.
revoke insert, update on table public.marketplace_partners from authenticated;
grant insert (org_id, name, slug, contact_email, website_url, created_by)
  on public.marketplace_partners to authenticated;
grant update (name, slug, contact_email, website_url)
  on public.marketplace_partners to authenticated;

-- ═══ D. webhook_endpoints — missing DELETE grant (latent 42501) ══════════════
-- FINDING (live): an admin-only RLS DELETE policy exists (20261087000000:282-285)
-- and deleteWebhookEndpoint() (app/(app)/settings/webhooks/actions.ts) deletes
-- via the user-JWT client, but NO migration ever granted DELETE to authenticated
-- (20261087 re-granted only safe-column SELECT + UPDATE). RLS permits the row,
-- the role lacks the table privilege → 42501. Inert only because the feature is
-- dark; it breaks the delete path the moment outbound-webhooks is enabled. FIX:
-- grant DELETE (RLS is_org_admin + org-scope stays the row gate). The `secret`
-- column remains withheld from the authenticated SELECT grant (unchanged here).
grant delete on table public.webhook_endpoints to authenticated;

-- ═══ E. over-granted identity sequences (8) ══════════════════════════════════
-- FINDING (live): these identity sequences on internal HQ/ops tables carry
-- anon+authenticated 'rwU'. A client never needs a sequence privilege through
-- PostgREST (service-role identity inserts do not use one); the latent risk is a
-- client setval() permanently breaking inserts. FIX: revoke from clients
-- (service_role keeps 'rwU'; the owning tables are already service-role-only).
revoke all privileges on sequence
  public.api_request_log_id_seq,
  public.dead_events_id_seq,
  public.hq_ai_executor_shadow_observations_id_seq,
  public.hq_application_records_id_seq,
  public.hq_apply_audit_id_seq,
  public.hq_ceo_briefings_id_seq,
  public.hq_embedding_runs_id_seq,
  public.hq_events_id_seq
  from public, anon, authenticated;

-- ═══ F. over-exposed views (3) ═══════════════════════════════════════════════
-- FINDING (live): these 3 views are security_invoker=true (no RLS bypass) but
-- carry anon+authenticated 'arwdDxtm' — full privileges, including meaningless
-- write bits on a view. They are read ONLY from the authenticated app surface
-- (app/(app)/quality, lib/stock, lib/quality); no anon/public/portal path reads
-- them. FIX: revoke from clients, then grant authenticated SELECT only (anon
-- gets nothing). security_invoker means the underlying tables' RLS still gates
-- the rows.
revoke all privileges on table
  public.stock_balances,
  public.stock_valuation,
  public.works_quality_plan_status
  from public, anon, authenticated;
grant select on table
  public.stock_balances,
  public.stock_valuation,
  public.works_quality_plan_status
  to authenticated;

-- ═══ G. AI-governor RPCs (12) → service-role only ════════════════════════════
-- FINDING (live): 4 month-rollup RPCs are explicitly granted anon+authenticated,
-- the other 8 are already service-role-only (the revokes below are belt-and-
-- braces against the default-privilege trap). NO user-JWT call site exists for
-- ANY of them — lib/ai/governor.ts, app/admin/ai-costs/*, server/services/
-- {ai-budget-controls,ai-cost-snapshot,maintenance-reminders}.ts all use the
-- service-role admin client. A client holding EXECUTE could probe or manipulate
-- the cost governor. FIX: revoke EXECUTE from public/anon/authenticated; keep
-- service_role.
revoke all on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_reserve_invocation(uuid, text, text, integer, uuid, text, integer, integer, integer) to service_role;
revoke all on function public.ai_settle_reservation(uuid, boolean, integer, text, text, integer, integer, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.ai_settle_reservation(uuid, boolean, integer, text, text, integer, integer, integer, text, uuid) to service_role;
revoke all on function public.ai_release_reservation(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_release_reservation(uuid, text) to service_role;
revoke all on function public.ai_set_org_ceiling(uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_set_org_ceiling(uuid, integer, uuid, text) to service_role;
revoke all on function public.ai_clear_org_ceiling(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_clear_org_ceiling(uuid, uuid, text) to service_role;
revoke all on function public.ai_set_employee_limit(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_set_employee_limit(uuid, uuid, integer, uuid, text) to service_role;
revoke all on function public.ai_clear_employee_limit(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_clear_employee_limit(uuid, uuid, uuid, text) to service_role;
revoke all on function public.ai_employee_month_totals(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.ai_employee_month_totals(uuid, uuid, date) to service_role;
revoke all on function public.ai_invocations_month_by_feature(date, uuid) from public, anon, authenticated;
grant execute on function public.ai_invocations_month_by_feature(date, uuid) to service_role;
revoke all on function public.ai_invocations_month_totals(uuid, date) from public, anon, authenticated;
grant execute on function public.ai_invocations_month_totals(uuid, date) to service_role;
revoke all on function public.ai_reservations_month_totals(uuid, date) from public, anon, authenticated;
grant execute on function public.ai_reservations_month_totals(uuid, date) to service_role;
revoke all on function public.claim_due_maintenance_reminders(uuid) from public, anon, authenticated;
grant execute on function public.claim_due_maintenance_reminders(uuid) to service_role;

-- ═══ H. job-existence RPCs — drop anon/PUBLIC, KEEP authenticated ════════════
-- FINDING (live): append_job_photo / remove_job_photo are SECURITY DEFINER and
-- anon+PUBLIC-executable → a job-existence oracle for an unauthenticated caller.
-- They ARE legitimately called by org members via the user-JWT client
-- (app/api/jobs/[id]/photos/*) and are membership-guarded internally (42501 to a
-- non-member), so authenticated EXECUTE MUST stay. FIX: drop anon + PUBLIC only.
revoke all on function public.append_job_photo(uuid, text) from public, anon;
grant execute on function public.append_job_photo(uuid, text) to authenticated, service_role;
revoke all on function public.remove_job_photo(uuid, text) from public, anon;
grant execute on function public.remove_job_photo(uuid, text) to authenticated, service_role;

-- ═══ I. catalogue-introspection RPC for the PR-1 regression tests ════════════
-- Mirrors public._introspect_client_table_grants (20261215000000): catalogue-
-- ONLY (no tenant data), service_role-ONLY. Extends the same introspection
-- family to SEQUENCES, VIEWS and FUNCTION EXECUTE so the real-DB regression
-- guard can pin the end-state of sections E/F/G (and PR 4 extends it further).
-- Reads relacl/proacl via aclexplode (membership-independent, world-readable);
-- aclexplode grantee 0 = PUBLIC. A NULL acl expands to no rows (correctly
-- reported as "no explicit grant").
create or replace function public._introspect_object_acls(p_kind text, p_names text[])
returns table (object_name text, grantee text, privilege_type text)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select c.relname::text,
         case when a.grantee = 0 then 'PUBLIC' else r.rolname::text end,
         a.privilege_type::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral aclexplode(c.relacl) a
  left join pg_roles r on r.oid = a.grantee
  where p_kind in ('sequence', 'view')
    and c.relkind = case p_kind when 'sequence' then 'S' else 'v' end
    and c.relname = any (p_names)
    and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
  union all
  select p.proname::text,
         case when a.grantee = 0 then 'PUBLIC' else r.rolname::text end,
         a.privilege_type::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  cross join lateral aclexplode(p.proacl) a
  left join pg_roles r on r.oid = a.grantee
  where p_kind = 'function'
    and p.proname = any (p_names)
    and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'));
$$;

revoke all on function public._introspect_object_acls(text, text[]) from public, anon, authenticated;
grant execute on function public._introspect_object_acls(text, text[]) to service_role;

comment on function public._introspect_object_acls(text, text[]) is
  'Slice 1.5 least-privilege self-audit: lists client (anon/authenticated/PUBLIC) '
  'and service_role privileges on the named public sequences, views or functions. '
  'Catalogue-only, service_role-only. Used by the PR-1 grant-regression guard; '
  'extended by PR 4.';
