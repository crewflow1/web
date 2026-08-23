import Link from "next/link";

/**
 * Breadcrumb — the canonical "where am I" trail for deep operational pages.
 *
 * Server component, slate chrome only (no tone-varying colour — status belongs
 * in a <Badge>, never in the trail). The last item is the current page and is
 * not a link. Use it on entity-detail and nested pages (Projects → Riverside →
 * Financials); skip it on top-level index screens where it would only add noise.
 */

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({ items }: { items: Crumb[] }) {
  if (!items.length) return null;
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1.5">
              {c.href && !last ? (
                <Link href={c.href} className="truncate hover:text-slate-900">
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "truncate font-medium text-slate-700" : "truncate"}
                >
                  {c.label}
                </span>
              )}
              {!last ? (
                <span aria-hidden className="text-slate-300">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
