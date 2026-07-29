/**
 * Operations skeleton.
 *
 * The command centre fans out across the fleet register, the schedule detector
 * and six estate reads, so it is the heaviest read on the product. This route
 * fallback is what keeps the shell — header, five counters, the two-column grid
 * — on screen instantly while that work completes, and it mirrors the real
 * page's shape exactly so nothing jumps when the data lands.
 */
export default function OperationsLoading() {
  return (
    <div className="mx-auto max-w-6xl animate-pulse space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="h-7 w-40 rounded bg-slate-200" />
          <div className="h-4 w-96 max-w-full rounded bg-slate-100" />
        </div>
        <div className="flex gap-2">
          <div className="h-10 w-20 rounded-md bg-slate-200" />
          <div className="h-10 w-20 rounded-md bg-slate-200" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="h-3 w-20 rounded bg-slate-100" />
            <div className="mt-2 h-7 w-12 rounded bg-slate-200" />
            <div className="mt-2 h-3 w-24 rounded bg-slate-100" />
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-48 rounded-xl border border-slate-200 bg-white shadow-sm"
            />
          ))}
        </div>
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 rounded-xl border border-slate-200 bg-white shadow-sm"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
