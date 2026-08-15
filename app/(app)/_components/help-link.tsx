import Link from "next/link";
import { helpHref, type HelpTarget } from "@/lib/help/articles";

/**
 * Contextual "?" help affordance.
 *
 * A small, reusable link that deep-links a page to the relevant help article
 * (or pre-filters the /help list by category). Drop it beside a page heading:
 *
 *   <HelpLink article="creating-a-quote" label="Help with quotes" />
 *   <HelpLink category="jobs" />
 *
 * Purely presentational + a resolved href (see lib/help/articles.ts) — no
 * client state, so it stays a server component. The target is validated by
 * {@link helpHref}: an unknown category degrades to /help rather than a dead
 * deep-link, so this can never render a broken URL.
 */
export function HelpLink({
  article,
  category,
  label = "Help",
  className,
}: {
  /** Article slug to deep-link to. Takes precedence over `category`. */
  article?: string;
  /** Category slug to pre-filter the /help list. */
  category?: string;
  /** Accessible label / tooltip. Defaults to "Help". */
  label?: string;
  className?: string;
}) {
  const target: HelpTarget = article
    ? { kind: "article", slug: article }
    : { kind: "category", slug: category ?? "" };

  return (
    <Link
      href={helpHref(target)}
      title={label}
      aria-label={label}
      className={
        className ??
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 text-xs font-semibold text-slate-500 transition hover:border-slate-400 hover:bg-slate-100 hover:text-slate-700"
      }
    >
      <span aria-hidden>?</span>
    </Link>
  );
}
