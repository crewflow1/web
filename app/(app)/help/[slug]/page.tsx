import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import {
  getHelpArticleBySlug,
  listHelpArticles,
} from "@/server/services/help-service";
import { categoryLabel } from "@/lib/help/articles";
import { renderMarkdown } from "@/lib/help/markdown";

/**
 * Help article detail. Renders the Markdown body via the XSS-safe
 * Markdown→React renderer (lib/help/markdown.tsx) — never dangerouslySetInnerHTML.
 * A missing/unpublished slug is a 404, not an error (getHelpArticleBySlug
 * returns null only for "no row"; a query failure still throws / loud-reads).
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;

export default async function HelpArticlePage({
  params,
}: {
  params: Params;
}) {
  await requireUser();
  const { slug } = await params;
  const article = await getHelpArticleBySlug(slug);
  if (!article) notFound();

  // Sibling articles in the same category, for a "related" rail.
  const all = await listHelpArticles();
  const related = all
    .filter((a) => a.category === article.category && a.slug !== article.slug)
    .slice(0, 5);

  return (
    <div className="space-y-5 p-6">
      <nav className="text-xs text-slate-500">
        <Link href="/help" className="hover:text-slate-700">
          Help
        </Link>
        <span aria-hidden className="mx-1.5">
          /
        </span>
        <Link
          href={`/help?category=${encodeURIComponent(article.category)}`}
          className="hover:text-slate-700"
        >
          {categoryLabel(article.category)}
        </Link>
      </nav>

      <article className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <header className="border-b border-slate-100 pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {categoryLabel(article.category)}
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">
            {article.title}
          </h1>
          {article.summary ? (
            <p className="mt-2 text-sm text-slate-600">{article.summary}</p>
          ) : null}
        </header>
        <div className="mt-4 text-[15px]">{renderMarkdown(article.body)}</div>
      </article>

      {related.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            More in {categoryLabel(article.category)}
          </h2>
          <ul className="space-y-1">
            {related.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/help/${encodeURIComponent(a.slug)}`}
                  className="text-sm font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900"
                >
                  {a.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Still stuck?{" "}
        <Link
          href="/support/new"
          className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
        >
          Raise a support ticket
        </Link>{" "}
        and the CrewFlow team will help.
      </div>
    </div>
  );
}
