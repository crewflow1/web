import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { listHelpArticles } from "@/server/services/help-service";
import {
  searchArticles,
  groupByCategory,
  HELP_CATEGORIES,
  categoryLabel,
  type HelpArticle,
} from "@/lib/help/articles";
import { EmptyState } from "../_components/empty-state";

/**
 * In-app Help / Knowledge Base — searchable article index.
 *
 * Reads GLOBAL platform help content (not org data). Any authenticated user
 * may view it, so we require a user but no org context. Search and category
 * filtering are pure (lib/help/articles.ts) over the fetched list, so the page
 * is deterministic and the same logic is unit-tested.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ q?: string; category?: string }>;

function ArticleCard({ article }: { article: HelpArticle }) {
  return (
    <Link
      href={`/help/${encodeURIComponent(article.slug)}`}
      className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
    >
      <h3 className="text-sm font-semibold text-slate-900">{article.title}</h3>
      {article.summary ? (
        <p className="mt-1 text-sm text-slate-600">{article.summary}</p>
      ) : null}
    </Link>
  );
}

export default async function HelpPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const activeCategory =
    sp.category && HELP_CATEGORIES.some((c) => c.slug === sp.category)
      ? sp.category
      : "";

  const all = await listHelpArticles();

  // Category filter first (when set), then free-text search over what remains.
  const scoped = activeCategory
    ? all.filter((a) => a.category === activeCategory)
    : all;
  const results = q ? searchArticles(scoped, q) : scoped;

  const isSearching = q.length > 0;
  const groups = groupByCategory(results);

  return (
    <div className="space-y-5 p-6">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Workspace · Help
        </p>
        <h1 className="text-2xl font-bold text-slate-900">Help &amp; guides</h1>
        <p className="mt-1 text-sm text-slate-600">
          How-to guides for the everyday workflows. Can&apos;t find an answer?{" "}
          <Link href="/support/new" className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700">
            Raise a support ticket
          </Link>
          .
        </p>
      </header>

      {/* Search + category chips */}
      <form
        method="get"
        action="/help"
        className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col text-[11px] font-medium text-slate-700">
            Search help
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="e.g. convert quote to job, invite team"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>
          {activeCategory ? (
            <input type="hidden" name="category" value={activeCategory} />
          ) : null}
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Search
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={q ? `/help?q=${encodeURIComponent(q)}` : "/help"}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              activeCategory === ""
                ? "bg-slate-900 text-white"
                : "border border-slate-300 text-slate-700 hover:bg-slate-100"
            }`}
          >
            All
          </Link>
          {HELP_CATEGORIES.map((c) => {
            const href = `/help?category=${encodeURIComponent(c.slug)}${
              q ? `&q=${encodeURIComponent(q)}` : ""
            }`;
            return (
              <Link
                key={c.slug}
                href={href}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  activeCategory === c.slug
                    ? "bg-slate-900 text-white"
                    : "border border-slate-300 text-slate-700 hover:bg-slate-100"
                }`}
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      </form>

      {results.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🔎"
            title={isSearching ? "No matching articles" : "No help articles yet"}
            body={
              isSearching
                ? `Nothing matched “${q}”${
                    activeCategory ? ` in ${categoryLabel(activeCategory)}` : ""
                  }. Try fewer or different words, or raise a support ticket.`
                : "Help content will appear here."
            }
            primary={{ href: "/support/new", label: "Raise a ticket" }}
            secondary={isSearching ? { href: "/help", label: "Clear search" } : undefined}
          />
        </div>
      ) : isSearching ? (
        // Flat, ranked list when searching — rank order matters more than grouping.
        <section className="space-y-2">
          <p className="text-xs font-medium text-slate-500">
            {results.length} {results.length === 1 ? "result" : "results"}
            {activeCategory ? ` in ${categoryLabel(activeCategory)}` : ""}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {results.map((a) => (
              <ArticleCard key={a.id} article={a} />
            ))}
          </div>
        </section>
      ) : (
        // Browsing — grouped by category.
        groups.map((group) => (
          <section key={group.slug} className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              {group.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.articles.map((a) => (
                <ArticleCard key={a.id} article={a} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
