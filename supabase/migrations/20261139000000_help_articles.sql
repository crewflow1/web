-- In-app Help / Knowledge Base — the platform help-article content model.
--
-- WHY THIS EXISTS
-- ---------------
-- Until now the only in-app self-serve surface was the support-ticket queue
-- (app/(app)/support) — every "how do I…" question became a ticket. This table
-- backs a searchable /help route and contextual "?" deep-links so a user can
-- answer the common questions themselves, in-product, without waiting for a
-- reply.
--
-- NOT TENANT DATA — GLOBAL PLATFORM CONTENT
-- -----------------------------------------
-- Help articles are CrewFlow-authored platform documentation shared by EVERY
-- org. They are deliberately NOT org-scoped: there is no `org_id`, and there is
-- NO tenant write path. Authoring is CrewFlow-internal (seed migrations / a
-- future HQ admin UI on the service-role client). Because the row carries no
-- `org_id`, it is correctly outside the GDPR org-export census (that guard
-- enumerates org-scoped BASE tables only — see lib/gdpr/export-tables.ts) and
-- must NOT be added to lib/gdpr/org-tables.json.
--
-- ACCESS MODEL
-- ------------
-- RLS is ENABLED. The only policy is a SELECT for `authenticated` restricted to
-- `active = true`: any signed-in user of any org can read published articles,
-- and drafts (active = false) are invisible to tenants. NO insert/update/delete
-- policy exists, so those verbs are denied to anon/authenticated — writes are
-- service-role only (which bypasses RLS). Table-level write grants that
-- PostgREST hands its roles by default are also revoked, belt-and-suspenders.
--
-- Additive + idempotent.

create table if not exists public.help_articles (
  id          uuid        primary key default gen_random_uuid(),
  -- URL-stable identifier used by /help/[slug] and every contextual HelpLink.
  slug        text        not null unique,
  title       text        not null,
  -- Grouping key for the category list on /help. Free text validated in the
  -- application layer (lib/help/articles.ts) rather than a DB enum, so new
  -- categories can be seeded without a schema migration.
  category    text        not null,
  -- One-line preview shown in the list before the article is opened.
  summary     text        not null default '',
  -- Article body in Markdown. Rendered XSS-safe by a whitelist Markdown→React
  -- renderer (lib/help/markdown.tsx) — never via dangerouslySetInnerHTML.
  body        text        not null,
  -- Extra search terms beyond title/summary/body (synonyms, feature names).
  keywords    text[]      not null default '{}',
  -- Stable ordering within a category; lower sorts first.
  sort_order  integer     not null default 100,
  -- Draft/published switch. Only active rows are visible to tenants (RLS).
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.help_articles is
  'Global platform help / knowledge-base articles. NOT org-scoped tenant data: '
  'no org_id, no tenant write path (authoring is CrewFlow-internal via '
  'service-role). RLS: authenticated may SELECT active rows only; writes are '
  'service-role. Deliberately excluded from the GDPR org-export census.';

-- The /help list reads active rows grouped by category, ordered within it.
create index if not exists help_articles_category_idx
  on public.help_articles (category, sort_order, title)
  where active;

alter table public.help_articles enable row level security;

-- Any signed-in user may read PUBLISHED articles. No org predicate: this is
-- global content. Drafts (active = false) are excluded here and therefore
-- invisible to every tenant role.
drop policy if exists "help_articles: authenticated read active" on public.help_articles;
create policy "help_articles: authenticated read active"
  on public.help_articles
  for select
  to authenticated
  using (active = true);

-- Writes are service-role only. No policy grants insert/update/delete to
-- anon/authenticated (default-deny), and we also revoke the default grants.
revoke insert, update, delete on table public.help_articles from anon, authenticated;
