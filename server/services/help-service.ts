import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import type { HelpArticle } from "@/lib/help/articles";

/**
 * Help / Knowledge-Base service.
 *
 * Reads global platform help content from `public.help_articles`. Uses the
 * USER-JWT supabase client: the table's RLS policy grants any authenticated
 * user SELECT on `active = true` rows, so no org context is needed — help
 * content is the same for every tenant. Writes are service-role only and live
 * nowhere in the tenant app.
 *
 * Loud reads: a rejected query THROWS (readFailure) so the route-group error
 * boundary shows "Something went wrong" and Sentry captures it, rather than an
 * empty article list masquerading as "no help yet".
 */

const COLUMNS = "id, slug, title, category, summary, body, keywords, sort_order";

/** Row shape as returned by PostgREST before we narrow to HelpArticle. */
type HelpArticleRow = {
  id: string;
  slug: string;
  title: string;
  category: string;
  summary: string | null;
  body: string;
  keywords: string[] | null;
  sort_order: number | null;
};

function toArticle(row: HelpArticleRow): HelpArticle {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    summary: row.summary ?? "",
    body: row.body,
    keywords: row.keywords ?? [],
    sort_order: row.sort_order ?? 100,
  };
}

/**
 * List every published help article, ordered by category → sort_order → title.
 * The stable ordering is what {@link groupByCategory} and searchArticles rely on
 * for deterministic output.
 */
export async function listHelpArticles(): Promise<HelpArticle[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("help_articles")
    .select(COLUMNS)
    .eq("active", true)
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("title", { ascending: true });

  if (error) throw readFailure("help_articles list", error);
  return (data ?? []).map((r) => toArticle(r as HelpArticleRow));
}

/**
 * Fetch one published article by slug, or null if there is no such active
 * article. A genuine query failure still THROWS (loud read) — null is reserved
 * strictly for "no matching row", which the page turns into a 404.
 */
export async function getHelpArticleBySlug(
  slug: string,
): Promise<HelpArticle | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("help_articles")
    .select(COLUMNS)
    .eq("active", true)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw readFailure("help_article fetch", error);
  return data ? toArticle(data as HelpArticleRow) : null;
}
