/**
 * /stock skeleton. Mirrors the real layout (header, four tiles, three cards) so
 * the page does not jump when the data lands.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse space-y-6">
      <div className="h-8 w-40 rounded bg-slate-200" />
      <div className="h-10 rounded bg-slate-100" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-slate-200 bg-white" />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-40 rounded-xl border border-slate-200 bg-white" />
      ))}
    </div>
  );
}
