import type { ReactNode } from "react";
import { Breadcrumb, type Crumb } from "./breadcrumb";

/**
 * PageHeader — the ONE canonical page-header anatomy for the product.
 *
 * Before this, every page invented its own header (the design-system audit
 * counted ~10 header shapes). This establishes the shell-level pattern so a user
 * instinctively reads: WHERE am I (breadcrumb) · WHAT is this (title) · WHY
 * (description) · WHAT can I do (primary/secondary actions, right-aligned).
 *
 * Server component; slate chrome only; matches the shipped h1 idiom exactly
 * (`text-2xl font-bold text-slate-900`) so adopting it on an existing page is a
 * byte-compatible visual swap, not a redesign. Wave 1 establishes it at shell
 * level; later waves adopt it across the index/detail pages.
 */

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumb?: Crumb[];
  /** Primary + secondary actions, right-aligned (use <ButtonLink>/<Button>). */
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {breadcrumb && breadcrumb.length > 0 ? (
        <div className="mb-2">
          <Breadcrumb items={breadcrumb} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
