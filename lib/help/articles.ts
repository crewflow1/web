/**
 * In-app Help / Knowledge Base — pure content model + search/resolution.
 *
 * Kept PURE (no `server-only`, no Supabase SDK) so the search, grouping, and
 * contextual-link resolution logic is unit-testable without a database and can
 * be shared by the server service and any client surface. All DB access lives
 * in server/services/help-service.ts.
 */

/**
 * A published help article, as read from `public.help_articles`.
 * `body` is Markdown — render it only through lib/help/markdown.tsx.
 */
export type HelpArticle = {
  id: string;
  slug: string;
  title: string;
  category: string;
  summary: string;
  body: string;
  keywords: readonly string[];
  sort_order: number;
};

/**
 * The known help categories, in display order. `category` on a row is free
 * text at the DB layer; this is the presentation contract. An article whose
 * category is not listed here still renders — it falls into "Other" (see
 * {@link groupByCategory}) rather than disappearing.
 */
export const HELP_CATEGORIES = [
  { slug: "getting-started", label: "Getting started" },
  { slug: "quotes", label: "Quotes" },
  { slug: "jobs", label: "Jobs" },
  { slug: "invoicing", label: "Invoicing & payments" },
  { slug: "team", label: "Your team" },
  { slug: "portal", label: "Customer portal" },
] as const;

export type HelpCategorySlug = (typeof HELP_CATEGORIES)[number]["slug"];

const CATEGORY_LABEL = new Map<string, string>(
  HELP_CATEGORIES.map((c) => [c.slug, c.label]),
);

/** Human label for a category slug, falling back to "Other" for unknowns. */
export function categoryLabel(slug: string): string {
  return CATEGORY_LABEL.get(slug) ?? "Other";
}

export type HelpCategoryGroup = {
  slug: string;
  label: string;
  articles: HelpArticle[];
};

/**
 * Group articles into categories in the canonical HELP_CATEGORIES order,
 * with any unknown-category articles collected into a trailing "Other" group.
 * Empty categories are omitted. Within a group, articles keep the order they
 * arrive in (the service sorts by sort_order, then title).
 */
export function groupByCategory(
  articles: readonly HelpArticle[],
): HelpCategoryGroup[] {
  const byCat = new Map<string, HelpArticle[]>();
  for (const a of articles) {
    const list = byCat.get(a.category) ?? [];
    list.push(a);
    byCat.set(a.category, list);
  }

  const groups: HelpCategoryGroup[] = [];
  for (const { slug, label } of HELP_CATEGORIES) {
    const list = byCat.get(slug);
    if (list && list.length > 0) {
      groups.push({ slug, label, articles: list });
      byCat.delete(slug);
    }
  }

  // Anything left is an unknown category → one "Other" bucket, sorted so the
  // output is deterministic regardless of Map insertion order.
  const leftover: HelpArticle[] = [];
  for (const list of byCat.values()) leftover.push(...list);
  if (leftover.length > 0) {
    leftover.sort(
      (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
    );
    groups.push({ slug: "other", label: "Other", articles: leftover });
  }

  return groups;
}

/**
 * Normalise a free-text query into lowercase word tokens. Punctuation is
 * dropped so "quote's" matches "quote", and empty tokens are removed.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/**
 * Full-text-ish search over title / summary / keywords / body.
 *
 * Deterministic and case-insensitive. Every token must match somewhere in an
 * article (AND semantics), so more words narrows the result. Results are ranked
 * by where matches land — title and keyword hits weigh more than body hits —
 * then by the article's own sort_order and title as a stable tiebreak. An empty
 * or whitespace-only query returns the input unchanged (callers show the full
 * categorised list rather than "no results").
 */
export function searchArticles(
  articles: readonly HelpArticle[],
  query: string,
): HelpArticle[] {
  const tokens = tokenize(query ?? "");
  if (tokens.length === 0) return [...articles];

  const scored: Array<{ article: HelpArticle; score: number }> = [];
  for (const article of articles) {
    const title = article.title.toLowerCase();
    const summary = article.summary.toLowerCase();
    const body = article.body.toLowerCase();
    const keywords = article.keywords.map((k) => k.toLowerCase());

    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      let tokenScore = 0;
      if (title.includes(token)) tokenScore += 10;
      if (keywords.some((k) => k.includes(token))) tokenScore += 6;
      if (summary.includes(token)) tokenScore += 4;
      if (body.includes(token)) tokenScore += 1;
      if (tokenScore === 0) {
        matchedAll = false;
        break;
      }
      score += tokenScore;
    }

    if (matchedAll) scored.push({ article, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.article.sort_order - b.article.sort_order ||
      a.article.title.localeCompare(b.article.title),
  );

  return scored.map((s) => s.article);
}

/**
 * Where a contextual HelpLink points. Either a specific article (by slug) or a
 * category landing on the /help list. Resolved to a concrete href by
 * {@link helpHref} — kept as data so it is unit-testable and so an unknown
 * category can never produce a broken deep-link.
 */
export type HelpTarget =
  | { kind: "article"; slug: string }
  | { kind: "category"; slug: string };

/**
 * Resolve a HelpTarget to an in-app href.
 *
 * - An article → `/help/<slug>`.
 * - A KNOWN category → `/help?category=<slug>` (pre-filters the list).
 * - An UNKNOWN category → `/help` (never a link to a category that doesn't
 *   exist; degrade to the help home rather than a dead filter).
 *
 * Slugs are emitted URL-encoded so a stray character can't break the path/query.
 */
export function helpHref(target: HelpTarget): string {
  if (target.kind === "article") {
    return `/help/${encodeURIComponent(target.slug)}`;
  }
  if (CATEGORY_LABEL.has(target.slug)) {
    return `/help?category=${encodeURIComponent(target.slug)}`;
  }
  return "/help";
}
