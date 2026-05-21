import { Skeleton, SkeletonTileRow, SkeletonHeader } from "@/components/ui/skeleton";

/**
 * Suspense boundary for /dashboard. Mirrors the live dashboard layout
 * shape (header → tile rows → charts) so the page doesn't jump on hydration.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <SkeletonHeader />
      <SkeletonTileRow />
      <SkeletonTileRow />
      <SkeletonTileRow />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-40 w-full" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-40 w-full" />
        </div>
      </div>
    </div>
  );
}
