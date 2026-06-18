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
import { Shimmer, ShimmerStatRow, ShimmerPanel } from "@/components/ui";

export default function HqLoading() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Shimmer className="h-7 w-48" />
        <Shimmer className="h-4 w-72" />
      </header>

      <ShimmerStatRow count={4} />

      <ShimmerPanel lines={4} />

      <p className="text-center text-[11px] text-slate-500">Loading HQ…</p>
    </div>
  );
}
