import { Skeleton, SkeletonHeader } from "@/components/ui/skeleton";

// L4: instant Suspense fallback so navigating to AI insights shows a skeleton
// rather than freezing on the previous route until the server data resolves.
// Insights is a card/prose layout (banner + question box + summary cards),
// not a table, so we approximate with stacked card blocks.
export default function InsightsLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-5/6" />
        <Skeleton className="mt-2 h-4 w-2/3" />
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-24 w-full" />
      </div>
    </div>
  );
}
