/**
 * Fleet skeleton — matches the overview's shape (header, four stat tiles, two
 * cards) so the page doesn't jump when the real data lands.
 */
export default function FleetLoading() {
  return (
    <div className="mx-auto max-w-6xl animate-pulse space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="h-7 w-32 rounded bg-slate-200" />
          <div className="h-4 w-80 rounded bg-slate-100" />
        </div>
        <div className="h-10 w-32 rounded-md bg-slate-200" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="h-3 w-20 rounded bg-slate-100" />
            <div className="mt-2 h-7 w-16 rounded bg-slate-200" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-64 rounded-xl border border-slate-200 bg-white shadow-sm lg:col-span-2" />
        <div className="h-64 rounded-xl border border-slate-200 bg-white shadow-sm" />
      </div>
    </div>
  );
}
