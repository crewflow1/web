import { SkeletonHeader, Skeleton } from "@/components/ui/skeleton";

/**
 * /settings skeleton — matches the live page shape.
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-5 p-6">
      <SkeletonHeader />
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}
