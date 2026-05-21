/**
 * Skeleton primitives for loading.tsx files.
 *
 * Uses Tailwind `animate-pulse` to indicate work-in-progress. Pure
 * presentation — no client component needed.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200 ${className}`}
      aria-hidden
    />
  );
}

/** A horizontally-laid-out tile row, matching the KPI tile component on /dashboard. */
export function SkeletonTileRow({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-32" />
          <Skeleton className="mt-2 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/** A table-like skeleton — N rows of M columns, with optional toolbar above. */
export function SkeletonTable({
  rows = 8,
  cols = 5,
  withToolbar = true,
}: {
  rows?: number;
  cols?: number;
  withToolbar?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      {withToolbar ? (
        <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
          <div className="ml-auto">
            <Skeleton className="h-7 w-24" />
          </div>
        </div>
      ) : null}
      <ul className="divide-y divide-slate-100">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3">
            {Array.from({ length: cols }).map((_, j) => (
              <Skeleton
                key={j}
                className={
                  j === 0
                    ? "h-4 w-24"
                    : j === cols - 1
                      ? "ml-auto h-4 w-12"
                      : "h-4 w-32"
                }
              />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A simple header (title + subtitle) skeleton — drop above the table skeleton. */
export function SkeletonHeader() {
  return (
    <div>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-2 h-4 w-72" />
    </div>
  );
}
