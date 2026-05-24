/**
 * /admin/* loading shell — surfaces during Next.js Suspense boundaries
 * while a server-rendered HQ page fetches its snapshot. Without this,
 * cold-function instances show a blank slate for 2-3s before the
 * page paints.
 *
 * Deliberately framework-thin: no client JS, no fancy animation,
 * just the same surface chrome the real page renders so the layout
 * doesn't visibly jump on resolve.
 */
export default function HqLoading() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="h-7 w-48 animate-pulse rounded-md bg-slate-200" />
        <div className="h-4 w-72 animate-pulse rounded-md bg-slate-100" />
      </header>

      <section className="grid gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white shadow-sm"
          />
        ))}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="space-y-3">
          <div className="h-5 w-40 animate-pulse rounded-md bg-slate-200" />
          <div className="h-4 w-full animate-pulse rounded-md bg-slate-100" />
          <div className="h-4 w-5/6 animate-pulse rounded-md bg-slate-100" />
          <div className="h-4 w-3/4 animate-pulse rounded-md bg-slate-100" />
        </div>
      </section>

      <p className="text-center text-[11px] text-slate-400">
        Loading HQ…
      </p>
    </div>
  );
}
